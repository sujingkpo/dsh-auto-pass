/**
 * @description dsh-auto-pass 单元测试：覆盖结构化审查协议、Reviewer 创建期隔离、
 *   证据装配、语言自动选择，以及「只自动放行 allow，其余一律转人工审批」的审批语义。
 * @author simon300000
 * @date 2026-08-14
 * @modify 2026-09-15 适配 dsh-auto-pass：deny 与审查失败改为调用 next() 转人工
 */
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  assessmentSchema,
  buildReviewPrompt,
  createAutoApprovalHandler,
  enforceHostPolicy,
  exactAction,
  exactRuleOf,
  parseAssessment,
  parseJsonReply,
  resolveConfig,
  resolveReviewLanguage,
} from '../src/index.js'

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
    }

    blocks() {
      return this.parts.length === 0 ? [] : [{ type: 'text', text: this.parts.join('') }]
    }
  },
}))

function event(type, data, seq) {
  return { type, data, seq, time: seq }
}

function sessionWith(preset = 'auto-approve', overrides = {}) {
  const { directUserText = '请运行测试', ...sessionOverrides } = overrides
  const events = [
    event('permission/preset', { preset }, 0),
    event('user/message', {
      id: 'user-1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: directUserText }],
    }, 1),
    event('user/message', {
      id: 'instructions-1',
      role: 'user',
      source: { kind: 'agent-instructions', form: 'instructions', changes: [] },
      content: [{ type: 'text', text: 'Instructions from: AGENTS.md\n\n只运行项目测试。' }],
    }, 2),
    event('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-1',
        role: 'assistant',
        source: { kind: 'model', provider: 'main', model: 'main' },
        content: [{ type: 'text', text: '我会运行测试。' }],
      },
    }, 3),
    event('tool/call', {
      turn: 1,
      step: 1,
      callId: 'ask-1',
      name: 'ask_user_question',
      arguments: '{"questions":[{"id":"confirm","question":"运行测试？"}]}',
    }, 4),
    event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'ask-1' },
        content: [{ type: 'text', text: '{"answers":[{"id":"confirm","selected":["允许"]}]}' }],
      },
    }, 5),
    event('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'bash',
      arguments: '{"command":"npm test","sandbox_permissions":"danger-full-access","justification":"运行项目测试"}',
    }, 6),
  ]
  return {
    id: 'session-1',
    seq: events.length,
    eventAt: seq => events[seq],
    snapshotEvents: (from = 0, to = events.length) => Object.freeze(events.slice(from, to)),
    header: { cwd: '/workspace' },
    requestHeader: () => ({
      config: { provider: 'reviewer', model: 'safe-model' },
      system: 'MAIN SYSTEM INSTRUCTIONS',
    }),
    ...sessionOverrides,
  }
}

function requestWith(preset = 'auto-approve', overrides = {}) {
  const { sessionOverrides, ...requestOverrides } = overrides
  const agent = {
    session: sessionWith(preset, sessionOverrides),
    options: {},
    inject: vi.fn(),
    cancel: vi.fn(),
  }
  return {
    agent,
    toolName: 'bash',
    callId: 'call-1',
    reason: 'escalate sandbox to danger-full-access: 运行项目测试',
    ...requestOverrides,
  }
}

function languageSession(messages, extraEvents = []) {
  const events = [
    ...messages.map((text, index) => event('user/message', {
      id: `user-${index}`,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    }, index)),
    ...extraEvents,
  ]
  return {
    get seq() { return events.length },
    snapshotEvents: (from = 0, to = events.length) => events.slice(from, to),
    appendDirectUserMessage(text) {
      events.push(event('user/message', {
        id: `user-${events.length}`,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text }],
      }, events.length))
    },
  }
}

