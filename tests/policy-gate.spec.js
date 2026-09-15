/**
 * @description 名单与权限记忆的链路测试：白名单直接放行、黑名单直接转人工、
 *   连续人工放行达阈值自动升级、插件自身自动放行不计数，以及升级/降级规则
 *   （模型建议优先）与 /api/dsh-auto-pass/policy、/rule 两条 HTTP 入口。
 * @author simon300000
 * @date 2026-09-15
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  createAutoApprovalHandler,
  exactAction,
  parseSuggestedRule,
  POLICY_PATH,
  resolveConfig,
  ruleFromRecord,
  RULE_PATH,
} from '../src/index.js'
import { createPolicyStore } from '../src/policy.js'
import { signatureOf } from '../src/policy.js'

const tempDirs = []

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auto-pass-gate-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true })
})

function event(type, data, seq) {
  return { type, data, seq, time: seq }
}

/** 一条 bash 工具调用 + 对应会话；参数刻意用 JSON 字符串，覆盖「事件里存字符串」的形态。 */
function sessionWith(options = {}) {
  const cwd = options.cwd ?? '/workspace'
  const command = options.command ?? 'npm test'
  const events = [
    event('permission/preset', { preset: 'auto-approve' }, 0),
    event('user/message', {
      id: 'user-1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '请运行测试' }],
    }, 1),
    event('tool/call', {
      turn: 1,
      step: 1,
      callId: options.callId ?? 'call-1',
      name: 'bash',
      arguments: JSON.stringify({ command, ...(options.extraArguments ?? {}) }),
    }, 2),
  ]
  return {
    id: 'session-1',
    seq: events.length,
    eventAt: seq => events[seq],
    snapshotEvents: (from = 0, to = events.length) => Object.freeze(events.slice(from, to)),
    header: { cwd },
    // 没有审查路由：走「审查失败 → 转人工」分支，正好用来观察人工放行的计数行为。
    requestHeader: () => ({ config: {}, system: 'MAIN SYSTEM' }),
  }
}

function requestWith(options = {}) {
  const session = sessionWith(options)
  return {
    agent: { session, options: {}, inject: vi.fn(), cancel: vi.fn() },
    toolName: 'bash',
    callId: options.callId ?? 'call-1',
    reason: 'escalate sandbox',
  }
}

function contextWith(runs = [], options = {}) {
  const queue = [...runs]
  return {
    subagents: { start: vi.fn().mockImplementation(() => Promise.resolve(queue.shift())) },
    get: vi.fn(name => name === 'sandboxPolicy'
      ? { resolve: () => ({ mode: 'workspace-write' }) }
      : name === 'approval'
        ? { config: { policy: 'ask' }, overrideOf: () => undefined }
        : name === 'userQuestions' ? options.userQuestions : undefined),
    logger: { info: vi.fn(), warn: vi.fn() },
  }
}

