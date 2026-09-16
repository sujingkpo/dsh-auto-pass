/**
 * @description 策略引擎单测：签名归一化、三种匹配条件的边界、白黑名单优先级、
 *   连续放行自动升级、阈值与落盘往返、项目目录不可写时降级写全局。
 * @author simon300000
 * @date 2026-09-15
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceSlug } from '../src/records.js'
import {
  canonicalizeCounters,
  canonicalizeMemoryCounters,
  canonicalMemoryKey,
  createPolicyStore,
  DEFAULT_MAX_COUNTERS,
  matchRule,
  MIN_PREFIX_CHARS,
  normalizePath,
  projectPolicyFile,
  pruneCounters,
  ruleCovers,
  signatureOf,
  validateRuleInput,
} from '../src/policy.js'

/** 每个用例一个独立的临时目录，避免相互污染。 */
function newRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-auto-pass-policy-'))
}

function pwshSignature(command, extra = {}) {
  return signatureOf({ toolName: 'pwsh' }, { arguments: { command, ...extra } })
}

function signatureRule(scope, list, signature, extra = {}) {
  return {
    scope,
    list,
    rule: {
      tool: signature.toolName,
      match: { kind: 'signature', value: signature.key },
      label: signature.text,
      ...extra,
    },
  }
}

describe('signatureOf', () => {
  it('折叠空白后同一命令得到同一签名', () => {
    expect(pwshSignature('git   status').key).toBe(pwshSignature('git status').key)
  })

  it('不同命令得到不同签名', () => {
    expect(pwshSignature('git status').key).not.toBe(pwshSignature('git diff').key)
  })

  it('噪声参数只影响精确签名，不影响记忆键', () => {
    // description / justification / timeoutMs 只影响展示与管道，不该拆散「连续」
    const first = pwshSignature('pnpm test', { description: '跑测试', justification: '理由一', timeoutMs: 300000 })
    const second = pwshSignature('pnpm test', { description: '再跑一次', justification: '完全不同的理由', timeoutMs: 60000 })
    expect(first.key).not.toBe(second.key)
    expect(first.memoryKey).toBe(second.memoryKey)
    // 提权标记改变的是授权范围，必须留在记忆键里：提权重试不与普通调用混计
    const elevated = pwshSignature('pnpm test', { description: '跑测试', justification: '理由一', sandbox_permissions: 'danger-full-access' })
    expect(elevated.memoryKey).not.toBe(first.memoryKey)
  })

  it('计数键把管道之后当噪声：同一条命令的不同输出截断算同一条', () => {
    // 真机踩到的坑（2026-09-15）：用户连续人工放行了 4 次
    // `pnpm vitest run tests/client.spec.js 2>&1 | Select-Object -Last 60/45/30/26`，
    // 因为计数键含完整命令，每次都是一条新计数，阈值（3）永远攒不到。
    const first = pwshSignature('pnpm vitest run tests/client.spec.js 2>&1 | Select-Object -Last 60')
    const second = pwshSignature('pnpm vitest run tests/client.spec.js 2>&1 | Select-Object -Last 30')
    const third = pwshSignature("pnpm vitest run tests/client.spec.js 2>&1 | Select-String -Pattern 'Tests ' | Out-String")
    // 精确签名仍然各不相同：规则匹配必须逐字，计数才做归并
    expect(first.key).not.toBe(second.key)
    expect(first.key).not.toBe(third.key)
    expect(first.memoryKey).toBe(second.memoryKey)
    expect(first.memoryKey).toBe(third.memoryKey)
    // 结尾的纯输出重定向也当噪声：`pnpm test 2>&1` 与 `pnpm test` 是同一条权限
    expect(first.memoryKey).toContain('cmd:pnpm vitest run tests/client.spec.js')
    expect(first.memoryKey).not.toContain('Select-Object')
    // 没有管道的命令整条保留
    expect(pwshSignature('git status --short').memoryKey).toContain('cmd:git status --short')
  })

  it('结尾的纯输出重定向也算噪声（2>&1 / >nul / 2>/dev/null）', () => {
    // 真机踩到的坑：`pnpm test 2>&1` 与 `pnpm test` 被算成两条权限，阈值 3 攒不到
    expect(pwshSignature('pnpm test 2>&1').memoryKey).toBe(pwshSignature('pnpm test').memoryKey)
    expect(pwshSignature('npm run build >nul').memoryKey).toBe(pwshSignature('npm run build').memoryKey)
    expect(pwshSignature('node x.js 2>/dev/null').memoryKey).toBe(pwshSignature('node x.js').memoryKey)
    // 真会写文件的输出重定向不是噪声：它改变的是「在授权什么」
    expect(pwshSignature('node x.js > out.txt').memoryKey).not.toBe(pwshSignature('node x.js').memoryKey)
  })

  it('workdir 不进计数键（同一工作区里的目录差异算同一条），精确签名仍按目录区分', () => {
    const back = pwshSignature('pnpm test 2>&1', { workdir: 'D:\\work\\dsh-auto' })
    const forward = pwshSignature('pnpm test 2>&1 | Select-Object -Last 12', { workdir: 'D:/work/dsh-auto' })
    const absent = pwshSignature('pnpm test', {})
    expect(back.memoryKey).toBe(forward.memoryKey)
    expect(forward.memoryKey).toBe(absent.memoryKey)
    // 精确签名只归一化分隔符、不丢目录：规则匹配不会因此放宽
    expect(pwshSignature('pnpm test', { workdir: 'D:\\work\\x' }).key)
      .toBe(pwshSignature('pnpm test', { workdir: 'D:/work/x' }).key)
    expect(pwshSignature('pnpm test', { workdir: 'D:/work/x' }).key)
      .not.toBe(pwshSignature('pnpm test', {}).key)
  })

  it('引号内的竖线不算管道（正则里的 | 不该截断计数键）', () => {
    const first = pwshSignature("rg 'a|b' src")
    const second = pwshSignature("rg 'a|c' src")
    expect(first.memoryKey).not.toBe(second.memoryKey)
    expect(first.memoryKey).toContain("rg 'a|b' src")
    // 引号之前的真管道照旧截断
    expect(pwshSignature("rg 'a|b' src | Select-Object -First 5").memoryKey)
      .toBe(pwshSignature("rg 'a|b' src | Out-String").memoryKey)
  })

  it('提权标记等额外参数参与签名', () => {
    const plain = pwshSignature('git status')
    const elevated = pwshSignature('git status', { sandbox_permissions: 'danger-full-access' })
    expect(elevated.key).not.toBe(plain.key)
  })

  it('非命令工具用参数 JSON 作签名，并保留人类可读标签', () => {
    const signature = signatureOf({ toolName: 'write' }, { arguments: { file_path: 'src\\a.js', content: 'x' } })
    expect(signature.command).toBeUndefined()
    expect(signature.paths).toEqual(['src/a.js'])
    expect(signature.text).toContain('write: ')
    expect(signature.key).toContain('args:')
  })

  it('缺少动作参数时不抛错', () => {
    expect(signatureOf({ toolName: 'pwsh' }, undefined).key).toContain('pwsh')
  })
})