function reviewerRun(structured, overrides = {}) {
  return {
    id: 'reviewer-session-1',
    localAgent: {
      session: {
        snapshotEvents: () => [
          event('step/start', { turn: 1, step: 1 }, 0),
          event('tool/call', { turn: 1, step: 1, callId: 'r1', name: 'read', arguments: '{}' }, 1),
          event('step/start', { turn: 1, step: 2 }, 2),
        ],
      },
    },
    result: Promise.resolve({ stopReason: 'completed', structured, output: [] }),
    dispose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

/** 把旧的 reviewerRun(...) 写法转成「模型回复 JSON」的取数函数。 */
function toReply(item) {
  if (typeof item === 'string' || item instanceof Error) return item
  return async () => {
    const result = await item.result
    if (result?.stopReason !== undefined && result.stopReason !== 'completed') {
      throw new Error('模型调用未正常结束：' + result.stopReason)
    }
    return JSON.stringify(result?.structured ?? {})
  }
}

/**
 * 假宿主：llm 服务按顺序吐出排练好的回复。
 * 每个条目可以是字符串（模型回复）、Error（调用失败），或沿用旧的 reviewerRun(...)（转成 JSON 回复）。
 */
function contextWith(replies) {
  const queue = (Array.isArray(replies) ? [...replies] : [replies]).map(toReply)
  const calls = []
  const llm = {
    stream(options) {
      calls.push(options)
      const next = queue.length === 0 ? new Error('没有排练好的模型回复') : queue.shift()
      return (async function* () {
        const value = typeof next === 'function' ? await next() : next
        if (value instanceof Error) throw value
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
          : undefined),
    logger: { info: vi.fn(), warn: vi.fn() },
  }
}

const allow = Object.freeze({
  risk_level: 'low',
  user_authorization: 'high',
  outcome: 'allow',
  rationale: '用户明确要求运行范围内的测试。',
})

const deny = Object.freeze({
  risk_level: 'high',
  user_authorization: 'low',
  outcome: 'deny',
  rationale: '提权范围超过运行测试所需。',
})

const allowEnglish = Object.freeze({
  risk_level: 'low',
  user_authorization: 'high',
  outcome: 'allow',
  rationale: 'The user explicitly requested this test within scope.',
})

describe('结构化审查协议', () => {
  it('只要求 outcome，并为省略字段采用保守且与 Codex 一致的默认值', () => {
    expect(parseAssessment(allow)).toEqual(allow)
    expect(parseAssessment({ outcome: 'allow' })).toEqual({
      risk_level: 'low',
      user_authorization: 'unknown',
      outcome: 'allow',
      rationale: '自动审查返回低风险允许决定。',
    })
    expect(parseAssessment({ outcome: 'deny' })).toEqual({
      risk_level: 'high',
      user_authorization: 'unknown',
      outcome: 'deny',
      rationale: '自动审查返回拒绝决定，但没有提供理由。',
    })
    expect(() => parseAssessment({ ...allow, risk_level: 'urgent' })).toThrow(/risk_level/)
    expect(() => parseAssessment({ ...allow, user_authorization: 'yes' })).toThrow(/user_authorization/)
    expect(parseAssessment({ ...allow, rationale: ' ' }).rationale).toBe('自动审查返回低风险允许决定。')
    expect(() => parseAssessment({ ...allow, confidence: 1 })).toThrow(/未知字段 confidence/)
  })

  it('schema 包含完整字段，但只把 outcome 设为必填', () => {
    expect(assessmentSchema.properties.risk_level.enum).toContain('critical')
    expect(assessmentSchema.properties.user_authorization.enum).toEqual(['unknown', 'low', 'medium', 'high'])
    expect(assessmentSchema.required).toEqual(['outcome'])
  })

  it('宿主把不一致的 allow 降级，但不升级 deny', () => {
    expect(enforceHostPolicy({ ...allow, risk_level: 'critical' }).outcome).toBe('deny')
    expect(enforceHostPolicy({ ...allow, risk_level: 'high', user_authorization: 'low' }).outcome).toBe('deny')
    expect(enforceHostPolicy({ ...allow, risk_level: 'high', user_authorization: 'medium' }).outcome).toBe('allow')
    expect(enforceHostPolicy(deny)).toBe(deny)
  })
})

describe('Auto Approve Reviewer 子 Agent', () => {
  it('只接管 auto-approve，其他档位继续走 Web 人工审批链', async () => {
    const ctx = contextWith(reviewerRun(allow))
    const next = vi.fn().mockResolvedValue('allowed-once')
    const outcome = await createAutoApprovalHandler(ctx, resolveConfig())(requestWith('workspace-write'), next)
    expect(outcome).toBe('allowed-once')
    expect(next).toHaveBeenCalledOnce()
    expect(ctx.llmCalls).toHaveLength(0)
  })

  it('单轮审查：一次 llm.stream 拿结论，不起子代理也不带转录', async () => {
    const ctx = contextWith(JSON.stringify(allow))
    const request = requestWith()
    const config = resolveConfig({
      reviewerProvider: 'deepseek-official',
      reviewerModel: 'deepseek-v4-flash',
      reviewerReasoningEffort: 'high',
    })
    const outcome = await createAutoApprovalHandler(ctx, config)(request, vi.fn())

    expect(outcome).toBe('allowed-once')
    expect(ctx.llmCalls).toHaveLength(1)
    expect(ctx.llmCalls[0]).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      maxTokens: 2_048,
      reasoningEffort: 'high',
      sessionId: 'session-1',
      purpose: 'auto-approve-review',
    })
    // 极简：只带动作 + 最后一条用户消息 + 最近一次人工回答，没有 system / AGENTS / 助手消息 / 工具流水
    const prompt = ctx.llmCalls[0].messages[0].content[0].text
    expect(prompt).toContain('npm test')
    expect(prompt).toContain('请运行测试')
    expect(prompt).toContain('允许')          // ask_user_question 的人工回答
    expect(prompt).toContain('danger-full-access')
    expect(prompt).not.toContain('MAIN SYSTEM INSTRUCTIONS')
    expect(prompt).not.toContain('Instructions from: AGENTS.md')
    expect(prompt).not.toContain('我会运行测试。')
    expect(prompt).not.toContain('justification')
    // 单轮审查的提示词本身也很小（历史上限：一次审查的输入控制在几百 token）
    expect(prompt.length).toBeLessThan(1_500)
    expect(ctx.llmCalls[0].system).toContain('权限审查器')
    expect(ctx.llmCalls[0].system).toContain('中文')
    const notice = request.agent.inject.mock.calls.at(-1)[0]
    // 通知只占一行：会进模型上下文，Reviewer 会话等细节留在时间线与宿主日志里
    expect(notice.content).toHaveLength(1)
    expect(notice.content[0].text.startsWith('[自动]')).toBe(true)
    expect(notice.content[0].text).toContain('自动审批 已自动批准 bash')
    expect(notice.content[0].text).toContain('low/high')
    expect(notice.content[0].text).not.toContain('\n')
    expect(notice.content[0].text).not.toContain('Reviewer 会话')
    // 折叠标题与正文用同一个标签
    expect(notice.source).toMatchObject({ form: 'notice', summary: '[自动] 自动审批：允许' })
  })

  it('模型 deny 时转交人工审批', async () => {
    const ctx = contextWith(reviewerRun(deny))
    const next = vi.fn().mockResolvedValue('rejected')
    const request = requestWith()
    const outcome = await createAutoApprovalHandler(ctx, resolveConfig())(request, next)

    expect(outcome).toBe('rejected')
    expect(ctx.llmCalls).toHaveLength(1)
    expect(next).toHaveBeenCalledOnce()
    expect(request.agent.cancel).not.toHaveBeenCalled()
    const notice = request.agent.inject.mock.calls.at(-1)[0]
    expect(notice.content[0].text.startsWith('[人工]')).toBe(true)
    expect(notice.content[0].text).toContain('自动审批 未自动批准 bash，已转交你审批')
    expect(notice.content[0].text).not.toContain('\n')
    expect(notice.content[0].text).toContain('理由：提权范围超过运行测试所需。')
    expect(notice.source.summary).toBe('[人工] 自动审批：转交人工审批')
  })

  it('子 Agent 异常、无 structured 输出或缺少精确动作时一律转人工审批', async () => {
    const failedRun = reviewerRun(undefined, {
      result: Promise.resolve({ stopReason: 'error', output: [] }),
    })
    const ctx = contextWith(failedRun)
    const failedNext = vi.fn().mockResolvedValue('allowed-once')
    const failedRequest = requestWith()
    expect(await createAutoApprovalHandler(ctx, resolveConfig())(failedRequest, failedNext)).toBe('allowed-once')
    expect(ctx.llmCalls).toHaveLength(1)
    expect(failedNext).toHaveBeenCalledOnce()
    expect(failedRequest.agent.inject.mock.calls.at(-1)[0].content[0].text)
      .toContain('自动审查未能完成，已转人工审批：模型调用未正常结束：error')

    const missing = requestWith('auto-approve', { callId: undefined })
    const missingNext = vi.fn().mockResolvedValue('rejected')
    expect(await createAutoApprovalHandler(ctx, resolveConfig())(missing, missingNext)).toBe('rejected')
    expect(missingNext).toHaveBeenCalledOnce()
    expect(missing.agent.inject.mock.calls.at(-1)[0].content[0].text)
      .toContain('理由：找不到待审批工具调用的精确参数。')
    // 拿不到精确动作时不建签名、也不调模型：只消耗了一条排练回复（第一次审查用掉）
    expect(ctx.llmCalls).toHaveLength(1)
  })

  it('自动放行的审批写入一条 allow 记录', async () => {
    const ctx = contextWith(reviewerRun(allow))
    const records = { add: vi.fn(), list: () => [], size: () => 0 }
    const request = requestWith()
    const outcome = await createAutoApprovalHandler(
      ctx,
      resolveConfig({ reviewerProvider: 'reviewer', reviewerModel: 'safe-model' }),
      records,
    )(request, vi.fn())

    expect(outcome).toBe('allowed-once')
    expect(records.add).toHaveBeenCalledOnce()
    const entry = records.add.mock.calls[0][0]
    expect(entry).toMatchObject({
      sessionId: 'session-1',
      toolName: 'bash',
      callId: 'call-1',
      reason: 'escalate sandbox to danger-full-access: 运行项目测试',
      verdict: 'allow',
      outcome: 'allowed-once',
      riskLevel: 'low',
      userAuthorization: 'high',
      rationale: allow.rationale,
      steps: 0,
      route: { provider: 'reviewer', model: 'safe-model' },
      // 插件自己决定的：时间线与通知都显示「自动」
      decidedBy: 'auto',
    })
    expect(typeof entry.latencyMs).toBe('number')
    expect(entry.action).toContain('npm test')
    expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('转人工的审批等人工答复后再记录，并带上人工侧结果', async () => {
    const ctx = contextWith(reviewerRun(deny))
    const records = { add: vi.fn(), list: () => [], size: () => 0 }
    const next = vi.fn().mockResolvedValue('allowed-once')
    const outcome = await createAutoApprovalHandler(ctx, resolveConfig(), records)(requestWith(), next)

    expect(outcome).toBe('allowed-once')
    expect(next).toHaveBeenCalledOnce()
    expect(records.add).toHaveBeenCalledOnce()
    expect(records.add.mock.calls[0][0]).toMatchObject({
      verdict: 'deny',
      outcome: 'allowed-once',
      // 结论来自人工审批链（先被模型拒绝，再交用户放行）：显示「人工」
      decidedBy: 'human',
      riskLevel: 'high',
      userAuthorization: 'low',
    })
  })

  it('拿不到精确动作时记 defer，人工结果原样返回', async () => {
    const ctx = contextWith([])
    const records = { add: vi.fn(), list: () => [], size: () => 0 }
    const next = vi.fn().mockResolvedValue('rejected')
    const outcome = await createAutoApprovalHandler(ctx, resolveConfig(), records)(
      requestWith('auto-approve', { callId: undefined }),
      next,
    )

    expect(outcome).toBe('rejected')
    expect(ctx.llmCalls).toHaveLength(0)
    expect(records.add.mock.calls[0][0]).toMatchObject({ verdict: 'defer', outcome: 'rejected', steps: 0, decidedBy: 'human' })
  })

  it('写入记录抛错也不改变审批结论', async () => {
    const ctx = contextWith(reviewerRun(allow))
    const records = {
      add: vi.fn(() => { throw new Error('disk full') }),
      list: () => [],
      size: () => 0,
    }
    const request = requestWith()
    const outcome = await createAutoApprovalHandler(ctx, resolveConfig(), records)(request, vi.fn())

    expect(outcome).toBe('allowed-once')
    expect(records.add).toHaveBeenCalledOnce()
    expect(request.agent.inject).toHaveBeenCalled()
  })

  it('连续多次 deny 不再中断 turn，每次都会转交人工审批', async () => {
    const runs = [reviewerRun(deny), reviewerRun(deny), reviewerRun(deny)]
    const ctx = contextWith(runs)
    const request = requestWith()
    const handler = createAutoApprovalHandler(ctx, resolveConfig())
    const next = vi.fn().mockResolvedValue('allowed-once')

    for (let index = 0; index < 3; index += 1) {
      expect(await handler(request, next)).toBe('allowed-once')
    }
    expect(next).toHaveBeenCalledTimes(3)
    expect(request.agent.cancel).not.toHaveBeenCalled()
    const notice = request.agent.inject.mock.calls.at(-1)[0]
    expect(notice.content[0].text).not.toContain('连续拒绝')
    expect(notice.content[0].text).not.toContain('中断')
  })
})


describe('输入装配与配置', () => {
  it('默认总时限为 90 秒并校验正整数', () => {
    expect(resolveConfig()).toMatchObject({
      language: 'auto',
      timeoutMs: 90_000,
      maxEvidenceChars: 400,
      maxActionChars: 16_000,
      maxOutputTokens: 2_048,
    })
    // 单轮审查后不再需要转录/调查预算这些键；profile 里旧值原样传进来也不报错
    expect(resolveConfig({ maxTranscriptTokens: 1, maxInvestigationSteps: 4 }))
      .toMatchObject({ maxEvidenceChars: 400 })
    expect(() => resolveConfig({ maxActionChars: 0 })).toThrow(/正整数/)
    expect(resolveConfig()).not.toHaveProperty('maxConsecutiveDenials')
    expect(() => resolveConfig({ reviewerReasoningEffort: ' ' })).toThrow(/reviewerReasoningEffort/)
    const warn = vi.fn()
    expect(resolveConfig({ language: 'ja' }, warn).language).toBe('auto')
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/language=ja.*auto/))

    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn() },
      on: vi.fn(() => vi.fn()),
      inject: vi.fn(),
    }
    apply(ctx, { language: 'invalid' })
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/language=invalid.*auto/))
  })

  it('精确动作保留 turn、step、原始参数、审批原因和 cwd', () => {
    expect(exactAction(requestWith())).toEqual({
      toolName: 'bash',
      callId: 'call-1',
      turn: 1,
      step: 1,
      arguments: '{"command":"npm test","sandbox_permissions":"danger-full-access","justification":"运行项目测试"}',
      approvalReason: 'escalate sandbox to danger-full-access: 运行项目测试',
      cwd: '/workspace',
    })
  })

  it('ptc 子调用：审批请求带派生 id 时回退到 tool/ptc-dispatch-start', () => {
    const events = [
      event('tool/call', {
        turn: 3,
        step: 2,
        callId: 'call-parent',
        name: 'run_code',
        arguments: '{"code":"await tools.pwsh({ command: \"git push\" })"}',
      }, 0),
      event('tool/ptc-dispatch-start', {
        rootCallId: 'call-parent',
        parentCallId: 'call-parent',
        subCallId: 'call-parent:ptc:1',
        name: 'pwsh',
        arguments: {
          command: 'git push',
          sandbox_permissions: 'danger-full-access',
          justification: '推送提交',
        },
      }, 1),
    ]
    const session = {
      id: 'session-ptc',
      seq: events.length,
      eventAt: seq => events[seq],
      snapshotEvents: () => events,
      header: { cwd: '/workspace' },
    }
    const request = {
      agent: { session },
      toolName: 'pwsh',
      callId: 'call-parent:ptc:1',
      reason: 'escalate sandbox to danger-full-access: 推送提交',
    }

    expect(exactAction(request)).toEqual({
      toolName: 'pwsh',
      callId: 'call-parent:ptc:1',
      turn: 3,
      step: 2,
      arguments: {
        command: 'git push',
        sandbox_permissions: 'danger-full-access',
        justification: '推送提交',
      },
      approvalReason: 'escalate sandbox to danger-full-access: 推送提交',
      cwd: '/workspace',
      subCallId: 'call-parent:ptc:1',
      parentCallId: 'call-parent',
      parentToolName: 'run_code',
    })
    // 派生 id 对不上、或工具名对不上时，仍然拒绝猜测
    expect(exactAction({ ...request, callId: 'call-parent:ptc:9' })).toBeUndefined()
    expect(exactAction({ ...request, toolName: 'bash' })).toBeUndefined()
  })

  it('极简证据：只带最后一条用户消息与最近一次人工回答', () => {
    const request = requestWith()
    const prompt = buildReviewPrompt({
      request,
      action: exactAction(request),
      signature: { toolName: 'bash', key: 'bash:npm test', text: 'bash · npm test', command: 'npm test', paths: [] },
      config: resolveConfig(),
      language: 'zh',
    })
    expect(prompt).toContain('待执行的工具调用')
    expect(prompt).toContain('npm test')
    // 用户最后一条消息 + 最近一次 ask_user_question 的人工回答
    expect(prompt).toContain('请运行测试')
    expect(prompt).toContain('允许')
    // 不带 system / AGENTS / 助手消息 / 工具流水 / 权限快照
    expect(prompt).not.toContain('MAIN SYSTEM INSTRUCTIONS')
    expect(prompt).not.toContain('Instructions from: AGENTS.md')
    expect(prompt).not.toContain('我会运行测试。')
    expect(prompt).not.toContain('trusted_for_authorization')
    expect(prompt).not.toContain('justification')
    expect(prompt.length).toBeLessThan(1_500)
  })

  it('证据按 maxEvidenceChars 截断', () => {
    const request = requestWith('auto-approve', {
      sessionOverrides: { directUserText: 'x'.repeat(1_000) },
    })
    const prompt = buildReviewPrompt({
      request,
      action: exactAction(request),
      signature: { toolName: 'bash', key: 'k', text: 't' },
      config: resolveConfig({ maxEvidenceChars: 50 }),
      language: 'zh',
    })
    expect(prompt).toContain('x'.repeat(49) + '…')
    expect(prompt.length).toBeLessThan(400)
  })

  it('ptc 档位：内层 ask_user_question 的人工回答仍然算授权证据', () => {
    const events = [
      event('user/message', { id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我跑测试' }] }, 0),
      event('tool/call', { turn: 1, step: 1, callId: 'call-parent', name: 'run_code', arguments: '{"code":"..."}' }, 1),
      event('tool/ptc-dispatch-start', {
        rootCallId: 'call-parent', parentCallId: 'call-parent', subCallId: 'call-parent:ptc:1',
        name: 'pwsh', arguments: { command: 'git push' },
      }, 2),
      event('tool/ptc-dispatch', {
        rootCallId: 'call-parent', parentCallId: 'call-parent', subCallId: 'call-parent:ptc:2',
        name: 'ask_user_question', arguments: { questions: [] }, isError: false,
        content: [{ type: 'text', text: '用户选了：可以推送' }],
      }, 3),
    ]
    const session = {
      id: 'session-ptc',
      seq: events.length,
      eventAt: seq => events[seq],
      snapshotEvents: () => events,
      header: { cwd: '/workspace' },
      requestHeader: () => ({ system: 'MAIN SYSTEM INSTRUCTIONS' }),
    }
    const request = { agent: { session }, toolName: 'pwsh', callId: 'call-parent:ptc:1', reason: 'escalate' }
    const prompt = buildReviewPrompt({
      request,
      action: exactAction(request),
      signature: { toolName: 'pwsh', key: 'pwsh:git push', text: 'pwsh · git push', command: 'git push' },
      config: resolveConfig(),
      language: 'zh',
    })
    expect(prompt).toContain('帮我跑测试')
    expect(prompt).toContain('用户选了：可以推送')
    expect(prompt).toContain('git push')
  })
})

