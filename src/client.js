/**
 * @description dsh-auto-pass 客户端半：注册两个面板——
 *   1) 对话区标签页「审批设置」：连续放行阈值 + 项目/全局 × 白名单/黑名单的查看与撤销；
 *   2) 右侧栏「审批时间线」：倒序展示审批记录，并支持把某条记录一键升级为白名单
 *      （以后直接放行）或降级为黑名单（以后直接转人工）；规则文本由 Reviewer 模型产出，
 *      记录里没有模型建议时精确回落到该次动作签名。
 *   放置位置参照 dsh-context：placement=auto 时优先右侧栏座位，座位不可用退回对话标签页。
 * @author simon300000
 * @date 2026-09-15
 * @modify 2026-09-15 对话区改放「审批设置」，时间线移入右侧栏并加升级/降级操作
 * @modify 2026-09-15 面板改为与消息列同宽的居中卡片；时间线行内展示审批意见摘要
 * @modify 2026-09-15 右侧栏 chip 标题加图标；审批意见只显示一行
 * @modify 2026-09-15 时间线切到「全部会话」时，在每条记录最下面用小字标出会话名
 * @modify 2026-09-15 时间线加「全部 / 白名单 / 黑名单 / 自动 / 人工」快捷筛选（多选叠加，按钮带条数）
 * @modify 2026-09-15 升级/降级结果如实区分「已更新同名规则 / 已被已有规则覆盖 / 已合并窄规则」
 * @modify 2026-09-15 自动打开时间线改为「只要触发审批、且时间线没打开就展开」：常驻观察器按当前会话最新记录 id 判断新审批，首次观测只记基线
 * @modify 2026-09-15 计数说明文案同步「最终结果为准、管道之后不参与区分」
 * @modify 2026-09-15 规则可微调：时间线详情加可编辑表单（匹配条件/匹配值/标签，四个按钮按你填的内容写入），设置面板每条规则可「编辑」（op=update 原地更新）
 * @modify 2026-09-15 规则表单改用自带分段按钮（原生 <select> 深色主题下弹层白底）、切条件时值立刻刷新、操作区改竖排
 * @modify 2026-09-15 换匹配条件后让模型按该条件重新生成（/rule/draft，提示词带上条件与当前草稿）；路径前缀的通配符即时校验与口径提示
 * @modify 2026-09-15 这次动作用不上的匹配条件（没有命令 / 没有路径）按钮禁用并说明原因
 * @modify 2026-09-16 详情里的「权限指纹」显示归一化后的签名 key（与规则表单生成的签名逐字一致），
 *   可读文本另起一行「签名摘要」；模型建议里不等于本次签名的假签名不再当表单默认值
 * @modify 2026-09-16 「加入名单」可撤销：详情里列出被顶掉的规则，并可通过 /rule/revert 还原；
 *   覆盖命中（没写入任何条目）不给撤销；设置面板编辑规则也会列出被合并掉的窄规则
 * @modify 2026-09-16 权限指纹只读 + 可视化：原始串（含 NUL）不再显示/不再靠选中复制——
 *   界面显示渲染后的文案，整串复制走「复制指纹」按钮（剪贴板 API）；详情里拆成工具/命令/额外参数
 */