describe('计数键折算（canonicalMemoryKey / canonicalizeCounters）', () => {
  it('当前算法产出的记忆键折算后不变（幂等）', () => {
    const signature = pwshSignature('pnpm test 2>&1 | Select-Object -Last 12', {
      workdir: 'D:/work/x',
      sandbox_permissions: 'danger-full-access',
    })
    expect(canonicalMemoryKey(signature.memoryKey)).toBe(signature.memoryKey)
  })

  it('格式不认识时返回 undefined，不乱改键', () => {
    expect(canonicalMemoryKey('pwsh\u0000cmd:x')).toBeUndefined()
    expect(canonicalMemoryKey('pwsh\u0000cmd:x\u0000y:{}')).toBeUndefined()
    expect(canonicalMemoryKey('')).toBeUndefined()
  })

  it('历史键合并到当前口径：管道之后 / workdir / 2>&1 不再各算一条，同目标取较大值', () => {
    const cwd = 'D:/w'
    const migrated = canonicalizeCounters({
      [cwd + '\u0000pwsh\u0000cmd:pnpm test 2>&1 | Select-Object -Last 30\u0000x:{"workdir":"D:/work/x"}']: { allow: 1, deny: 0 },
      [cwd + '\u0000pwsh\u0000cmd:pnpm test 2>&1\u0000x:{"workdir":"D:\\\\work\\\\x"}']: { allow: 2, deny: 0 },
      [cwd + '\u0000pwsh\u0000cmd:pnpm test\u0000x:{}']: { allow: 1, deny: 3 },
    })
    expect(migrated.moved).toBe(2)
    const keys = Object.keys(migrated.counters)
    expect(keys).toHaveLength(1)
    // 折算历史不该凭空攒出新的「连续次数」：取较大值而不是求和
    expect(migrated.counters[keys[0]]).toEqual({ allow: 2, deny: 3 })
  })

  it('计数文件里的裸 memoryKey 也能折算（同目标取较大值）', () => {
    const current = pwshSignature('pnpm test 2>&1')
    const migrated = canonicalizeMemoryCounters({
      'pwsh\u0000cmd:pnpm test 2>&1 | Select-Object -Last 30\u0000x:{"workdir":"D:/w"}': { allow: 1, deny: 0 },
      [current.memoryKey]: { allow: 2, deny: 0 },
    })
    expect(migrated.moved).toBe(1)
    expect(Object.keys(migrated.counters)).toEqual([current.memoryKey])
    expect(migrated.counters[current.memoryKey]).toEqual({ allow: 2, deny: 0 })
  })

  it('启动时把老全局文件里的计数拆到各工作区的计数文件，并从全局文件里删掉', () => {
    const root = newRoot()
    const file = join(root, 'home', 'policy.json')
    const counterDir = join(root, 'home', 'counters')
    const current = pwshSignature('pnpm test 2>&1')
    const legacy = 'D:/w\u0000pwsh\u0000cmd:pnpm test 2>&1 | Select-Object -Last 30\u0000x:{"workdir":"D:/w"}'
    const canonical = 'D:/w\u0000' + current.memoryKey
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({
      version: 1,
      rules: { allow: [], deny: [] },
      counters: {
        [legacy]: { allow: 1, deny: 0 },
        [canonical]: { allow: 2, deny: 0 },
        ['D:/other\u0000' + current.memoryKey]: { allow: 1, deny: 0 },
      },
    }), 'utf8')
    const info = vi.fn()
    createPolicyStore({ globalFile: file, counterDir, warn: () => {}, info })
    // 折算（1 个历史键）与拆分（2 个工作区）各记一行
    expect(info).toHaveBeenCalledWith(expect.stringContaining('已折算 1 个历史计数键'))
    expect(info).toHaveBeenCalledWith(expect.stringContaining('已把 2 个计数键按工作区拆进 2 个计数文件'))
    const persisted = JSON.parse(readFileSync(file, 'utf8'))
    expect(persisted.counters).toBeUndefined()
    // 同一个工作区的历史键与当前键合并（取较大值），键只留裸 memoryKey
    const first = JSON.parse(readFileSync(join(counterDir, workspaceSlug('D:/w') + '.json'), 'utf8'))
    expect(first.counters).toEqual({ [current.memoryKey]: { allow: 2, deny: 0 } })
    const second = JSON.parse(readFileSync(join(counterDir, workspaceSlug('D:/other') + '.json'), 'utf8'))
    expect(Object.keys(second.counters)).toEqual([current.memoryKey])
  })
})

