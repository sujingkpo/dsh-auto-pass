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
  buildReviewEvidence,
  buildReviewPrompt,
  createAutoApprovalHandler,
  enforceHostPolicy,
  exactAction,
  parseAssessment,
  resolveConfig,
  resolveReviewLanguage,
} from '../src/index.js'

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

function contextWith(runs) {
  const queue = Array.isArray(runs) ? [...runs] : [runs]
  return {
    subagents: {
      start: vi.fn().mockImplementation(() => Promise.resolve(queue.shift())),
    },
    get: vi.fn(name => name === 'sandboxPolicy'
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
    expect(ctx.subagents.start).not.toHaveBeenCalled()
  })

  it('为一次审批启动一个受限 spawn Reviewer，并读取 structured 结果', async () => {
    const run = reviewerRun(allow)
    const ctx = contextWith(run)
    const request = requestWith()
    const config = resolveConfig({
      reviewerProvider: 'deepseek-official',
      reviewerModel: 'deepseek-v4-flash',
      reviewerReasoningEffort: 'high',
    })
    const outcome = await createAutoApprovalHandler(ctx, config)(request, vi.fn())

    expect(outcome).toBe('allowed-once')
    expect(ctx.subagents.start).toHaveBeenCalledOnce()
    const [provider, start] = ctx.subagents.start.mock.calls[0]
    expect(provider).toBe('spawn')
    expect(start).toMatchObject({
      label: '_auto-approve:call-1',
      parent: request.agent,
      agentOptions: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        maxTokens: 8_192,
      },
      persona: expect.stringContaining('独立安全审批 Reviewer'),
      // restrict 名单只能列端能力工具：run_code 是保留的 PTC 传输层，列进去会直接报错
      toolFilter: { allow: ['read', 'glob', 'grep'] },
      outputSchema: assessmentSchema,
      maxDepth: 1,
    })
    expect(start.prompt[0].text).toContain('MAIN SYSTEM INSTRUCTIONS')
    expect(start.prompt[0].text).toContain('Instructions from: AGENTS.md')
    expect(start.prompt[0].text).toContain('justification')
    expect(start.prompt[0].text).toContain('trusted_for_authorization')
    expect(start.prompt[0].text).not.toContain('CACHEABLE')
    expect(start.prompt[0].text).not.toContain('cacheable')
    expect(start.prompt[0].text.indexOf('审查上下文'))
      .toBeLessThan(start.prompt[0].text.indexOf('本次审批'))
    expect(start.prompt[0].text.indexOf('MAIN SYSTEM INSTRUCTIONS'))
      .toBeLessThan(start.prompt[0].text.indexOf('session-1'))
    expect(start.persona).toContain('使用直接用户 prompt 的语言书写简短理由')
    expect(run.dispose).toHaveBeenCalledOnce()
    const notice = request.agent.inject.mock.calls.at(-1)[0]
    // 通知只占一行：会进模型上下文，Reviewer 会话等细节留在时间线与宿主日志里
    expect(notice.content).toHaveLength(1)
    expect(notice.content[0].text.startsWith('[自动]')).toBe(true)
    expect(notice.content[0].text).toContain('Auto Approve 已自动批准 bash')
    expect(notice.content[0].text).toContain('low/high')
    expect(notice.content[0].text).not.toContain('\n')
    expect(notice.content[0].text).not.toContain('Reviewer 会话')
    // 折叠标题与正文用同一个标签
    expect(notice.source).toMatchObject({ form: 'notice', summary: '[自动] Auto Approve：允许' })
  })

  it('Reviewer deny 时转交人工审批，且不再重复审查', async () => {
    const ctx = contextWith(reviewerRun(deny))
    const next = vi.fn().mockResolvedValue('rejected')
    const request = requestWith()
    const outcome = await createAutoApprovalHandler(ctx, resolveConfig())(request, next)

    expect(outcome).toBe('rejected')
    expect(ctx.subagents.start).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledOnce()
    expect(request.agent.cancel).not.toHaveBeenCalled()
    const notice = request.agent.inject.mock.calls.at(-1)[0]
    expect(notice.content[0].text.startsWith('[人工]')).toBe(true)
    expect(notice.content[0].text).toContain('Auto Approve 未自动批准 bash，已转交你审批')
    expect(notice.content[0].text).not.toContain('\n')
    expect(notice.content[0].text).toContain('理由：提权范围超过运行测试所需。')
    expect(notice.source.summary).toBe('[人工] Auto Approve：转交人工审批')
  })

  it('子 Agent 异常、无 structured 输出或缺少精确动作时一律转人工审批', async () => {
    const failedRun = reviewerRun(undefined, {
      result: Promise.resolve({ stopReason: 'error', output: [] }),
    })
    const ctx = contextWith(failedRun)
    const failedNext = vi.fn().mockResolvedValue('allowed-once')
    const failedRequest = requestWith()
    expect(await createAutoApprovalHandler(ctx, resolveConfig())(failedRequest, failedNext)).toBe('allowed-once')
    expect(ctx.subagents.start).toHaveBeenCalledOnce()
    expect(failedNext).toHaveBeenCalledOnce()
    expect(failedRequest.agent.inject.mock.calls.at(-1)[0].content[0].text)
      .toContain('Reviewer 子 Agent 未正常结束：error')

    const missing = requestWith('auto-approve', { callId: undefined })
    const missingNext = vi.fn().mockResolvedValue('rejected')
    expect(await createAutoApprovalHandler(ctx, resolveConfig())(missing, missingNext)).toBe('rejected')
    expect(missingNext).toHaveBeenCalledOnce()
    expect(missing.agent.inject.mock.calls.at(-1)[0].content[0].text)
      .toContain('理由：找不到待审批工具调用的精确参数。')
    expect(ctx.subagents.start).toHaveBeenCalledOnce()
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
      reviewerSessionId: 'reviewer-session-1',
      steps: 2,
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
    expect(ctx.subagents.start).not.toHaveBeenCalled()
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

describe('Reviewer 创建期隔离', () => {
  it('在首次请求前钉死只读沙箱、工具 guard、推理等级和 step 上限', async () => {
    const listeners = new Map()
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn() },
      on: vi.fn((name, listener) => {
        listeners.set(name, listener)
        return vi.fn()
      }),
      inject: vi.fn(),
    }
    apply(ctx, {
      reviewerProvider: 'deepseek-official',
      reviewerModel: 'deepseek-v4-flash',
      reviewerReasoningEffort: 'high',
      maxInvestigationSteps: 4,
    })

    const approval = contextWith(reviewerRun(allow))
    const request = requestWith()
    await createAutoApprovalHandler(approval, resolveConfig({ reviewerReasoningEffort: 'high' }))(request, vi.fn())
    const start = approval.subagents.start.mock.calls[0][1]
    const scopedListeners = new Map()
    let guard
    const reviewer = {
      options: start.agentOptions,
      session: { append: vi.fn() },
      ctx: {
        tools: { guard: vi.fn(candidate => { guard = candidate }) },
        on: vi.fn((name, listener) => { scopedListeners.set(name, listener); return vi.fn() }),
      },
    }
    listeners.get('agent/created')({ agent: reviewer })

    expect(reviewer.session.append).toHaveBeenCalledWith('sandbox/mode', {
      mode: 'read-only',
      source: 'delegation',
    })
    expect(reviewer.session.append).toHaveBeenCalledWith('approval/policy', {
      policy: 'never',
      source: 'delegation',
    })
    expect(guard({ name: 'read', arguments: { file_path: 'src/index.js' } })).toBeUndefined()
    expect(guard({ name: 'structured_output' })).toBeUndefined()
    // ptc 档位下 run_code 是唯一入口：必须放行，否则 Reviewer 既查不了也交不了结论
    expect(guard({ name: 'run_code', arguments: { code: 'await tools.read({ file_path: "a" })' } })).toBeUndefined()
    expect(guard({ name: 'write' })).toMatch(/只允许只读/)
    expect(guard({ name: 'bash' })).toMatch(/只允许只读/)
    expect(guard({ name: 'read', arguments: { file_path: '.env' } })).toBeUndefined()
    expect(guard({ name: 'grep', arguments: { pattern: 'token', path: '.ssh' } })).toBeUndefined()
    expect(guard({ name: 'grep', arguments: { pattern: 'token', include: '*.ts' } })).toBeUndefined()
    await expect(scopedListeners.get('agent/request')({}, () => Promise.resolve({ provider: 'p', model: 'm' })))
      .resolves.toMatchObject({ reasoningEffort: 'high' })
    await expect(scopedListeners.get('agent/pre-step')({ step: 5 }, () => Promise.resolve({ kind: 'enter' })))
      .resolves.toEqual({ kind: 'enter' })
    await expect(scopedListeners.get('agent/pre-step')({ step: 6 }, vi.fn()))
      .resolves.toEqual({ kind: 'reject' })
  })
})