/** 规则询问是旁路的：等它走完再断言（真实运行时它不阻塞审批结论）。 */
async function flush(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function reviewerRun(structured) {
  return {
    id: 'reviewer-session-1',
    localAgent: { session: { snapshotEvents: () => [event('step/start', { turn: 1, step: 1 }, 0)] } },
    result: Promise.resolve({ stopReason: 'completed', structured, output: [] }),
    dispose: vi.fn().mockResolvedValue(undefined),
  }
}

/** Reviewer 判定放行。 */
function allowRun() {
  return reviewerRun({ risk_level: 'low', user_authorization: 'high', outcome: 'allow', rationale: '用户明确要求。' })
}

/** Reviewer 判定拒绝。 */
function denyRun() {
  return reviewerRun({ risk_level: 'high', user_authorization: 'low', outcome: 'deny', rationale: '这条命令风险过高。' })
}

/** 规则优化调用：返回优化后的匹配条件（不是审查结论）。 */
function ruleRun(matchValue = 'npm test') {
  return reviewerRun({ tool: 'bash', match_kind: 'command_prefix', match_value: matchValue, label: 'npm 测试命令' })
}

function policyStore(root, autoApproveAfter, autoDenyAfter) {
  return createPolicyStore({ globalFile: join(root, 'home', 'policy.json'), autoApproveAfter, autoDenyAfter, warn: () => {} })
}

/** 用插件自己的归一化生成「精确签名规则」，保证测试和实现同源。 */
function signatureRuleFor(request, scope, list) {
  const signature = signatureOf(request, exactAction(request))
  return {
    scope,
    list,
    rule: { tool: 'bash', match: { kind: 'signature', value: signature.key }, label: signature.text },
  }
}

describe('签名归一化的健壮性', () => {
  it('JSON 字符串参数会被解析，不同命令得到不同签名', () => {
    const first = signatureOf(requestWith({ command: 'npm test' }), exactAction(requestWith({ command: 'npm test' })))
    const second = signatureOf(requestWith({ command: 'npm run build' }), exactAction(requestWith({ command: 'npm run build' })))
    expect(first.command).toBe('npm test')
    expect(first.key).not.toBe(second.key)
  })

  it('非 JSON 的字符串参数退化为「整段文本就是命令」而不是空签名', () => {
    const request = requestWith()
    const action = { toolName: 'bash', callId: 'call-1', arguments: 'npm test --silent' }
    expect(signatureOf(request, action).command).toBe('npm test --silent')
  })
})

describe('白名单与黑名单', () => {
  it('白名单命中直接放行，既不调用人工链也不启动 Reviewer', async () => {
    const root = tempDir()
    const policies = policyStore(root)
    const request = requestWith()
    expect(policies.addRule(signatureRuleFor(request, 'global', 'allow'), undefined).ok).toBe(true)

    const ctx = contextWith()
    const next = vi.fn().mockResolvedValue('rejected')
    const outcome = await createAutoApprovalHandler(ctx, resolveConfig(), undefined, policies)(request, next)

    expect(outcome).toBe('allowed-once')
    expect(next).not.toHaveBeenCalled()
    expect(ctx.subagents.start).not.toHaveBeenCalled()
    // 通知的折叠标题与正文都带「名单·自动」标签
    const notice = request.agent.inject.mock.calls.at(-1)[0]
    expect(notice.source.summary).toContain('[白名单·自动]')
    expect(notice.content[0].text.startsWith('[白名单·自动]')).toBe(true)
  })

  it('黑名单命中直接转人工，且不启动 Reviewer', async () => {
    const root = tempDir()
    const policies = policyStore(root)
    const request = requestWith()
    expect(policies.addRule(signatureRuleFor(request, 'global', 'deny'), undefined).ok).toBe(true)

    const ctx = contextWith()
    const next = vi.fn().mockResolvedValue('rejected')
    const outcome = await createAutoApprovalHandler(ctx, resolveConfig(), undefined, policies)(request, next)

    expect(outcome).toBe('rejected')
    expect(next).toHaveBeenCalledOnce()
    expect(ctx.subagents.start).not.toHaveBeenCalled()
  })

  it('白名单命中的记录写清命中的是哪一侧与哪条规则（时间线据此显示白名单）', async () => {
    const root = tempDir()
    const policies = policyStore(root)
    const request = requestWith()
    expect(policies.addRule(signatureRuleFor(request, 'global', 'allow'), undefined).ok).toBe(true)

    const records = { add: vi.fn(), list: () => [], size: () => 0 }
    const outcome = await createAutoApprovalHandler(contextWith(), resolveConfig(), records, policies)(
      request, vi.fn().mockResolvedValue('allowed-once'))

    expect(outcome).toBe('allowed-once')
    expect(records.add).toHaveBeenCalledOnce()
    const record = records.add.mock.calls[0][0]
    expect(record.verdict).toBe('allow')
    expect(record.steps).toBe(0)
    expect(record.policy.list).toBe('allow')
    expect(record.policy.scope).toBe('global')
    expect(record.policy.label).toContain('npm test')
    // 规则来源一并写进记录：时间线在命中 chip 里显示 自动 / 手动
    expect(record.policy.source).toBe('user')
  })

  it('黑名单命中的记录同样带上命中信息，结论是交给人工链', async () => {
    const root = tempDir()
    const policies = policyStore(root)
    const request = requestWith()
    expect(policies.addRule(signatureRuleFor(request, 'project', 'deny'), join(root, 'project')).ok).toBe(true)

    const records = { add: vi.fn(), list: () => [], size: () => 0 }
    const outcome = await createAutoApprovalHandler(contextWith(), resolveConfig(), records, policies)(
      requestWith({ cwd: join(root, 'project') }), vi.fn().mockResolvedValue('rejected'))

    expect(outcome).toBe('rejected')
    const record = records.add.mock.calls[0][0]
    expect(record.verdict).toBe('defer')
    expect(record.policy.list).toBe('deny')
    expect(record.policy.scope).toBe('project')
    expect(record.policy.label).toContain('npm test')
  })

  it('黑名单压过白名单', async () => {
    const root = tempDir()
    const policies = policyStore(root)
    const request = requestWith()
    policies.addRule(signatureRuleFor(request, 'global', 'allow'), undefined)
    policies.addRule(signatureRuleFor(request, 'project', 'deny'), join(root, 'project'))

    const next = vi.fn().mockResolvedValue('rejected')
    const outcome = await createAutoApprovalHandler(contextWith(), resolveConfig(), undefined, policies)(
      requestWith({ cwd: join(root, 'project') }), next)
    expect(outcome).toBe('rejected')
    expect(next).toHaveBeenCalledOnce()
  })
})

describe('权限记忆（达阈值后询问用户）', () => {
  it('连续放行达到阈值后询问用户，同意才写入白名单', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const policies = policyStore(root, 2)
    const asked = []
    // 两次审查 + 一次规则优化（队列顺序即调用顺序）：审查不放行名单，规则优化产出 command_prefix 条件
    const ctx = contextWith([allowRun(), allowRun(), ruleRun()], {
      userQuestions: {
        ask: async request => {
          asked.push(request)
          return { answers: [{ id: 'dsh-auto-pass:allow', selected: ['加入白名单（本项目）'] }] }
        },
      },
    })
    const config = resolveConfig({ reviewerProvider: 'p', reviewerModel: 'm' })
    const handler = createAutoApprovalHandler(ctx, config, undefined, policies)

    // 第一次只是计数：没有询问，也没有规则
    expect(await handler(requestWith({ cwd: projectDir }), vi.fn().mockResolvedValue('allowed-once'))).toBe('allowed-once')
    await flush()
    expect(asked).toHaveLength(0)
    expect(policies.snapshot(projectDir).project.allow).toHaveLength(0)

    // 第二次达到阈值：审批结论照常返回，询问在旁路进行
    expect(await handler(requestWith({ cwd: projectDir }), vi.fn().mockResolvedValue('allowed-once'))).toBe('allowed-once')
    await flush()
    expect(asked).toHaveLength(1)
    expect(asked[0].questions[0].options.map(option => option.label)).toEqual([
      '加入白名单（本项目）',
      '加入白名单（全局）',
      '不加入（以后不再询问这类动作）',
    ])
    expect(asked[0].questions[0].question).toContain('npm test')
    // 落盘的是模型优化后的条件（不是精确签名）
    const rules = policies.snapshot(projectDir).project.allow
    expect(rules).toHaveLength(1)
    expect(rules[0].match).toEqual({ kind: 'command_prefix', value: 'npm test' })
    expect(rules[0].source).toBe('model')
    expect(JSON.parse(readFileSync(join(projectDir, '.dsh-auto-pass', 'policy.json'), 'utf8')).rules.allow).toHaveLength(1)

    // 第三次直接命中名单：连人工链都不用调
    const third = vi.fn()
    expect(await handler(requestWith({ cwd: projectDir }), third)).toBe('allowed-once')
    expect(third).not.toHaveBeenCalled()
  })

  it('人工拒绝打断连续计数', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const policies = policyStore(root, 2)
    const handler = createAutoApprovalHandler(contextWith(), resolveConfig(), undefined, policies)

    await handler(requestWith({ cwd: projectDir }), vi.fn().mockResolvedValue('allowed-once'))
    await handler(requestWith({ cwd: projectDir }), vi.fn().mockResolvedValue('rejected'))
    await handler(requestWith({ cwd: projectDir }), vi.fn().mockResolvedValue('allowed-once'))
    expect(policies.snapshot(projectDir).project.allow).toHaveLength(0)
  })

  it('插件自动放行同样计数：达到阈值一样询问，选「不加入」后不再打扰', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const policies = policyStore(root, 1)
    const request = requestWith({ cwd: projectDir })
    const signature = signatureOf(request, exactAction(request))
    const asked = []
    // 第一次审查已经给出结构化建议 → 直接沿用它，不必再单独跑一次规则优化调用
    const ctx = contextWith([
      reviewerRun({
        risk_level: 'low',
        user_authorization: 'high',
        outcome: 'allow',
        rationale: '用户明确要求。',
        rule: { tool: 'bash', match_kind: 'signature', match_value: signature.key, label: signature.text },
      }),
      allowRun(),
    ], {
      userQuestions: {
        ask: async askRequest => {
          asked.push(askRequest)
          return { answers: [{ id: 'dsh-auto-pass:allow', selected: ['不加入（以后不再询问这类动作）'] }] }
        },
      },
    })
    const config = resolveConfig({ reviewerProvider: 'p', reviewerModel: 'm' })
    const handler = createAutoApprovalHandler(ctx, config, undefined, policies)

    expect(await handler(request, vi.fn())).toBe('allowed-once')
    await flush()
    expect(asked).toHaveLength(1)
    // 选「不加入」：没有规则写进任何名单
    expect(policies.snapshot(projectDir).project.allow ?? []).toHaveLength(0)
    expect(policies.snapshot(projectDir).global.allow).toHaveLength(0)

    // 再连续放行也不会再问：同一个动作已经被用户明确拒绝过一次
    expect(await handler(requestWith({ cwd: projectDir }), vi.fn().mockResolvedValue('allowed-once'))).toBe('allowed-once')
    await flush()
    expect(asked).toHaveLength(1)
  })

  it('只换了理由与说明的同一条命令也算连续：第三次询问', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const policies = policyStore(root, 3)
    const asked = []
    const ctx = contextWith([allowRun(), allowRun(), allowRun(), ruleRun()], {
      userQuestions: {
        ask: async askRequest => {
          asked.push(askRequest)
          return { answers: [{ id: 'dsh-auto-pass:allow', selected: ['不加入（以后不再询问这类动作）'] }] }
        },
      },
    })
    const config = resolveConfig({ reviewerProvider: 'p', reviewerModel: 'm' })
    const handler = createAutoApprovalHandler(ctx, config, undefined, policies)

    // 真实场景里，同一条命令每次的 description / justification / timeoutMs 都不一样
    const drafts = [
      { description: '跑测试', justification: '沙箱下必报 EPERM' },
      { description: '再跑一次', justification: '另一段完全不同的理由' },
      { description: '跑最后一遍', justification: '第三段理由' },
    ]
    for (const draft of drafts) {
      const request = requestWith({ cwd: projectDir, extraArguments: draft })
      expect(await handler(request, vi.fn().mockResolvedValue('allowed-once'))).toBe('allowed-once')
      await flush()
    }
    expect(asked).toHaveLength(1)
    expect(asked[0].questions[0].question).toContain('连续通过 3 次')
  })

  it('连续被拒达到阈值后询问是否加入黑名单', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const policies = policyStore(root, 3, 2)
    const signature = signatureOf(requestWith({ cwd: projectDir }), exactAction(requestWith({ cwd: projectDir })))
    const asked = []
    // 两次审查都判定拒绝，第三次调用是规则优化
    const ctx = contextWith([denyRun(), denyRun(), ruleRun()], {
      userQuestions: {
        ask: async askRequest => {
          asked.push(askRequest)
          return { answers: [{ id: 'dsh-auto-pass:deny', selected: ['加入黑名单（全局）'] }] }
        },
      },
    })
    const config = resolveConfig({ reviewerProvider: 'p', reviewerModel: 'm' })
    const handler = createAutoApprovalHandler(ctx, config, undefined, policies)

    // 两次被拒（人工拒绝）后触发询问；被拒的动作本身不进人工链以外的任何名单
    await handler(requestWith({ cwd: projectDir }), vi.fn().mockResolvedValue('rejected'))
    await handler(requestWith({ cwd: projectDir }), vi.fn().mockResolvedValue('rejected'))
    await flush()
    expect(asked).toHaveLength(1)
    expect(asked[0].questions[0].options.map(option => option.label)).toContain('加入黑名单（全局）')
    const rules = policies.snapshot(projectDir).global.deny
    expect(rules).toHaveLength(1)
    expect(rules[0].match).toEqual({ kind: 'command_prefix', value: 'npm test' })
    // 于是之后的同类动作直接转人工，连模型都不叫
    const signature2 = signatureOf(requestWith({ cwd: projectDir }), exactAction(requestWith({ cwd: projectDir })))
    expect(signature2.key).toBe(signature.key)
    const next = vi.fn().mockResolvedValue('rejected')
    expect(await handler(requestWith({ cwd: projectDir }), next)).toBe('rejected')
    // Reviewer 只在前两次调用时启动：命中黑名单后连模型都不叫
    expect(ctx.subagents.start).toHaveBeenCalledTimes(3)
  })

  it('没有 userQuestions 服务时只记日志，不写任何规则', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const policies = policyStore(root, 1)
    const ctx = contextWith([allowRun()])
    const config = resolveConfig({ reviewerProvider: 'p', reviewerModel: 'm' })
    expect(await createAutoApprovalHandler(ctx, config, undefined, policies)(requestWith({ cwd: projectDir }), vi.fn())).toBe('allowed-once')
    await flush()
    expect(policies.snapshot(projectDir).project.allow ?? []).toHaveLength(0)
    expect(policies.snapshot(projectDir).global.allow).toHaveLength(0)
  })

  it('拿不到精确动作时不建立签名，不会被记忆升级', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const policies = policyStore(root, 2)
    const handler = createAutoApprovalHandler(contextWith(), resolveConfig(), undefined, policies)
    // 会话里的 tool/call 是 call-1，这里把请求的 callId 改成匹配不上的值：
    // exactAction 返回 undefined（真实场景就是「找不到待审批工具调用的精确参数」）
    const unmatched = () => {
      const request = requestWith({ cwd: projectDir })
      request.callId = 'missing-call'
      return request
    }
    for (let index = 0; index < 3; index += 1) {
      const next = vi.fn().mockResolvedValue('allowed-once')
      expect(await handler(unmatched(), next)).toBe('allowed-once')
      expect(next).toHaveBeenCalledOnce()
    }
    expect(existsSync(join(projectDir, '.dsh-auto-pass', 'policy.json'))).toBe(false)
    expect(existsSync(join(root, 'home', 'policy.json'))).toBe(false)
  })

  it('命中黑名单后的人工放行不计入连续授权', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const policies = policyStore(root, 1)
    const request = requestWith({ cwd: projectDir })
    expect(policies.addRule(signatureRuleFor(request, 'global', 'deny'), undefined).ok).toBe(true)

    const handler = createAutoApprovalHandler(contextWith(), resolveConfig(), undefined, policies)
    const next = vi.fn().mockResolvedValue('allowed-once')
    expect(await handler(requestWith({ cwd: projectDir }), next)).toBe('allowed-once')
    expect(next).toHaveBeenCalledOnce()
    // 阈值是 1：如果这次被计数，就会冒出一条记忆白名单规则
    expect(policies.snapshot(projectDir).global.allow).toHaveLength(0)
  })

  it('项目级规则写入失败时降级为全局规则（不丢用户的升级动作）', () => {
    const root = tempDir()
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'x', 'utf8')
    const policies = policyStore(root)
    const added = policies.addRule({ scope: 'project', list: 'allow', rule: { tool: 'bash', match: { kind: 'signature', value: 'k' }, label: 'l' } }, blocker)
    expect(added.ok).toBe(true)
    expect(added.scope).toBe('global')
  })
})