describe('pruneCounters（单工作区：死条目清理与上限）', () => {
  /** 造一个计数键：一个工作区文件里的键就是裸 memoryKey。 */
  const key = name => 'pwsh\u0000cmd:' + name + '\u0000x:{}'

  it('删掉「两侧都是 0、也没被 dismissed」的死条目', () => {
    const pruned = pruneCounters({
      [key('pnpm test')]: { allow: 2, deny: 0 },
      [key('pnpm lint')]: { allow: 0, deny: 0 },
      [key('pnpm build')]: { count: 0 },
    })
    expect(Object.keys(pruned.counters)).toEqual([key('pnpm test')])
    expect(pruned.removed).toBe(2)
  })

  it('dismissed 条目（哪怕两侧都是 0）不会被当死条目删掉', () => {
    const dismissed = key('rm -rf /')
    const pruned = pruneCounters({ [dismissed]: { allow: 0, deny: 0, dismissed: { deny: true } } })
    expect(Object.keys(pruned.counters)).toEqual([dismissed])
    expect(pruned.removed).toBe(0)
  })

  it('超过上限时先淘汰最久未用的活动条目，dismissed 最后才动', () => {
    const pruned = pruneCounters({
      [key('oldest')]: { allow: 1, deny: 0, at: 10 },
      [key('middle')]: { allow: 1, deny: 0, at: 20 },
      [key('newest')]: { allow: 1, deny: 0, at: 30 },
      [key('dismissed')]: { allow: 0, deny: 0, dismissed: { deny: true }, at: 1 },
    }, { max: 2 })
    expect(Object.keys(pruned.counters).sort()).toEqual([key('newest'), key('dismissed')].sort())
    expect(pruned.removed).toBe(2)
  })

  it('正在更新的那一条（protect）永不淘汰', () => {
    const fresh = key('fresh')
    const pruned = pruneCounters({
      [key('a-1')]: { allow: 1, deny: 0, at: 1 },
      [key('a-2')]: { allow: 1, deny: 0, at: 2 },
      [fresh]: { allow: 1, deny: 0, at: 99 },
    }, { max: 2, protect: new Set([fresh]) })
    expect(Object.keys(pruned.counters)).toContain(fresh)
    expect(pruned.removed).toBe(1)
  })

  it('保留 at（老条目缺 at 按最旧处理）', () => {
    const pruned = pruneCounters({
      [key('legacy')]: { allow: 1, deny: 0 },
      [key('timed')]: { allow: 1, deny: 0, at: 7 },
    }, { max: 1 })
    expect(Object.keys(pruned.counters)).toEqual([key('timed')])
    expect(pruned.counters[key('timed')].at).toBe(7)
  })
})

describe('normalizePath', () => {
  it('统一分隔符并去掉尾部分隔符', () => {
    expect(normalizePath('D:\\a\\b\\')).toBe('D:/a/b')
  })
})

describe('matchRule', () => {
  const status = pwshSignature('git status --short')

  it('精确签名命中，不同签名不命中', () => {
    expect(matchRule({ tool: 'pwsh', match: { kind: 'signature', value: status.key } }, status)).toBe(true)
    expect(matchRule({ tool: 'pwsh', match: { kind: 'signature', value: 'other' } }, status)).toBe(false)
  })

  it('工具名不同则不命中', () => {
    expect(matchRule({ tool: 'bash', match: { kind: 'signature', value: status.key } }, status)).toBe(false)
  })

  it('命令前缀要求词边界：git status 命中 --short，不命中 statusx', () => {
    const prefix = { tool: 'pwsh', match: { kind: 'command_prefix', value: 'git status' } }
    expect(matchRule(prefix, status)).toBe(true)
    expect(matchRule(prefix, pwshSignature('git statusx'))).toBe(false)
    expect(matchRule(prefix, pwshSignature('git status'))).toBe(true)
  })

  it('过短的前缀一律不命中', () => {
    const shortPrefix = { tool: 'pwsh', match: { kind: 'command_prefix', value: 'gi' } }
    expect(matchRule(shortPrefix, status)).toBe(false)
    expect('gi'.length).toBeLessThan(MIN_PREFIX_CHARS)
  })

  it('路径前缀按目录边界匹配，不误伤同前缀兄弟目录', () => {
    const inside = signatureOf({ toolName: 'write' }, { arguments: { file_path: 'D:/repo/src/a.js' } })
    const sibling = signatureOf({ toolName: 'write' }, { arguments: { file_path: 'D:/repo/src-old/a.js' } })
    const rule = { tool: 'write', match: { kind: 'path_prefix', value: 'D:/repo/src' } }
    expect(matchRule(rule, inside)).toBe(true)
    expect(matchRule(rule, sibling)).toBe(false)
  })

  it('路径前缀允许精确命中目录本身', () => {
    const exact = signatureOf({ toolName: 'write' }, { arguments: { file_path: 'D:/repo/src' } })
    const rule = { tool: 'write', match: { kind: 'path_prefix', value: 'D:/repo/src' } }
    expect(matchRule(rule, exact)).toBe(true)
  })

  it('重建签名时缺 paths（老记录）一律不命中，绝不因为字段缺失而放行', () => {
    // signatureFromRecord 对老记录不再伪造空数组：字段缺失 = 不知道，matchRule 必须拒绝
    const legacy = { toolName: 'write', key: 'k', text: 'write: x' }
    expect(matchRule({ tool: 'write', match: { kind: 'path_prefix', value: 'D:/repo/src' } }, legacy)).toBe(false)
    expect(matchRule({ tool: 'write', match: { kind: 'path_prefix', value: 'D:/repo/src/*.js' } }, legacy)).toBe(false)
  })

  it('路径前缀的单层通配：同目录的 .js 命中，子目录 / 别的目录 / 别的后缀都不命中', () => {
    const rule = { tool: 'write', match: { kind: 'path_prefix', value: 'D:/repo/src/*.js' } }
    const at = path => signatureOf({ toolName: 'write' }, { arguments: { file_path: path } })
    expect(matchRule(rule, at('D:/repo/src/a.js'))).toBe(true)
    expect(matchRule(rule, at('D:/repo/src/a.b.js'))).toBe(true)
    expect(matchRule(rule, at('D:/repo/src/a.ts'))).toBe(false)
    // 不跨目录：子目录与兄弟目录都不算
    expect(matchRule(rule, at('D:/repo/src/sub/a.js'))).toBe(false)
    expect(matchRule(rule, at('D:/repo/other/a.js'))).toBe(false)
    // 目录本身不是文件，不命中带通配符的规则
    expect(matchRule(rule, at('D:/repo/src'))).toBe(false)
  })
})

