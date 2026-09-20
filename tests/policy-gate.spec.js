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
  decisionSignal,
  defaultRuleOf,
  exactAction,
  kindApplicable,
  parseSuggestedRule,
  POLICY_PATH,
  RECORD_CONFIG_PATH,
  resolveConfig,
  ruleFromRecord,
  RULE_DRAFT_PATH,
  RULE_PATH,
  RULE_REVERT_PATH,
  suggestionUsable,
} from '../src/index.js'
import { createPolicyStore } from '../src/policy.js'
import { signatureOf } from '../src/policy.js'

// 单轮调用要用 DSH 的 llm 模块（消息构造器 + 流式装配器）。测试环境里没有这个包，
// 用工厂 mock 顶掉：装配器只认本套测试产出的文本块。
vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: input => ({ role: 'user', ...input }),
  BlockAssembler: class {
    constructor() {
      this.parts = []
    }

    push(chunk) {
      if (typeof chunk === 'string') this.parts.push(chunk)
      else if (chunk !== null && typeof chunk === 'object' && chunk.text !== undefined) this.parts.push(String(chunk.text))
      // 真实的 BlockAssembler 也这样收 usage 块：留在 this.usage 上供调用方读取
      else if (chunk !== null && typeof chunk === 'object' && chunk.usage !== undefined) this.usage = chunk.usage
    }

    blocks() {
      return this.parts.length === 0 ? [] : [{ type: 'text', text: this.parts.join('') }]
    }
  },
}))

/** 把 reviewerRun(...) 转成「模型回复」的取数函数（stopReason 不是 completed 就当调用失败）。 */
function toReply(item) {
  if (typeof item === 'string' || item instanceof Error) return item
  // 直接给 { text, usage }：拿它当模型回复原文（用于「有用量但回复不合法」这类用例）
  if (item !== null && typeof item === 'object' && typeof item.text === 'string') return () => item
  return async () => {
    const result = await item.result
    if (result?.stopReason !== undefined && result.stopReason !== 'completed') {
      throw new Error('模型调用未正常结束：' + result.stopReason)
    }
    const text = JSON.stringify(result?.structured ?? {})
    // reviewerRun 可以带 usage：交给 stream 变成一次 usage 块，覆盖「记录 token 消耗」的路径
    const usage = item.usage ?? result?.usage
    return usage === undefined ? text : { text, usage }
  }
}

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