describe('升级/降级规则', () => {
  it('parseSuggestedRule 接受三种条件，丢弃非法建议', () => {
    expect(parseSuggestedRule({
      tool: 'bash',
      match_kind: 'command_prefix',
      match_value: 'npm test',
      label: 'npm 测试命令',
    })).toEqual({ tool: 'bash', match: { kind: 'command_prefix', value: 'npm test' }, label: 'npm 测试命令' })
    expect(parseSuggestedRule({ tool: 'bash', match_kind: 'regex', match_value: '.*', label: 'x' })).toBeUndefined()
    expect(parseSuggestedRule({ tool: 'bash', match_kind: 'command_prefix', match_value: 'n', label: 'x' })).toBeUndefined()
    expect(parseSuggestedRule(undefined)).toBeUndefined()
  })

  it('ruleFromRecord 优先用模型建议，没有建议时精确回落到本次签名', () => {
    const withSuggestion = ruleFromRecord({
      cwd: '/p',
      signature: { toolName: 'bash', key: 'k', text: 'bash: npm test' },
      suggestedRule: { tool: 'bash', match: { kind: 'command_prefix', value: 'npm test' }, label: 'npm 测试命令' },
    })
    expect(withSuggestion.match.kind).toBe('command_prefix')
    expect(withSuggestion.source).toBe('model')

    const fallback = ruleFromRecord({ cwd: '/p', signature: { toolName: 'bash', key: 'k', text: 'bash: npm test' } })
    expect(fallback.match).toEqual({ kind: 'signature', value: 'k' })
    expect(fallback.source).toBe('user')
    expect(ruleFromRecord({ cwd: '/p' })).toBeUndefined()
  })
})