describe('validateRuleInput', () => {
  it('接受合法规则并裁剪空白', () => {
    const result = validateRuleInput({
      tool: ' pwsh ',
      label: ' git 只读命令 ',
      match: { kind: 'command_prefix', value: 'git status' },
    })
    expect(result.ok).toBe(true)
    expect(result.rule.tool).toBe('pwsh')
    expect(result.rule.label).toBe('git 只读命令')
  })

  it('路径规则只认单层 *：** / ? / [] / 中段通配 / 无目录的通配一律拒绝', () => {
    const ruleOf = value => validateRuleInput({ tool: 'write', label: 'x', match: { kind: 'path_prefix', value } })
    expect(ruleOf('D:/repo/**/*.js').error).toContain('**')
    expect(ruleOf('D:/repo/src/?a.js').ok).toBe(false)
    expect(ruleOf('D:/repo/src/[ab].js').ok).toBe(false)
    // * 只能出现在最后一段
    expect(ruleOf('D:/repo/*/a.js').ok).toBe(false)
    // 通配符前面必须有目录：*.js 这种相对模式在绝对路径上一条也命不中
    expect(ruleOf('*.js').ok).toBe(false)
    expect(ruleOf('*').ok).toBe(false)
    // 合法的单层通配
    expect(ruleOf('D:/repo/src/*.js').ok).toBe(true)
    expect(ruleOf('D:/repo/src/*').ok).toBe(true)
    // 不含通配符的目录前缀照旧
    expect(ruleOf('D:/repo/src').ok).toBe(true)
  })

  it('拒绝未知匹配条件、空标签与过短前缀', () => {
    expect(validateRuleInput({ tool: 'pwsh', label: 'x', match: { kind: 'regex', value: '.*' } }).ok).toBe(false)
    expect(validateRuleInput({ tool: 'pwsh', label: '', match: { kind: 'signature', value: 'k' } }).ok).toBe(false)
    expect(validateRuleInput({ tool: 'pwsh', label: 'x', match: { kind: 'command_prefix', value: 'gi' } }).ok).toBe(false)
    expect(validateRuleInput(null).ok).toBe(false)
  })
})

describe('ruleCovers（规则之间的语义包含）', () => {
  const prefix = (value, tool = 'pwsh') => ({ tool, match: { kind: 'command_prefix', value } })
  const exact = (value, tool = 'pwsh') => ({ tool, match: { kind: 'signature', value } })
  const pathPrefix = (value, tool = 'write') => ({ tool, match: { kind: 'path_prefix', value } })

  it('命令前缀覆盖更长的前缀（含只差尾部空格的同义前缀），忽略大小写', () => {
    // 「pnpm test」与「pnpm test 」（模型生成的规则文本常差一个尾部空格）是同一个范围
    expect(ruleCovers(prefix('pnpm test'), prefix('pnpm test '))).toBe(true)
    expect(ruleCovers(prefix('pnpm test'), prefix('PNPM test 2>&1'))).toBe(true)
    expect(ruleCovers(prefix('pnpm test'), prefix('pnpm test'))).toBe(true)
    // 词边界：更长的前缀必须从分隔符接上，否则不算被覆盖
    expect(ruleCovers(prefix('pnpm test'), prefix('pnpm testing'))).toBe(false)
    // 反向不成立：更长的前缀不覆盖更短的前缀
    expect(ruleCovers(prefix('pnpm test 2>&1'), prefix('pnpm test'))).toBe(false)
  })

  it('命令前缀覆盖同一命令的精确签名，但不认非命令类签名', () => {
    const test = pwshSignature('pnpm test 2>&1 | Select-Object -Last 12')
    expect(ruleCovers(prefix('pnpm test'), exact(test.key))).toBe(true)
    expect(ruleCovers(prefix('pnpm test'), exact(pwshSignature('git status').key))).toBe(false)
    // 写文件这类签名是 args: 形态，取不出命令，判不出来就一律不算覆盖
    const write = signatureOf({ toolName: 'write' }, { arguments: { file_path: 'D:/repo/a.js' } })
    expect(ruleCovers({ tool: 'write', match: { kind: 'command_prefix', value: 'pnpm test' } }, exact(write.key, 'write'))).toBe(false)
  })

  it('路径前缀按目录边界覆盖，不误伤兄弟目录', () => {
    expect(ruleCovers(pathPrefix('D:/repo/src'), pathPrefix('D:/repo/src/a'))).toBe(true)
    expect(ruleCovers(pathPrefix('D:/repo/src'), pathPrefix('D:/repo/src'))).toBe(true)
    expect(ruleCovers(pathPrefix('D:/repo/src'), pathPrefix('D:/repo/src-old'))).toBe(false)
  })

  it('工具不同、条件种类无法比较、缺字段时一律返回 false', () => {
    expect(ruleCovers(prefix('pnpm test', 'bash'), prefix('pnpm test'))).toBe(false)
    expect(ruleCovers(prefix('pnpm test'), pathPrefix('D:/repo'))).toBe(false)
    expect(ruleCovers(exact('k'), prefix('pnpm test'))).toBe(false)
    expect(ruleCovers(null, prefix('pnpm test'))).toBe(false)
    expect(ruleCovers({ tool: 'pwsh' }, prefix('pnpm test'))).toBe(false)
  })

  it('精确签名只覆盖同一个签名', () => {
    expect(ruleCovers(exact('a'), exact('a'))).toBe(true)
    expect(ruleCovers(exact('a'), exact('b'))).toBe(false)
  })
})