describe('审查语言自动选择', () => {
  it('自动模式累计直接用户消息中的汉字，超过三个才选择中文', () => {
    expect(resolveReviewLanguage(languageSession(['中文测']))).toBe('en')
    expect(resolveReviewLanguage(languageSession(['中文', '测试']))).toBe('zh')
    expect(resolveReviewLanguage(languageSession(['𠀀一二三']))).toBe('zh')
  })

  it('在追加式 session 上增量累计新消息', () => {
    const session = languageSession(['中文测'])
    expect(resolveReviewLanguage(session)).toBe('en')
    session.appendDirectUserMessage('试')
    expect(resolveReviewLanguage(session)).toBe('zh')
  })

  it('忽略 Agent 指令、助手消息和工具结果中的中文', () => {
    const ignored = [
      event('user/message', {
        source: { kind: 'agent-instructions' },
        content: [{ type: 'text', text: '这里有很多中文字符' }],
      }, 1),
      event('assistant/message', {
        message: { content: [{ type: 'text', text: '这里也有很多中文字符' }] },
      }, 2),
      event('tool/result', {
        message: { content: [{ type: 'text', text: '工具返回中文字符' }] },
      }, 3),
    ]
    expect(resolveReviewLanguage(languageSession(['Please run tests'], ignored))).toBe('en')
  })

  it('zh 和 en 配置会覆盖自动判断', () => {
    expect(resolveReviewLanguage(languageSession(['Please run tests']), 'zh')).toBe('zh')
    expect(resolveReviewLanguage(languageSession(['请帮我运行全部测试']), 'en')).toBe('en')
  })

  it('英文会话使用英文提示、通知与转交理由', async () => {
    const ctx = contextWith(reviewerRun(allowEnglish))
    const request = requestWith('auto-approve', {
      sessionOverrides: { directUserText: 'Please run the tests' },
    })
    expect(await createAutoApprovalHandler(ctx, resolveConfig())(request, vi.fn())).toBe('allowed-once')

    const call = ctx.llmCalls[0]
    // 审查 system 模板固定是中文那份（语言只影响「理由用什么语言写」，在模板里替换）
    expect(call.system).toContain('权限审查器')
    expect(call.system).toContain('the language used by the direct user message')
    expect(call.messages[0].content[0].text).toContain('The tool call awaiting approval')
    expect(call.messages[0].content[0].text).not.toContain('待执行的工具调用')
    const notice = request.agent.inject.mock.calls.at(-1)[0]
    expect(notice.content[0].text.startsWith('[auto]')).toBe(true)
    expect(notice.content[0].text).toContain('Auto Approve allowed bash')
    expect(notice.content[0].text).not.toContain('Reviewer session')
    expect(notice.content[0].text).not.toContain('\n')
    expect(notice.content[0].text).toContain('Rationale: The user explicitly requested')
    expect(notice.source.summary).toBe('[auto] Auto Approve: allowed')

    const failed = requestWith('auto-approve', {
      callId: undefined,
      sessionOverrides: { directUserText: 'Please run the tests' },
    })
    const failedNext = vi.fn().mockResolvedValue('rejected')
    expect(await createAutoApprovalHandler(contextWith(reviewerRun(allowEnglish)), resolveConfig())(failed, failedNext))
      .toBe('rejected')
    expect(failedNext).toHaveBeenCalledOnce()
    const deferredNotice = failed.agent.inject.mock.calls.at(-1)[0]
    expect(deferredNotice.content[0].text.startsWith('[human]')).toBe(true)
    expect(deferredNotice.content[0].text)
      .toContain('Auto Approve did not allow bash; handed to you')
    expect(deferredNotice.content[0].text)
      .toContain('Rationale: The exact tool call awaiting approval could not be found.')
    expect(deferredNotice.source.summary).toBe('[human] Auto Approve: deferred to the user')

    const denied = requestWith('auto-approve', {
      sessionOverrides: { directUserText: 'Please run the tests' },
    })
    const deniedNext = vi.fn().mockResolvedValue('allowed-once')
    expect(await createAutoApprovalHandler(
      contextWith(reviewerRun({ ...deny, rationale: 'Out of scope.' })),
      resolveConfig(),
    )(denied, deniedNext)).toBe('allowed-once')
    expect(deniedNext).toHaveBeenCalledOnce()
    expect(denied.agent.inject.mock.calls.at(-1)[0].content[0].text).toContain('Rationale: Out of scope.')
  })
})