/** 假宿主：llm 服务按顺序吐出排练好的回复（单轮审查 / 单轮规则优化共用）。 */
function contextWith(runs = [], options = {}) {
  const queue = [...runs].map(toReply)
  const calls = []
  const llm = {
    stream(call) {
      calls.push(call)
      const next = queue.length === 0 ? new Error('没有排练好的模型回复') : queue.shift()
      return (async function* () {
        const value = typeof next === 'function' ? await next() : next
        if (value instanceof Error) throw value
        // 排练项可以是纯文本，也可以是 { text, usage }（带 token 用量）
        if (value !== null && typeof value === 'object' && typeof value.text === 'string') {
          yield { text: value.text }
          if (value.usage !== undefined) yield { usage: value.usage }
          return
        }
        yield { text: value }
      })()
    },
  }
  return {
    llmCalls: calls,
    get: vi.fn(name => name === 'llm'
      ? llm
      : name === 'sandboxPolicy'
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

/** 达到阈值后要写进名单的匹配条件：由审查那一次调用顺带给出（不再单独跑规则优化）。 */
const RULE_SUGGESTION = Object.freeze({
  tool: 'bash',
  match_kind: 'command_prefix',
  match_value: 'npm test',
  label: 'npm 测试命令',
})

/** Reviewer 判定放行；可选带上一条建议规则。 */
function allowRun(rule) {
  return reviewerRun({
    risk_level: 'low',
    user_authorization: 'high',
    outcome: 'allow',
    rationale: '用户明确要求。',
    ...(rule === undefined ? {} : { rule }),
  })
}

/** Reviewer 判定拒绝；可选带上一条建议规则。 */
function denyRun(rule) {
  return reviewerRun({
    risk_level: 'high',
    user_authorization: 'low',
    outcome: 'deny',
    rationale: '这条命令风险过高。',
    ...(rule === undefined ? {} : { rule }),
  })
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
    expect(ctx.llmCalls).toHaveLength(0)
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
    expect(ctx.llmCalls).toHaveLength(0)
    // 审批卡首行（DSH 渲染 req.reason）带上「为什么转人工」，并保留调用方给的原文
    expect(request.reason).toContain('\n\n自动审批：命中全局黑名单')
    expect(request.reason).toContain('escalate sandbox')
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

describe('计数信号（decisionSignal）', () => {
  it('最终获准执行就是放行：人工放行盖过模型的 deny', () => {
    // 真机踩到的坑：模型判 deny、转人工后用户点了「允许一次」，旧实现计成「连续被拒」，
    // 白名单永远攒不够阈值。
    expect(decisionSignal('allowed-once', { verdict: 'deny' })).toBe('pass')
    expect(decisionSignal('allowed-once', { verdict: 'allow' })).toBe('pass')
    expect(decisionSignal('allowed-once', { verdict: 'defer' })).toBe('pass')
  })

  it('最终未被批准算拒绝；没人拍板时只看模型判定', () => {
    expect(decisionSignal('rejected', { verdict: 'allow' })).toBe('reject')
    expect(decisionSignal('rejected', { verdict: 'deny' })).toBe('reject')
    // 无人应答 / 已取消：模型判过 deny 的算一次未获批准，其余（审查失败、defer）不计数
    expect(decisionSignal('unavailable', { verdict: 'deny' })).toBe('reject')
    expect(decisionSignal('cancelled', { verdict: 'deny' })).toBe('reject')
    expect(decisionSignal('unavailable', { verdict: 'defer' })).toBeUndefined()
    expect(decisionSignal(undefined, undefined)).toBeUndefined()
  })
})

describe('权限记忆（白名单达阈值自动写入、黑名单询问用户）', () => {
  it('模型判 deny、你连续放行三次：达阈值直接写进白名单，全程不问用户', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const policies = policyStore(root, 3)
    const asked = []
    const records = { add: vi.fn(() => ({ id: 'record-1' })), update: vi.fn(), list: () => [], size: () => 0 }
    const ctx = contextWith([denyRun(), denyRun(), denyRun(RULE_SUGGESTION)], {
      userQuestions: {
        ask: async request => {
          asked.push(request)
          return { answers: [] }
        },
      },
    })
    const handler = createAutoApprovalHandler(
      ctx, resolveConfig({ reviewerProvider: 'p', reviewerModel: 'm' }), records, policies)
    /** 每次都是「模型 deny → 你在审批卡上点允许一次」。 */
    const approve = () => vi.fn().mockResolvedValue('allowed-once')

    expect(await handler(requestWith({ cwd: projectDir }), approve())).toBe('allowed-once')
    await flush()
    expect(policies.snapshot(projectDir).project.allow).toHaveLength(0)
    expect(await handler(requestWith({ cwd: projectDir }), approve())).toBe('allowed-once')
    await flush()
    expect(policies.snapshot(projectDir).project.allow).toHaveLength(0)

    expect(await handler(requestWith({ cwd: projectDir }), approve())).toBe('allowed-once')
    await flush()
    // 第三次达到阈值：你的放行被计成连续放行 → 规则直接写进**本项目白名单**，黑名单一侧不被计数
    expect(asked).toHaveLength(0)
    const rules = policies.snapshot(projectDir).project.allow
    expect(rules).toHaveLength(1)
    expect(rules[0].match).toEqual({ kind: 'command_prefix', value: 'npm test' })
    expect(policies.snapshot(projectDir).project.deny ?? []).toHaveLength(0)
    // 记录里带上「自动写入」标记：时间线据此说明这条规则没问过用户，并且照样能一键撤销
    const patch = records.update.mock.calls.at(-1)[1]
    expect(patch.ruleApplied.auto).toBe(true)
    expect(patch.ruleApplied.list).toBe('allow')
    expect(patch.ruleApplied.ruleId).toBe(rules[0].id)
    // 条件来自哪条路也写进记录：时间线的折叠行据此标出「模型建议」/「权限指纹」
    expect(patch.ruleApplied.optimizedBy).toBe('record')
  })

  it('连续放行达到阈值后自动写入白名单：用审查那次的模型建议，不额外叫模型', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const policies = policyStore(root, 2)
    const asked = []
    // 达阈值不再另起「规则优化」调用：直接用审查那次给出的建议规则自动写入
    const ctx = contextWith([allowRun(), allowRun(RULE_SUGGESTION)], {
      userQuestions: {
        ask: async request => {
          asked.push(request)
          return { answers: [] }
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

    // 第二次达到阈值：审批结论照常返回，写入在旁路进行，用户全程没被问过
    expect(await handler(requestWith({ cwd: projectDir }), vi.fn().mockResolvedValue('allowed-once'))).toBe('allowed-once')
    await flush()
    expect(asked).toHaveLength(0)
    // 写进去的是审查那次的模型建议（不是精确签名）
    const rules = policies.snapshot(projectDir).project.allow
    expect(rules).toHaveLength(1)
    expect(rules[0].match).toEqual({ kind: 'command_prefix', value: 'npm test' })
    expect(rules[0].source).toBe('model')
    expect(JSON.parse(readFileSync(join(projectDir, '.dsh-auto-pass', 'policy.json'), 'utf8')).rules.allow).toHaveLength(1)

    // 第三次直接命中名单：连人工链都不用调，模型也只被叫过两次（达阈值没有额外的固化调用）
    const third = vi.fn()
    expect(await handler(requestWith({ cwd: projectDir }), third)).toBe('allowed-once')
    expect(third).not.toHaveBeenCalled()
    expect(ctx.llmCalls).toHaveLength(2)
  })

  it('没有可用的模型建议时，兜底写的是这次动作的权限指纹', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const policies = policyStore(root, 2)
    const asked = []
    // 两次审查都判 deny 且**不给**建议规则：兜底必须自己整理成好用的条件
    const ctx = contextWith([denyRun(), denyRun()], {
      userQuestions: {
        ask: async request => {
          asked.push(request)
          return { answers: [] }
        },
      },
    })
    const records = { add: vi.fn(() => ({ id: 'record-1' })), update: vi.fn(), list: () => [], size: () => 0 }
    const handler = createAutoApprovalHandler(
      ctx, resolveConfig({ reviewerProvider: 'p', reviewerModel: 'm' }), records, policies)
    const approve = () => vi.fn().mockResolvedValue('allowed-once')

    expect(await handler(requestWith({ cwd: projectDir }), approve())).toBe('allowed-once')
    await flush()
    expect(await handler(requestWith({ cwd: projectDir }), approve())).toBe('allowed-once')
    await flush()

    // 自动写入的兜底条件就是这次动作的权限指纹（机器算出来的整串 key），全程没问过用户
    expect(asked).toHaveLength(0)
    const rules = policies.snapshot(projectDir).project.allow
    expect(rules).toHaveLength(1)
    expect(rules[0].match.kind).toBe('signature')
    expect(rules[0].match.value).toBe(signatureOf(requestWith({ command: 'npm test' }), exactAction(requestWith({ command: 'npm test' }))).key)
    // 兜底路写进记录的条件来源是 signature：时间线据此标「权限指纹」（而不是「模型建议」）
    const patch = records.update.mock.calls.at(-1)[1]
    expect(patch.ruleApplied.auto).toBe(true)
    expect(patch.ruleApplied.optimizedBy).toBe('signature')
  })

  it('黑名单确认卡上写的是这次动作的可读摘要，不是含 NUL 的机器指纹', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const policies = policyStore(root, 3, 2)
    const asked = []
    // 两次拒绝、且模型不给建议：兜底条件是这次动作的权限指纹（机器串），卡上必须换成可读摘要
    const ctx = contextWith([denyRun(), denyRun()], {
      userQuestions: {
        ask: async askRequest => {
          asked.push(askRequest)
          return { answers: [] }
        },
      },
    })
    const handler = createAutoApprovalHandler(
      ctx, resolveConfig({ reviewerProvider: 'p', reviewerModel: 'm' }), undefined, policies)
    await handler(requestWith({ cwd: projectDir }), vi.fn().mockResolvedValue('rejected'))
    await handler(requestWith({ cwd: projectDir }), vi.fn().mockResolvedValue('rejected'))
    await flush()

    const suggestion = asked.find(ask => ask.questions[0].id === 'dsh-auto-pass:deny')
    expect(suggestion).toBeDefined()
    expect(suggestion.questions[0].question).toContain('权限指纹')
    expect(suggestion.questions[0].question).toContain('权限指纹：bash: npm test')
    expect(suggestion.questions[0].question).not.toContain('\u0000')
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

  it('插件自动放行同样计数：阈值 1 时这一次就自动写入白名单', async () => {
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
    ], {
      userQuestions: {
        ask: async askRequest => {
          asked.push(askRequest)
          return { answers: [] }
        },
      },
    })
    const config = resolveConfig({ reviewerProvider: 'p', reviewerModel: 'm' })
    const handler = createAutoApprovalHandler(ctx, config, undefined, policies)

    expect(await handler(request, vi.fn())).toBe('allowed-once')
    await flush()
    // 插件自己放行的这一次就攒满阈值：模型给的权限指纹直接写进项目白名单，没问用户
    expect(asked).toHaveLength(0)
    const rules = policies.snapshot(projectDir).project.allow
    expect(rules).toHaveLength(1)
    expect(rules[0].match).toEqual({ kind: 'signature', value: signature.key })

    // 再来一次同一条动作：命中白名单，连模型都不叫了
    const second = vi.fn()
    expect(await handler(requestWith({ cwd: projectDir }), second)).toBe('allowed-once')
    expect(second).not.toHaveBeenCalled()
    expect(ctx.llmCalls).toHaveLength(1)
  })

  it('只换了理由与说明的同一条命令也算连续：第三次自动写入白名单', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const policies = policyStore(root, 3)
    const asked = []
    const ctx = contextWith([allowRun(), allowRun(), allowRun(RULE_SUGGESTION)], {
      userQuestions: {
        ask: async askRequest => {
          asked.push(askRequest)
          return { answers: [] }
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
    expect(asked).toHaveLength(0)
    const rules = policies.snapshot(projectDir).project.allow
    expect(rules).toHaveLength(1)
    expect(rules[0].match).toEqual({ kind: 'command_prefix', value: 'npm test' })
  })

  it('连续被拒达到阈值后询问是否加入黑名单', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const policies = policyStore(root, 3, 2)
    const signature = signatureOf(requestWith({ cwd: projectDir }), exactAction(requestWith({ cwd: projectDir })))
    const asked = []
    // 两次审查都判定拒绝：第二条回复里带上建议的黑名单匹配条件（达阈值直接用它）
    const ctx = contextWith([denyRun(), denyRun(RULE_SUGGESTION)], {
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
    // 两次人工拒绝各自还会触发一次「拒绝理由」追问，所以按 question id 挑出规则确认那一条
    const suggestions = asked.filter(ask => ask.questions[0].id === 'dsh-auto-pass:deny')
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].questions[0].options.map(option => option.label)).toContain('加入黑名单（全局）')
    const rules = policies.snapshot(projectDir).global.deny
    expect(rules).toHaveLength(1)
    expect(rules[0].match).toEqual({ kind: 'command_prefix', value: 'npm test' })
    // 于是之后的同类动作直接转人工，连模型都不叫
    const signature2 = signatureOf(requestWith({ cwd: projectDir }), exactAction(requestWith({ cwd: projectDir })))
    expect(signature2.key).toBe(signature.key)
    const next = vi.fn().mockResolvedValue('rejected')
    expect(await handler(requestWith({ cwd: projectDir }), next)).toBe('rejected')
    // 模型只被叫过两次：命中黑名单后连模型都不叫，达阈值也没有额外调用
    expect(ctx.llmCalls).toHaveLength(2)
  })

  it('白名单不需要 ask 通道就能自动写入；黑名单没有 ask 通道时只记日志', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const config = resolveConfig({ reviewerProvider: 'p', reviewerModel: 'm' })

    // 白名单这条路**不经过 userQuestions**：问不到人（子 Agent / 无人应答）也照样写入，
    // 因为连续放行已经由用户自己或插件放行了三次，不需要再确认一次
    const allowPolicies = policyStore(root, 1)
    const allowCtx = contextWith([allowRun()])
    expect(await createAutoApprovalHandler(allowCtx, config, undefined, allowPolicies)(
      requestWith({ cwd: projectDir }), vi.fn())).toBe('allowed-once')
    await flush()
    expect(allowPolicies.snapshot(projectDir).project.allow).toHaveLength(1)

    // 黑名单仍然要用户拍板：没有 ask 服务就只记日志、不写规则
    const denyRoot = tempDir()
    const denyDir = join(denyRoot, 'project')
    const denyPolicies = policyStore(denyRoot, 3, 1)
    const denyCtx = contextWith([denyRun()])
    expect(await createAutoApprovalHandler(denyCtx, config, undefined, denyPolicies)(
      requestWith({ cwd: denyDir }), vi.fn().mockResolvedValue('rejected'))).toBe('rejected')
    await flush()
    expect(denyPolicies.snapshot(denyDir).global.deny).toHaveLength(0)
    expect(denyCtx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('没有 userQuestions 服务'))
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

  it('ruleFromRecord 的兜底默认是权限指纹：同一个动作换个输出截断仍命得中，换参数仍分得开', () => {
    const signature = signatureOf({ toolName: 'pwsh' }, {
      arguments: { command: 'pnpm test 2>&1 | Select-Object -Last 12', sandbox_permissions: 'danger-full-access' },
    })
    const withCommand = ruleFromRecord({ cwd: '/p', signature })
    expect(withCommand.match).toEqual({ kind: 'signature', value: signature.key })
    expect(withCommand.note).toContain('权限指纹')
    // 同一个动作换个输出截断：指纹一致（这条规则仍然命得中）
    expect(signatureOf({ toolName: 'pwsh' }, {
      arguments: { command: 'pnpm test | Out-String', sandbox_permissions: 'danger-full-access' },
    }).key).toBe(signature.key)
    // 换了参数就是另一条权限：规则不会顺带放行
    expect(signatureOf({ toolName: 'pwsh' }, {
      arguments: { command: 'pnpm test --filter a', sandbox_permissions: 'danger-full-access' },
    }).key).not.toBe(signature.key)
    // 动作没有命令（write 之类）时同样是权限指纹
    const noCommand = ruleFromRecord({
      cwd: '/p',
      signature: signatureOf({ toolName: 'write' }, { arguments: { file_path: '/p/a.txt' } }),
    })
    expect(noCommand.match.kind).toBe('signature')
  })

  it('defaultRuleOf：默认就是这次动作的权限指纹，提权仍是另一条权限', () => {
    const plain = defaultRuleOf(signatureOf({ toolName: 'pwsh' }, { arguments: { command: 'pnpm test 2>&1' } }))
    expect(plain.match.kind).toBe('signature')
    // 同一动作换个输出截断/换句说明仍是同一个指纹
    expect(plain.match.value)
      .toBe(signatureOf({ toolName: 'pwsh' }, { arguments: { command: 'pnpm test' } }).key)
    // 提权是另一条权限：普通调用的默认规则不会顺手把提权重试也放行
    const elevated = signatureOf({ toolName: 'pwsh' }, {
      arguments: { command: 'pnpm test', sandbox_permissions: 'danger-full-access' },
    })
    expect(defaultRuleOf(elevated).match.value).not.toBe(plain.match.value)
    expect(defaultRuleOf(signatureOf({ toolName: 'write' }, { arguments: { file_path: '/p/a.txt' } })).match.kind)
      .toBe('signature')
    expect(defaultRuleOf(undefined)).toBeUndefined()
  })
})

describe('模型建议规则的有效性（suggestionUsable）', () => {
  const signature = signatureOf({ toolName: 'pwsh' }, {
    arguments: { command: 'pnpm vitest run tests/policy-gate.spec.js 2>&1 | Select-String "done"', sandbox_permissions: 'danger-full-access' },
  })

  it('「精确签名」必须逐字等于本次签名，写成一句描述的一律不可用', () => {
    // 真机记录里模型写过这三种：danger-full-access / escalation:danger-full-access / escalation=danger-full-access
    expect(suggestionUsable({ tool: 'pwsh', match: { kind: 'signature', value: 'danger-full-access' } }, signature)).toBe(false)
    expect(suggestionUsable({ tool: 'pwsh', match: { kind: 'signature', value: 'escalation:danger-full-access' } }, signature)).toBe(false)
    expect(suggestionUsable({ tool: 'pwsh', match: { kind: 'signature', value: 'escalation=danger-full-access' } }, signature)).toBe(false)
    expect(suggestionUsable({ tool: 'pwsh', match: { kind: 'signature', value: signature.key } }, signature)).toBe(true)
    // 工具名对不上、条件种类不认识、没有签名可比对：一律不可用
    expect(suggestionUsable({ tool: 'wsl', match: { kind: 'signature', value: signature.key } }, signature)).toBe(false)
    expect(suggestionUsable({ tool: 'pwsh', match: { kind: 'regex', value: '.*' } }, signature)).toBe(false)
    expect(suggestionUsable({ tool: 'pwsh', match: { kind: 'signature', value: signature.key } }, undefined)).toBe(false)
  })

  it('前缀类条件要真的覆盖本次动作；签名里没有可比对字段时先信模型', () => {
    expect(suggestionUsable({ tool: 'pwsh', match: { kind: 'command_prefix', value: 'pnpm vitest run' } }, signature)).toBe(true)
    expect(suggestionUsable({ tool: 'pwsh', match: { kind: 'command_prefix', value: 'git status' } }, signature)).toBe(false)
    // 老记录只有 key/text（没有 command/paths）：判不了就照旧信任模型，别凭空丢弃
    const legacy = { toolName: 'pwsh', key: 'k', text: 'pwsh: pnpm test' }
    expect(suggestionUsable({ tool: 'pwsh', match: { kind: 'command_prefix', value: 'npm test' } }, legacy)).toBe(true)
  })

  it('新记录「字段为空」与老记录「字段缺失」区别对待：空的一律判不可用', () => {
    // 真机踩到的坑：一条 pwsh 命令记录（paths 是空数组）被要求生成路径前缀，模型给了个目录，
    // 旧写法因为「paths 为空 = 判不了」而放行，写进去一条永远命不中的规则
    const commandOnly = {
      toolName: 'pwsh',
      key: 'k',
      text: 'pwsh: pnpm test',
      command: 'pnpm test',
      paths: [],
    }
    expect(suggestionUsable({ tool: 'pwsh', match: { kind: 'path_prefix', value: 'D:/work/x' } }, commandOnly)).toBe(false)
    expect(suggestionUsable({ tool: 'pwsh', match: { kind: 'command_prefix', value: 'pnpm test' } }, commandOnly)).toBe(true)
    // 反过来：写文件的动作没有命令，命令前缀也命不中
    const fileOnly = {
      toolName: 'write',
      key: 'k',
      text: 'write: D:/work/x/a.js',
      paths: ['D:/work/x/a.js'],
    }
    expect(suggestionUsable({ tool: 'write', match: { kind: 'command_prefix', value: 'pnpm test' } }, fileOnly)).toBe(false)
    expect(suggestionUsable({ tool: 'write', match: { kind: 'path_prefix', value: 'D:/work/x' } }, fileOnly)).toBe(true)
    // 老记录（连 paths 都没有）两边都算判不了 → 不拦
    const legacy = { toolName: 'write', key: 'k', text: 'write: x' }
    expect(suggestionUsable({ tool: 'write', match: { kind: 'path_prefix', value: 'D:/work/x' } }, legacy)).toBe(true)
    expect(suggestionUsable({ tool: 'write', match: { kind: 'command_prefix', value: 'pnpm test' } }, legacy)).toBe(true)
  })

  it('kindApplicable 与上面同一口径：新记录按实际字段判，老记录一律可用', () => {
    expect(kindApplicable({ toolName: 'pwsh', key: 'k', text: 't', command: 'pnpm test', paths: [] }, 'command_prefix')).toBe(true)
    expect(kindApplicable({ toolName: 'pwsh', key: 'k', text: 't', command: 'pnpm test', paths: [] }, 'path_prefix')).toBe(false)
    expect(kindApplicable({ toolName: 'write', key: 'k', text: 't', paths: ['D:/a.js'] }, 'path_prefix')).toBe(true)
    expect(kindApplicable({ toolName: 'write', key: 'k', text: 't', paths: ['D:/a.js'] }, 'command_prefix')).toBe(false)
    expect(kindApplicable({ toolName: 'x', key: 'k', text: 't' }, 'path_prefix')).toBe(true)
    expect(kindApplicable({ toolName: 'x', key: 'k', text: 't' }, 'signature')).toBe(true)
    expect(kindApplicable(undefined, 'signature')).toBe(false)
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
        // 手动升级要现场起一次单轮规则优化调用：llm 缺失或调用失败就回落到精确签名
        get: name => (name === 'llm' ? options.llm : undefined),
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
    // 新增时如实回报「没有查到重复」
    expect(added).toMatchObject({ replaced: false, covered: false, merged: 0 })

    // 查重走 HTTP 出口：同一「工具 + 匹配条件」只差一个尾部空格 = 同一条规则，更新而不是追加
    const again = fakeHttp('POST', POLICY_PATH, JSON.stringify({
      op: 'add',
      scope: 'project',
      list: 'deny',
      cwd: projectDir,
      rule: { tool: 'bash', match: { kind: 'command_prefix', value: 'rm -rf ' }, label: '递归删除（更新）' },
    }))
    await handler(again.req, again.res)
    expect(JSON.parse(again.state.body)).toMatchObject({ ok: true, replaced: true, covered: false })

    // 已被更宽的规则覆盖：不写重复条目，回报 covered 并指向那条已有规则
    const covered = fakeHttp('POST', POLICY_PATH, JSON.stringify({
      op: 'add',
      scope: 'project',
      list: 'deny',
      cwd: projectDir,
      rule: { tool: 'bash', match: { kind: 'command_prefix', value: 'rm -rf /' }, label: '递归删除根目录' },
    }))
    await handler(covered.req, covered.res)
    const coveredBody = JSON.parse(covered.state.body)
    expect(coveredBody).toMatchObject({ ok: true, covered: true, replaced: false })
    expect(coveredBody.rule.match).toEqual({ kind: 'command_prefix', value: 'rm -rf ' })

    const afterAdd = fakeHttp('GET', POLICY_PATH + '?cwd=' + encodeURIComponent(projectDir))
    await handler(afterAdd.req, afterAdd.res)
    expect(JSON.parse(afterAdd.state.body).project.deny).toHaveLength(1)

    // 覆盖那次没写新条目，所以删的仍是「更新后仍生效」的那条（id 已经不是第一次那条了）
    const remove = fakeHttp('POST', POLICY_PATH, JSON.stringify({ op: 'remove', scope: 'project', list: 'deny', id: coveredBody.rule.id, cwd: projectDir }))
    await handler(remove.req, remove.res)
    expect(JSON.parse(remove.state.body).ok).toBe(true)

    const afterRemove = fakeHttp('GET', POLICY_PATH + '?cwd=' + encodeURIComponent(projectDir))
    await handler(afterRemove.req, afterRemove.res)
    expect(JSON.parse(afterRemove.state.body).project.deny).toEqual([])
  })

  it('/config 的「自动打开审批时间线」按工作区区分：带 cwd 读写该项目文件，不带 cwd 写全局', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const otherDir = join(root, 'other')
    const { ctx, routes } = fakeContext()
    apply(ctx, { policyFile: join(root, 'home', 'policy.json') })
    const handler = routes[0].handler

    // 不带 cwd：只有全局那份，没有 workspace 段
    const global = fakeHttp('GET', RECORD_CONFIG_PATH)
    await handler(global.req, global.res)
    const globalBody = JSON.parse(global.state.body)
    expect(globalBody.settings.autoOpenTimeline).toBe(true)
    expect(globalBody.workspace).toBeUndefined()

    // 带 cwd：workspace 段给出本工作区的生效值（还没存过 → 跟随全局，scoped=false）
    const read = fakeHttp('GET', RECORD_CONFIG_PATH + '?cwd=' + encodeURIComponent(projectDir))
    await handler(read.req, read.res)
    expect(JSON.parse(read.state.body).workspace).toEqual({ cwd: projectDir, autoOpenTimeline: true, scoped: false })

    // 只改本工作区：落进 <cwd>/.dsh-auto-pass/policy.json 的 prefs，不写设置命名空间
    const write = fakeHttp('POST', RECORD_CONFIG_PATH, JSON.stringify({ autoOpenTimeline: false, cwd: projectDir }))
    await handler(write.req, write.res)
    expect(write.state.code).toBe(200)
    expect(JSON.parse(write.state.body).workspace).toEqual({ cwd: projectDir, autoOpenTimeline: false, scoped: true })
    expect(JSON.parse(readFileSync(join(projectDir, '.dsh-auto-pass', 'policy.json'), 'utf8')).prefs)
      .toEqual({ autoOpenTimeline: false })

    // 另一个工作区不受影响（仍然跟随全局）
    const other = fakeHttp('GET', RECORD_CONFIG_PATH + '?cwd=' + encodeURIComponent(otherDir))
    await handler(other.req, other.res)
    expect(JSON.parse(other.state.body).workspace).toEqual({ cwd: otherDir, autoOpenTimeline: true, scoped: false })

    // 不带 cwd 的 POST 才是「改全局默认」：这个假宿主没有可写 settings，所以如实 503（证明它没走工作区那条路）
    const globalWrite = fakeHttp('POST', RECORD_CONFIG_PATH, JSON.stringify({ autoOpenTimeline: false }))
    await handler(globalWrite.req, globalWrite.res)
    expect(globalWrite.state.code).toBe(503)
    expect(JSON.parse(readFileSync(join(projectDir, '.dsh-auto-pass', 'policy.json'), 'utf8')).prefs)
      .toEqual({ autoOpenTimeline: false })

    // 项目写盘失败（cwd 指向一个文件）：降级走全局设置那条路，不再抛错也不再写项目文件
    const blocked = join(root, 'blocked-cwd')
    writeFileSync(blocked, 'x', 'utf8')
    const blockedWrite = fakeHttp('POST', RECORD_CONFIG_PATH, JSON.stringify({ autoOpenTimeline: true, cwd: blocked }))
    await handler(blockedWrite.req, blockedWrite.res)
    expect(blockedWrite.state.code).toBe(503)
  })

  it('/config 的「自动打开审批时间线」按会话区分：带 session + cwd 写该会话那份，缺 cwd 直接 400', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const { ctx, routes } = fakeContext()
    apply(ctx, { policyFile: join(root, 'home', 'policy.json') })
    const handler = routes[0].handler
    const sessionA = 'session-aaaa'
    const sessionB = 'session-bbbb'

    // 带 session + cwd：这个会话还没存过 → 跟随全局，scoped=false
    const read = fakeHttp('GET', RECORD_CONFIG_PATH + '?cwd=' + encodeURIComponent(projectDir) + '&session=' + sessionA)
    await handler(read.req, read.res)
    expect(JSON.parse(read.state.body).session).toEqual({ sessionId: sessionA, autoOpenTimeline: true, scoped: false })

    // 只改这个会话：落进该项目策略文件的 prefs.autoOpenTimelineSessions，不写设置命名空间
    const write = fakeHttp('POST', RECORD_CONFIG_PATH,
      JSON.stringify({ autoOpenTimeline: false, cwd: projectDir, session: sessionA }))
    await handler(write.req, write.res)
    expect(write.state.code).toBe(200)
    expect(JSON.parse(write.state.body).session).toEqual({ sessionId: sessionA, autoOpenTimeline: false, scoped: true })
    expect(JSON.parse(readFileSync(join(projectDir, '.dsh-auto-pass', 'policy.json'), 'utf8')).prefs)
      .toEqual({ autoOpenTimelineSessions: { [sessionA]: false } })

    // 同一个工作区里的另一个会话不受影响（按会话隔离）
    const other = fakeHttp('GET', RECORD_CONFIG_PATH + '?cwd=' + encodeURIComponent(projectDir) + '&session=' + sessionB)
    await handler(other.req, other.res)
    expect(JSON.parse(other.state.body).session).toEqual({ sessionId: sessionB, autoOpenTimeline: true, scoped: false })

    // 带 session 却没有 cwd：直接 400——绝不静默写全局（那会改掉所有会话的默认值）
    const noCwd = fakeHttp('POST', RECORD_CONFIG_PATH, JSON.stringify({ autoOpenTimeline: false, session: sessionA }))
    await handler(noCwd.req, noCwd.res)
    expect(noCwd.state.code).toBe(400)
    expect(JSON.parse(noCwd.state.body).error).toContain('cwd required')
    // 非法 session（空串 / 只有空白）同样 400
    const badSession = fakeHttp('POST', RECORD_CONFIG_PATH,
      JSON.stringify({ autoOpenTimeline: false, cwd: projectDir, session: '   ' }))
    await handler(badSession.req, badSession.res)
    expect(badSession.state.code).toBe(400)
    expect(JSON.parse(badSession.state.body).error).toContain('invalid session')
  })

  it('时间线上手填的匹配条件原样写入，不再让模型改写；不覆盖本次动作的手填条件当场拒绝', async () => {
    const root = tempDir()
    const logFile = join(root, 'approvals.json')
    const projectDir = join(root, 'project')
    writeFileSync(logFile, JSON.stringify({
      version: 1,
      records: [{
        id: 'rec-manual',
        sessionId: 'session-1',
        cwd: projectDir,
        toolName: 'bash',
        // 老记录只有 key/text：前缀类条件判不了「是否覆盖」，按信任处理
        signature: { toolName: 'bash', key: 'sig-1', text: 'bash: npm test' },
      }],
    }), 'utf8')
    const { ctx, routes } = fakeContext()
    apply(ctx, { logFile, policyFile: join(root, 'home', 'policy.json') })
    const handler = routes[0].handler

    const promote = fakeHttp('POST', RULE_PATH, JSON.stringify({
      recordId: 'rec-manual',
      scope: 'project',
      list: 'allow',
      rule: { tool: 'bash', match: { kind: 'command_prefix', value: 'npm test' }, label: '我自己写的条件' },
    }))
    await handler(promote.req, promote.res)
    const result = JSON.parse(promote.state.body)
    expect(result.ok).toBe(true)
    expect(result.optimizedBy).toBe('manual')
    expect(result.rule.label).toBe('我自己写的条件')
    expect(result.rule.source).toBe('user')
    // 记录里带上来源：时间线据此显示「（你手填的匹配条件）」
    const persisted = JSON.parse(readFileSync(logFile, 'utf8'))
    expect(persisted.records[0].ruleApplied.optimizedBy).toBe('manual')

    // 手填一条「精确签名」但值不是本次签名（模型写错过的那种）→ 400，不写盘
    const bogus = fakeHttp('POST', RULE_PATH, JSON.stringify({
      recordId: 'rec-manual',
      scope: 'project',
      list: 'allow',
      rule: { tool: 'bash', match: { kind: 'signature', value: 'danger-full-access' }, label: '提权' },
    }))
    await handler(bogus.req, bogus.res)
    expect(bogus.state.code).toBe(400)
    expect(JSON.parse(bogus.state.body).code).toBe('not-covering')
    const store = createPolicyStore({ globalFile: join(root, 'home', 'policy.json'), warn: () => {} })
    expect(store.snapshot(projectDir).project.allow).toHaveLength(1)
  })

  it('加入名单可撤销：/rule 写进撤销凭据、日志点名被顶掉的规则，/rule/revert 把名单还原', async () => {
    const root = tempDir()
    const logFile = join(root, 'approvals.json')
    const projectDir = join(root, 'project')
    const command = 'pnpm test 2>&1 | Select-Object -Last 12'
    const signature = signatureOf({ toolName: 'pwsh' }, { arguments: { command } })
    writeFileSync(logFile, JSON.stringify({
      version: 1,
      records: [{
        id: 'rec-undo',
        sessionId: 'session-1',
        cwd: projectDir,
        toolName: 'pwsh',
        signature: { toolName: 'pwsh', key: signature.key, text: signature.text, command, paths: [] },
      }],
    }), 'utf8')
    const policyFile = join(root, 'home', 'policy.json')
    // 用户之前确认过的窄规则（这条动作的精确签名）：即将加入的命令前缀会把它盖住
    const seed = createPolicyStore({ globalFile: policyFile, warn: () => {} })
    const narrow = seed.addRule({
      scope: 'project',
      list: 'allow',
      rule: { tool: 'pwsh', match: { kind: 'signature', value: signature.key }, label: '只跑这一条' },
    }, projectDir)
    expect(narrow.ok).toBe(true)

    const { ctx, routes } = fakeContext()
    apply(ctx, { logFile, policyFile })
    const handler = routes[0].handler
    /** 现读磁盘的策略仓库（模拟另一次运行看到的名单）。 */
    const store = () => createPolicyStore({ globalFile: policyFile, warn: () => {} })

    // 用户手填一条更宽的「命令前缀」：它会把上面那条精确签名的窄规则盖住（真机里的那种合并）
    const promote = fakeHttp('POST', RULE_PATH, JSON.stringify({
      recordId: 'rec-undo',
      scope: 'project',
      list: 'allow',
      rule: { tool: 'pwsh', match: { kind: 'command_prefix', value: 'pnpm test' }, label: '跑 pnpm 测试' },
    }))
    await handler(promote.req, promote.res)
    const result = JSON.parse(promote.state.body)
    expect(result.ok).toBe(true)
    expect(result.merged).toBe(1)
    // 被合并掉的窄规则**点了名**：界面与日志都据此说清楚「名单为什么少了一条」
    expect(result.dropped).toEqual(['只跑这一条'])
    expect(store().snapshot(projectDir).project.allow).toHaveLength(1)
    expect(ctx.logger.info.mock.calls.map(call => String(call[0])).join('\n')).toContain('dropped=只跑这一条')

    // 记录里带着撤销凭据：被顶掉那条的完整快照 + 这次写入那条的身份（match）
    const applied = JSON.parse(readFileSync(logFile, 'utf8')).records[0].ruleApplied
    expect(applied.mergedRules[0].id).toBe(narrow.rule.id)
    expect(applied.match).toEqual(result.rule.match)
    expect(applied.ruleId).toBe(result.rule.id)

    const undo = fakeHttp('POST', RULE_REVERT_PATH, JSON.stringify({ recordId: 'rec-undo' }))
    await handler(undo.req, undo.res)
    const undone = JSON.parse(undo.state.body)
    expect(undone.ok, JSON.stringify(undone)).toBe(true)
    expect(undone.restored).toEqual(['只跑这一条'])
    // 名单还原：宽的那条没了，窄的回来了
    expect(store().snapshot(projectDir).project.allow.map(rule => rule.id)).toEqual([narrow.rule.id])
    // 记录标记已撤销（界面据此不再显示撤销按钮）
    expect(JSON.parse(readFileSync(logFile, 'utf8')).records[0].ruleReverted.restored).toEqual(['只跑这一条'])

    // 同一条记录不能撤销两次
    const again = fakeHttp('POST', RULE_REVERT_PATH, JSON.stringify({ recordId: 'rec-undo' }))
    await handler(again.req, again.res)
    expect(again.state.code).toBe(400)
    expect(store().snapshot(projectDir).project.allow.map(rule => rule.id)).toEqual([narrow.rule.id])
  })

  it('设置面板能按 id 改一条已有规则（op=update），id 不变', async () => {
    const root = tempDir()
    const projectDir = join(root, 'project')
    const { ctx, routes } = fakeContext()
    apply(ctx, { policyFile: join(root, 'home', 'policy.json') })
    const handler = routes[0].handler
    const add = fakeHttp('POST', POLICY_PATH, JSON.stringify({
      op: 'add',
      scope: 'project',
      list: 'allow',
      cwd: projectDir,
      rule: { tool: 'pwsh', match: { kind: 'command_prefix', value: 'pnpm vitest run tests/policy.spec.js' }, label: '运行 policy.spec.js 单测' },
    }))
    await handler(add.req, add.res)
    const added = JSON.parse(add.state.body)

    const update = fakeHttp('POST', POLICY_PATH, JSON.stringify({
      op: 'update',
      scope: 'project',
      list: 'allow',
      cwd: projectDir,
      id: added.rule.id,
      rule: { tool: 'pwsh', match: { kind: 'command_prefix', value: 'pnpm test' }, label: '运行测试套件' },
    }))
    await handler(update.req, update.res)
    const updated = JSON.parse(update.state.body)
    expect(updated.ok).toBe(true)
    expect(updated.rule.id).toBe(added.rule.id)
    expect(updated.rule.match).toEqual({ kind: 'command_prefix', value: 'pnpm test' })

    const snapshot = fakeHttp('GET', POLICY_PATH + '?cwd=' + encodeURIComponent(projectDir))
    await handler(snapshot.req, snapshot.res)
    const rules = JSON.parse(snapshot.state.body).project.allow
    expect(rules).toHaveLength(1)
    expect(rules[0].label).toBe('运行测试套件')
  })

  it('换条件后让模型按该条件重新生成：条件写进提示词、不落盘、换条件或不覆盖就判失败', async () => {
    const root = tempDir()
    const logFile = join(root, 'approvals.json')
    const projectDir = join(root, 'project')
    writeFileSync(logFile, JSON.stringify({
      version: 1,
      records: [{
        id: 'rec-draft',
        sessionId: 'session-1',
        cwd: projectDir,
        toolName: 'bash',
        signature: { toolName: 'bash', key: 'sig-1', text: 'bash: npm test', command: 'npm test', paths: [] },
      }],
    }), 'utf8')
    /** 每个分支一份独立的假 llm：队列里排好模型回复，返回注册好的路由与调用记录。 */
    const harnessFor = runs => {
      const model = contextWith(runs)
      const { ctx, routes } = fakeContext({ llm: model.get('llm') })
      // 规则优化要有审查模型路由：与 profile 里的写法一致（provider/model 成对给出）
      apply(ctx, { logFile, policyFile: join(root, 'home', 'policy.json'), reviewerProvider: 'p', reviewerModel: 'm' })
      return { handler: routes[0].handler, model }
    }
    const draftHttp = (kind, draft) => fakeHttp('POST', RULE_DRAFT_PATH, JSON.stringify({
      recordId: 'rec-draft',
      kind,
      ...(draft === undefined ? {} : { draft }),
    }))

    // ① 正常：按用户点的条件生成，提示词里带着条件与当前草稿；只回给界面，不写名单
    const ok = harnessFor([ruleRun('npm test')])
    const draft = draftHttp('command_prefix', { kind: 'command_prefix', value: 'npm', label: 'npm 测试' })
    await ok.handler(draft.req, draft.res)
    expect(draft.state.code).toBe(200)
    expect(JSON.parse(draft.state.body).rule.match).toEqual({ kind: 'command_prefix', value: 'npm test' })
    expect(ok.model.llmCalls).toHaveLength(1)
    // 提示词走 createUserMessage 的 content 段（mock 把 input 原样摊开）：用户选的条件与草稿都在里面
    const prompt = JSON.stringify(ok.model.llmCalls[0].messages)
    expect(prompt).toContain('用户指定的匹配条件：命令前缀')
    expect(prompt).toContain('npm 测试')
    const store = createPolicyStore({ globalFile: join(root, 'home', 'policy.json'), warn: () => {} })
    expect(store.snapshot(projectDir).project.allow ?? []).toHaveLength(0)

    // ② 模型擅自换条件 → 失败（客户端保留自己按条件推导的值）
    const wrong = harnessFor([reviewerRun({ tool: 'bash', match_kind: 'signature', match_value: 'sig-1', label: '换个条件' })])
    const wrongDraft = draftHttp('command_prefix')
    await wrong.handler(wrongDraft.req, wrongDraft.res)
    expect(wrongDraft.state.code).toBe(503)

    // ③ 生成的条件不覆盖本次动作 → 同样失败，不会回给界面一条永远命不中的规则
    const outside = harnessFor([ruleRun('git status')])
    const outsideDraft = draftHttp('command_prefix')
    await outside.handler(outsideDraft.req, outsideDraft.res)
    expect(outsideDraft.state.code).toBe(503)

    // ④ 条件不在闭集里 → 400，连模型都不叫
    const bad = harnessFor([])
    const badDraft = draftHttp('regex')
    await bad.handler(badDraft.req, badDraft.res)
    expect(badDraft.state.code).toBe(400)
    expect(bad.model.llmCalls).toHaveLength(0)

    // ⑤ 条件与这次动作不搭（这条记录没有文件路径，却要路径前缀）→ 400，同样不叫模型
    const mismatch = harnessFor([])
    const mismatchDraft = draftHttp('path_prefix')
    await mismatch.handler(mismatchDraft.req, mismatchDraft.res)
    expect(mismatchDraft.state.code).toBe(400)
    expect(JSON.parse(mismatchDraft.state.body).code).toBe('kind-not-applicable')
    expect(mismatch.model.llmCalls).toHaveLength(0)
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

    const calls = []
    const llm = {
      stream(call) {
        calls.push(call)
        return (async function* () {
          yield { text: JSON.stringify({ tool: 'pwsh', match_kind: 'command_prefix', match_value: 'pnpm test', label: 'pnpm 测试' }) }
        })()
      },
    }
    const { ctx, routes } = fakeContext({ llm })
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
    // 单轮调用：一次 llm.stream，system 是规则模板，提示词里带这次的动作与目标名单
    expect(calls).toHaveLength(1)
    expect(calls[0].system).toContain('匹配条件')
    expect(calls[0].messages[0].content[0].text).toContain('pnpm test')
    expect(calls[0].messages[0].content[0].text).toContain('白名单')
    expect(result.optimizedBy).toBe('model')
    expect(result.rule.match).toEqual({ kind: 'command_prefix', value: 'pnpm test' })
    expect(result.rule.source).toBe('model')
  })

  it('单轮优化失败（没有 llm 服务）时如实回落到精确签名', async () => {
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