describe('policy store', () => {
  let root
  let globalFile
  let counterDir
  let cwd

  beforeEach(() => {
    root = newRoot()
    globalFile = join(root, 'home', 'policy.json')
    counterDir = join(root, 'home', 'counters')
    cwd = join(root, 'project')
  })

  function store(options = {}) {
    return createPolicyStore({ globalFile, counterDir, warn: () => {}, ...options })
  }

  it('项目规则落在项目目录，全局规则落在全局文件，且能重新读回', () => {
    const first = store()
    const signature = pwshSignature('git status')
    expect(first.addRule(signatureRule('project', 'allow', signature), cwd).scope).toBe('project')
    expect(first.addRule(signatureRule('global', 'allow', signature), cwd).scope).toBe('global')

    const projectFile = projectPolicyFile(cwd)
    expect(JSON.parse(readFileSync(projectFile, 'utf8')).rules.allow).toHaveLength(1)
    expect(JSON.parse(readFileSync(globalFile, 'utf8')).rules.allow).toHaveLength(1)

    // 新实例（模拟重启）读回同样的规则
    const second = store()
    expect(second.snapshot(cwd).project.allow).toHaveLength(1)
    expect(second.match({ signature, cwd }).scope).toBe('project')
  })

  it('黑名单压过白名单，项目压过全局', () => {
    const instance = store()
    const signature = pwshSignature('rm -rf build')
    instance.addRule(signatureRule('global', 'allow', signature), cwd)
    instance.addRule(signatureRule('project', 'deny', signature), cwd)
    const hit = instance.match({ signature, cwd })
    expect(hit.list).toBe('deny')
    expect(hit.scope).toBe('project')
  })

  it('同工具同条件重复升级只保留一条并更新内容，且如实回报 replaced', () => {
    const instance = store()
    const signature = pwshSignature('git status')
    // 第一次是新增，第二次命中同一条规则 = 更新（客户端据此提示「已更新」而不是「已加入」）
    expect(instance.addRule(signatureRule('global', 'allow', signature, { note: 'a' }), cwd).replaced).toBe(false)
    const second = instance.addRule(signatureRule('global', 'allow', signature, { note: 'b' }), cwd)
    expect(second.replaced).toBe(true)
    const rules = instance.snapshot(cwd).global.allow
    expect(rules).toHaveLength(1)
    expect(rules[0].note).toBe('b')
    // 不同名单互不干扰：同条件加进黑名单是新的一条，不是更新
    expect(instance.addRule(signatureRule('global', 'deny', signature), cwd).replaced).toBe(false)
    expect(instance.snapshot(cwd).global.deny).toHaveLength(1)
  })

  it('只差尾部空格（模型文本抖动）的同义规则按同一条更新，不会留下两条', () => {
    const instance = store()
    const prefixRule = value => ({
      scope: 'global',
      list: 'allow',
      rule: { tool: 'pwsh', label: '跑测试', match: { kind: 'command_prefix', value } },
    })
    expect(instance.addRule(prefixRule('pnpm test'), cwd).replaced).toBe(false)
    // 真机踩过的坑：模型第二次给的是「pnpm test 」（尾部多一个空格），旧代码按字符串比对判不出重复
    const second = instance.addRule(prefixRule('pnpm test '), cwd)
    expect(second.replaced).toBe(true)
    expect(second.covered).toBe(false)
    expect(instance.snapshot(cwd).global.allow).toHaveLength(1)
    // 大小写同样归一：匹配器本来就忽略大小写，名单里也不该出现两条
    expect(instance.addRule(prefixRule('PNPM TEST'), cwd).replaced).toBe(true)
    expect(instance.snapshot(cwd).global.allow).toHaveLength(1)
  })

  it('已被更宽的规则覆盖时不重复写入，回报 covered 并指向那条规则', () => {
    const instance = store()
    const wide = instance.addRule({
      scope: 'global',
      list: 'allow',
      rule: { tool: 'pwsh', label: '跑测试', match: { kind: 'command_prefix', value: 'pnpm test' } },
    }, cwd)
    // 精确签名（同一个动作）本来就在那条前缀规则的范围里：不该再写一条
    const added = instance.addRule(signatureRule('global', 'allow', pwshSignature('pnpm test 2>&1 | Select-Object -Last 12')), cwd)
    expect(added.covered).toBe(true)
    expect(added.replaced).toBe(false)
    expect(added.rule.id).toBe(wide.rule.id)
    const rules = instance.snapshot(cwd).global.allow
    expect(rules).toHaveLength(1)
    expect(rules[0].match).toEqual({ kind: 'command_prefix', value: 'pnpm test' })
  })

  it('新规则覆盖了更窄的旧规则时合并掉窄规则，只留一条', () => {
    const instance = store()
    const narrow = instance.addRule(signatureRule('global', 'allow', pwshSignature('pnpm test 2>&1 | Select-Object -Last 12')), cwd)
    const added = instance.addRule({
      scope: 'global',
      list: 'allow',
      rule: { tool: 'pwsh', label: '跑测试', match: { kind: 'command_prefix', value: 'pnpm test' } },
    }, cwd)
    expect(added.covered).toBe(false)
    expect(added.replaced).toBe(false)
    expect(added.merged).toBe(1)
    const rules = instance.snapshot(cwd).global.allow
    expect(rules).toHaveLength(1)
    expect(rules[0].id).not.toBe(narrow.rule.id)
    expect(rules[0].match.kind).toBe('command_prefix')
    // 合并是落盘的：新实例（模拟重启）看到的同样只有一条
    expect(store().snapshot(cwd).global.allow).toHaveLength(1)
  })

  it('项目与全局两级各自查重，互不干扰', () => {
    const instance = store()
    const prefixRule = scope => ({
      scope,
      list: 'allow',
      rule: { tool: 'pwsh', label: '跑测试', match: { kind: 'command_prefix', value: 'pnpm test' } },
    })
    expect(instance.addRule(prefixRule('project'), cwd).replaced).toBe(false)
    // 全局是新的一条（同一份规则加到全局 = 放宽到所有项目，不是重复）
    const global = instance.addRule(prefixRule('global'), cwd)
    expect(global.replaced).toBe(false)
    expect(global.covered).toBe(false)
    expect(instance.snapshot(cwd).project.allow).toHaveLength(1)
    expect(instance.snapshot(cwd).global.allow).toHaveLength(1)
  })

  it('签名按逐字比对：参数里只差空白的两条签名不会被当成同一条', () => {
    const instance = store()
    const ruleFor = key => ({
      scope: 'global',
      list: 'allow',
      rule: { tool: 'write', label: '写文件', match: { kind: 'signature', value: key } },
    })
    // 前缀类条件要折叠空白/大小写，但签名是机器产出的精确 key：折叠会把两条不同签名
    // 判成同一条，替换掉旧规则就等于让那条签名失去覆盖（审批面变大）
    expect(instance.addRule(ruleFor('write\u0000args:{"content":"a b"}'), cwd).replaced).toBe(false)
    const second = instance.addRule(ruleFor('write\u0000args:{"content":"a  b"}'), cwd)
    expect(second.replaced).toBe(false)
    expect(second.covered).toBe(false)
    expect(instance.snapshot(cwd).global.allow).toHaveLength(2)
  })

  it('updateRule 按 id 原地更新匹配条件与标签，id 不变、立刻生效', () => {
    const instance = store()
    const added = instance.addRule({
      scope: 'project',
      list: 'allow',
      rule: {
        tool: 'pwsh',
        label: '运行 policy.spec.js 单测',
        match: { kind: 'command_prefix', value: 'pnpm vitest run tests/policy.spec.js' },
      },
    }, cwd)
    const updated = instance.updateRule({
      scope: 'project',
      list: 'allow',
      id: added.rule.id,
      rule: { tool: 'pwsh', label: '运行测试套件', match: { kind: 'command_prefix', value: 'pnpm test' } },
    }, cwd)
    expect(updated.ok).toBe(true)
    // id 不变：记录/时间线里的 ruleId 仍指得回来；来源如实改成「手动」
    expect(updated.rule.id).toBe(added.rule.id)
    expect(updated.rule.source).toBe('user')
    expect(updated.rule.label).toBe('运行测试套件')
    expect(updated.rule.match).toEqual({ kind: 'command_prefix', value: 'pnpm test' })
    const rules = instance.snapshot(cwd).project.allow
    expect(rules).toHaveLength(1)
    expect(rules[0].match.value).toBe('pnpm test')
    // 落盘 + 立刻生效：改宽之后原先命不中的动作也能命中
    expect(store().snapshot(cwd).project.allow[0].label).toBe('运行测试套件')
    expect(instance.match({ signature: pwshSignature('pnpm test 2>&1'), cwd })?.list).toBe('allow')
  })

  it('updateRule 改完与另一条同义时合并掉那条，名单里不留两条', () => {
    const instance = store()
    const prefixRule = value => ({
      scope: 'project',
      list: 'allow',
      rule: { tool: 'pwsh', label: value, match: { kind: 'command_prefix', value } },
    })
    instance.addRule(prefixRule('pnpm test'), cwd)
    const second = instance.addRule(prefixRule('pnpm vitest run tests/policy.spec.js'), cwd)
    // 把第二条改成与第一条同义（只差一个尾部空格）：归一化后同值 → 合并
    const updated = instance.updateRule({
      scope: 'project',
      list: 'allow',
      id: second.rule.id,
      rule: { tool: 'pwsh', label: '改名后的规则', match: { kind: 'command_prefix', value: 'pnpm test ' } },
    }, cwd)
    expect(updated.ok).toBe(true)
    expect(updated.replaced).toBe(true)
    const rules = instance.snapshot(cwd).project.allow
    expect(rules).toHaveLength(1)
    expect(rules[0].id).toBe(second.rule.id)
  })

  it('updateRule 找不到 id 或条件非法时如实报错，不动盘', () => {
    const instance = store()
    const added = instance.addRule({
      scope: 'project',
      list: 'allow',
      rule: { tool: 'pwsh', label: 'x', match: { kind: 'signature', value: 'k' } },
    }, cwd)
    const missing = instance.updateRule({
      scope: 'project', list: 'allow', id: 'nope',
      rule: { tool: 'pwsh', label: 'x', match: { kind: 'signature', value: 'k' } },
    }, cwd)
    expect(missing.ok).toBe(false)
    const invalid = instance.updateRule({
      scope: 'project', list: 'allow', id: added.rule.id,
      rule: { tool: 'pwsh', label: 'x', match: { kind: 'regex', value: '.*' } },
    }, cwd)
    expect(invalid.ok).toBe(false)
    const badScope = instance.updateRule({
      scope: 'nope', list: 'allow', id: added.rule.id,
      rule: { tool: 'pwsh', label: 'x', match: { kind: 'signature', value: 'k' } },
    }, cwd)
    expect(badScope.ok).toBe(false)
    expect(instance.snapshot(cwd).project.allow).toHaveLength(1)
    expect(instance.snapshot(cwd).project.allow[0].label).toBe('x')
  })

  it('removeRule 按 id 删除并落盘', () => {
    const instance = store()
    const signature = pwshSignature('git status')
    const added = instance.addRule(signatureRule('global', 'allow', signature), cwd)
    expect(instance.removeRule({ scope: 'global', list: 'allow', id: added.rule.id }, cwd)).toBe(true)
    expect(instance.removeRule({ scope: 'global', list: 'allow', id: added.rule.id }, cwd)).toBe(false)
    expect(store().snapshot(cwd).global.allow).toHaveLength(0)
  })

  it('项目目录不可写时降级写全局，并如实回报作用域', () => {
    const instance = store()
    // 把 cwd 指向一个「文件」，则 <cwd>/.dsh-auto-pass 无法创建
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'x', 'utf8')
    const signature = pwshSignature('git status')
    const added = instance.addRule(signatureRule('project', 'allow', signature), blocker)
    expect(added.ok).toBe(true)
    expect(added.scope).toBe('global')
    expect(instance.snapshot(blocker).global.allow).toHaveLength(1)
  })

  it('两侧阈值可读写，非法值被忽略', () => {
    const file = join(root, 'home', 'policy.json')
    const counterDir = join(root, 'home', 'counters')
    const instance = createPolicyStore({ globalFile: file, counterDir, warn: () => {}, autoApproveAfter: 3, autoDenyAfter: 3 })
    expect(instance.threshold()).toBe(3)
    expect(instance.threshold('deny')).toBe(3)
    expect(instance.setThreshold(5)).toBe(5)
    expect(instance.setThreshold(4, 'deny')).toBe(4)
    // 阈值是用户偏好：重启后从全局文件读回
    const reopened = createPolicyStore({ globalFile: file, counterDir, warn: () => {} })
    expect(reopened.threshold()).toBe(5)
    expect(reopened.threshold('deny')).toBe(4)
    expect(instance.setThreshold(0)).toBe(5)
    expect(instance.setThreshold(0, 'deny')).toBe(4)
    // 早期版本只有一个 threshold 字段，按白名单阈值兼容读取
    writeFileSync(file, JSON.stringify({ version: 1, rules: { allow: [], deny: [] }, counters: {}, threshold: 7 }), 'utf8')
    expect(createPolicyStore({ globalFile: file, counterDir, warn: () => {} }).threshold()).toBe(7)
  })
})

