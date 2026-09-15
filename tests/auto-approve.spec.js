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

/**
 * 等一轮宏任务：拒绝理由追问是**旁路**注入（finish 不 await 它），断言注入结果前要让它跑完。
 */
function flush() {
  return new Promise(resolve => setTimeout(resolve, 0))
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

/**
 * 假宿主：llm 服务按顺序吐出排练好的回复。
 * 每个条目可以是字符串（模型回复）、Error（调用失败），或沿用旧的 reviewerRun(...)（转成 JSON 回复）。
 */
function contextWith(replies, options = {}) {
  const queue = (Array.isArray(replies) ? [...replies] : [replies]).map(toReply)
  const calls = []
  const llm = {
    stream(options) {
      calls.push(options)
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
          // 设置命名空间（options.settings 给了就当作宿主已注册，用来验证行为开关）
          : name === 'settings' && options.settings !== undefined
            ? { get: () => options.settings }
            // 人工追问通道（规则确认 / 拒绝理由追问）：给了就当作有人在应答
            : name === 'userQuestions' && options.userQuestions !== undefined
              ? options.userQuestions
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
    // 自动放行的结果当场就有了：正文要写明「最终结果：已批准」
    expect(notice.content[0].text).toContain('最终结果：已批准')
    expect(notice.content[0].text).not.toContain('\n')
    expect(notice.content[0].text).not.toContain('Reviewer 会话')
    // 折叠标题与正文用同一个标签
    expect(notice.source).toMatchObject({ form: 'notice', summary: '[自动] 自动审批：已批准' })
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
    // 通知改到审批结束后注入：正文带上人工链的最终结论（this case: 人工拒绝）
    expect(notice.content[0].text).toContain('最终结果：已拒绝')
    expect(notice.source.summary).toBe('[人工] 自动审批：已转人工审批')
  })

  it('人工拒绝后追问理由：默认选项就是模型意见，回答作为第二行注入并回写记录', async () => {
    const request = requestWith()
    const records = { add: vi.fn(() => ({ id: 'record-1' })), update: vi.fn(), list: () => [], size: () => 0 }
    const userQuestions = {
      ask: vi.fn().mockResolvedValue({
        answers: [{ id: 'dsh-auto-pass:reject-reason', selected: ['采用模型意见：提权范围超过运行测试所需。'] }],
      }),
    }
    const outcome = await createAutoApprovalHandler(
      contextWith(reviewerRun(deny), { userQuestions }),
      resolveConfig(),
      records,
    )(request, vi.fn().mockResolvedValue('rejected'))
    await flush()

    expect(outcome).toBe('rejected')
    // 第一行照旧是结果（不阻塞工具调用），第二行才是人工补的理由
    const injected = request.agent.inject.mock.calls.map(call => call[0])
    expect(injected).toHaveLength(2)
    expect(injected[0].content[0].text).toContain('最终结果：已拒绝')
    expect(injected[1].content[0].text).toBe('[人工] 人工拒绝理由：提权范围超过运行测试所需。')
    expect(injected[1].source).toMatchObject({ form: 'notice', summary: '[人工] 自动审批：拒绝理由' })
    // 追问卡：agent 是父 Agent，第一项采用模型意见、最后一项是不留言
    const asked = userQuestions.ask.mock.calls[0][0]
    expect(asked.agent).toBe(request.agent)
    expect(asked.questions[0].options.map(option => option.label)).toEqual([
      '采用模型意见：提权范围超过运行测试所需。',
      '不留言',
    ])
    // 理由同时回写进审批记录（时间线详情里能看到「人工拒绝理由」）
    expect(records.update).toHaveBeenCalledWith('record-1', { rejectReason: '提权范围超过运行测试所需。' })
  })

  it('追问理由只看 askRejectReason：设置关掉、自动放行不追问；notice 关掉不连带（只少结果行）', async () => {
    const offRequest = requestWith()
    const offQuestions = { ask: vi.fn() }
    await createAutoApprovalHandler(
      contextWith(reviewerRun(deny), { settings: { notice: true, askRejectReason: false }, userQuestions: offQuestions }),
      resolveConfig(),
    )(offRequest, vi.fn().mockResolvedValue('rejected'))
    await flush()
    expect(offQuestions.ask).not.toHaveBeenCalled()
    expect(offRequest.agent.inject).toHaveBeenCalledOnce()

    // notice 不是总开关：关掉后结果行不注入，但「拒绝理由」照问、第二行照注入
    const quietRequest = requestWith()
    const quietQuestions = {
      ask: vi.fn().mockResolvedValue({
        answers: [{ id: 'dsh-auto-pass:reject-reason', selected: ['采用模型意见：提权范围超过运行测试所需。'] }],
      }),
    }
    await createAutoApprovalHandler(
      contextWith(reviewerRun(deny), { settings: { notice: false, askRejectReason: true }, userQuestions: quietQuestions }),
      resolveConfig(),
    )(quietRequest, vi.fn().mockResolvedValue('rejected'))
    await flush()
    expect(quietQuestions.ask).toHaveBeenCalledOnce()
    const quietInjected = quietRequest.agent.inject.mock.calls.map(call => call[0])
    expect(quietInjected).toHaveLength(1)
    expect(quietInjected[0].content[0].text).toBe('[人工] 人工拒绝理由：提权范围超过运行测试所需。')

    // 自动放行没有「拒绝理由」可问
    const allowRequest = requestWith()
    const allowQuestions = { ask: vi.fn() }
    await createAutoApprovalHandler(
      contextWith(reviewerRun(allow), { userQuestions: allowQuestions }),
      resolveConfig(),
    )(allowRequest, vi.fn())
    await flush()
    expect(allowQuestions.ask).not.toHaveBeenCalled()
    expect(allowRequest.agent.inject).toHaveBeenCalledOnce()
  })

  it('追问支持自由文本与「不留言」；问不到人时只记日志、结论不变', async () => {
    // 自由文本优先：原生问题卡在有自定义答案时会把 selected 清空，只把文本放进 custom
    const typedRequest = requestWith()
    const typedQuestions = {
      ask: vi.fn().mockResolvedValue({
        answers: [{ id: 'dsh-auto-pass:reject-reason', selected: [], custom: '这次不需要提权，先别动。' }],
      }),
    }
    await createAutoApprovalHandler(
      contextWith(reviewerRun(deny), { userQuestions: typedQuestions }),
      resolveConfig(),
    )(typedRequest, vi.fn().mockResolvedValue('rejected'))
    await flush()
    expect(typedRequest.agent.inject.mock.calls.at(-1)[0].content[0].text)
      .toBe('[人工] 人工拒绝理由：这次不需要提权，先别动。')

    // 选「不留言」：只留结果那一行
    const skipRequest = requestWith()
    const skipQuestions = {
      ask: vi.fn().mockResolvedValue({
        answers: [{ id: 'dsh-auto-pass:reject-reason', selected: ['不留言'] }],
      }),
    }
    await createAutoApprovalHandler(
      contextWith(reviewerRun(deny), { userQuestions: skipQuestions }),
      resolveConfig(),
    )(skipRequest, vi.fn().mockResolvedValue('rejected'))
    await flush()
    expect(skipQuestions.ask).toHaveBeenCalledOnce()
    expect(skipRequest.agent.inject).toHaveBeenCalledOnce()

    // 没有 userQuestions 服务（子 Agent / 无人应答）：只记日志，审批结论与结果通知都不受影响
    const offlineRequest = requestWith()
    const offlineCtx = contextWith(reviewerRun(deny))
    const outcome = await createAutoApprovalHandler(offlineCtx, resolveConfig())(
      offlineRequest,
      vi.fn().mockResolvedValue('rejected'),
    )
    await flush()
    expect(outcome).toBe('rejected')
    expect(offlineRequest.agent.inject).toHaveBeenCalledOnce()
    expect(offlineCtx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('跳过拒绝理由追问'))
  })

  it('追问理由与规则确认串行：前一张问题卡答完才挂下一张', async () => {
    const request = requestWith()
    const signature = signatureOf(request, exactAction(request))
    // 达阈值给出黑名单建议：这次审批同时欠两张问题卡（拒绝理由 + 规则确认）
    const policies = {
      match: () => undefined,
      observe: () => ({ approvals: 0, denials: 0, suggestion: { list: 'deny', count: 3 } }),
      dismiss: vi.fn(),
      addRule: vi.fn(() => ({ ok: false, error: 'not used' })),
    }
    const events = []
    let releaseReason
    const userQuestions = {
      ask: vi.fn(askRequest => {
        events.push(askRequest.questions[0].id)
        // 第一张卡（拒绝理由）先挂起：规则确认必须等它答完才发出
        if (events.length === 1) {
          return new Promise(resolve => {
            releaseReason = () => resolve({
              answers: [{ id: 'dsh-auto-pass:reject-reason', selected: ['不留言'] }],
            })
          })
        }
        return Promise.resolve({ answers: [] })
      }),
    }
    const records = { add: vi.fn(() => ({ id: 'record-1' })), update: vi.fn(), list: () => [], size: () => 0 }
    await createAutoApprovalHandler(
      contextWith(reviewerRun(deny), { userQuestions }),
      resolveConfig(),
      records,
      policies,
    )(request, vi.fn().mockResolvedValue('rejected'))
    await flush()

    // 串行：第一张卡还没答，第二张卡不许发出
    expect(events).toEqual(['dsh-auto-pass:reject-reason'])
    expect(userQuestions.ask).toHaveBeenCalledOnce()

    releaseReason()
    await flush()
    expect(events).toEqual(['dsh-auto-pass:reject-reason', 'dsh-auto-pass:deny'])
    expect(userQuestions.ask).toHaveBeenCalledTimes(2)
    // 规则确认照旧落盘/记结果：串行不改变任何一条旁路流程的结论
    expect(policies.dismiss).toHaveBeenCalledOnce()
  })

  it('插件自己判的拒绝（黑名单直接拒绝）不追问：没有人参与，也就没有人能回答', async () => {
    const request = requestWith()
    const signature = signatureOf(request, exactAction(request))
    const policies = {
      match: () => ({ list: 'deny', scope: 'global', file: 'x', rule: { id: 'rule-1', label: signature.text, source: 'user', match: { kind: 'signature', value: signature.key } } }),
      observe: () => ({ approvals: 0, denials: 0, suggestion: null }),
    }
    const userQuestions = { ask: vi.fn() }
    const records = { add: vi.fn(() => ({ id: 'record-1' })), update: vi.fn(), list: () => [], size: () => 0 }
    const outcome = await createAutoApprovalHandler(
      contextWith([], { settings: { notice: true, denyDirect: true }, userQuestions }),
      resolveConfig(),
      records,
      policies,
    )(request, vi.fn())
    await flush()

    expect(outcome).toBe('rejected')
    expect(userQuestions.ask).not.toHaveBeenCalled()
    expect(records.update).not.toHaveBeenCalled()
    // 插件自己判的拒绝：没有人参与这次判断，标签必须是「黑名单·自动」
    expect(records.add.mock.calls[0][0].decidedBy).toBe('auto')
    expect(request.agent.inject.mock.calls[0][0].content[0].text.startsWith('[黑名单·自动]')).toBe(true)
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
      // 第几轮第几步：审批记录要能定位回对话里的那一步
      turn: 1,
      step: 1,
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

  it('转人工时把模型意见写到审批卡首行，并保留调用方给的提权原文', async () => {
    const ctx = contextWith(reviewerRun(deny))
    const request = requestWith()
    const next = vi.fn().mockResolvedValue('rejected')
    const outcome = await createAutoApprovalHandler(ctx, resolveConfig())(request, next)

    expect(outcome).toBe('rejected')
    expect(next).toHaveBeenCalledOnce()
    // DSH 的人工审批卡首行渲染的就是 req.reason（dsh-client-ui-approval 的 headline）：
    // 版式 =「调用方原文 + 空行 + 模型审批意见」，换行由客户端注入的 pre-wrap 打开
    expect(request.reason.startsWith('escalate sandbox to danger-full-access: 运行项目测试\n\n模型审批意见：')).toBe(true)
    expect(request.reason).toContain(deny.rationale)
    // 调用方原本的提权说明不能被覆盖掉
    expect(request.reason).toContain('escalate sandbox to danger-full-access: 运行项目测试')
  })

  it('拿不到精确动作而转人工时，审批卡首行带上转交理由', async () => {
    const request = requestWith('auto-approve', { callId: undefined })
    const next = vi.fn().mockResolvedValue('rejected')
    await createAutoApprovalHandler(contextWith([]), resolveConfig())(request, next)

    expect(request.reason.startsWith('escalate sandbox to danger-full-access: 运行项目测试\n\n')).toBe(true)
    expect(request.reason).toContain('自动审批：找不到待审批工具调用的精确参数。')
  })

  it('调用方没给 reason 时，首行只留意见那一段', async () => {
    const request = requestWith('auto-approve', { callId: undefined, reason: undefined })
    const next = vi.fn().mockResolvedValue('rejected')
    await createAutoApprovalHandler(contextWith([]), resolveConfig())(request, next)

    expect(request.reason).toBe('自动审批：找不到待审批工具调用的精确参数。')
  })

  it('审查失败转人工时，审批卡首行带上失败原因', async () => {
    const ctx = contextWith(new Error('模型服务不可用'))
    const request = requestWith()
    const next = vi.fn().mockResolvedValue('rejected')
    await createAutoApprovalHandler(ctx, resolveConfig())(request, next)

    expect(request.reason).toContain('自动审批：自动审查未能完成，已转人工审批：模型服务不可用')
  })

  it('自动放行时不改审批请求的理由（本来也不会弹卡）', async () => {
    const request = requestWith()
    expect(await createAutoApprovalHandler(contextWith(reviewerRun(allow)), resolveConfig())(request, vi.fn()))
      .toBe('allowed-once')
    expect(request.reason).toBe('escalate sandbox to danger-full-access: 运行项目测试')
  })

  it('审查模型的 token 用量写进审批记录', async () => {
    const usage = { inputTokens: 1200, outputTokens: 40, totalTokens: 1240, cacheReadTokens: 800 }
    const ctx = contextWith(reviewerRun(allow, { usage }))
    const records = { add: vi.fn(), list: () => [], size: () => 0 }
    await createAutoApprovalHandler(ctx, resolveConfig(), records)(requestWith(), vi.fn())

    expect(records.add.mock.calls[0][0].usage).toEqual(usage)
    // 用量也写进宿主日志，排查时不用翻记录文件
    expect(ctx.logger.info.mock.calls.map(call => call[0]).join('\n')).toContain('tokens=in=1200 out=40')
  })

  it('提供方没给用量时，记录里不出现 usage 字段', async () => {
    const ctx = contextWith(reviewerRun(allow))
    const records = { add: vi.fn(), list: () => [], size: () => 0 }
    await createAutoApprovalHandler(ctx, resolveConfig(), records)(requestWith(), vi.fn())

    expect('usage' in records.add.mock.calls[0][0]).toBe(false)
  })

  it('回复不合法而转人工时，已经烧掉的 token 仍记进记录', async () => {
    const usage = { inputTokens: 900, outputTokens: 30 }
    const ctx = contextWith([{ text: '这不是 JSON', usage }])
    const records = { add: vi.fn(), list: () => [], size: () => 0 }
    await createAutoApprovalHandler(ctx, resolveConfig(), records)(requestWith(), vi.fn().mockResolvedValue('rejected'))

    const record = records.add.mock.calls[0][0]
    expect(record.verdict).toBe('defer')
    expect(record.usage).toEqual(usage)
  })

  it('英文会话用英文前缀', async () => {
    const ctx = contextWith(reviewerRun({ ...deny, rationale: 'Escalation exceeds the request.' }))
    const request = requestWith('auto-approve', { sessionOverrides: { directUserText: 'Please run the tests' } })
    const next = vi.fn().mockResolvedValue('rejected')
    await createAutoApprovalHandler(ctx, resolveConfig())(request, next)

    expect(request.reason).toContain('\n\nModel review: Escalation exceeds the request.')
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

  it('设置里关掉通知注入后，上下文里不再写任何审批结果（审批结论不变）', async () => {
    const request = requestWith()
    const outcome = await createAutoApprovalHandler(
      contextWith(reviewerRun(allow)),
      resolveConfig({ notice: false }),
    )(request, vi.fn())

    expect(outcome).toBe('allowed-once')
    expect(request.agent.inject).not.toHaveBeenCalled()
  })

  it('设置页的开关优先于插件 config：settings.notice 为 true 时照旧注入', async () => {
    const request = requestWith()
    const cfg = resolveConfig({
      notice: false,
      reviewerProvider: 'reviewer',
      reviewerModel: 'safe-model',
    })
    const outcome = await createAutoApprovalHandler(
      contextWith(reviewerRun(allow), { settings: { notice: true, denyDirect: false } }),
      cfg,
    )(request, vi.fn())

    expect(outcome).toBe('allowed-once')
    const notice = request.agent.inject.mock.calls.at(-1)[0]
    expect(notice.content[0].text).toContain('最终结果：已批准')
  })

  it('黑名单直接拒绝（设置开启）：不弹人工审批卡，直接返回 rejected 并记一条 blacklist-reject', async () => {
    const request = requestWith()
    const signature = signatureOf(request, exactAction(request))
    // 最小策略替身：命中黑名单（真实匹配逻辑由 tests/policy.spec.js 覆盖）
    const policies = {
      match: () => ({ list: 'deny', scope: 'global', file: 'x', rule: { id: 'rule-1', label: signature.text, source: 'user', match: { kind: 'signature', value: signature.key } } }),
      observe: () => ({ approvals: 0, denials: 0, suggestion: null }),
    }
    const records = { add: vi.fn(), list: () => [], size: () => 0 }
    const next = vi.fn().mockResolvedValue('allowed-once')
    const outcome = await createAutoApprovalHandler(
      contextWith([], { settings: { notice: true, denyDirect: true } }),
      resolveConfig(),
      records,
      policies,
    )(request, next)

    // 关键语义：命中黑名单直接判为拒绝，人工审批链完全不被调用
    expect(outcome).toBe('rejected')
    expect(next).not.toHaveBeenCalled()
    // 审批卡不会弹出，但理由仍写进 reason（时间线与日志都看得到为什么拒绝）
    expect(request.reason).toContain('黑名单，已直接拒绝')
    const record = records.add.mock.calls[0][0]
    expect(record.verdict).toBe('blacklist-reject')
    expect(record.outcome).toBe('rejected')
    expect(record.policy.list).toBe('deny')
    // 插件自己决定的拒绝：标签是「黑名单·人工」以外的形态——结论不是人工给的，最终结果记「已批准」之外的拒绝
    const notice = request.agent.inject.mock.calls.at(-1)[0]
    expect(notice.content[0].text).toContain('自动审批 已直接拒绝 bash')
    expect(notice.content[0].text).toContain('最终结果：已拒绝')
  })

  it('黑名单直接拒绝默认关闭：设置没写时仍然转人工', async () => {
    const request = requestWith()
    const signature = signatureOf(request, exactAction(request))
    const policies = {
      match: () => ({ list: 'deny', scope: 'global', file: 'x', rule: { id: 'rule-1', label: signature.text, source: 'user', match: { kind: 'signature', value: signature.key } } }),
      observe: () => ({ approvals: 0, denials: 0, suggestion: null }),
    }
    const next = vi.fn().mockResolvedValue('rejected')
    expect(await createAutoApprovalHandler(contextWith([]), resolveConfig(), undefined, policies)(request, next))
      .toBe('rejected')
    expect(next).toHaveBeenCalledOnce()
  })

  it('行为开关每次审批重新读设置：handler 建好之后再打开 denyDirect 也立刻生效', async () => {
    const request = requestWith()
    const signature = signatureOf(request, exactAction(request))
    const policies = {
      match: () => ({ list: 'deny', scope: 'global', file: 'x', rule: { id: 'rule-1', label: signature.text, source: 'user', match: { kind: 'signature', value: signature.key } } }),
      observe: () => ({ approvals: 0, denials: 0, suggestion: null }),
    }
    const records = { add: vi.fn(), list: () => [], size: () => 0 }
    // 同一个 settings 对象：先在「关」的状态下建好 handler，再把开关翻成「开」。
    // 回归点：旧实现把三个开关提到 handler 外面求值，那时 settings 还没就绪（`apply()` 里
    // `installSettings` 排在 handler 创建之后），开关会静默退回默认值——这条用例必须看到
    // 翻转立刻生效，且黑名单不再转人工。
    const settings = { notice: true, denyDirect: false }
    const handler = createAutoApprovalHandler(contextWith([], { settings }), resolveConfig(), records, policies)
    settings.denyDirect = true

    const next = vi.fn().mockResolvedValue('rejected')
    expect(await handler(request, next)).toBe('rejected')
    expect(next).not.toHaveBeenCalled()
    expect(records.add.mock.calls[0][0].verdict).toBe('blacklist-reject')
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

    // 四个行为开关的默认值：通知注入默认开、黑名单直接拒绝默认关、自动打开时间线默认开、拒绝后追问理由默认开
    expect(resolveConfig()).toMatchObject({ notice: true, denyDirect: false, autoOpenTimeline: true, askRejectReason: true })
    expect(resolveConfig({ notice: false, denyDirect: true, autoOpenTimeline: false, askRejectReason: false }))
      .toMatchObject({ notice: false, denyDirect: true, autoOpenTimeline: false, askRejectReason: false })

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
    expect(notice.content[0].text).toContain('final result：approved')
    expect(notice.source.summary).toBe('[auto] Auto Approve: approved')

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
    expect(deferredNotice.content[0].text).toContain('final result：rejected')
    expect(deferredNotice.source.summary).toBe('[human] Auto Approve: handed to the user')

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