window.__ModuleLoader__.load({
  id: 'dsh-auto-pass',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const react = require('react')

    /** 客户端日志前缀。 */
    const LOG = '[dsh-auto-pass]'
    /** 宿主接口。 */
    const API_CONFIG = '/api/dsh-auto-pass/config'
    const API_LOG = '/api/dsh-auto-pass/log'
    const API_POLICY = '/api/dsh-auto-pass/policy'
    const API_RULE = '/api/dsh-auto-pass/rule'
    /** 只生成不落盘：换匹配条件时让模型按那个条件重新生成一遍。 */
    const API_RULE_DRAFT = API_RULE + '/draft'
    /** 撤销一次「加入名单」：宿主按记录里的凭据还原名单。 */
    const API_RULE_REVERT = API_RULE + '/revert'
    /** 启动信标：把客户端半走到哪一步写进宿主日志（排查「看不到面板」用）。 */
    const API_BEACON = '/api/dsh-auto-pass/beacon'
    /** 时间轴轮询间隔（毫秒）。 */
    const POLL_MS = 3_000
    /** 自动打开审批时间线失败后的重试延迟（毫秒）。 */
    const AUTO_OPEN_RETRY_MS = 150
    /** 右侧栏 tab 类型标识，同时是正文/标题席位的 key。 */
    const SIDEBAR_ID = 'dsh-auto-pass'
    const SIDEBAR_KIND = 'dsh-auto-pass-log'
    /** 对话区标签页的席位 id（conversation.view 内必须唯一）。 */
    const VIEW_ID = 'dsh-auto-pass'
    const PLACEMENTS = ['auto', 'tab', 'sidebar', 'all']

    /**
     * 上报一次启动阶段：既打宿主日志（fetch），也写 localStorage 轨迹
     * （后者不依赖 fetch，可直接从渲染器的 leveldb 文件里读出来核对）。
     * 两条通道都失败也不影响插件本体。
     */
    function beacon(stage, detail = '') {
      try {
        const trail = JSON.parse(localStorage.getItem('dsh-auto-pass:boot') ?? '[]')
        trail.push(stage + (detail === '' ? '' : '(' + detail + ')'))
        localStorage.setItem('dsh-auto-pass:boot', JSON.stringify(trail.slice(-24)))
      } catch (error) {
        // localStorage 不可用时只靠宿主日志；这里不打断流程
        void error
      }
      try {
        void fetch(API_BEACON + '?stage=' + encodeURIComponent(stage) + '&detail=' + encodeURIComponent(detail), {
          headers: { accept: 'application/json' },
        }).catch(() => {})
      } catch (error) {
        // fetch 本身不可用时忽略
        void error
      }
    }
    try {
      localStorage.removeItem('dsh-auto-pass:boot')
    } catch (error) {
      // 清不掉上一轮轨迹不影响功能
      void error
    }
    beacon('factory')

    /** 取界面语言：跟随浏览器语言，中文用简体文案。 */
    const ZH = /^zh/i.test(typeof navigator === 'object' && navigator !== null ? String(navigator.language ?? '') : '')
    const COPY = {
      zh: {
        timelineTab: '审批时间线',
        policyTab: '审批设置',
        guideDescription: '自动审批的自动批准与转人工记录，可一键升级为白名单或降级为黑名单',
        title: '审批时间线',
        subtitle: '最新的在最上面',
        scopeSession: '本次会话',
        scopeAll: '全部会话',
        reload: '刷新',
        empty: '还没有审批记录',
        loading: '加载中…',
        autoApproved: '自动批准',
        referred: '转人工',
        denyRejected: '直接拒绝',
        reviewFailed: '审查未完成',
        outcomeAllowed: '已批准',
        outcomeRejected: '已拒绝',
        outcomeUnavailable: '无人应答',
        outcomeCancelled: '已取消',
        risk: '风险',
        authorization: '授权',
        rationale: '审批意见',
        action: '动作',
        latency: '耗时',
        reviewer: 'Reviewer',
        tokens: 'Token 消耗',
        usageIn: '输入',
        usageOut: '输出',
        usageTotal: '合计',
        reason: '审批原因',
        time: '时间',
        signature: '权限指纹',
        signatureText: '签名摘要',
        suggestedRule: '模型建议规则',
        policyHit: '命中规则',
        hitAllow: '白名单',
        hitDeny: '黑名单',
        filterAll: '全部',
        filterAuto: '自动',
        filterHuman: '人工',
        filterEmpty: '没有符合筛选条件的记录',
        promoted: '已自动升级',
        applied: '已应用',
        approvals: '连续放行',
        denials: '连续被拒',
        decidedAuto: '自动',
        decidedHuman: '人工',
        decidedBy: '决策来源',
        ruleAuto: '自动',
        ruleManual: '手动',
        decidedAutoText: '模型自动审批',
        decidedHumanText: '人工审批',
        decidedUnknown: '无人工结论',
        decidedAutoTitle: '模型自动审批',
        decidedHumanTitle: '人工审批通过或拒绝',
        ruleAsk: '规则询问',
        ruleDeclined: '已询问，未加入',
        promote: '升级为白名单',
        demote: '降级为黑名单',
        scopeProject: '本项目',
        scopeGlobal: '全局',
        working: '处理中…',
        appliedModel: '已加入（模型优化）',
        appliedRecord: '已加入（采用审查时的模型建议）',
        appliedFallback: '已加入（没有可用的模型建议，已回落到本次动作的权限指纹）',
        appliedReplaced: labels => '（已更新同名规则' + (labels === '' || labels === undefined ? '' : '：' + labels) + '）',
        appliedCovered: '（已有规则已覆盖这个动作，未重复添加）',
        appliedMerged: (count, labels) => '（已合并 ' + String(count) + ' 条被它覆盖的窄规则'
          + (labels === '' || labels === undefined ? '' : '：' + labels) + '）',
        appliedManual: '已按你填写的条件加入',
        // 「加入名单」可以撤销（用户 2026-09-16 要求）：一条更宽的前缀会把之前确认过的窄规则合并掉，得能还原
        undoRule: '撤销这次加入',
        ruleUndoLabel: '本次加入的规则',
        ruleDropped: labels => '顶掉了：' + labels,
        ruleUndone: '已撤销，名单已还原',
        ruleDraftLabel: '加入名单的规则',
        ruleKind: '匹配条件',
        ruleValue: '匹配值',
        ruleLabelField: '规则标签',
        ruleDraftFromModel: '默认来自这次审查的模型建议，可以直接改',
        ruleDraftFromSignature: '默认是本次动作的权限指纹（同一动作换个输出截断/说明仍是同一个）；想覆盖同一命令的其他参数就切到「命令前缀」',
        ruleDraftEdited: '值已按所选条件刷新，仍可继续手改（管道 | 之后的部分只决定怎么显示输出）',
        ruleDraftRegenerating: '正在让模型按所选条件重新生成…',
        ruleDraftRegenerated: '已让模型按所选条件重新生成，仍可继续手改',
        ruleDraftRegenFailed: '模型这次没能生成（已按条件本地推导，可继续手改）',
        ruleNeedLabel: '规则标签不能为空',
        ruleNeedValue: '匹配值不能为空',
        ruleNeedLongerPrefix: '前缀类条件至少 3 个字符',
        rulePathGlobHint: '路径前缀支持单层通配：D:/work/x/src/*.js 只匹配该目录下的 .js 文件（不跨目录）',
        ruleNoDoubleStar: '路径规则不支持 **（跨目录通配太宽）',
        ruleNoOtherGlob: '只支持 * 这一个通配符（不支持 ? 与 []）',
        ruleStarLastSegment: '* 只能出现在路径的最后一段（文件名部分）',
        ruleCommandStarHint: '命令前缀里的 * 是字面量、不会展开：这样写只会命中「命令文本里真的带 tests/*」的调用。想覆盖一类命令请把前缀写短，例如 pnpm vitest run',
        ruleKindUnavailable: kind => kind + '匹配不到这次动作（它没有对应的命令或路径参数），已禁用',
        edit: '编辑',
        saveEdit: '保存修改',
        cancelEdit: '取消',
        sourceUser: '手动',
        sourceModel: '模型',
        sourceMemory: '记忆',
        kindSignature: '权限指纹',
        // 权限指纹是机器算出来的串：界面上只读，并按它的结构摊开给人看（用户 2026-09-16 要求）
        fingerprintTool: '工具',
        fingerprintCommand: '命令',
        fingerprintArgs: '参数',
        fingerprintExtra: '额外参数',
        fingerprintReadonly: '权限指纹由插件算出、不能手改；想覆盖同一命令的其他参数请切到「命令前缀」',
        fingerprintLocked: '权限指纹不能手填（只能由时间线上的某条记录生成）',
        copyFingerprint: '复制指纹',
        copiedFingerprint: '已复制完整指纹',
        copyFingerprintFailed: '复制不了（这个环境没有剪贴板权限）',
        kindCommandPrefix: '命令前缀',
        kindPathPrefix: '路径前缀',
        settingsTitle: '审批设置',
        settingsDesc: '连续通过或连续被拒达到阈值后，插件会先让 DSH 模型把这次动作优化成一条匹配条件，再询问你是否加入白名单/黑名单——你确认了才会写入。',
        thresholdLabel: '连续放行阈值',
        thresholdLabelDeny: '连续被拒阈值',
        thresholdHintAllow: '达到后询问是否加入白名单',
        thresholdHintDeny: '达到后询问是否加入黑名单',
        thresholdUnit: '次',
        ruleAskNote: '自动审批与你本人的放行都计入「连续放行」（哪怕模型原本判了拒绝，只要你点了允许一次就算放行）；最终没被批准才计入「连续被拒」。计数只看命令本身，管道 | 后面的输出截断不参与区分。问过一次并选择「不加入」后，这个动作不会再被询问。',
        save: '保存',
        saved: '已保存',
        globalScope: '全局（所有项目）',
        projectScope: '项目',
        allowList: '白名单 · 直接放行',
        denyList: '黑名单 · 直接转人工',
        emptyList: '（空）',
        remove: '删除',
        projectUnknown: '还没有本会话的审批记录，暂时无法确定项目目录；本会话产生第一条审批记录后即可管理项目规则。',
        cardName: '自动审批面板',
        placementTitle: '面板显示位置',
        placementDesc: '审批设置显示在对话标签页，审批时间线显示在右侧栏（auto 优先右侧栏，座位不可用时退回对话标签页）',
        noticeTitle: '注入审批结果到上下文',
        noticeHint: '关闭后，审批结果不再写进模型的对话上下文（审批时间线不受影响）',
        denyDirectTitle: '黑名单直接拒绝',
        denyDirectHint: '命中黑名单时直接把这次调用判为拒绝（工具调用失败），不再弹人工审批卡',
        autoOpenTitle: '自动打开审批时间线',
        autoOpenHint: '触发审批时自动展开审批时间线；已显示时不抢焦点',
        askReasonTitle: '拒绝后追问理由',
        askReasonHint: '你拒绝一次审批后，插件问一句拒绝理由并注入模型上下文（默认选项就是本次的模型审批意见）',
        saveFailed: '保存失败',
        switchOn: '开',
        switchOff: '关',
        turnStep: '轮次/步数',
        turnStepLabel: (turn, step) => '第 ' + String(turn) + ' 轮 · 第 ' + String(step) + ' 步',
        rejectReason: '人工拒绝理由',
        savedTip: '已保存',
        placementAuto: '自动',
        placementTab: '只保留审批设置',
        placementSidebar: '只保留时间线',
        placementAll: '两处都显示',
        panelCardDesc: '面板显示在哪里，以及四个行为开关：是否把审批结果注入模型上下文、命中黑名单是否直接拒绝、本会话第一次审批时是否自动打开审批时间线、人工拒绝后是否追问一句拒绝理由。',
      },
      en: {
        timelineTab: 'Approval timeline',
        policyTab: 'Approval policy',
        guideDescription: 'Auto Approve auto-approvals and hand-offs; promote or demote each one',
        title: 'Approval timeline',
        subtitle: 'newest first',
        scopeSession: 'This session',
        scopeAll: 'All sessions',
        reload: 'Refresh',
        empty: 'No approvals recorded yet',
        loading: 'Loading…',
        autoApproved: 'auto-approved',
        referred: 'handed to user',
        denyRejected: 'rejected outright',
        reviewFailed: 'review incomplete',
        outcomeAllowed: 'allowed',
        outcomeRejected: 'rejected',
        outcomeUnavailable: 'no answerer',
        outcomeCancelled: 'cancelled',
        risk: 'Risk',
        authorization: 'Authorization',
        rationale: 'Rationale',
        action: 'Action',
        latency: 'Latency',
        reviewer: 'Reviewer',
        tokens: 'Token usage',
        usageIn: 'in',
        usageOut: 'out',
        usageTotal: 'total',
        reason: 'Approval reason',
        time: 'Time',
        signature: 'Permission fingerprint',
        signatureText: 'Signature summary',
        suggestedRule: 'Suggested rule',
        policyHit: 'Matched rule',
        hitAllow: 'Allowlist',
        hitDeny: 'Denylist',
        filterAll: 'All',
        filterAuto: 'Auto',
        filterHuman: 'Human',
        filterEmpty: 'No records match the filters',
        promoted: 'Auto-promoted',
        applied: 'Applied',
        approvals: 'Consecutive approvals',
        denials: 'Consecutive denials',
        decidedAuto: 'auto',
        decidedHuman: 'human',
        decidedBy: 'Decided by',
        ruleAuto: 'auto',
        ruleManual: 'manual',
        decidedAutoText: 'allowed by the model automatically',
        decidedHumanText: 'human decision',
        decidedUnknown: 'no human outcome',
        decidedAutoTitle: 'allowed by the model automatically',
        decidedHumanTitle: 'approved or rejected by the human',
        ruleAsk: 'Rule prompt',
        ruleDeclined: 'Asked, not added',
        promote: 'Promote to allowlist',
        demote: 'Demote to denylist',
        scopeProject: 'This project',
        scopeGlobal: 'Global',
        working: 'Working…',
        appliedModel: 'Added (model-optimized)',
        appliedRecord: 'Added (rule suggested by the review model)',
        appliedFallback: 'Added (no usable model suggestion; fell back to this action\u2019s permission fingerprint)',
        appliedReplaced: labels => ' (updated the existing rule' + (labels === '' || labels === undefined ? '' : ': ' + labels) + ')',
        appliedCovered: ' (already covered by an existing rule; nothing added)',
        appliedMerged: (count, labels) => ' (merged ' + String(count) + ' narrower rule(s) it covers'
          + (labels === '' || labels === undefined ? '' : ': ' + labels) + ')',
        appliedManual: 'Added with the condition you wrote',
        undoRule: 'Undo this add',
        ruleUndoLabel: 'Rule added',
        ruleDropped: labels => 'Displaced: ' + labels,
        ruleUndone: 'Undone; the list was restored',
        ruleDraftLabel: 'Rule to add',
        ruleKind: 'Match kind',
        ruleValue: 'Match value',
        ruleLabelField: 'Rule label',
        ruleDraftFromModel: 'prefilled from this review model suggestion - edit it freely',
        ruleDraftFromSignature: 'prefilled with this action\u2019s permission fingerprint (same action, different output truncation or description, still the same); switch to a command prefix to also cover other arguments',
        ruleDraftEdited: 'the value was refreshed for the kind you picked - edit it freely (anything after a | only shapes the output)',
        ruleDraftRegenerating: 'asking the model to regenerate a rule for the kind you picked...',
        ruleDraftRegenerated: 'the model regenerated a rule for the kind you picked - still editable',
        ruleDraftRegenFailed: 'the model could not regenerate this time (kept the locally derived value - still editable)',
        ruleNeedLabel: 'rule label must not be empty',
        ruleNeedValue: 'match value must not be empty',
        ruleNeedLongerPrefix: 'a prefix condition needs at least 3 characters',
        rulePathGlobHint: 'a path prefix takes one single-segment wildcard: D:/work/x/src/*.js matches only .js files directly in that directory',
        ruleNoDoubleStar: '** is not supported for path rules (cross-directory is too broad)',
        ruleNoOtherGlob: 'only * is supported as a wildcard (no ? or [])',
        ruleStarLastSegment: '* may only appear in the last path segment (the file name)',
        ruleCommandStarHint: '* in a command prefix is literal and never expands: that rule only matches calls whose command text literally contains tests/*. Shorten the prefix instead, e.g. pnpm vitest run',
        ruleKindUnavailable: kind => kind + ' cannot match this action (it carries no command/paths) - disabled',
        edit: 'Edit',
        saveEdit: 'Save',
        cancelEdit: 'Cancel',
        sourceUser: 'manual',
        sourceModel: 'model',
        sourceMemory: 'memory',
        kindSignature: 'permission fingerprint',
        fingerprintTool: 'Tool',
        fingerprintCommand: 'Command',
        fingerprintArgs: 'Arguments',
        fingerprintExtra: 'Extra arguments',
        fingerprintReadonly: 'computed by the plugin and is not editable; switch to "command prefix" to cover other arguments of the same command',
        fingerprintLocked: 'a permission fingerprint cannot be typed in (it can only be generated from a timeline record)',
        copyFingerprint: 'Copy fingerprint',
        copiedFingerprint: 'full fingerprint copied',
        copyFingerprintFailed: 'cannot copy (no clipboard access here)',
        kindCommandPrefix: 'command prefix',
        kindPathPrefix: 'path prefix',
        settingsTitle: 'Approval policy',
        settingsDesc: 'After this many consecutive approvals or denials the plugin first has the DSH model turn the action into a match condition, then asks whether to add it to the allowlist/denylist — nothing is written until you confirm.',
        thresholdLabel: 'Consecutive approval threshold',
        thresholdLabelDeny: 'Consecutive denial threshold',
        thresholdHintAllow: 'ask to allowlist after this many',
        thresholdHintDeny: 'ask to denylist after this many',
        thresholdUnit: 'times',
        ruleAskNote: 'Auto-approved calls and your own approvals (that includes clicking "allow once" over a model denial) both count as approvals; only a request that ends up unapproved counts as a denial. Counting looks at the command itself, ignoring the output plumbing after a |. After you answer "do not add" once, that action is never asked about again.',
        save: 'Save',
        saved: 'Saved',
        globalScope: 'Global (all projects)',
        projectScope: 'Project',
        allowList: 'Allowlist · allowed directly',
        denyList: 'Denylist · handed to the user',
        emptyList: '(empty)',
        remove: 'Remove',
        projectUnknown: 'No approval recorded in this session yet, so the project directory is unknown; project rules become manageable after the first approval in this session.',
        cardName: 'Auto Approve panel',
        placementTitle: 'Panel placement',
        placementDesc: 'Approval policy lives in the conversation tab, the approval timeline in the right sidebar (auto prefers the sidebar and falls back to the conversation tab)',
        noticeTitle: 'Inject approval results into the context',
        noticeHint: 'When off, approval results are never written into the model conversation (the timeline is unaffected)',
        denyDirectTitle: 'Reject on denylist',
        denyDirectHint: 'A denylist hit fails the tool call outright instead of opening a human approval card',
        autoOpenTitle: 'Open the approval timeline automatically',
        autoOpenHint: 'Open the approval timeline when an approval is triggered; when it is already visible it stays put',
        askReasonTitle: 'Ask for a rejection reason',
        askReasonHint: 'After you reject an approval, the plugin asks for a reason and injects it into the model context (the model review note is the default answer)',
        saveFailed: 'Save failed',
        switchOn: 'on',
        switchOff: 'off',
        turnStep: 'Turn / step',
        turnStepLabel: (turn, step) => 'turn ' + String(turn) + ' · step ' + String(step),
        rejectReason: 'Rejection reason (user)',
        savedTip: 'Saved',
        placementAuto: 'Auto',
        placementTab: 'Policy only',
        placementSidebar: 'Timeline only',
        placementAll: 'Both',
        panelCardDesc: 'Where the panels live, plus four behaviour switches: inject approval results into the context, reject on a denylist hit, open the approval timeline automatically for this session’s first approval, and ask for a rejection reason after you reject one.',
      },
    }
    const t = COPY[ZH ? 'zh' : 'en']

    // ── 权限档位图标（盾牌 + A）──
    // DSH 客户端把档位图标硬编码给 read-only / workspace-write / danger-full-access 三个 id
    // （ui-conversation 的 permissionGlyphs，注释原话 host-configured names outside the design set
    // get none），宿主 presets.<id> 的 schema 也只有 {sandbox, approval, name, description}，
    // 所以自建档位拿不到矢量图标。这里用「给档位名所在的 span 打标记 + ::before + mask」补上：
    // 不改 React 的 DOM 结构、不依赖 DSH 的哈希类名，颜色跟文字走（currentColor），与内置单色图标一致。
    const PRESET_ICON_LABEL = '自动审批'
    const PRESET_ICON_CLASS = 'ap-presetGlyph'
    // 两套几何：chip 对齐内置 .triggerIcon svg（14px、跟文字同色），菜单项对齐内置 .itemIcon
    // （16px、三级文字色、与 label 的间距 8px）。变体写成**内联自定义属性**（见 applyPresetIconVars），
    // 不走「两个 class 比层叠」的路子 —— 上一版就是菜单态那条规则没生效，菜单里的图标一直是 chip 的 14px。
    const PRESET_ICON_VARIANTS = Object.freeze({
      chip: Object.freeze({ box: '14px', icon: '14px', gap: '4px', color: 'currentColor' }),
      menu: Object.freeze({ box: '16px', icon: '16px', gap: '8px', color: 'var(--dsw-alias-label-tertiary,currentColor)' }),
    })
    const PRESET_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">'
      + '<path d="M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z" stroke="#fff" stroke-width="1.31831" stroke-linejoin="round"/>'
      + '<path d="M6.45 10.45 8.2 5.7 9.95 10.45" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M7.2 8.75h2" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>'
      + '</svg>'
    // mask 走 data URI：encodeURIComponent 会连 # 与引号一起编码，避免 CSS 解析歧义
    const PRESET_ICON_MASK = 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(PRESET_ICON_SVG) + '")'

    /**
     * 是否是承载档位名的元素：按文字精确匹配，不依赖 DSH 的哈希类名（客户端升级也不怕）。
     * @param {*} node 待判定元素
     * @param {string} label 档位显示名
     * @returns {boolean} 命中则返回 true
     */
    function isPresetLabelNode(node, label) {
      if (node === null || typeof node !== 'object') { return false }
      if (node.tagName !== 'SPAN') { return false }
      if (typeof node.textContent !== 'string' || node.textContent.trim() !== label) { return false }
      // 只认「纯文字」span：里面有元素就不是档位名（例如我们自己面板里的文案）
      if (node.children !== undefined && node.children !== null && node.children.length > 0) { return false }
      if (node.classList === undefined || typeof node.classList.contains !== 'function') { return false }
      return node.classList.contains(PRESET_ICON_CLASS) === false
    }

    /**
     * 这个 span 属于哪一处宿主：chip 的按钮带 aria-label（访问模式，当前：<档位名>），菜单项是 role=menuitem。
     * @param {*} node 档位名所在的 span
     * @returns {'chip'|'menu'} 变体名
     */
    function presetIconVariant(node) {
      const owner = typeof node.closest === 'function' ? node.closest('button') : null
      if (owner !== null && owner !== undefined && typeof owner.getAttribute === 'function') {
        const label = owner.getAttribute('aria-label')
        if (typeof label === 'string' && label.includes(PRESET_ICON_LABEL)) { return 'chip' }
      }
      return 'menu'
    }

    /**
     * 把变体写成内联自定义属性：CSS 里只有一条规则读这些变量，谁也不会覆盖谁。
     * @param {*} node 档位名所在的 span
     * @param {'chip'|'menu'} variant 变体名
     * @returns {void} 无返回值；拿不到 style（测试替身）时跳过
     */
    function applyPresetIconVars(node, variant) {
      const spec = PRESET_ICON_VARIANTS[variant]
      if (node.style === undefined || node.style === null || typeof node.style.setProperty !== 'function') { return }
      node.style.setProperty('--ap-glyph-box', spec.box)
      node.style.setProperty('--ap-glyph-icon', spec.icon)
      node.style.setProperty('--ap-glyph-gap', spec.gap)
      node.style.setProperty('--ap-glyph-color', spec.color)
    }

    /**
     * 给权限档位名补图标：只在档位 chip 与下拉菜单项里找，DOM 变动时重扫（React 重建节点会丢标记）。
     * @returns {void} 无返回值；浏览器环境缺失（测试/SSR）时直接退出
     */
    function installPresetIcon() {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') { return }
      if (document.body === undefined || document.body === null) { return }
      let scheduled = false
      // 覆盖两处宿主：输入框上方的档位 chip 与弹出的菜单项。composer 的 trigger 只带 aria-label
      // （菜单原语不会给 anchor 补 aria-haspopup），所以连 button span 一起匹配 —— 反正
      // isPresetLabelNode 按文字精确过滤，选择器放宽不会误伤。
      const selector = '[role="menu"] span,[role="menuitem"] span,[aria-haspopup="menu"] span,'
        + 'button span,[aria-label*="' + PRESET_ICON_LABEL + '"] span'
      // 每处宿主只回报一次：把浏览器算出来的几何写进宿主日志，便于「看着不对」时直接核对
      const reported = new Set()
      /**
       * 回报一次该 span 的 ::before 实际几何（宽 / 右间距 / 图标色）。
       * @param {*} node 档位名所在的 span
       * @param {string} variant 变体名
       * @returns {void} 无返回值
       */
      const report = (node, variant) => {
        if (reported.has(variant) || typeof getComputedStyle !== 'function') { return }
        reported.add(variant)
        try {
          const before = getComputedStyle(node, '::before')
          const own = getComputedStyle(node)
          // 对齐相关的量都给出来：图标宽高、行高、display、gap、图标色 —— 真机上「看着不对」时按这几个值核对
          beacon('preset-icon', variant + ' w=' + String(before.width) + ' h=' + String(before.height)
            + ' gap=' + String(own.gap) + ' disp=' + String(own.display) + ' lineH=' + String(own.lineHeight)
            + ' color=' + String(before.backgroundColor))
        } catch (error) {
          // 计算样式拿不到只影响回报，不影响图标本身
        }
      }
      /** 给尚未打标记的档位名加上图标类，并按所在宿主写入变体变量。 */
      const mark = () => {
        for (const node of document.querySelectorAll(selector)) {
          if (isPresetLabelNode(node, PRESET_ICON_LABEL) === false) { continue }
          const variant = presetIconVariant(node)
          // 先写变量再挂 class：class 一挂上规则就生效，不会出现「先按默认值渲染一帧」的闪烁
          applyPresetIconVars(node, variant)
          node.classList.add(PRESET_ICON_CLASS)
          report(node, variant)
        }
      }
      /** 合并同一帧内的多次变动：会话流式渲染时 DOM 变动很密集，避免反复全量查询。 */
      const schedule = () => {
        if (scheduled === true) { return }
        scheduled = true
        const run = () => { scheduled = false; mark() }
        if (typeof requestAnimationFrame === 'function') { requestAnimationFrame(run) }
        else { Promise.resolve().then(run) }
      }
      mark()
      // childList 管节点增删，characterData 管「切换档位时 label 文本被改写」——那是同一个 span
      // 的文本节点变化，不观察它就永远补不上图标。加 class 不在观察范围内（未开 attributes），不会自激。
      new MutationObserver(schedule).observe(document.body, { childList: true, characterData: true, subtree: true })
    }

    // ── 幂等样式注入（带 id，卸载残留可重复注入）──
    if (typeof document !== 'undefined' && document.getElementById('dsh-auto-pass-style') === null) {
      const tag = document.createElement('style')
      tag.id = 'dsh-auto-pass-style'
      tag.textContent = [
        '.ap-root{box-sizing:border-box;flex:auto;min-height:0;height:100%;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);font-size:13px}',
        // 对话区面板：内容列与消息列同宽并居中（--dsh-chat-content-width 由会话根元素下发，取不到时回退 748px）
        // 右侧栏 chip 标题：图标 + 文案（标题席位 key 与 tab id 同名）
        '.ap-tabTitle{display:inline-flex;align-items:center;gap:6px;min-width:0}',
        '.ap-tabLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.ap-frame{flex:auto;min-height:0;overflow-y:auto;padding:16px calc(var(--dsh-composer-side-clearance,16px) + 16px) 24px;display:flex;flex-direction:column;align-items:center}',
        '.ap-col{width:100%;max-width:var(--dsh-chat-content-width,748px);display:flex;flex-direction:column;gap:12px}',
        // 卡片外观对齐设置页内置插件卡（.TKtcza_card）：.5px 描边 + 层三底色 + 16px 圆角
        '.ap-card{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none}',
        '.ap-cardHead{padding:14px 16px 0}',
        '.ap-cardText{display:flex;flex-direction:column;gap:4px;min-width:0}',
        '.ap-cardName{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
        '.ap-cardDesc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
        '.ap-cardBody{border-top:.5px solid var(--dsw-alias-border-l2);margin:12px 16px 0;padding:12px 0 14px;display:flex;flex-direction:column;gap:10px;min-width:0}',
        '.ap-head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
        '.ap-title{font-size:13px;font-weight:600;line-height:20px}',
        '.ap-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
        '.ap-grow{flex:auto;min-width:0}',
        '.ap-seg{display:flex;flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}',
        '.ap-seg button{appearance:none;border:0;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:2px 8px;cursor:pointer}',
        '.ap-seg button+button{border-left:1px solid var(--dsw-alias-border-l1)}',
        '.ap-seg button[data-on="1"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
        '.ap-btn{appearance:none;flex:none;border:1px solid var(--dsw-alias-border-l1);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;border-radius:8px;padding:2px 8px;cursor:pointer}',
        '.ap-btn:hover{border-color:var(--dsw-alias-label-dimmed)}',
        '.ap-btn:disabled{opacity:.5;cursor:default}',
        '.ap-btnPrimary{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
        '.ap-btnDanger{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
        // 快捷筛选条：多选 chip（命中名单两类 + 决策来源两类），每个 chip 后面跟当前范围内的条数
        '.ap-filters{flex:none;display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
        '.ap-chip{appearance:none;display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l1);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;border-radius:8px;padding:2px 8px;cursor:pointer}',
        '.ap-chip:hover{border-color:var(--dsw-alias-label-dimmed)}',
        '.ap-chip[data-on="1"]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
        '.ap-chipCount{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
        '.ap-chip[data-on="1"] .ap-chipCount{color:inherit}',
        '.ap-list{flex:auto;min-height:0;overflow-y:auto;margin:0;padding:4px 0 12px;list-style:none}',
        '.ap-row{border-bottom:1px solid var(--dsw-alias-border-l1)}',
        '.ap-rowHead{width:100%;appearance:none;border:0;background:0 0;font:inherit;text-align:left;color:inherit;display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer}',
        '.ap-rowHead:hover{background:var(--dsw-alias-bg-layer-2)}',
        '.ap-time{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:11px;line-height:16px}',
        '.ap-tool{flex:none;font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:12px}',
        '.ap-turnStep{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}',
        '.ap-badge{flex:none;border-radius:8px;padding:0 6px;font-size:11px;line-height:16px}',
        '.ap-badgeOk{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}',
        '.ap-badgeWarn{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary)}',
        '.ap-badgeMuted{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-base)}',
        // 「自动」标签用业务色，「人工」标签用中性色：与命中名单的绿/黄区分开
        '.ap-badgeInfo{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}',
        '.ap-chevron{flex:none;color:var(--dsw-alias-label-tertiary)}',
        '.ap-detail{padding:0 12px 10px;display:flex;flex-direction:column;gap:4px}',
        '.ap-field{display:flex;gap:6px;align-items:baseline}',
        '.ap-fieldKey{flex:none;min-width:5.5em;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
        '.ap-fieldVal{min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere;white-space:pre-wrap}',
        '.ap-mono{font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:11px}',
        '.ap-empty{color:var(--dsw-alias-label-tertiary);padding:16px 12px}',
        '.ap-error{color:var(--dsw-alias-state-warn-primary);padding:6px 12px;font-size:11px}',
        // 记录详情的操作区：竖着一行一行来（规则编辑器一行、两个操作各一行、状态提示一行），
        // 之前是一整排 flex-wrap，控件一多就横七竖八（用户反馈「按钮排版好乱」）
        '.ap-actions{display:flex;flex-direction:column;gap:6px;align-items:flex-start;padding-top:4px;min-width:0}',
        '.ap-actionRow{display:flex;flex-wrap:wrap;align-items:center;gap:6px;width:100%;min-width:0}',
        '.ap-actionsLabel{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;min-width:5.5em}',
        '.ap-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
        '.ap-warn{color:var(--dsw-alias-state-warn-primary)}',
        '.ap-rowMain{flex:auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
        '.ap-rowTop{display:flex;align-items:center;gap:8px;min-width:0}',
        '.ap-opinion{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-align:left;overflow:hidden;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}',
        // 标签行（决策来源 / 命中名单共用）：chip + 说明文字，折叠态就能看见
        '.ap-hitRow{display:flex;align-items:center;gap:6px;min-width:0}',
        '.ap-hitText{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;min-width:0;overflow-wrap:anywhere}',
        // 「全部会话」时记录最下面的一行会话名：小字、单行截断，不与审批意见/标签行抢视觉
        '.ap-session{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;padding:0 12px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}',
        '.ap-sectionTitle{font-size:12px;font-weight:600;line-height:18px}',
        '.ap-subTitle{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:4px}',
        '.ap-ruleList{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}',
        '.ap-rule{display:flex;align-items:baseline;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:4px 6px}',
        '.ap-ruleLabel{min-width:0;flex:auto;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
        '.ap-input{appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:0 0;color:inherit;font:inherit;font-size:12px;line-height:18px;padding:2px 8px;width:5em}',
        // 规则编辑器（时间线的「加入名单的规则」与设置面板的编辑行）：条件分段按钮 + 值 + 标签一行，
        // 说明与校验提示另起一行（挤在同一行会盖住按钮）。条件不用原生 <select>：它的弹层在深色主题下白底黑字
        '.ap-ruleBlock{display:flex;flex-direction:column;gap:4px;width:100%;min-width:0}',
        '.ap-ruleEditor{display:flex;flex-wrap:wrap;align-items:center;gap:6px;width:100%;min-width:0}',
        '.ap-ruleEditorRow{flex:1}',
        '.ap-inputWide{width:auto;flex:1;min-width:10em}',
        '.ap-row2{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        // 开关：轨道 + 滑块。状态由原生 checkbox 承载（无障碍与键盘可用），轨道随 :checked 变色。
        // 选择器用「input + track」的兄弟关系，不依赖 label 包裹。
        '.ap-switch{flex:none;display:inline-flex;align-items:center;gap:8px;cursor:pointer}',
        '.ap-switchInput{position:absolute;opacity:0;width:0;height:0;margin:0}',
        '.ap-switchTrack{flex:none;position:relative;width:32px;height:18px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l3)}',
        '.ap-switchTrack::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}',
        '.ap-switchInput:checked+.ap-switchTrack{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
        '.ap-switchInput:checked+.ap-switchTrack::after{transform:translateX(14px);background:var(--dsw-alias-bg-layer-3)}',
        '.ap-switchInput:focus-visible+.ap-switchTrack{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
        '.ap-switchInput:disabled+.ap-switchTrack{opacity:.5}',
        '.ap-switchText{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-width:1.5em}',
        // 档位名字前面的「盾牌 + A」：几何全部走 --ap-glyph-* 变量（chip 14/4/currentColor，菜单项 16/8/三级色），
        // 变量由 applyPresetIconVars 内联写在 span 上；mask 用 longhand，避免简写与变量混在一起出歧义
        `.${PRESET_ICON_CLASS}{display:inline-flex;align-items:center;gap:var(--ap-glyph-gap,8px)}`,
        // 图标本体：尺寸全走 --ap-glyph-* 变量；用 flex 的 align-items:center 对齐，和内置 itemIcon / triggerIcon 同一套机制（之前用 vertical-align 手调，真机上差了 2px）
        `.${PRESET_ICON_CLASS}::before{content:"";flex:none;width:var(--ap-glyph-box,16px);height:var(--ap-glyph-box,16px);background-color:var(--ap-glyph-color,currentColor);-webkit-mask-image:${PRESET_ICON_MASK};mask-image:${PRESET_ICON_MASK};-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;-webkit-mask-size:var(--ap-glyph-icon,16px) var(--ap-glyph-icon,16px);mask-size:var(--ap-glyph-icon,16px) var(--ap-glyph-icon,16px)}`,
        // 审批卡首行：DSH 把 pending.reason 放进一个纯文本 div，默认 white-space 会把我
        // 们写入的换行折叠成空格；这里打开换行，让「原有信息 / 空行 / 模型审批意见」分行。
        // 选择器只认官方卡片的 data-approval-key 属性（稳定），不依赖它的哈希类名。
        '[data-approval-key] *{white-space:pre-wrap}',
      ].join('\n')
      ;(document.head || document.documentElement).appendChild(tag)
    }
    /** 记录图标：一个带勾的时间轴时钟，用于引导页胶囊。 */
    function LogGlyph({ size }) {
      const edge = typeof size === 'number' && size > 0 ? size : 16
      return react.createElement('svg', {
        width: edge, height: edge, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        react.createElement('circle', { cx: '6.6', cy: '6.6', r: '4.6' }),
        react.createElement('path', { d: 'M6.6 4.3v2.4l1.7 1' }),
        react.createElement('path', { d: 'M11.4 12.4l1.5 1.5 2.4-2.9' }))
    }

    /**
     * 界面偏好状态：唯一真值在宿主（config 默认值 + 设置命名空间覆盖）。
     * placement 决定面板挂在哪里（变更会广播出去重新挂载），notice / denyDirect 是两个行为开关
     * （关掉通知注入、开启黑名单直接拒绝）。设置页卡片与审批设置面板共用这一份状态。
     */
    const runtimeStore = {
      placement: 'all',
      notice: true,
      denyDirect: false,
      // 本会话第一次产生审批记录时自动打开右侧栏时间线（默认开）
      autoOpenTimeline: true,
      // 人工拒绝后追问一句拒绝理由（默认开）
      askRejectReason: true,
      writable: false,
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
      /** 广播变更；placement 变化时把新值一并交给监听者（挂载逻辑要用它）。 */
      emit() {
        for (const listener of [...this.listeners]) listener(this.placement)
      },
      /** 把宿主返回的 settings 对象套用到本地状态；认不出的值保持原样。 */
      apply(settings) {
        if (settings === null || typeof settings !== 'object') return
        if (typeof settings.placement === 'string' && PLACEMENTS.includes(settings.placement)) {
          this.placement = settings.placement
        }
        if (typeof settings.notice === 'boolean') this.notice = settings.notice
        if (typeof settings.denyDirect === 'boolean') this.denyDirect = settings.denyDirect
        if (typeof settings.autoOpenTimeline === 'boolean') this.autoOpenTimeline = settings.autoOpenTimeline
        if (typeof settings.askRejectReason === 'boolean') this.askRejectReason = settings.askRejectReason
      },
      async load() {
        try {
          const response = await fetch(API_CONFIG, { headers: { accept: 'application/json' } })
          const data = await response.json()
          this.apply(data?.settings)
          this.writable = data?.writable === true
        } catch (error) {
          console.warn(LOG, '读取宿主界面偏好失败，沿用本地默认值', error)
        }
        this.emit()
        return this.placement
      },
      /** 写一个偏好（placement / notice / denyDirect）并套用宿主回执；失败抛出由调用方回滚。 */
      async save(patch) {
        const response = await fetch(API_CONFIG, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        const data = await response.json()
        if (data?.ok !== true) throw new Error(String(data?.error ?? 'save failed'))
        this.apply(data.settings)
        this.emit()
      },
    }
    /** placement 的读写入口：面板挂载逻辑只关心它，行为开关的变更不会触发重新挂载。 */
    const placementStore = {
      get value() { return runtimeStore.placement },
      set(value) {
        if (runtimeStore.placement === value) return
        runtimeStore.placement = value
        runtimeStore.emit()
      },
      subscribe(listener) {
        return runtimeStore.subscribe(listener)
      },
    }

    /** 客户端上下文：applyInner 时捕获，供组件里访问宿主客户端服务（sessions / sidebarRight）。 */
    let clientCtx

    /**
     * 当前挂载状态（applyInner 与时间线面板写入）：
     * - sidebar：右侧栏 tab 的注入 handle，非空表示 tab 类型已注册（placement=tab 时不注册，
     *   那种放置方式下也没有可自动打开的时间线）；
     * - timelineShown：审批时间线是否**正显示在眼前**——面板挂载且 tab 可见（收起侧栏、
     *   切到别的 tab 都算「没打开」，用户选定的判定规则就靠它）。
     */
    const mountState = { tab: undefined, sidebar: undefined, timelineShown: false }

    /** 审批观察器：seen 记每个会话上一次看到的最新记录 id（判断有没有出现新审批），timer 是轮询句柄。 */
    const approvalWatch = { seen: new Map(), timer: undefined }

    /** 当前会话 id：来自宿主 sessions 服务的列表快照（拿不到返回 undefined）。 */
    function currentSessionId() {
      try {
        const snapshot = clientCtx?.get?.('sessions')?.list?.getSnapshot?.()
        const current = snapshot?.current
        return typeof current === 'string' && current !== '' ? current : undefined
      } catch (error) {
        console.warn(LOG, '读取当前会话失败', error)
        return undefined
      }
    }

    /**
     * 看一次「当前会话有没有刚触发的审批」。
     *
     * 判定规则（用户 2026-09-15 选定）：**只要触发审批、且审批列表没打开，就自动打开**。
     * 所以这里没有「本会话只开一次」的记忆：approvalWatch.seen 只用来发现「最新一条记录的 id 变了」，
     * 变了就说明刚发生了审批。**首次观测只记基线**——页面刷新后会话里往往已经堆着历史记录，
     * 那不是「刚触发的审批」，不该把时间线弹开。
     * 观察器与面板无关：用户停在「轨迹」标签页、或 placement 只挂右侧栏时同样会触发
     * （旧实现把探针写在「拿不到项目目录」的分支里，正常情况根本不执行，等于没生效）。
     * @returns {Promise<void>} 无返回值；任何失败只记日志，绝不影响面板自身
     */
    async function watchApprovals() {
      if (runtimeStore.autoOpenTimeline !== true) return
      if (mountState.sidebar === undefined) return
      const sessionId = currentSessionId()
      if (sessionId === undefined) return
      let newest = ''
      try {
        const response = await fetch(API_LOG + '?session=' + encodeURIComponent(sessionId) + '&limit=1', {
          headers: { accept: 'application/json' },
        })
        const data = await response.json()
        const first = Array.isArray(data?.records) ? data.records[0] : undefined
        newest = first === undefined ? '' : String(first.id ?? first.time ?? '')
      } catch (error) {
        console.warn(LOG, '读取审批记录以判断是否自动打开时间线失败', error)
        return
      }
      const seen = approvalWatch.seen.get(sessionId)
      if (seen === newest) return
      approvalWatch.seen.set(sessionId, newest)
      // seen 不存在 = 本轮页面会话第一次看到这个会话：这是历史记录，只记基线不打开
      if (seen === undefined || newest === '') return
      maybeAutoOpenTimeline(sessionId)
    }

    /**
     * 触发审批后自动展开右侧栏的「审批时间线」。
     *
     * 判定规则（用户 2026-09-15 选定）：**只要触发审批、且审批列表没打开，就自动打开**——
     * 时间线已经显示在眼前时什么都不做（不抢焦点）；没显示（tab 从没打开过、切到了别的 tab、
     * 或者侧栏被收起）就展开它。真正展开靠官方 sidebarRight 服务的 openTab
     * （dsh-client-ui-sidebar-right 的 openContent 内部会 planSetExpanded(true)，右侧栏因此自动展开），
     * 不需要自己拼 layout 调用。
     * @param {string} sessionId 触发这次展开的会话（只用于信标与日志）
     * @returns {void} 无返回值；任何失败只影响这次自动展开
     */
    function maybeAutoOpenTimeline(sessionId) {
      if (runtimeStore.autoOpenTimeline !== true) return
      if (mountState.sidebar === undefined) return
      if (mountState.timelineShown === true) return
      /** 开一次时间线；服务不可用或抛错时返回 false（调用方只重试一次）。 */
      const attempt = () => {
        try {
          const service = typeof clientCtx?.get === 'function' ? clientCtx.get('sidebarRight') : undefined
          if (service === undefined || typeof service.openTab !== 'function') return false
          service.openTab(SIDEBAR_KIND)
          return true
        } catch (error) {
          console.warn(LOG, '自动打开审批时间线失败', error)
          return false
        }
      }
      if (attempt()) {
        beacon('auto-open-timeline', sessionId)
        return
      }
      // 只重试一次：首个审批出现时，官方 sidebar-right 服务可能还没把座位绑定到当前会话
      setTimeout(() => {
        if (attempt()) beacon('auto-open-timeline', sessionId + '(retry)')
      }, AUTO_OPEN_RETRY_MS)
    }

    /**
     * 取当前会话的工作目录（项目作用域规则要用）。真值来自宿主 sessions 服务的
     * 会话列表快照；服务缺失或字段不对时返回 undefined，任何异常都吞掉——
     * 拿不到项目目录只影响项目规则的展示，不该让面板白屏。
     */
    function workspaceOf(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      try {
        const sessions = typeof clientCtx?.get === 'function' ? clientCtx.get('sessions') : undefined
        const snapshot = typeof sessions?.list?.getSnapshot === 'function' ? sessions.list.getSnapshot() : undefined
        const row = snapshot !== null && typeof snapshot === 'object' && snapshot.byId !== undefined
          ? snapshot.byId[sessionId]
          : undefined
        const cwd = row !== null && typeof row === 'object' ? row.cwd : undefined
        return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
      } catch (error) {
        console.warn(LOG, '读取会话工作目录失败', error)
        return undefined
      }
    }

    /**
     * 会话显示名：与 DSH 左侧会话列表同一份投影（durable title → 项目目录名 → 会话 id）。
     * 「全部会话」视图下每条记录要在最下面标出属于哪个会话；历史会话可能不在当前列表快照里，
     * 这时退回 id 的短形式（DSH 的会话 id 形如 session-<uuid>，去掉前缀再取 8 位），
     * 保证不同会话仍能区分，而不是所有记录都空着。
     */
    function sessionNameOf(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      try {
        const sessions = typeof clientCtx?.get === 'function' ? clientCtx.get('sessions') : undefined
        const snapshot = typeof sessions?.list?.getSnapshot === 'function' ? sessions.list.getSnapshot() : undefined
        const row = snapshot !== null && typeof snapshot === 'object' && snapshot.byId !== undefined
          ? snapshot.byId[sessionId]
          : undefined
        const displayTitle = row !== null && typeof row === 'object' ? row.displayTitle : undefined
        if (typeof displayTitle === 'string' && displayTitle !== '') return displayTitle
      } catch (error) {
        console.warn(LOG, '读取会话名称失败', error)
      }
      // 8 位足以区分同机会话，又不至于把这行小字挤成两行
      const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
      return bare.length > 8 ? bare.slice(0, 8) : bare
    }

    /** 策略快照的客户端缓存：设置面板与时间线共用，任何变更广播给订阅者。 */
    const policyStore = {
      value: undefined,
      error: '',
      cwd: undefined,
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
      emit() {
        for (const listener of [...this.listeners]) listener()
      },
      /** 拉一次策略快照；cwd 给定时一并更新项目作用域。 */
      async load(cwd) {
        if (cwd !== undefined) this.cwd = cwd
        const query = this.cwd === undefined ? '' : '?cwd=' + encodeURIComponent(this.cwd)
        try {
          const response = await fetch(API_POLICY + query, { headers: { accept: 'application/json' } })
          const data = await response.json()
          if (data === null || typeof data !== 'object' || data.ok !== true) {
            throw new Error(String(data?.error ?? 'bad response'))
          }
          this.value = data
          this.error = ''
        } catch (error) {
          this.error = String(error?.message ?? error)
        }
        this.emit()
      },
      /** 写策略（改阈值 / 删规则）；成功后自动重拉快照。 */
      async post(body) {
        const response = await fetch(API_POLICY, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = await response.json()
        if (data === null || typeof data !== 'object' || data.ok !== true) {
          throw new Error(String(data?.error ?? 'policy write failed'))
        }
        await this.load()
        return data
      },
    }

    /**
     * 把一条审批记录升级/降级成规则。`rule` 给定时以它为准（用户在时间线上手填/微调过的条件，
     * 宿主校验后原样写入）；不给时由宿主依据记录里的模型建议产出，没有建议就精确回落到该次签名。
     */
    async function promoteRecord(recordId, scope, list, sessionId, rule) {
      const response = await fetch(API_RULE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recordId,
          scope,
          list,
          // 会话 id 让宿主把「现场模型优化」挂在对应会话的 Agent 下
          ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
          ...(rule === undefined ? {} : { rule }),
        }),
      })
      const data = await response.json()
      if (data === null || typeof data !== 'object' || data.ok !== true) {
        throw new Error(String(data?.error ?? 'rule write failed'))
      }
      await policyStore.load()
      return data
    }

    /**
     * 请宿主**按指定匹配条件**重新生成一条规则（不写名单，只回给界面填草稿）。
     * 提示词里会带上用户选的条件与当前草稿，所以模型知道要产出哪种条件。
     * @param recordId 审批记录 id
     * @param list 'allow' / 'deny'（只影响提示词里名单的说法）
     * @param kind 用户选的匹配条件
     * @param draft 当前草稿（给模型参考）
     * @param sessionId 会话 id（宿主按它记 llm session）
     * @returns {Promise<object>} 宿主回执（rule.match.kind / rule.match.value / rule.label）
     */
    async function draftRule(recordId, list, kind, draft, sessionId) {
      const response = await fetch(API_RULE_DRAFT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recordId,
          list,
          kind,
          draft,
          ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
        }),
      })
      const data = await response.json()
      if (data === null || typeof data !== 'object' || data.ok !== true) {
        throw new Error(String(data?.error ?? 'rule draft failed'))
      }
      return data
    }

    /**
     * 撤销一次「加入名单」：宿主按记录里的凭据删掉那次写入的规则、把它顶掉的旧规则放回去。
     * 客户端只报 recordId——**不让浏览器指定要恢复什么**，凭据只认记录里那一份。
     * @param recordId 审批记录 id
     * @returns {Promise<object>} 宿主回执（restored：被放回去的规则标签）
     */
    async function revertRecord(recordId) {
      const response = await fetch(API_RULE_REVERT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recordId }),
      })
      const data = await response.json()
      if (data === null || typeof data !== 'object' || data.ok !== true) {
        throw new Error(String(data?.error ?? 'revert failed'))
      }
      await policyStore.load()
      return data
    }

    /** 规则来源文案。 */
    function sourceLabel(source) {
      if (source === 'model') return t.sourceModel
      if (source === 'memory') return t.sourceMemory
      return t.sourceUser
    }

    /** 匹配条件下拉的顺序（与宿主 policy.js 的 MATCH_KINDS 同一套闭集）。 */
    const MATCH_KIND_ORDER = ['command_prefix', 'signature', 'path_prefix']

    /**
     * 模型建议能不能当表单默认值：**`signature`（权限指纹）类的建议必须逐字等于本次签名**——
     * 与宿主 `suggestionUsable` 里「signature 必须等于本次签名 key」那道闸同口径。
     * 前缀类建议这里不拦（对不对一眼能看出来，宿主提交时还会再验一次）。
     * 真机实测（~/.dsh/dsh-auto-pass/records/*.json）：模型把「签名」写成了
     * `danger-full-access` / `escalation=danger-full-access` 这类一句描述，当默认值填进表单后
     * 既与详情里的权限指纹对不上，点按钮还会被宿主用 400 `not-covering` 拒掉。
     * @param record 审批记录
     * @param suggested 记录里的模型建议规则
     * @returns {boolean} 能当默认值返回 true
     */
    function suggestedRuleFits(record, suggested) {
      if (suggested?.match?.kind !== 'signature') return true
      const key = record?.signature?.key
      return typeof key === 'string' && key !== '' && String(suggested.match.value ?? '') === key
    }

    /**
     * 规则草稿：默认用这次审查的模型建议（能覆盖本次动作的才行，见 suggestedRuleFits），
     * 没有可用建议就用本次动作的权限指纹——它是最窄、最安全又耐用的默认值，
     * 也正是详情里那一行「权限指纹」。
     * fromModel 只影响界面上的那句说明，用户改不改都行。
     */
    function ruleDraftOf(record) {
      const suggested = record?.suggestedRule
      if (suggested !== null && typeof suggested === 'object' && suggested.match !== undefined
        && suggested.match !== null && suggestedRuleFits(record, suggested)) {
        return {
          kind: suggested.match.kind,
          value: String(suggested.match.value ?? ''),
          label: String(suggested.label ?? ''),
          fromModel: true,
          edited: false,
          source: 'suggestion',
          pending: false,
          error: '',
        }
      }
      return {
        kind: 'signature',
        value: String(record?.signature?.key ?? ''),
        label: String(record?.signature?.text ?? record?.toolName ?? ''),
        fromModel: false,
        edited: false,
        source: 'signature',
        pending: false,
        error: '',
      }
    }

    /**
     * 把一条已有规则的匹配值翻译成另一种条件的值（设置面板里改条件时用）：
     * 权限指纹 → 命令前缀，就从签名 key 的 `cmd:` 段里把命令取出来（同样砍掉管道之后）。
     * 翻译不出来就保留原值，绝不猜。
     */
    /**
     * 命令前缀用的文本：砍掉第一个管道之后（只决定怎么显示输出）与结尾的纯输出重定向
     * （`2>&1` / `>nul`）——与宿主 countingCommand 同口径，界面草稿才不会和宿主默认值长得不一样。
     * @param command 原始命令文本
     * @returns {string} 归一化后的命令
     */
    function plainCommand(command) {
      const text = String(command ?? '').replace(/\s+/g, ' ').trim()
      // 与宿主 firstPipeOutsideQuotes 同口径：引号里的竖线（正则里的 |）不算管道
      let quote = ''
      let cut = -1
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]
        if (quote !== '') {
          if (char === quote) quote = ''
          continue
        }
        if (char === '"' || char === "'") quote = char
        else if (char === '|') {
          cut = index
          break
        }
      }
      const head = (cut === -1 ? text : text.slice(0, cut)).trim()
      return head
        .replace(/(?:\s|^)(?:\d?>{1,2}\s*(?:&1|&2|nul|\/dev\/null)|&>{1,2}\s*(?:nul|\/dev\/null))$/i, '')
        .trim()
    }

    function ruleValueForKind(kind, value) {
      if (kind !== 'command_prefix') return value
      const head = String(value).split('\u0000')[1]
      if (typeof head !== 'string' || !head.startsWith('cmd:')) return value
      return plainCommand(head.slice('cmd:'.length))
    }

    /** 命令前缀的默认值：命令砍掉管道之后与结尾重定向（与宿主 defaultRuleOf 同源）。 */
    function commandPrefixOf(signature) {
      const plain = plainCommand(typeof signature?.command === 'string' ? signature.command : '')
      return plain === '' ? undefined : plain
    }

    /**
     * 换匹配条件时草稿值该填什么：签名 → 本次签名 key；命令前缀 → 本次命令（砍掉管道之后）；
     * 路径前缀 → 本次动作的第一个路径。推导不出来就保留用户原来的值（别把人手填的内容冲掉）。
     * @param record 审批记录
     * @param kind 新选的匹配条件
     * @param fallback 保留值（推导不出来时用它）
     * @returns {string} 新的匹配值
     */
    function ruleDraftValueOf(record, kind, fallback) {
      const signature = record?.signature
      if (kind === 'signature') {
        return typeof signature?.key === 'string' && signature.key !== '' ? signature.key : fallback
      }
      if (kind === 'command_prefix') return commandPrefixOf(signature) ?? fallback
      if (kind === 'path_prefix') {
        const paths = Array.isArray(signature?.paths) ? signature.paths : []
        return paths.length > 0 ? String(paths[0]) : fallback
      }
      return fallback
    }

    /**
     * 这次动作能不能用某种匹配条件（与宿主 kindApplicable 同口径）：新记录一定带 `paths` 字段
     * （可能是空数组），所以「有没有命令 / 文件路径」是可知的——可知却对不上就禁用那个按钮，
     * 免得生成一条永远命不中的规则（真机踩过：pwsh 命令记录被切到路径前缀，模型给了个目录）。
     * 老记录判不了，按可用处理。
     * @param record 审批记录
     * @param kind 匹配条件
     * @returns {boolean} 可用返回 true
     */
    function kindApplicable(record, kind) {
      const signature = record?.signature
      if (signature === undefined || signature === null) return true
      const known = Array.isArray(signature.paths)
      if (kind === 'command_prefix') return known !== true || typeof signature.command === 'string'
      if (kind === 'path_prefix') {
        return known !== true || (Array.isArray(signature.paths) && signature.paths.length > 0)
      }
      return true
    }

    /**
     * 草稿那一行的说明文字：正在让模型按条件重新生成 / 模型已生成 / 本地按条件推导 / 初始来源。
     * @param draft 规则草稿
     * @returns {string} 说明文本
     */
    function draftHintText(draft) {
      if (draft.pending === true) return t.ruleDraftRegenerating
      if (typeof draft.error === 'string' && draft.error !== '') return t.ruleDraftRegenFailed
      if (draft.source === 'model') return t.ruleDraftRegenerated
      if (draft.source === 'local' || draft.edited === true) return t.ruleDraftEdited
      return draft.fromModel === true ? t.ruleDraftFromModel : t.ruleDraftFromSignature
    }

    /**
     * 草稿的本地校验（与宿主 validateRuleInput 同口径）：值与标签非空，前缀类条件至少 3 个字符。
     * @param draft 规则草稿
     * @returns {string|undefined} 有问题的说明文本；没问题返回 undefined
     */
    function ruleDraftProblem(draft) {
      if (draft.label.trim() === '') return t.ruleNeedLabel
      if (draft.value.trim() === '') return t.ruleNeedValue
      if (draft.kind !== 'signature' && draft.value.trim().length < 3) return t.ruleNeedLongerPrefix
      // 路径前缀的通配符口径与宿主 validatePathPattern 一致，先把关省得白跑一趟
      if (draft.kind === 'path_prefix') {
        const value = draft.value.trim()
        if (value.includes('**')) return t.ruleNoDoubleStar
        if (/[?[\]]/.test(value)) return t.ruleNoOtherGlob
        const star = value.indexOf('*')
        if (star !== -1 && value.slice(star + 1).includes('/')) return t.ruleStarLastSegment
      }
      return undefined
    }

    /**
     * 权限指纹的可视化：把机器串 `工具\u0000cmd:命令\u0000x:{额外参数}` 拆开。
     * 指纹是给机器用的（规则匹配、连续计数），管理名单的人得看得懂它在授权什么——
     * 界面上只读，并按这个结构摊开显示（用户 2026-09-16 要求）。
     * **不在规则里另存一份渲染文本**：指纹本身就是唯一事实来源，渲染每次都从它现算。
     * 解析不出来（老记录、手搓的值）返回 undefined，调用方退回显示原始值。
     * @param value 指纹串（规则的 match.value 或记录里的 signature.key）
     * @returns {{tool: string, command?: string, args?: string, extras: {key: string, value: string}[], short: string}|undefined}
     */
    function fingerprintOf(value) {
      const parts = String(value ?? '').split('\u0000')
      if (parts.length < 3) return undefined
      const extraText = parts.slice(2).join('\u0000')
      if (!extraText.startsWith('x:')) return undefined
      let extra
      try {
        extra = JSON.parse(extraText.slice(2))
      } catch (error) {
        return undefined
      }
      if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) return undefined
      const base = parts[1]
      let head
      if (base.startsWith('cmd:')) head = { command: base.slice('cmd:'.length) }
      else if (base.startsWith('args:')) head = { args: clipText(base.slice('args:'.length), 80) }
      else return undefined
      const extras = Object.keys(extra).sort().map(key => ({ key, value: clipText(fingerprintValue(extra[key]), 60) }))
      const bits = [parts[0], head.command ?? head.args]
      for (const item of extras) bits.push(item.key + '=' + item.value)
      return { tool: parts[0], ...head, extras, short: bits.join(' · ') }
    }

    /** 指纹里某个参数值的显示文本：字符串直接给，其余压成 JSON。 */
    function fingerprintValue(value) {
      if (typeof value === 'string') return value
      try {
        return JSON.stringify(value)
      } catch (error) {
        return String(value)
      }
    }

    /** 截断长文本（指纹里的命令与参数都可能很长，界面上只给一眼能看完的一段）。 */
    function clipText(text, max) {
      const value = String(text ?? '')
      return value.length > max ? value.slice(0, max) + '…' : value
    }

    /** 一行紧凑的指纹文案（列表与表单里用）；解析不出来就退回原始值。 */
    function fingerprintShort(value) {
      const parsed = fingerprintOf(value)
      return parsed === undefined ? clipText(value, 60) : parsed.short
    }

    /**
     * 指纹的分行明细（详情里用）：工具 / 命令（或参数）/ 额外参数。
     * 解析不出来就返回空数组，只留详情里那一行原始 key。
     * @param value 指纹串
     * @returns {Array} Field 元素数组
     */
    function fingerprintFields(value) {
      const parsed = fingerprintOf(value)
      if (parsed === undefined) return []
      return [
        react.createElement(Field, { key: 'fingerprint-tool', label: t.fingerprintTool, value: parsed.tool }),
        react.createElement(Field, {
          key: 'fingerprint-head',
          label: parsed.command === undefined ? t.fingerprintArgs : t.fingerprintCommand,
          value: parsed.command ?? parsed.args,
          mono: true,
        }),
        ...(parsed.extras.length === 0 ? [] : [react.createElement(Field, {
          key: 'fingerprint-extra',
          label: t.fingerprintExtra,
          value: parsed.extras.map(item => item.key + '=' + item.value).join(' / '),
          mono: true,
        })]),
      ]
    }

    /**
     * 把文本写进剪贴板。**原始指纹含 NUL 分隔符**，只有走剪贴板 API 才能整串复制：
     * 在界面上选中那段文字再复制，NUL 会被吃掉，粘出来是 `pwshcmd:pnpm testx:{…}` 这种废串
     * （真机反馈过），所以显示走渲染、复制走 API。拿不到 clipboard 时返回 false，调用方提示一句。
     */
    async function copyText(text) {
      const clipboard = typeof navigator === 'object' && navigator !== null ? navigator.clipboard : undefined
      if (clipboard === undefined || clipboard === null || typeof clipboard.writeText !== 'function') return false
      try {
        await clipboard.writeText(String(text ?? ''))
        return true
      } catch (error) {
        return false
      }
    }

    /**
     * 权限指纹的只读展示：一行可视化 + 「复制指纹」按钮，原始串只挂 title。
     * **不把原始串塞进输入框**：那串里全是 NUL 分隔符，浏览器把每个 NUL 画成一个方框（真机反馈
     * 「像乱码」），而且选中复制会丢分隔符——所以显示走渲染，整串复制走剪贴板 API。
     */
    function FingerprintValue({ value }) {
      const raw = String(value ?? '')
      const [note, setNote] = react.useState('')
      const copy = () => {
        void copyText(raw).then(ok => setNote(ok ? t.copiedFingerprint : t.copyFingerprintFailed))
      }
      return react.createElement('span', { className: 'ap-fingerprintValue', title: raw },
        react.createElement('span', { className: 'ap-mono ap-fingerprintShort' }, fingerprintShort(raw)),
        react.createElement('button', { type: 'button', className: 'ap-btn', onClick: copy }, t.copyFingerprint),
        note !== '' && react.createElement('span', { className: 'ap-note' }, note))
    }

    /** 匹配条件文案。 */
    function kindLabel(kind) {
      if (kind === 'command_prefix') return t.kindCommandPrefix
      if (kind === 'path_prefix') return t.kindPathPrefix
      return t.kindSignature
    }

    /** 作用域文案。 */
    function scopeLabel(scope) {
      return scope === 'project' ? t.scopeProject : t.scopeGlobal
    }

    /** 把一组字段渲染成详情行。title 用来挂那些**不适合直接显示**的原始值（比如含 NUL 的指纹）。 */
    function Field({ label, value, mono, title }) {
      if (value === undefined || value === null || value === '') return null
      return react.createElement('div', { className: 'ap-field' },
        react.createElement('span', { className: 'ap-fieldKey' }, label),
        react.createElement('span', {
          className: 'ap-fieldVal' + (mono === true ? ' ap-mono' : ''),
          ...(title === undefined ? {} : { title: String(title) }),
        }, String(value)))
    }

    /**
     * 命中规则的来源：记录里存了就用记录里的；老记录没有这个字段时，按 ruleId 去当前策略快照反查——
     * 规则本身带 source，所以历史记录也能显示「自动 / 手动」。
     */
    function ruleSourceOf(record) {
      if (record.policy === undefined) return undefined
      if (record.policy.source !== undefined) return record.policy.source
      const snapshot = policyStore.value
      if (snapshot === null || typeof snapshot !== 'object') return undefined
      const view = record.policy.scope === 'project' ? snapshot.project : snapshot.global
      if (view === undefined || view === null) return undefined
      for (const list of ['allow', 'deny']) {
        const rule = (view[list] ?? []).find(candidate => candidate.id === record.policy.ruleId)
        if (rule !== undefined && rule.source !== undefined) return rule.source
      }
      return undefined
    }

    /** 记录里的决策来源；老记录没有这个字段时按 verdict / outcome 兜底推断。 */
    function decidedByOf(record) {
      if (record.decidedBy === 'auto' || record.decidedBy === 'human') return record.decidedBy
      // 与宿主 decisionSource 同一套口径：黑名单直接拒绝是插件自己判的，没有人参与
      if (record.verdict === 'blacklist-reject') return 'auto'
      const pluginDecided = record.verdict === 'allow' || record.policy?.list === 'allow'
      return pluginDecided && record.outcome === 'allowed-once' ? 'auto' : 'human'
    }

    /**
     * 快捷筛选的键：命中名单两类（allow / deny）+ 决策来源两类（auto / human），
     * 数组顺序就是按钮顺序；四个键互不重叠（见 matchesFilter）。
     * 「全部」不在表里，它是清空筛选的入口。
     */
    const FILTER_KEYS = ['allow', 'deny', 'auto', 'human']

    /**
     * 一条记录是否命中某个快捷筛选键。四个键**互不重叠**，四个 chip 的条数相加正好是总数。
     * allow / deny 看这次审批有没有命中名单（record.policy.list）；auto / human 看决策来源，
     * 但**命中名单的记录一律不算**——命中白名单那次 decidedBy 是 auto、命中黑名单那次是 human，
     * 不排除就会让同一批记录同时出现在两类里。
     * 于是 auto = 模型自动放行的记录，human = 你最终拍板的记录，两者都不含被名单拦下的那些。
     * @param {object} record 审批记录
     * @param {string} key 筛选键
     * @returns {boolean} 命中返回 true
     */
    function matchesFilter(record, key) {
      const list = record.policy?.list
      if (key === 'allow' || key === 'deny') {
        return list === key
      }
      if (list !== undefined) {
        return false
      }
      return decidedByOf(record) === key
    }

    /**
     * 快捷筛选按钮的文案：白/黑名单复用命中名单的措辞，自动/人工复用决策来源的措辞。
     * @param {string} key 筛选键
     * @returns {string} 按钮文字
     */
    function filterLabel(key) {
      const map = { allow: t.hitAllow, deny: t.hitDeny, auto: t.filterAuto, human: t.filterHuman }
      return map[key] ?? key
    }

    /**
     * 结论徽标：allow=模型自动批准；blacklist-reject=插件按黑名单直接拒绝（设置开启时）；
     * deny=模型拒绝（转人工）；其余按「审查未完成」显示。后两种都会转交人工，所以是警告色。
     */
    function VerdictBadge({ record }) {
      const allow = record.verdict === 'allow'
      const label = allow
        ? t.autoApproved
        : record.verdict === 'blacklist-reject' ? t.denyRejected
          : record.verdict === 'deny' ? t.referred : t.reviewFailed
      return react.createElement('span', {
        className: 'ap-badge ' + (allow ? 'ap-badgeOk' : 'ap-badgeWarn'),
        title: record.rationale ?? '',
      }, label)
    }

    /** 人工侧结论的文案与徽标样式；没有人工结论时返回 undefined。 */
    function outcomeOf(record) {
      const map = {
        'allowed-once': [t.outcomeAllowed, 'ap-badgeOk'],
        rejected: [t.outcomeRejected, 'ap-badgeWarn'],
        unavailable: [t.outcomeUnavailable, 'ap-badgeMuted'],
        cancelled: [t.outcomeCancelled, 'ap-badgeMuted'],
      }
      return map[record.outcome]
    }

    /** 最终结果徽标：转人工的记录才需要展示人工侧结果。 */
    function OutcomeBadge({ record }) {
      if (record.verdict === 'allow') return null
      const hit = outcomeOf(record)
      if (hit === undefined) return null
      return react.createElement('span', { className: 'ap-badge ' + hit[1] }, hit[0])
    }

    /**
     * 折叠态那一行标签：「命中名单」与「决策来源」合并成一行——
     * chip 是「名单·自动/人工」（没命中名单时只剩 自动/人工），说明文字是命中规则信息，
     * 没命中时是决策含义（自动 = 模型自动审批；人工 = 人工审批通过/拒绝）。
     */
    function TagRow({ record }) {
      const auto = decidedByOf(record) === 'auto'
      const policy = record.policy
      const listLabel = policy === undefined ? '' : (policy.list === 'allow' ? t.hitAllow : t.hitDeny)
      const sourceLabel = auto ? t.decidedAuto : t.decidedHuman
      const text = policy === undefined
        ? (auto ? t.decidedAutoText : t.decidedHumanText + ' · ' + (outcomeOf(record)?.[0] ?? t.decidedUnknown))
        : scopeLabel(policy.scope) + ' · ' + String(policy.label ?? '')
      const badgeClass = policy === undefined
        ? (auto ? 'ap-badgeInfo' : 'ap-badgeMuted')
        : (policy.list === 'allow' ? 'ap-badgeOk' : 'ap-badgeWarn')
      return react.createElement('span', {
        className: 'ap-hitRow',
        title: auto ? t.decidedAutoTitle : t.decidedHumanTitle,
      },
        react.createElement('span', { className: 'ap-badge ' + badgeClass },
          listLabel === '' ? sourceLabel : listLabel + '·' + sourceLabel),
        react.createElement('span', { className: 'ap-hitText' }, text))
    }

    /** 时间戳格式化：完整时间放 title，行内只显示到秒。 */
    function formatTime(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value ?? '')
      const pad = (n) => String(n).padStart(2, '0')
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    /** 升级/降级按钮组：两种名单 × 两种作用域，作用域真值由宿主按记录里的 cwd 决定。 */
    function RuleActions({ record, onDone }) {
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')
      const [done, setDone] = react.useState(undefined)
      // 可调草稿：默认模型建议 / 本次动作的权限指纹，用户不满意就直接改（用户 2026-09-15 要求）
      const [draft, setDraft] = react.useState(() => ruleDraftOf(record))
      const draftProblem = ruleDraftProblem(draft)
      const patch = next => setDraft(previous => ({ ...previous, ...next }))
      /** 这次动作用不上的条件（没有命令 / 没有路径）：按钮已禁用，这里给一行说明。 */
      const unavailableNote = MATCH_KIND_ORDER.filter(kind => kindApplicable(record, kind) !== true)
        .map(kind => t.ruleKindUnavailable(kindLabel(kind))).join('；')
      /**
       * 换匹配条件：**值立刻按新条件刷新**（用户要求），不会留下「条件 = 命令前缀、值却是签名 key」
       * 这种自相矛盾的组合；换过之后就不再是「模型建议」，提示语也跟着换。
       */
      const chooseKind = kind => {
        // 这次动作根本用不上这个条件（没有命令 / 没有路径）：按钮已禁用，这里再兜一层
        if (kindApplicable(record, kind) !== true) return
        // ① 本地先按新条件推导一个值：不用等模型，界面立刻不空转
        const derived = ruleDraftValueOf(record, kind, draft.value)
        setDraft(previous => ({
          ...previous,
          kind,
          value: derived,
          fromModel: false,
          edited: true,
          source: 'local',
          pending: true,
          error: '',
        }))
        // ② 同时请模型**按这个条件**重新生成（提示词带上条件与当前草稿）；回来时若还停在这个
        //    条件上就覆盖草稿（用户随时可以接着改），换了条件或失败就保留本地推导值
        if (typeof record.id !== 'string' || record.id === '') return
        draftRule(record.id, 'allow', kind, { kind, value: derived, label: draft.label }, record.sessionId)
          .then(data => setDraft(previous => previous.kind === kind
            ? {
              ...previous,
              source: 'model',
              pending: false,
              error: '',
              value: String(data.rule?.match?.value ?? previous.value),
              label: String(data.rule?.label ?? previous.label),
            }
            : previous))
          .catch(cause => setDraft(previous => previous.kind === kind
            ? { ...previous, pending: false, error: String(cause?.message ?? cause) }
            : previous))
      }
      const run = (list, scope) => {
        setBusy(true)
        setError('')
        setDone(undefined)
        promoteRecord(record.id, scope, list, record.sessionId, {
          tool: record.toolName,
          match: { kind: draft.kind, value: draft.value },
          label: draft.label,
        })
          .then(data => {
            setDone(data)
            if (typeof onDone === 'function') onDone()
          })
          .catch(cause => setError(String(cause?.message ?? cause)))
          .finally(() => setBusy(false))
      }
      // 规则文本可能来自「审查时的建议」「现场模型优化」或「权限指纹兜底」，如实写出来；
      // 查重结果也如实写出来（三选一）：已有规则覆盖了这次动作（没写新条目）/ 更新了同一条规则 /
      // 顺带合并掉了几条被新规则覆盖的窄规则——用户一眼能看出「为什么名单没变或变少了」
      // 被这次写入顶掉的旧规则（同名更新掉的那条 + 被覆盖掉的窄规则）**点名列出来**：
      // 「我的规则明明不一样，为什么被覆盖/合并了」必须一眼看明白（用户 2026-09-16）
      const dropped = Array.isArray(done?.dropped) ? done.dropped.map(label => String(label)) : []
      const droppedText = dropped.filter(label => label !== '').join(' / ')
      const dedupeNote = done === undefined
        ? ''
        : done.covered === true
          ? t.appliedCovered
          : (done.replaced === true ? t.appliedReplaced(droppedText) : '')
            + (typeof done.merged === 'number' && done.merged > 0 ? t.appliedMerged(done.merged, droppedText) : '')
      const doneText = done === undefined
        ? undefined
        : (done.optimizedBy === 'signature'
          ? t.appliedFallback
          : done.optimizedBy === 'record' ? t.appliedRecord
            : done.optimizedBy === 'manual' ? t.appliedManual : t.appliedModel)
          + dedupeNote
          + '：' + String(done.rule?.label ?? '')
      const scopeButtons = (list, className) => ['project', 'global'].map(scope => react.createElement('button', {
        key: list + ':' + scope,
        type: 'button',
        className: 'ap-btn ' + className,
        disabled: busy || draftProblem !== undefined || typeof record.id !== 'string',
        onClick: () => run(list, scope),
      }, scope === 'project' ? t.scopeProject : t.scopeGlobal))
      return react.createElement('div', { className: 'ap-actions' },
        // 匹配条件 / 值 / 标签都能改：默认填的是模型建议或本次动作的权限指纹，按钮按这里的内容写入。
        // 匹配条件用自带的分段按钮，不用原生 <select>：原生下拉的弹层在深色主题下是白底黑字（用户反馈）
        react.createElement('span', { className: 'ap-actionsLabel' }, t.ruleDraftLabel),
        react.createElement('div', { className: 'ap-ruleBlock' },
          react.createElement('div', { className: 'ap-ruleEditor' },
            react.createElement('div', { className: 'ap-seg', role: 'group', 'aria-label': t.ruleKind },
              ...MATCH_KIND_ORDER.map(kind => react.createElement('button', {
                key: kind,
                type: 'button',
                'data-kind': kind,
                'data-on': draft.kind === kind ? '1' : '0',
                'aria-pressed': draft.kind === kind,
                // 这次动作没有命令 / 路径时对应条件禁用：那种规则永远命不中
                disabled: kindApplicable(record, kind) !== true,
                title: kindApplicable(record, kind) === true ? undefined : t.ruleKindUnavailable(kindLabel(kind)),
                onClick: () => chooseKind(kind),
              }, kindLabel(kind)))),
            // 权限指纹：显示渲染后的可视化 + 一键复制（原始串含 NUL，塞进输入框会显示成方框）；
            // 别的条件才是可编辑的输入框
            draft.kind === 'signature'
              ? react.createElement(FingerprintValue, { value: draft.value })
              : react.createElement('input', {
                className: 'ap-input ap-inputWide',
                'aria-label': t.ruleValue,
                title: draft.value,
                value: draft.value,
                onChange: event => patch({ value: event.target.value }),
              }),
            react.createElement('input', {
              className: 'ap-input ap-inputWide',
              'aria-label': t.ruleLabelField,
              title: draft.label,
              value: draft.label,
              onChange: event => patch({ label: event.target.value }),
            })),
          draft.kind === 'signature'
            && react.createElement('span', { className: 'ap-note' }, t.fingerprintReadonly),
          react.createElement('span', { className: 'ap-note', title: draft.error === '' ? undefined : draft.error },
            draftHintText(draft)),
          // 选了路径前缀就说明一下通配符口径：只支持单层 *（** 会被宿主拒绝）
          draft.kind === 'path_prefix'
            && react.createElement('span', { className: 'ap-note' }, t.rulePathGlobHint),
          // 命令前缀里的 * 是**字面量**（用户问过「pnpm vitest run tests/* 支持吗」）：提示一句，
          // 别指望它会像 shell 那样展开——想覆盖一类命令就把前缀写短
          draft.kind === 'command_prefix' && draft.value.includes('*')
            && react.createElement('span', { className: 'ap-note' }, t.ruleCommandStarHint),
          // 这次动作用不上的条件（没有命令 / 没有路径）明说一句，别让按钮无声地灰着
          unavailableNote !== ''
            && react.createElement('span', { className: 'ap-note' }, unavailableNote),
          draftProblem !== undefined && react.createElement('span', { className: 'ap-note ap-warn' }, draftProblem)),
        // 两行操作各自成行：标签 + 该组的两个作用域按钮，不会和别的控件挤在一起换行
        react.createElement('div', { className: 'ap-actionRow' },
          react.createElement('span', { className: 'ap-actionsLabel' }, t.promote),
          ...scopeButtons('allow', 'ap-btnPrimary')),
        react.createElement('div', { className: 'ap-actionRow' },
          react.createElement('span', { className: 'ap-actionsLabel' }, t.demote),
          ...scopeButtons('deny', 'ap-btnDanger')),
        (busy || error !== '' || doneText !== undefined) && react.createElement('div', { className: 'ap-actionRow' },
          busy && react.createElement('span', { className: 'ap-note' }, t.working),
          error !== '' && react.createElement('span', { className: 'ap-note ap-warn' }, error),
          doneText !== undefined && react.createElement('span', {
            className: done.optimizedBy === 'signature' ? 'ap-note ap-warn' : 'ap-note',
          }, doneText)))
    }

    /**
     * 「本次加入的规则」那一行：说明这次写了什么、顶掉了哪些旧规则，并可一键撤销。
     * 凭据在记录里（`ruleApplied`），所以刷新页面后照样能撤销；撤销过（`ruleReverted`）就不再给按钮。
     * 「已有规则覆盖这次动作」（covered）没有写入任何东西，**不给撤销**——那种 ruleId 指的是别人的规则。
     */
    function UndoRule({ record, onDone }) {
      const applied = record?.ruleApplied
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')
      const [undone, setUndone] = react.useState(record?.ruleReverted !== undefined)
      if (applied === undefined || applied === null || typeof applied.ruleId !== 'string'
        || applied.ruleId === '' || applied.covered === true) return null
      const dropped = []
      if (applied.previousRule !== undefined && applied.previousRule !== null) {
        dropped.push(String(applied.previousRule.label ?? applied.previousRule.id ?? ''))
      }
      for (const rule of Array.isArray(applied.mergedRules) ? applied.mergedRules : []) {
        dropped.push(String(rule?.label ?? rule?.id ?? ''))
      }
      const droppedText = dropped.filter(label => label !== '').join(' / ')
      const run = () => {
        setBusy(true)
        setError('')
        revertRecord(record.id)
          .then(() => {
            setUndone(true)
            if (typeof onDone === 'function') onDone()
          })
          .catch(cause => setError(String(cause?.message ?? cause)))
          .finally(() => setBusy(false))
      }
      return react.createElement('div', { className: 'ap-actionRow ap-undo' },
        react.createElement('span', { className: 'ap-actionsLabel' }, t.ruleUndoLabel),
        react.createElement('span', { className: 'ap-note' },
          scopeLabel(applied.scope) + ' / ' + (applied.list === 'allow' ? t.allowList : t.denyList)
          + ' · ' + String(applied.label ?? '')),
        droppedText !== '' && react.createElement('span', { className: 'ap-note ap-warn' }, t.ruleDropped(droppedText)),
        undone
          ? react.createElement('span', { className: 'ap-note' }, t.ruleUndone)
          : react.createElement('button', {
            type: 'button',
            className: 'ap-btn',
            disabled: busy || typeof record.id !== 'string',
            onClick: run,
          }, busy ? t.working : t.undoRule),
        error !== '' && react.createElement('span', { className: 'ap-note ap-warn' }, error))
    }

    /**
     * 把记录里的 token 用量格式化成详情里一行的值文本。
     * 只显示记录里确实存在的数字字段：审查失败或提供方不给用量时整行不显示。
     * @param {object|undefined} usage 宿主写入的用量
     * @param {object} t 当前语言的字典
     * @returns {string|undefined} 形如「输入 1200 · 输出 40 · 合计 1240」的文本
     */
    function formatUsage(usage, t) {
      if (usage === null || typeof usage !== 'object') return undefined
      const parts = []
      if (typeof usage.inputTokens === 'number') parts.push(t.usageIn + ' ' + String(usage.inputTokens))
      if (typeof usage.outputTokens === 'number') parts.push(t.usageOut + ' ' + String(usage.outputTokens))
      if (typeof usage.totalTokens === 'number') parts.push(t.usageTotal + ' ' + String(usage.totalTokens))
      return parts.length === 0 ? undefined : parts.join(' · ')
    }

    /** 单条记录：折叠只显示概要，展开显示风险/授权/理由/动作，以及升级/降级操作。 */
    function RecordRow({ record, open, onToggle, onChanged, showSession }) {
      // 会话名只在「全部会话」视图里需要：本次会话下每条都属于当前会话，写了只是噪声
      const sessionName = showSession === true ? sessionNameOf(record.sessionId) : undefined
      const route = record.route === undefined ? undefined : record.route.provider + '/' + record.route.model
      const suggested = record.suggestedRule === undefined
        ? undefined
        : record.suggestedRule.label + '（' + kindLabel(record.suggestedRule.match?.kind) + '：' + String(record.suggestedRule.match?.value ?? '') + '）'
      const applied = record.ruleApplied === undefined
        ? undefined
        : scopeLabel(record.ruleApplied.scope) + ' / ' + (record.ruleApplied.list === 'allow' ? t.allowList : t.denyList) + ' · ' + String(record.ruleApplied.label ?? '')
          // 覆盖命中：这次其实什么都没写，明细里说清楚，别让人以为名单多了这条
          + (record.ruleApplied.covered === true ? t.appliedCovered : '')
          + (record.ruleApplied.optimizedBy === 'manual' ? '（你手填的匹配条件）' : '')
      const promoted = record.promotedRule === undefined
        ? undefined
        : scopeLabel(record.promotedRule.scope) + ' · ' + String(record.promotedRule.label ?? '')
      // 命中规则信息（只在展开详情里用；折叠态由 TagRow 统一渲染）
      const hitText = record.policy === undefined
        ? undefined
        : scopeLabel(record.policy.scope) + ' · ' + String(record.policy.label ?? '')
      const declined = record.ruleDeclined === undefined
        ? undefined
        : t.ruleDeclined + ' · ' + (record.ruleDeclined.list === 'allow' ? t.allowList : t.denyList)
          + ' · ' + String(record.ruleDeclined.label ?? '')
      const approvals = typeof record.approvals === 'number' && record.approvals > 0
        ? String(record.approvals)
        : undefined
      // 审批意见：折叠态也要看得见，展开后是完整文本（CSS 限两行）
      const opinion = typeof record.rationale === 'string' && record.rationale.trim() !== ''
        ? record.rationale
        : undefined
      // 这次审查烧掉的 token（详情里展示，折叠态留给结论与标签）
      const usageText = formatUsage(record.usage, t)
      // 这次动作发生在第几轮第几步（工作流定位用；老记录没有这两个字段时整行不显示）
      const turn = typeof record.turn === 'number' ? record.turn : undefined
      const step = typeof record.step === 'number' ? record.step : undefined
      const turnStep = turn === undefined && step === undefined ? undefined : t.turnStepLabel(turn ?? '?', step ?? '?')
      return react.createElement('li', { className: 'ap-row' },
        react.createElement('button', {
          type: 'button', className: 'ap-rowHead', 'aria-expanded': open,
          onClick: onToggle,
        },
          react.createElement('span', { className: 'ap-chevron', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
          react.createElement('span', { className: 'ap-rowMain' },
            react.createElement('span', { className: 'ap-rowTop' },
              react.createElement('span', { className: 'ap-time', title: String(record.time ?? '') }, formatTime(record.time)),
              // 折叠态就能看到「第几轮第几步」：审批记录要靠它对应回对话里的那一步
              turnStep !== undefined && react.createElement('span', { className: 'ap-turnStep' }, turnStep),
              react.createElement('span', { className: 'ap-tool' }, String(record.toolName ?? '?')),
              react.createElement('span', { className: 'ap-grow' }, ''),
              react.createElement(VerdictBadge, { record }),
              react.createElement(OutcomeBadge, { record })),
            opinion !== undefined && react.createElement('span', { className: 'ap-opinion' }, opinion),
            react.createElement(TagRow, { record }))),
        open === true && react.createElement('div', { className: 'ap-detail' },
          react.createElement(Field, { label: t.risk, value: record.riskLevel }),
          react.createElement(Field, { label: t.authorization, value: record.userAuthorization }),
          react.createElement(Field, { label: t.turnStep, value: turnStep }),
          react.createElement(Field, { label: t.rationale, value: record.rationale }),
          // 人工补的拒绝理由（追问卡的回答）：与插件/模型意见分开显示
          react.createElement(Field, { label: t.rejectReason, value: record.rejectReason }),
          react.createElement(Field, { label: t.reason, value: record.reason }),
          react.createElement(Field, { label: t.action, value: record.action, mono: true }),
          // 「权限指纹」显示机器 key：与规则表单里生成的签名逐字一致（用户 2026-09-16 要求）；
          // 可读文本另起一行，别让长 key 把「这次在授权什么」这件事盖住
          // 权限指纹：显示渲染后的可视化，原始串（含 NUL）挂 title，别在详情里糊一串方框
          react.createElement(Field, {
            label: t.signature,
            value: record.signature === undefined ? undefined : fingerprintShort(record.signature.key),
            title: record.signature === undefined ? undefined : record.signature.key,
            mono: true,
          }),
          // 指纹是机器串：紧跟着按它的结构摊开（工具 / 命令或参数 / 额外参数），人一眼看得出在授权什么
          ...fingerprintFields(record.signature === undefined ? undefined : record.signature.key),
          react.createElement(Field, { label: t.signatureText, value: record.signature === undefined ? undefined : record.signature.text }),
          react.createElement(Field, { label: t.suggestedRule, value: suggested }),
          react.createElement(Field, { label: t.policyHit, value: hitText }),
          react.createElement(Field, { label: t.applied, value: applied }),
          react.createElement(Field, { label: t.promoted, value: promoted }),
          react.createElement(Field, { label: t.approvals, value: approvals }),
          react.createElement(Field, { label: t.decidedBy, value: decidedByOf(record) === 'auto' ? t.decidedAuto : t.decidedHuman }),
          react.createElement(Field, { label: t.denials, value: record.denials === undefined || record.denials === 0 ? undefined : String(record.denials) }),
          react.createElement(Field, { label: t.ruleAsk, value: declined }),
          react.createElement(Field, { label: t.latency, value: record.latencyMs === undefined ? undefined : String(record.latencyMs) + ' ms' }),
          react.createElement(Field, { label: t.reviewer, value: [record.reviewerSessionId, record.steps === undefined ? undefined : record.steps + ' steps'].filter(Boolean).join(' · ') }),
          react.createElement(Field, { label: t.tokens, value: usageText }),
          react.createElement(Field, { label: t.time, value: record.time }),
          // 升级/降级需要记录的签名或模型建议；更早版本留下的老记录两者都没有，不显示死按钮
          (record.signature !== undefined || record.suggestedRule !== undefined)
            && react.createElement(RuleActions, { record, onDone: onChanged }),
          // 「本次加入的规则」+ 撤销这次加入（记录里带撤销凭据、且没撤销过时才渲染）
          react.createElement(UndoRule, { record, onDone: onChanged })),
        // 「全部会话」时在整条记录的最下面用小字标出会话名；title 挂完整 sessionId 便于核对
        sessionName !== undefined && react.createElement('div', {
          className: 'ap-session',
          title: typeof record.sessionId === 'string' ? record.sessionId : undefined,
        }, sessionName))
    }

    /**
     * 一组规则的列表：显示标签、来源、匹配条件，并可**编辑**或删除。
     * 编辑走「原地更新」（同一 id）：改完标签或匹配条件就立刻生效，不需要删掉再加一条。
     */
    function RuleList({ scope, list, title, rules, onRemove, onEdit }) {
      const [editing, setEditing] = react.useState(undefined)
      const [draft, setDraft] = react.useState(undefined)
      const [error, setError] = react.useState('')
      /** 进入编辑态：把这条规则摊成草稿。 */
      const begin = rule => {
        setError('')
        setEditing(String(rule.id))
        setDraft({
          id: rule.id,
          tool: rule.tool,
          kind: rule.match?.kind ?? 'signature',
          value: String(rule.match?.value ?? ''),
          label: String(rule.label ?? ''),
          // 这条规则原本是不是权限指纹：决定「值只读」与「能不能切成指纹」（见下面两个判断）
          originalKind: rule.match?.kind ?? 'signature',
        })
      }
      /** 保存：本地先按宿主同口径校验，再把草稿交给面板写回。 */
      const save = () => {
        const problem = ruleDraftProblem(draft)
        if (problem !== undefined) {
          setError(problem)
          return
        }
        setEditing(undefined)
        setError('')
        onEdit(scope, list, draft.id, {
          tool: draft.tool,
          match: { kind: draft.kind, value: draft.value },
          label: draft.label,
        })
      }
      /** 一条规则的展示行（不在编辑态时）。 */
      const rowOf = rule => [
        react.createElement('span', { className: 'ap-ruleLabel', key: 'label' }, String(rule.label ?? '')),
        react.createElement('span', { className: 'ap-badge ap-badgeMuted', key: 'source' }, sourceLabel(rule.source)),
        react.createElement('span', { className: 'ap-badge ap-badgeMuted', key: 'kind' }, kindLabel(rule.match?.kind)),
        // 指纹是机器串（含 NUL 与参数 JSON），列表里给人看的是它摊开后的紧凑文案；原始值挂 title
        react.createElement('span', {
          className: 'ap-mono',
          key: 'value',
          title: String(rule.match?.value ?? ''),
        }, rule.match?.kind === 'signature'
          ? fingerprintShort(rule.match?.value)
          : String(rule.match?.value ?? '').slice(0, 48)),
        react.createElement('button', {
          type: 'button', className: 'ap-btn', key: 'edit', onClick: () => begin(rule),
        }, t.edit),
        react.createElement('button', {
          type: 'button', className: 'ap-btn', key: 'remove', onClick: () => onRemove(scope, list, rule.id),
        }, t.remove),
      ]
      /**
       * 换匹配条件：值也按新条件刷新一下（从权限指纹切到命令前缀时，把签名 key 里的命令取出来当前缀），
       * 免得留下「条件 = 命令前缀、值却是一串签名 key」这种组合。
       */
      /**
       * 设置面板里的两条指纹规则（用户 2026-09-16 要求「指纹不许手改」）：
       * - 本来就是指纹的规则：值只读，只能改标签；
       * - 不是指纹的规则：不能切成指纹——指纹只能由插件从时间线某条记录算出来，没有值可填。
       * 判断依据是**草稿里记下的原始 kind**，不是当前选中的 kind（否则切走再切回来就绕过了）。
       */
      const isFingerprint = draft => (draft?.originalKind ?? 'signature') === 'signature'
      const cannotSwitchToFingerprint = draft => isFingerprint(draft) !== true
      const chooseKind = kind => setDraft(previous => (
        kind === 'signature' && cannotSwitchToFingerprint(previous)
          ? previous
          : {
            ...previous,
            kind,
            value: ruleValueForKind(kind, previous.value),
          }))
      /** 一条规则的编辑行：匹配条件 / 值 / 标签，与时间线那块表单同一套控件（同样不用原生下拉）。 */
      const editorOf = rule => react.createElement('span', { className: 'ap-ruleEditor ap-ruleEditorRow' },
        react.createElement('span', { className: 'ap-seg', role: 'group', 'aria-label': t.ruleKind },
          ...MATCH_KIND_ORDER.map(kind => react.createElement('button', {
            key: kind,
            type: 'button',
            'data-kind': kind,
            'data-on': draft.kind === kind ? '1' : '0',
            'aria-pressed': draft.kind === kind,
            // 权限指纹不能手填：非指纹规则切成指纹没有值可填，按钮直接禁用（用户 2026-09-16 要求）
            disabled: kind === 'signature' && cannotSwitchToFingerprint(draft),
            title: kind === 'signature' && cannotSwitchToFingerprint(draft) ? t.fingerprintLocked : undefined,
            onClick: () => chooseKind(kind),
          }, kindLabel(kind)))),
        draft.kind === 'signature'
          ? react.createElement(FingerprintValue, { value: draft.value })
          : react.createElement('input', {
            className: 'ap-input ap-inputWide',
            'aria-label': t.ruleValue,
            title: draft.value,
            value: draft.value,
            onChange: event => setDraft(previous => ({ ...previous, value: event.target.value })),
          }),
        isFingerprint(draft) && react.createElement('span', { className: 'ap-note' }, t.fingerprintReadonly),
        react.createElement('input', {
          className: 'ap-input ap-inputWide',
          'aria-label': t.ruleLabelField,
          value: draft.label,
          onChange: event => setDraft(previous => ({ ...previous, label: event.target.value })),
        }),
        react.createElement('button', {
          type: 'button', className: 'ap-btn ap-btnPrimary', onClick: save,
        }, t.saveEdit),
        react.createElement('button', {
          type: 'button', className: 'ap-btn', onClick: () => setEditing(undefined),
        }, t.cancelEdit))
      return react.createElement('div', null,
        react.createElement('div', { className: 'ap-subTitle' }, title),
        rules.length === 0
          ? react.createElement('div', { className: 'ap-note' }, t.emptyList)
          : react.createElement('ul', { className: 'ap-ruleList' },
            rules.map(rule => react.createElement('li', { className: 'ap-rule', key: String(rule.id) },
              ...(editing === String(rule.id) && draft !== undefined ? [editorOf(rule)] : rowOf(rule))))),
        error !== '' && react.createElement('div', { className: 'ap-note ap-warn' }, error))
    }

    /** 设置页卡片 / 审批设置面板共用的放置位置选择器（写宿主设置命名空间，即时重挂）。 */
    function PlacementControl() {
      const [value, setValue] = react.useState(() => placementStore.value)
      const [error, setError] = react.useState('')
      react.useEffect(() => runtimeStore.subscribe(setValue), [])
      const choose = (next) => {
        setError('')
        const previous = placementStore.value
        setValue(next)
        runtimeStore.save({ placement: next }).catch(cause => {
          console.warn(LOG, '保存 placement 失败', cause)
          setValue(previous)
          setError(String(cause?.message ?? cause))
        })
      }
      const options = [
        ['auto', t.placementAuto],
        ['tab', t.placementTab],
        ['sidebar', t.placementSidebar],
        ['all', t.placementAll],
      ]
      return react.createElement('div', { className: 'ap-row2' },
        react.createElement('span', { className: 'ap-fieldKey' }, t.placementTitle),
        react.createElement('div', { className: 'ap-seg' },
          options.map(([id, label]) => react.createElement('button', {
            key: id, type: 'button', 'data-on': value === id ? '1' : '0', onClick: () => choose(id),
          }, label))),
        error !== '' && react.createElement('span', { className: 'ap-note' }, error))
    }

    /**
     * 一行设置：标题 + switch（轨道 + 滑块）+ 说明。状态由原生 checkbox 承载（可键盘操作、
     * 读屏可识别），宿主每次审批时读设置，所以拨动即生效。保存失败由调用方回滚并提示。
     * @param props.label 标题、props.hint 说明、props.value 当前值、props.onChange 写值
     */
    function SwitchRow({ label, hint, value, onChange }) {
      return react.createElement('div', { className: 'ap-row2' },
        react.createElement('span', { className: 'ap-fieldKey' }, label),
        react.createElement('label', { className: 'ap-switch' },
          react.createElement('input', {
            type: 'checkbox',
            className: 'ap-switchInput',
            checked: value === true,
            onChange: event => onChange(event.target.checked === true),
          }),
          react.createElement('span', { className: 'ap-switchTrack', 'aria-hidden': 'true' }),
          react.createElement('span', { className: 'ap-switchText' }, value === true ? t.switchOn : t.switchOff)),
        react.createElement('span', { className: 'ap-note' }, hint))
    }

    /** 四个行为开关的键 + 文案（设置页卡片与「审批设置」面板共用同一份顺序）。 */
    function behaviorSwitchSpecs() {
      return [
        { key: 'notice', label: t.noticeTitle, hint: t.noticeHint },
        { key: 'denyDirect', label: t.denyDirectTitle, hint: t.denyDirectHint },
        { key: 'autoOpenTimeline', label: t.autoOpenTitle, hint: t.autoOpenHint },
        { key: 'askRejectReason', label: t.askReasonTitle, hint: t.askReasonHint },
      ]
    }

    /**
     * 行为开关组：注入审批结果到上下文 / 黑名单直接拒绝 / 自动打开审批时间线 / 拒绝后追问理由。
     * 四个值都来自宿主 /config（设置命名空间）；写回是**先乐观置本地值**，失败回滚并提示，
     * 绝不让界面显示一个没写进宿主的状态。设置页卡片与「审批设置」面板都渲染这一个组件。
     */
    function BehaviorSettings() {
      const [, bump] = react.useState(0)
      const [saved, setSaved] = react.useState(false)
      const [error, setError] = react.useState('')
      react.useEffect(() => runtimeStore.subscribe(() => bump(value => value + 1)), [])
      /** 写一个开关：乐观置值 → 写宿主 → 成功提示 / 失败回滚。 */
      const save = (key, next) => {
        setError('')
        setSaved(false)
        const previous = runtimeStore[key]
        runtimeStore[key] = next
        runtimeStore.emit()
        runtimeStore.save({ [key]: next })
          .then(() => { setSaved(true); bump(value => value + 1) })
          .catch(cause => {
            console.warn(LOG, '保存界面偏好失败', cause)
            runtimeStore[key] = previous
            runtimeStore.emit()
            setError(t.saveFailed + '：' + String(cause?.message ?? cause))
          })
      }
      return react.createElement('div', { className: 'ap-col' },
        ...behaviorSwitchSpecs().map(spec => react.createElement(SwitchRow, {
          key: spec.key,
          label: spec.label,
          hint: spec.hint,
          value: runtimeStore[spec.key],
          onChange: next => save(spec.key, next),
        })),
        saved && react.createElement('div', { className: 'ap-note' }, t.savedTip),
        error !== '' && react.createElement('div', { className: 'ap-note ap-warn' }, error))
    }

    /**
     * 渲染一张卡片：设置页插件卡与对话区面板共用同一套外观。
     * 设置页的容器是 ul，所以那里必须传 'li'——传 div 会拿不到任何卡片样式，
     * 表现就是「设置里只有一段裸文字」。
     */
    function card(tag, title, desc, children) {
      const body = children === undefined || children === null
        ? []
        : Array.isArray(children) ? children : [children]
      return react.createElement(tag, { className: 'ap-card' },
        react.createElement('div', { className: 'ap-cardHead' },
          react.createElement('div', { className: 'ap-cardText' },
            react.createElement('div', { className: 'ap-cardName' }, title),
            desc === undefined || desc === '' ? null : react.createElement('div', { className: 'ap-cardDesc' }, desc))),
        react.createElement.apply(null, ['div', { className: 'ap-cardBody' }].concat(body)))
    }

    /**
     * 设置卡片：面板显示在哪里（写宿主设置命名空间、即时重挂）+ 三个行为开关
     * （注入审批结果到上下文 / 黑名单直接拒绝 / 自动打开审批时间线）。
     * 设置页（容器是 ul，所以必须是 li）与「审批设置」面板共用同一套内容。
     * @param props.tag 宿主标签（设置页传 'li'，对话区面板传 'section'）
     * @param props.desc 卡片说明（设置页多一句：这里还能开关通知与黑名单行为）
     */
    function SettingsCard({ tag, desc }) {
      return card(tag ?? 'section', t.cardName, desc ?? t.placementDesc, react.createElement('div', { className: 'ap-col' },
        react.createElement(PlacementControl, null),
        react.createElement(BehaviorSettings, null)))
    }

    /**
     * 对话标签页「审批设置」：连续放行阈值 + 项目/全局两级的白名单与黑名单。
     * 时间线不在这里——它只在右侧栏，两者刻意分开，避免对话区被审批噪声占满。
     */
    function ApprovalSettingsPanel(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const [cwd, setCwd] = react.useState(() => workspaceOf(sessionId))
      const [error, setError] = react.useState('')
      // 编辑规则的结果（合并掉了哪些窄规则）：只影响这一行的提示，不影响列表本身
      const [editNote, setEditNote] = react.useState('')
      const [saved, setSaved] = react.useState(false)
      const [thresholdDraft, setThresholdDraft] = react.useState({})
      const [revision, setRevision] = react.useState(0)

      react.useEffect(() => policyStore.subscribe(() => setRevision(value => value + 1)), [])

      react.useEffect(() => {
        let alive = true
        /** 项目目录：先问宿主 sessions 服务；拿不到就退回本会话最新一条记录里的 cwd。 */
        const resolve = async () => {
          let next = workspaceOf(sessionId)
          if (next === undefined && sessionId !== '') {
            try {
              const response = await fetch(API_LOG + '?session=' + encodeURIComponent(sessionId) + '&limit=1', {
                headers: { accept: 'application/json' },
              })
              const data = await response.json()
              const first = Array.isArray(data?.records) ? data.records[0] : undefined
              if (first !== undefined && typeof first.cwd === 'string' && first.cwd !== '') next = first.cwd
            } catch (cause) {
              console.warn(LOG, '读取审批记录以推断项目目录失败', cause)
            }
          }
          if (!alive) return
          setCwd(next)
          await policyStore.load(next)
        }
        void resolve()
        const timer = setInterval(() => { void resolve() }, POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId])

      const snapshot = policyStore.value
      const globalRules = snapshot?.global ?? { allow: [], deny: [] }
      const projectRules = snapshot?.project
      // 阈值分两侧：allow=连续放行后询问是否加入白名单，deny=连续被拒后询问是否加入黑名单。
      const thresholds = snapshot?.thresholds ?? { allow: snapshot?.threshold }
      const shownThreshold = list => thresholdDraft[list] === undefined
        ? String(thresholds[list] ?? '')
        : thresholdDraft[list]
      const editThreshold = (list, value) => {
        setThresholdDraft(previous => ({ ...previous, [list]: value }))
        setSaved(false)
      }

      const save = () => {
        setError('')
        setSaved(false)
        // 只提交合法值：数字框里留空或写脏值时，那一侧保持原样
        const writes = ['allow', 'deny']
          .map(list => ({ list, value: Number.parseInt(shownThreshold(list), 10) }))
          .filter(entry => Number.isSafeInteger(entry.value) && entry.value >= 1)
        Promise.all(writes.map(entry => policyStore.post({ op: 'threshold', list: entry.list, threshold: entry.value })))
          .then(() => { setSaved(true); setThresholdDraft({}) })
          .catch(cause => setError(String(cause?.message ?? cause)))
      }
      const remove = (scope, list, id) => {
        setError('')
        setEditNote('')
        policyStore.post({ op: 'remove', scope, list, id, cwd })
          .catch(cause => setError(String(cause?.message ?? cause)))
      }
      /**
       * 编辑一条已有规则（按 id 原地更新）：改完立刻写宿主并回读快照。
       * 改宽之后可能把别的窄规则盖住（宿主按同一套口径合并掉）——那样名单会少条目，
       * 所以把被顶掉的规则标签如实显示出来（用户 2026-09-16 要求「说清楚」）。
       */
      const editRule = (scope, list, id, rule) => {
        setError('')
        setEditNote('')
        policyStore.post({ op: 'update', scope, list, id, rule, cwd })
          .then(data => {
            const dropped = Array.isArray(data.dropped)
              ? data.dropped.map(label => String(label)).filter(label => label !== '')
              : []
            const merged = Number.isSafeInteger(data.merged) ? data.merged : 0
            const note = (data.replaced === true ? t.appliedReplaced('') : '')
              + (merged > 0 ? t.appliedMerged(merged, dropped.join(' / ')) : '')
            setEditNote(note)
          })
          .catch(cause => setError(String(cause?.message ?? cause)))
      }
      void revision
      // 内容列与消息列同宽并居中：一屏一卡，卡片外观与设置页保持一致
      return react.createElement('div', { className: 'ap-root' },
        react.createElement('div', { className: 'ap-frame' },
          react.createElement('div', { className: 'ap-col' },
            card('section', t.settingsTitle, t.settingsDesc, [
              [['allow', t.thresholdLabel, t.thresholdHintAllow], ['deny', t.thresholdLabelDeny, t.thresholdHintDeny]]
                .map(([list, label, hint]) => react.createElement('div', { className: 'ap-row2', key: list },
                  react.createElement('span', { className: 'ap-fieldKey' }, label),
                  react.createElement('input', {
                    className: 'ap-input',
                    type: 'number',
                    min: '1',
                    value: shownThreshold(list),
                    onChange: event => editThreshold(list, event.target.value),
                  }),
                  react.createElement('span', { className: 'ap-note' }, t.thresholdUnit),
                  react.createElement('span', { className: 'ap-note' }, hint))),
              react.createElement('div', { className: 'ap-row2' },
                react.createElement('button', { type: 'button', className: 'ap-btn', onClick: save }, t.save),
                saved && react.createElement('span', { className: 'ap-note' }, t.saved)),
              react.createElement('div', { className: 'ap-note' }, t.ruleAskNote),
            ]),
            card('section', t.globalScope, undefined, [
              react.createElement(RuleList, { scope: 'global', list: 'allow', title: t.allowList, rules: globalRules.allow, onRemove: remove, onEdit: editRule }),
              react.createElement(RuleList, { scope: 'global', list: 'deny', title: t.denyList, rules: globalRules.deny, onRemove: remove, onEdit: editRule }),
            ]),
            cwd === undefined
              ? card('section', t.projectScope, t.projectUnknown, null)
              : card('section', t.projectScope + ' · ' + cwd, undefined, [
                react.createElement(RuleList, { scope: 'project', list: 'allow', title: t.allowList, rules: projectRules?.allow ?? [], onRemove: remove, onEdit: editRule }),
                react.createElement(RuleList, { scope: 'project', list: 'deny', title: t.denyList, rules: projectRules?.deny ?? [], onRemove: remove, onEdit: editRule }),
              ]),
            react.createElement(SettingsCard, { tag: 'section' }),
            editNote !== '' && react.createElement('div', { className: 'ap-note' }, editNote),
            (error !== '' || policyStore.error !== '')
              && react.createElement('div', { className: 'ap-note' }, error !== '' ? error : policyStore.error))))
    }

    /** 右侧栏「审批时间线」：倒序记录，展开即可把某条记录升级/降级成规则。 */
    function ApprovalTimelinePanel(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined
      // 右侧栏 tab 隐藏时暂停轮询；对话标签页没有这个信号，保持轮询。
      const visible = info === undefined || info?.tab?.visible !== false
      // 自动打开的判定要读「时间线是不是正显示在眼前」（面板挂载 + tab 可见）：收起侧栏、
      // 切到别的 tab 都算没打开。useTabInfo 缺失（单测里没有宿主 hook）时按「打开」处理——
      // 面板都在渲染了，它就确实显示着。
      react.useEffect(() => {
        mountState.timelineShown = visible
        return () => { mountState.timelineShown = false }
      }, [visible])
      const [scope, setScope] = react.useState('session')
      const [state, setState] = react.useState({ records: [], error: '', loaded: false })
      const [openId, setOpenId] = react.useState('')
      // 快捷筛选：多选叠加（空数组 = 不筛选，显示全部）
      const [filters, setFilters] = react.useState([])

      const key = scope + '|' + sessionId
      const load = react.useCallback(async () => {
        const query = scope === 'session' && sessionId !== '' ? '?session=' + encodeURIComponent(sessionId) : ''
        try {
          const response = await fetch(API_LOG + query, { headers: { accept: 'application/json' } })
          const data = await response.json()
          if (data !== null && typeof data === 'object' && data.ok === true && Array.isArray(data.records)) {
            setState({ records: data.records, error: '', loaded: true })
            return
          }
          setState(previous => ({ records: previous.records, error: String(data?.error ?? 'bad response'), loaded: true }))
        } catch (error) {
          setState(previous => ({ records: previous.records, error: String(error?.message ?? error), loaded: true }))
        }
      }, [scope, sessionId])

      react.useEffect(() => {
        let alive = true
        // 时间线也要有一份策略快照：命中 chip 的「自动 / 手动」靠它反查规则来源
        void policyStore.load()
        const tick = () => {
          if (alive && (visible || state.loaded === false)) void load()
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [key, visible, load, state.loaded])

      const records = state.records
      const auto = records.filter(record => record.verdict === 'allow').length
      // 各筛选键在当前会话范围下的条数：为 0 也显示，用户据此判断点下去会不会空
      const filterCounts = {}
      for (const key of FILTER_KEYS) {
        filterCounts[key] = records.filter(record => matchesFilter(record, key)).length
      }
      // 多选叠加：点亮多个时显示满足任一条件的记录（并集）；一个都没点亮就是全部
      const shown = filters.length === 0
        ? records
        : records.filter(record => filters.some(key => matchesFilter(record, key)))
      /** 切换一个筛选键：已点亮就取消，未点亮就叠加。 */
      const toggleFilter = key => {
        setFilters(previous => previous.includes(key)
          ? previous.filter(item => item !== key)
          : [...previous, key])
      }
      // 升级/降级成功后同时刷新记录与策略快照：记录上会回写「已应用」，设置面板同步见到新规则
      const refresh = () => { void load(); void policyStore.load() }
      return react.createElement('div', { className: 'ap-root' },
        react.createElement('div', { className: 'ap-head' },
          react.createElement('div', { className: 'ap-grow' },
            react.createElement('div', { className: 'ap-title' }, t.title),
            react.createElement('div', { className: 'ap-sub' }, t.subtitle + ' · ' + auto + '/' + records.length)),
          react.createElement('div', { className: 'ap-seg' },
            react.createElement('button', { type: 'button', 'data-on': scope === 'session' ? '1' : '0', onClick: () => setScope('session') }, t.scopeSession),
            react.createElement('button', { type: 'button', 'data-on': scope === 'all' ? '1' : '0', onClick: () => setScope('all') }, t.scopeAll)),
          react.createElement('button', { type: 'button', className: 'ap-btn', onClick: refresh }, t.reload)),
        state.error !== '' && react.createElement('div', { className: 'ap-error' }, state.error),
        react.createElement('div', { className: 'ap-filters' },
          react.createElement('button', {
            type: 'button',
            className: 'ap-chip',
            'data-filter': 'all',
            'data-on': filters.length === 0 ? '1' : '0',
            onClick: () => setFilters([]),
          }, t.filterAll, react.createElement('span', { className: 'ap-chipCount' }, String(records.length))),
          ...FILTER_KEYS.map(key => react.createElement('button', {
            key,
            type: 'button',
            className: 'ap-chip',
            'data-filter': key,
            'data-on': filters.includes(key) ? '1' : '0',
            onClick: () => toggleFilter(key),
          }, filterLabel(key), react.createElement('span', { className: 'ap-chipCount' }, String(filterCounts[key]))))),
        shown.length === 0
          ? react.createElement('div', { className: 'ap-empty' },
            state.loaded === false ? t.loading : (records.length === 0 ? t.empty : t.filterEmpty))
          : react.createElement('ul', { className: 'ap-list' },
            shown.map(record => react.createElement(RecordRow, {
              key: String(record.id ?? record.time),
              record,
              open: openId === String(record.id ?? record.time),
              onToggle: () => setOpenId(previous => previous === String(record.id ?? record.time) ? '' : String(record.id ?? record.time)),
              onChanged: refresh,
              // 只有「全部会话」需要标明每条记录属于哪个会话
              showSession: scope === 'all',
            }))))
    }

    /** 客户端插件入口：按 placement 决定挂载审批设置标签页、时间线 tab 或两者。 */
    function apply(ctx) {
      try {
        applyInner(ctx)
      } catch (error) {
        beacon('error', String(error?.message ?? error))
        console.warn(LOG, '客户端半 apply 失败', error)
        throw error
      }
    }

    /** 真正的挂载逻辑；外层包一层 try/catch 只为把失败上报成信标。 */
    function applyInner(ctx) {
      beacon('apply')
      // 档位图标与 slots 无关，放在 slots 判空之前，没有面板时也照样补图标
      installPresetIcon()
      clientCtx = ctx
      const slots = ctx.get('slots')
      if (slots === undefined) {
        beacon('no-slots')
        console.warn(LOG, '没有 slots 服务，审批面板未注册')
        return
      }
      // 复用模块级挂载状态：自动打开时间线要能看到「右侧栏 tab 是否已注册」
      const mounted = mountState
      mounted.tab = undefined
      mounted.sidebar = undefined
      let lastKey = ''

      /** 对话区标签页：只放「审批设置」，时间线不再出现在这里。 */
      const mountTab = () => {
        if (mounted.tab !== undefined) return
        mounted.tab = slots.inject('conversation.view', () => {
          try {
            const dispose = slots.register({
              name: 'conversation.view',
              id: VIEW_ID,
              order: 30,
              label: () => t.policyTab,
            }, props => react.createElement(ApprovalSettingsPanel, props))
            beacon('view-registered')
            return dispose
          } catch (error) {
            beacon('view-error', String(error?.message ?? error))
            throw error
          }
        })
      }

      /** 右侧栏 tab：审批时间线（含升级/降级操作）。座位按契约可选。 */
      const mountSidebar = () => {
        if (mounted.sidebar !== undefined) return
        mounted.sidebar = ctx.inject(['sidebarRightTabs'], raw => {
          const tabs = raw?.sidebarRightTabs
          if (tabs === undefined || typeof tabs.register !== 'function') return undefined
          const disposers = []
          const own = (result) => {
            if (typeof result === 'function') disposers.push(result)
          }
          try {
            own(tabs.register({
              id: SIDEBAR_ID,
              kind: SIDEBAR_KIND,
              title: () => t.timelineTab,
              guide: [{
                order: 30,
                title: () => t.timelineTab,
                description: () => t.guideDescription,
                icon: LogGlyph,
              }],
            }))
            own(raw.slots.inject('sidebar.right.pane.tab', () => raw.slots.register({
              name: 'sidebar.right.pane.tab',
              key: SIDEBAR_ID,
            }, props => react.createElement(ApprovalTimelinePanel, props))))
            // 标题席位：不加这一段时 chip 只有文字，跟别的插件（文件/上下文）不一致
            own(raw.slots.inject('sidebar.right.pane.tab.title', () => raw.slots.register({
              name: 'sidebar.right.pane.tab.title',
              key: SIDEBAR_ID,
            }, () => react.createElement('span', { className: 'ap-tabTitle' },
              react.createElement(LogGlyph, { size: 16 }),
              react.createElement('span', { className: 'ap-tabLabel' }, t.timelineTab)))))
            beacon('sidebar-registered')
          } catch (error) {
            beacon('sidebar-error', String(error?.message ?? error))
            console.warn(LOG, '右侧栏 tab 注册失败', error)
            for (const dispose of disposers) dispose()
            return undefined
          }
          return () => {
            for (const dispose of disposers) dispose()
          }
        })
      }
      const unmount = () => {
        for (const name of ['tab', 'sidebar']) {
          const handle = mounted[name]
          mounted[name] = undefined
          if (handle === undefined) continue
          if (typeof handle === 'function') handle()
          else if (typeof handle.dispose === 'function') handle.dispose()
        }
      }

      /** 决定当前生效的放置方式；auto 优先右侧栏座位，没有座位时退回对话标签页。 */
      const effective = placement => placement === 'auto'
        ? (ctx.get('sidebarRightTabs') === undefined ? 'tab' : 'sidebar')
        : placement
      const remount = () => {
        const placement = effective(placementStore.value)
        if (placement === lastKey) return
        lastKey = placement
        unmount()
        if (placement === 'tab' || placement === 'all') mountTab()
        if (placement === 'sidebar' || placement === 'all') mountSidebar()
      }

      const unsubscribe = placementStore.subscribe(remount)
      remount()
      beacon('mounted', 'placement=' + placementStore.value + ' tab=' + String(mounted.tab !== undefined)
        + ' sidebar=' + String(mounted.sidebar !== undefined)
        + ' hasSidebarSeat=' + String(ctx.get('sidebarRightTabs') !== undefined))
      void runtimeStore.load().then(remount)
      void policyStore.load(undefined)
      // 审批观察器：当前会话一出现新审批、且时间线没打开，就自动展开它。它与面板无关
      // （用户停在「轨迹」标签页、或 placement 只挂右侧栏时同样要能触发），所以挂在插件入口；
      // 放在 remount() 之后启动，右侧栏 tab 才已经注册、页面一加载就能取到「历史记录」基线。
      if (approvalWatch.timer !== undefined) clearInterval(approvalWatch.timer)
      approvalWatch.timer = setInterval(() => { void watchApprovals() }, POLL_MS)
      void watchApprovals()

      ctx.effect(() => slots.inject('settings.plugin.item', () => {
        try {
          const dispose = slots.register({
            name: 'settings.plugin.item',
            key: 'dsh-auto-pass',
            id: 'dsh-auto-pass',
          }, () => react.createElement(SettingsCard, { tag: 'li', desc: t.panelCardDesc }))
          beacon('settings-registered')
          return dispose
        } catch (error) {
          beacon('settings-error', String(error?.message ?? error))
          throw error
        }
      }), 'dsh-auto-pass: placement settings card')

      ctx.effect(() => () => {
        unsubscribe()
        unmount()
        // 观察器随插件一起停：插件被卸载后不该再有后台轮询
        if (approvalWatch.timer !== undefined) {
          clearInterval(approvalWatch.timer)
          approvalWatch.timer = undefined
        }
      }, 'dsh-auto-pass: panel mounts')
      console.log(LOG, 'client loaded, placement=' + placementStore.value)
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