describe('observe（连续计数与升级建议）', () => {
  let root
  let cwd
  let signature

  beforeEach(() => {
    root = newRoot()
    cwd = join(root, 'project')
    signature = pwshSignature('git status')
  })

  function store(threshold = 3, denyThreshold = 3) {
    return createPolicyStore({
      globalFile: join(root, 'home', 'policy.json'),
      counterDir: join(root, 'home', 'counters'),
      warn: () => {},
      autoApproveAfter: threshold,
      autoDenyAfter: denyThreshold,
    })
  }

  it('连续放行达到阈值时只给出建议，不落任何规则', () => {
    const instance = store(3)
    for (let index = 0; index < 2; index += 1) {
      const seen = instance.observe({ signature, cwd, signal: 'pass' })
      expect(seen.suggestion).toBeNull()
      expect(seen.approvals).toBe(index + 1)
    }
    const triggered = instance.observe({ signature, cwd, signal: 'pass' })
    expect(triggered.suggestion).toEqual({ list: 'allow', count: 3 })
    // 关键性质：建议不是规则——没有经过模型优化与用户确认，绝不落盘
    expect(instance.snapshot(cwd).global.allow).toHaveLength(0)
    expect(instance.match({ signature, cwd })).toBeUndefined()
    // 触发后计数清零：同一次累积不会被重复触发
    expect(instance.observe({ signature, cwd, signal: 'pass' }).approvals).toBe(1)
  })

  it('同一条命令的不同管道变体算同一类：连续放行照样攒够阈值', () => {
    // 用户真实场景：每次都是同一条 pnpm vitest run，只是输出截断从 -Last 60 变成 -Last 30
    const instance = store(2)
    const first = pwshSignature('pnpm vitest run tests/client.spec.js 2>&1 | Select-Object -Last 60')
    const second = pwshSignature('pnpm vitest run tests/client.spec.js 2>&1 | Select-Object -Last 30')
    expect(instance.observe({ signature: first, cwd, signal: 'pass' }).suggestion).toBeNull()
    expect(instance.observe({ signature: second, cwd, signal: 'pass' }).suggestion)
      .toEqual({ list: 'allow', count: 2 })
  })

  it('连续被拒达到阈值时给出黑名单建议', () => {
    const instance = store(3, 2)
    expect(instance.observe({ signature, cwd, signal: 'reject' }).denials).toBe(1)
    const triggered = instance.observe({ signature, cwd, signal: 'reject' })
    expect(triggered.suggestion).toEqual({ list: 'deny', count: 2 })
  })

  it('相反信号打断另一侧的连续', () => {
    const instance = store(3)
    instance.observe({ signature, cwd, signal: 'pass' })
    instance.observe({ signature, cwd, signal: 'pass' })
    const rejected = instance.observe({ signature, cwd, signal: 'reject' })
    expect(rejected.approvals).toBe(0)
    expect(rejected.denials).toBe(1)
    expect(instance.observe({ signature, cwd, signal: 'pass' }).approvals).toBe(1)
  })

  it('dismiss 之后既不再计数，也不再给出建议', () => {
    const instance = store(1)
    expect(instance.observe({ signature, cwd, signal: 'pass' }).suggestion.list).toBe('allow')
    expect(instance.dismiss({ signature, cwd, list: 'allow' })).toBe(true)
    const seen = instance.observe({ signature, cwd, signal: 'pass' })
    expect(seen.approvals).toBe(0)
    expect(seen.suggestion).toBeNull()
    // 另一侧不受影响
    expect(instance.observe({ signature, cwd, signal: 'reject' }).suggestion).toBeNull()
  })

  it('没有签名或没有信号时不计数', () => {
    const instance = store(5)
    expect(instance.observe({ signature: undefined, cwd, signal: 'pass' }).suggestion).toBeNull()
    expect(instance.observe({ signature, cwd, signal: undefined }).suggestion).toBeNull()
    expect(instance.observe({ signature, cwd, signal: 'pass' }).approvals).toBe(1)
  })

  it('只有噪声参数不同时归到同一个计数（记忆键）', () => {
    const instance = store(2)
    const first = pwshSignature('pnpm test', { justification: '理由一' })
    const second = pwshSignature('pnpm test', { justification: '理由二' })
    expect(instance.observe({ signature: first, cwd, signal: 'pass' }).suggestion).toBeNull()
    expect(instance.observe({ signature: second, cwd, signal: 'pass' }).suggestion).toEqual({ list: 'allow', count: 2 })
  })

  it('不同项目各自计数，互不影响', () => {
    const instance = store(2)
    const other = join(root, 'other')
    instance.observe({ signature, cwd, signal: 'pass' })
    expect(instance.observe({ signature, cwd: other, signal: 'pass' }).suggestion).toBeNull()
    expect(instance.observe({ signature, cwd, signal: 'pass' }).suggestion).not.toBeNull()
  })
})