describe('策略 HTTP 入口', () => {
  /** 造一个只实现 webServer 路由注册所需面的假宿主。 */
  function fakeContext(options = {}) {
    const routes = []
    return {
      routes,
      ctx: {
        logger: { info: vi.fn(), warn: vi.fn() },
        on: () => () => {},
        effect: fn => fn(),
        // 手动升级要现场起一次规则优化调用：这两个服务缺一就回落到精确签名
        ...(options.subagents === undefined ? {} : { subagents: options.subagents }),
        get: name => (name === 'agents' ? options.agents : undefined),
        inject: (names, callback) => {
          if (names.includes('webServer')) {
            callback({ effect: fn => fn(), webServer: { register: registration => { routes.push(registration); return () => {} } } })
          }
          return { dispose: () => {} }
        },
      },
    }
  }

  /** 假在册 Agent：规则优化调用只需要 session（判语言）与 options。 */
  function fakeAgent() {
    return {
      id: 'session-1',
      options: {},
      session: {
        id: 'session-1',
        seq: 0,
        snapshotEvents: () => [],
        header: { cwd: '/p' },
        requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
      },
    }
  }

  function fakeHttp(method, url, body) {
    const state = { code: 0, body: '' }
    return {
      state,
      req: {
        method,
        url,
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield Buffer.from(body, 'utf8')
        },
      },
      res: {
        writeHead(code) { state.code = code },
        end(chunk) { state.body = String(chunk ?? '') },
      },
    }
  }

  it('GET 返回阈值与两级名单，POST 能改阈值、加规则、删规则', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const { ctx, routes } = fakeContext()
    apply(ctx, { policyFile: join(root, 'home', 'policy.json'), autoApproveAfter: 4 })
    const handler = routes[0].handler

    const initial = fakeHttp('GET', POLICY_PATH + '?cwd=' + encodeURIComponent(projectDir))
    await handler(initial.req, initial.res)
    const snapshot = JSON.parse(initial.state.body)
    expect(snapshot.thresholds).toEqual({ allow: 4, deny: 3 })
    expect(snapshot.global.allow).toEqual([])
    expect(snapshot.projectFile).toContain('.dsh-auto-pass')

    const threshold = fakeHttp('POST', POLICY_PATH, JSON.stringify({ op: 'threshold', threshold: 5 }))
    await handler(threshold.req, threshold.res)
    expect(JSON.parse(threshold.state.body).threshold).toBe(5)
    const denyThreshold = fakeHttp('POST', POLICY_PATH, JSON.stringify({ op: 'threshold', list: 'deny', threshold: 6 }))
    await handler(denyThreshold.req, denyThreshold.res)
    expect(JSON.parse(denyThreshold.state.body)).toMatchObject({ threshold: 6, list: 'deny' })

    const add = fakeHttp('POST', POLICY_PATH, JSON.stringify({
      op: 'add',
      scope: 'project',
      list: 'deny',
      cwd: projectDir,
      rule: { tool: 'bash', match: { kind: 'command_prefix', value: 'rm -rf' }, label: '递归删除' },
    }))
    await handler(add.req, add.res)
    const added = JSON.parse(add.state.body)
    expect(added.ok).toBe(true)
    expect(added.scope).toBe('project')

    const afterAdd = fakeHttp('GET', POLICY_PATH + '?cwd=' + encodeURIComponent(projectDir))
    await handler(afterAdd.req, afterAdd.res)
    expect(JSON.parse(afterAdd.state.body).project.deny).toHaveLength(1)

    const remove = fakeHttp('POST', POLICY_PATH, JSON.stringify({ op: 'remove', scope: 'project', list: 'deny', id: added.rule.id, cwd: projectDir }))
    await handler(remove.req, remove.res)
    expect(JSON.parse(remove.state.body).ok).toBe(true)

    const afterRemove = fakeHttp('GET', POLICY_PATH + '?cwd=' + encodeURIComponent(projectDir))
    await handler(afterRemove.req, afterRemove.res)
    expect(JSON.parse(afterRemove.state.body).project.deny).toEqual([])
  })

  it('由一条审批记录一键升级：采用记录里的模型建议规则并回写记录', async () => {
    const root = tempDir()
    const logFile = join(root, 'approvals.json')
    writeFileSync(logFile, JSON.stringify({
      version: 1,
      records: [{
        id: 'rec-1',
        sessionId: 'session-1',
        cwd: join(root, 'project'),
        toolName: 'bash',
        signature: { toolName: 'bash', key: 'sig-1', text: 'bash: npm test' },
        suggestedRule: { tool: 'bash', match: { kind: 'command_prefix', value: 'npm test' }, label: 'npm 测试命令' },
      }],
    }), 'utf8')

    const { ctx, routes } = fakeContext()
    apply(ctx, { logFile, policyFile: join(root, 'home', 'policy.json') })
    const handler = routes[0].handler

    const promote = fakeHttp('POST', RULE_PATH, JSON.stringify({ recordId: 'rec-1', scope: 'global', list: 'allow' }))
    await handler(promote.req, promote.res)
    const result = JSON.parse(promote.state.body)
    expect(result.ok).toBe(true)
    expect(result.rule.source).toBe('model')
    expect(result.rule.match).toEqual({ kind: 'command_prefix', value: 'npm test' })
    // 审查时模型已经给过建议：不额外烧一次优化调用，但如实标注来源
    expect(result.optimizedBy).toBe('record')

    // 记录被回写：时间线上能看到这条已经应用过的规则
    const persisted = JSON.parse(readFileSync(logFile, 'utf8'))
    expect(persisted.records[0].ruleApplied.list).toBe('allow')
    expect(persisted.records[0].ruleApplied.ruleId).toBe(result.rule.id)

    // 规则真的生效：同一命令族的另一次调用命中白名单
    const store = createPolicyStore({ globalFile: join(root, 'home', 'policy.json'), warn: () => {} })
    const hit = store.match({
      signature: signatureOf({ toolName: 'bash' }, { arguments: { command: 'npm test --silent' } }),
      cwd: undefined,
    })
    expect(hit.list).toBe('allow')
  })

  it('没有模型建议时现场跑一次模型优化，规则仍然经过模型', async () => {
    const root = tempDir()
    const logFile = join(root, 'approvals.json')
    writeFileSync(logFile, JSON.stringify({
      version: 1,
      records: [{
        id: 'rec-2',
        sessionId: 'session-1',
        cwd: join(root, 'project'),
        toolName: 'pwsh',
        signature: { toolName: 'pwsh', key: 'sig-2', memoryKey: 'sig-2', text: 'pwsh: pnpm test', command: 'pnpm test' },
      }],
    }), 'utf8')

    const started = []
    const subagents = {
      start: vi.fn().mockImplementation((provider, options) => {
        started.push(options)
        return Promise.resolve(ruleRun('pnpm test'))
      }),
    }
    const { ctx, routes } = fakeContext({
      agents: { get: () => fakeAgent(), roots: () => [fakeAgent()] },
      subagents,
    })
    apply(ctx, {
      logFile,
      policyFile: join(root, 'home', 'policy.json'),
      language: 'zh',
      reviewerProvider: 'p',
      reviewerModel: 'm',
    })

    const promote = fakeHttp('POST', RULE_PATH, JSON.stringify({
      recordId: 'rec-2', scope: 'project', list: 'allow', sessionId: 'session-1',
    }))
    await routes[0].handler(promote.req, promote.res)
    const result = JSON.parse(promote.state.body)
    expect(subagents.start).toHaveBeenCalledOnce()
    // 两种档位都要能交结论：persona 与任务提示都必须写明 ptc 下经 run_code 提交 structured_output
    expect(started[0].persona).toContain('run_code')
    expect(started[0].prompt[0].text).toContain('structured_output')
    expect(result.optimizedBy).toBe('model')
    expect(result.rule.match).toEqual({ kind: 'command_prefix', value: 'pnpm test' })
    expect(result.rule.source).toBe('model')
  })

  it('取不到在册 Agent 时如实回落到精确签名', async () => {
    const root = tempDir()
    const logFile = join(root, 'approvals.json')
    writeFileSync(logFile, JSON.stringify({
      version: 1,
      records: [{
        id: 'rec-3',
        sessionId: 'session-gone',
        cwd: join(root, 'project'),
        toolName: 'pwsh',
        signature: { toolName: 'pwsh', key: 'sig-3', text: 'pwsh: pnpm test' },
      }],
    }), 'utf8')

    const { ctx, routes } = fakeContext()
    apply(ctx, { logFile, policyFile: join(root, 'home', 'policy.json'), language: 'zh' })
    const promote = fakeHttp('POST', RULE_PATH, JSON.stringify({ recordId: 'rec-3', scope: 'project', list: 'deny' }))
    await routes[0].handler(promote.req, promote.res)
    const result = JSON.parse(promote.state.body)
    expect(result.optimizedBy).toBe('signature')
    expect(result.rule.match).toEqual({ kind: 'signature', value: 'sig-3' })
  })

  it('记录不存在时返回 404', async () => {
    const root = tempDir()
    const { ctx, routes } = fakeContext()
    apply(ctx, { logFile: join(root, 'approvals.json'), policyFile: join(root, 'home', 'policy.json') })
    const missing = fakeHttp('POST', RULE_PATH, JSON.stringify({ recordId: 'nope', scope: 'global', list: 'allow' }))
    await routes[0].handler(missing.req, missing.res)
    expect(missing.state.code).toBe(404)
  })
})
