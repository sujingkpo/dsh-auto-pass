/**
 * @description 策略引擎单测：签名归一化、三种匹配条件的边界、白黑名单优先级、
 *   连续放行自动升级、阈值与落盘往返、项目目录不可写时降级写全局。
 * @author simon300000
 * @date 2026-09-15
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createPolicyStore,
  matchRule,
  MIN_PREFIX_CHARS,
  normalizePath,
  projectPolicyFile,
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

  it('拒绝未知匹配条件、空标签与过短前缀', () => {
    expect(validateRuleInput({ tool: 'pwsh', label: 'x', match: { kind: 'regex', value: '.*' } }).ok).toBe(false)
    expect(validateRuleInput({ tool: 'pwsh', label: '', match: { kind: 'signature', value: 'k' } }).ok).toBe(false)
    expect(validateRuleInput({ tool: 'pwsh', label: 'x', match: { kind: 'command_prefix', value: 'gi' } }).ok).toBe(false)
    expect(validateRuleInput(null).ok).toBe(false)
  })
})

describe('policy store', () => {
  let root
  let globalFile
  let cwd

  beforeEach(() => {
    root = newRoot()
    globalFile = join(root, 'home', 'policy.json')
    cwd = join(root, 'project')
  })

  function store(options = {}) {
    return createPolicyStore({ globalFile, warn: () => {}, ...options })
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

  it('同工具同条件重复升级只保留一条并更新内容', () => {
    const instance = store()
    const signature = pwshSignature('git status')
    instance.addRule(signatureRule('global', 'allow', signature, { note: 'a' }), cwd)
    instance.addRule(signatureRule('global', 'allow', signature, { note: 'b' }), cwd)
    const rules = instance.snapshot(cwd).global.allow
    expect(rules).toHaveLength(1)
    expect(rules[0].note).toBe('b')
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

  it('阈值可读写，非法值被忽略', () => {
    const instance = store()
    expect(instance.threshold()).toBe(3)
    expect(instance.setThreshold(5)).toBe(5)
    expect(store().threshold()).toBe(5)
    expect(instance.setThreshold(0)).toBe(5)
  })
})

describe('observe（记忆与自动升级）', () => {
  let root
  let cwd
  let signature

  beforeEach(() => {
    root = newRoot()
    cwd = join(root, 'project')
    signature = pwshSignature('git status')
  })

  function store(threshold = 3) {
    return createPolicyStore({ globalFile: join(root, 'home', 'policy.json'), warn: () => {}, autoApproveAfter: threshold })
  }

  it('连续人工放行达到阈值后升级为项目级免审查规则', () => {
    const instance = store(3)
    for (let index = 0; index < 2; index += 1) {
      const seen = instance.observe({ signature, cwd, outcome: 'allowed-once', fromHuman: true })
      expect(seen.promoted).toBeNull()
      expect(seen.approvals).toBe(index + 1)
    }
    const promoted = instance.observe({ signature, cwd, outcome: 'allowed-once', fromHuman: true })
    expect(promoted.promoted).not.toBeNull()
    expect(promoted.promoted.source).toBe('memory')
    expect(promoted.promoted.match.kind).toBe('signature')
    expect(instance.match({ signature, cwd }).scope).toBe('project')
    // 升级后计数清零：再放行一次要重新从 1 开始
    expect(instance.observe({ signature, cwd, outcome: 'allowed-once', fromHuman: true }).approvals).toBe(1)
  })

  it('人工拒绝把连续计数清零', () => {
    const instance = store(3)
    instance.observe({ signature, cwd, outcome: 'allowed-once', fromHuman: true })
    instance.observe({ signature, cwd, outcome: 'allowed-once', fromHuman: true })
    expect(instance.observe({ signature, cwd, outcome: 'rejected', fromHuman: true }).approvals).toBe(0)
    expect(instance.observe({ signature, cwd, outcome: 'allowed-once', fromHuman: true }).approvals).toBe(1)
  })

  it('插件自己的自动放行（fromHuman=false）不计数', () => {
    const instance = store(2)
    expect(instance.observe({ signature, cwd, outcome: 'allowed-once', fromHuman: false }).approvals).toBe(0)
    expect(instance.snapshot(cwd).global.allow).toHaveLength(0)
  })

  it('不同项目各自计数，互不影响', () => {
    const instance = store(2)
    const other = join(root, 'other')
    instance.observe({ signature, cwd, outcome: 'allowed-once', fromHuman: true })
    expect(instance.observe({ signature, cwd: other, outcome: 'allowed-once', fromHuman: true }).promoted).toBeNull()
    expect(instance.observe({ signature, cwd, outcome: 'allowed-once', fromHuman: true }).promoted).not.toBeNull()
  })

  it('没有工作目录时升级为全局规则', () => {
    const instance = store(1)
    const promoted = instance.observe({ signature, cwd: undefined, outcome: 'allowed-once', fromHuman: true })
    expect(promoted.promoted.scope).toBe('global')
  })
})