describe('计数文件（按工作区拆分 / 清理 / 上限）', () => {
  let root
  let cwd
  let other
  let policyFile
  let counterDir
  let counterFile

  /** 计数文件里的键：裸 memoryKey。 */
  const entryKey = name => 'pwsh\u0000cmd:' + name + '\u0000x:{}'

  beforeEach(() => {
    root = newRoot()
    cwd = join(root, 'project')
    other = join(root, 'other')
    policyFile = join(root, 'home', 'policy.json')
    counterDir = join(root, 'home', 'counters')
    counterFile = join(counterDir, workspaceSlug(cwd) + '.json')
  })

  function store(options = {}) {
    return createPolicyStore({ globalFile: policyFile, counterDir, warn: () => {}, ...options })
  }

  /** 预置一份计数文件（父目录由仓库自己建，这里手动补齐）。 */
  function seed(counters, target = counterFile) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify({ version: 1, counters }), 'utf8')
    return target
  }

  it('启动时整理已有计数文件：折算历史键并清掉死条目', () => {
    const current = pwshSignature('pnpm test 2>&1')
    const legacy = 'pwsh\u0000cmd:pnpm test 2>&1 | Select-Object -Last 30\u0000x:{"workdir":"D:/w"}'
    seed({ [legacy]: { allow: 2, deny: 0 }, [entryKey('dead')]: { allow: 0, deny: 0 } })
    const info = vi.fn()
    store({ info })
    expect(info).toHaveBeenCalledWith(expect.stringContaining('已整理 1 个计数文件'))
    const persisted = JSON.parse(readFileSync(counterFile, 'utf8'))
    expect(Object.keys(persisted.counters)).toEqual([current.memoryKey])
    expect(persisted.counters[current.memoryKey]).toEqual({ allow: 2, deny: 0 })
  })

  it('observe 只写本工作区的计数文件（带最后更新时刻），计数不再进策略文件', () => {
    const signature = pwshSignature('git status')
    store().observe({ signature, cwd, signal: 'pass' })
    const entry = JSON.parse(readFileSync(counterFile, 'utf8')).counters[signature.memoryKey]
    expect(entry).toMatchObject({ allow: 1, deny: 0 })
    expect(typeof entry.at).toBe('number')
    // 计数不再进策略文件：observe 之后它甚至不该被创建
    const policyText = existsSync(policyFile) ? readFileSync(policyFile, 'utf8') : ''
    expect(policyText).not.toContain('counters')
  })

  it('不同工作区各写各的计数文件，互不牵连', () => {
    const signature = pwshSignature('git status')
    const instance = store()
    instance.observe({ signature, cwd, signal: 'pass' })
    instance.observe({ signature, cwd: other, signal: 'pass' })
    const otherFile = join(counterDir, workspaceSlug(other) + '.json')
    expect(Object.keys(JSON.parse(readFileSync(counterFile, 'utf8')).counters)).toEqual([signature.memoryKey])
    expect(JSON.parse(readFileSync(otherFile, 'utf8')).counters[signature.memoryKey]).toMatchObject({ allow: 1 })
  })

  it('超过上限时淘汰最久未用的活动条目', () => {
    const signature = pwshSignature('git status')
    const counters = {}
    for (let index = 0; index < DEFAULT_MAX_COUNTERS; index += 1) {
      counters[entryKey('cmd-' + String(index))] = { allow: 1, deny: 0, at: index + 1 }
    }
    seed(counters)
    const info = vi.fn()
    store({ info }).observe({ signature, cwd, signal: 'pass' })
    const persisted = Object.keys(JSON.parse(readFileSync(counterFile, 'utf8')).counters)
    expect(persisted).toHaveLength(DEFAULT_MAX_COUNTERS)
    expect(persisted).toContain(signature.memoryKey)
    expect(persisted).not.toContain(entryKey('cmd-0'))
    expect(info).toHaveBeenCalledWith(expect.stringContaining('已清理 1 个计数条目'))
  })

  it('同为最旧时，dismissed 条目比活动条目更晚被淘汰', () => {
    const signature = pwshSignature('git status')
    const dismissed = entryKey('rm -rf')
    const counters = { [dismissed]: { allow: 0, deny: 0, dismissed: { deny: true }, at: 1 } }
    for (let index = 1; index < DEFAULT_MAX_COUNTERS; index += 1) {
      counters[entryKey('cmd-' + String(index))] = { allow: 1, deny: 0, at: index + 1 }
    }
    seed(counters)
    store().observe({ signature, cwd, signal: 'pass' })
    const persisted = Object.keys(JSON.parse(readFileSync(counterFile, 'utf8')).counters)
    expect(persisted).toContain(dismissed)
    expect(persisted).not.toContain(entryKey('cmd-1'))
    expect(persisted).toHaveLength(DEFAULT_MAX_COUNTERS)
  })
})