describe('输入装配与配置', () => {
  it('默认总时限为 90 秒并校验正整数', () => {
    expect(resolveConfig()).toMatchObject({
      language: 'auto',
      timeoutMs: 90_000,
      maxInvestigationSteps: 4,
      maxMessageTranscriptTokens: 4_000,
      maxToolTranscriptTokens: 3_000,
      maxMessageEntryTokens: 1_000,
      maxToolEntryTokens: 512,
      maxSystemInstructionTokens: 6_000,
      maxAgentInstructionTokens: 6_000,
      maxRecentNonUserEntries: 20,
    })
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

  it('从原始 events 分离 system、AGENTS、消息、工具和当前权限', () => {
    const request = requestWith()
    const ctx = contextWith(reviewerRun(allow))
    const evidence = buildReviewEvidence(ctx, request, exactAction(request), resolveConfig())
    expect(evidence.reviewer_context.main_agent_instructions.system).toEqual({
      trusted_for_policy: true,
      trusted_for_authorization: true,
      content: 'MAIN SYSTEM INSTRUCTIONS',
    })
    expect(evidence.reviewer_context.main_agent_instructions).not.toHaveProperty('developer')
    expect(evidence.reviewer_context.main_agent_instructions).not.toHaveProperty('developer_note')
    expect(evidence.reviewer_context.main_agent_instructions.workspace_instructions.records[0])
      .toContain('AGENTS.md')
    expect(evidence.reviewer_context.main_agent_instructions.workspace_instructions.records[0])
      .toContain('"trusted_for_authorization":true')
    expect(evidence.approval_request.transcript.messages.records
      .some(record => record.includes('trusted_for_authorization'))).toBe(true)
    expect(evidence.approval_request.transcript.tools.records
      .some(record => record.includes('tool_call'))).toBe(true)
    expect(evidence.approval_request.transcript.tools.records.some(record => record.includes('ask-1')
      && record.includes('"trusted_for_authorization":true'))).toBe(true)
    expect(evidence.approval_request.current_permissions).toEqual({
      permission_preset: 'auto-approve',
      sandbox_mode: 'workspace-write',
      approval_policy: 'ask',
    })
    expect(evidence.approval_request.reviewed_parent_session_id).toBe('session-1')
    expect(evidence.approval_request.exact_action.callId).toBe('call-1')
  })

  it('ptc 档位的内层调用同样进证据，内层 ask_user_question 仍算可信授权', () => {
    const events = [
      event('user/message', { id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我跑测试' }] }, 0),
      event('tool/call', { turn: 1, step: 1, callId: 'call-parent', name: 'run_code', arguments: '{"code":"..."}' }, 1),
      event('tool/ptc-dispatch-start', {
        rootCallId: 'call-parent', parentCallId: 'call-parent', subCallId: 'call-parent:ptc:1',
        name: 'pwsh', arguments: { command: 'npm test' },
      }, 2),
      event('tool/ptc-dispatch', {
        rootCallId: 'call-parent', parentCallId: 'call-parent', subCallId: 'call-parent:ptc:1',
        name: 'pwsh', arguments: { command: 'npm test' }, isError: false, content: [{ type: 'text', text: 'ok' }],
      }, 3),
      event('tool/ptc-dispatch', {
        rootCallId: 'call-parent', parentCallId: 'call-parent', subCallId: 'call-parent:ptc:2',
        name: 'ask_user_question', arguments: { questions: [] }, isError: false, content: [{ type: 'text', text: '{"answers":[]}' }],
      }, 4),
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
    const evidence = buildReviewEvidence(contextWith(reviewerRun(allow)), request, exactAction(request), resolveConfig())
    const records = evidence.approval_request.transcript.tools.records
    // 内层调用要作为真正的工具调用出现（否则 Reviewer 只看到一段 run_code 脚本）
    expect(records.some(record => record.includes('call-parent:ptc:1') && record.includes('"via_ptc":true'))).toBe(true)
    // 内层 ask_user_question 的回答是可信授权来源，ptc 档位下不能丢这个标记
    const answer = records.find(record => record.includes('call-parent:ptc:2'))
    expect(answer).toBeDefined()
    expect(answer).toContain('"trusted_for_authorization":true')
  })

  it('把稳定指令放在动态审批数据之前，并使用两个独立 JSON 区段', () => {
    const request = requestWith()
    const evidence = buildReviewEvidence(
      contextWith(reviewerRun(allow)),
      request,
      exactAction(request),
      resolveConfig(),
    )
    const prompt = buildReviewPrompt(evidence)
    const contextIndex = prompt.indexOf('审查上下文')
    const approvalIndex = prompt.indexOf('本次审批')

    expect(prompt).not.toMatch(/cacheable|dynamic/i)
    expect(contextIndex).toBeGreaterThanOrEqual(0)
    expect(approvalIndex).toBeGreaterThan(contextIndex)
    expect(prompt.indexOf('MAIN SYSTEM INSTRUCTIONS')).toBeLessThan(approvalIndex)
    expect(prompt.indexOf('session-1')).toBeGreaterThan(approvalIndex)
    expect(prompt.indexOf('call-1')).toBeGreaterThan(approvalIndex)
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

  it('英文会话使用英文任务提示、通知、guard 和宿主失败理由', async () => {
    const listeners = new Map()
    apply({
      logger: { info: vi.fn(), warn: vi.fn() },
      on: vi.fn((name, listener) => { listeners.set(name, listener); return vi.fn() }),
      inject: vi.fn(),
    }, {})

    const ctx = contextWith(reviewerRun(allowEnglish))
    const request = requestWith('auto-approve', {
      sessionOverrides: { directUserText: 'Please run the tests' },
    })
    expect(await createAutoApprovalHandler(ctx, resolveConfig())(request, vi.fn())).toBe('allowed-once')

    const start = ctx.subagents.start.mock.calls[0][1]
    expect(start.persona).toContain('Write a concise rationale in the language used by the direct user prompt')
    expect(start.persona).toContain('独立安全审批 Reviewer')
    expect(start.prompt[0].text).toContain('Review context')
    expect(start.prompt[0].text).not.toContain('审查上下文')
    const notice = request.agent.inject.mock.calls.at(-1)[0]
    expect(notice.content[0].text.startsWith('[auto]')).toBe(true)
    expect(notice.content[0].text).toContain('Auto Approve allowed bash')
    expect(notice.content[0].text).not.toContain('Reviewer session')
    expect(notice.content[0].text).not.toContain('\n')
    expect(notice.content[0].text).toContain('Rationale: The user explicitly requested')
    expect(notice.source.summary).toBe('[auto] Auto Approve: allowed')

    let guard
    listeners.get('agent/created')({
      agent: {
        options: start.agentOptions,
        session: { append: vi.fn() },
        ctx: { tools: { guard: vi.fn(candidate => { guard = candidate }) }, on: vi.fn(() => vi.fn()) },
      },
    })
    expect(guard({ name: 'write' })).toMatch(/read-only investigation tools/)

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
