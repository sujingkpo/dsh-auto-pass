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
    /** 启动信标：把客户端半走到哪一步写进宿主日志（排查「看不到面板」用）。 */
    const API_BEACON = '/api/dsh-auto-pass/beacon'
    /** 时间轴轮询间隔（毫秒）。 */
    const POLL_MS = 3_000
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
        guideDescription: 'Auto Approve 的自动批准与转人工记录，可一键升级为白名单或降级为黑名单',
        title: '审批时间线',
        subtitle: '最新的在最上面',
        scopeSession: '本次会话',
        scopeAll: '全部会话',
        reload: '刷新',
        empty: '还没有审批记录',
        loading: '加载中…',
        autoApproved: '自动批准',
        referred: '转人工',
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
        reason: '审批原因',
        time: '时间',
        signature: '权限签名',
        suggestedRule: '模型建议规则',
        policyHit: '命中规则',
        hitAllow: '白名单',
        hitDeny: '黑名单',
        promoted: '已自动升级',
        applied: '已应用',
        approvals: '连续放行',
        denials: '连续被拒',
        ruleAsk: '规则询问',
        ruleDeclined: '已询问，未加入',
        promote: '升级为白名单',
        demote: '降级为黑名单',
        scopeProject: '本项目',
        scopeGlobal: '全局',
        working: '处理中…',
        sourceUser: '手动',
        sourceModel: '模型',
        sourceMemory: '记忆',
        kindSignature: '精确签名',
        kindCommandPrefix: '命令前缀',
        kindPathPrefix: '路径前缀',
        settingsTitle: '审批设置',
        settingsDesc: '连续通过或连续被拒达到阈值后，插件会先让 DSH 模型把这次动作优化成一条匹配条件，再询问你是否加入白名单/黑名单——你确认了才会写入。',
        thresholdLabel: '连续放行阈值',
        thresholdLabelDeny: '连续被拒阈值',
        thresholdHintAllow: '达到后询问是否加入白名单',
        thresholdHintDeny: '达到后询问是否加入黑名单',
        thresholdUnit: '次',
        ruleAskNote: '自动审批与你本人的放行都计入「连续放行」；模型判定拒绝或你选择了拒绝都计入「连续被拒」。问过一次并选择「不加入」后，这个动作不会再被询问。',
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
        placementAuto: '自动',
        placementTab: '只保留审批设置',
        placementSidebar: '只保留时间线',
        placementAll: '两处都显示',
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
        reason: 'Approval reason',
        time: 'Time',
        signature: 'Signature',
        suggestedRule: 'Suggested rule',
        policyHit: 'Matched rule',
        hitAllow: 'Allowlist',
        hitDeny: 'Denylist',
        promoted: 'Auto-promoted',
        applied: 'Applied',
        approvals: 'Consecutive approvals',
        denials: 'Consecutive denials',
        ruleAsk: 'Rule prompt',
        ruleDeclined: 'Asked, not added',
        promote: 'Promote to allowlist',
        demote: 'Demote to denylist',
        scopeProject: 'This project',
        scopeGlobal: 'Global',
        working: 'Working…',
        sourceUser: 'manual',
        sourceModel: 'model',
        sourceMemory: 'memory',
        kindSignature: 'exact signature',
        kindCommandPrefix: 'command prefix',
        kindPathPrefix: 'path prefix',
        settingsTitle: 'Approval policy',
        settingsDesc: 'After this many consecutive approvals or denials the plugin first has the DSH model turn the action into a match condition, then asks whether to add it to the allowlist/denylist — nothing is written until you confirm.',
        thresholdLabel: 'Consecutive approval threshold',
        thresholdLabelDeny: 'Consecutive denial threshold',
        thresholdHintAllow: 'ask to allowlist after this many',
        thresholdHintDeny: 'ask to denylist after this many',
        thresholdUnit: 'times',
        ruleAskNote: 'Auto-approved and user-approved calls both count as approvals; a model deny and your own rejection both count as denials. After you answer "do not add" once, that action is never asked about again.',
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
        placementAuto: 'Auto',
        placementTab: 'Policy only',
        placementSidebar: 'Timeline only',
        placementAll: 'Both',
      },
    }
    const t = COPY[ZH ? 'zh' : 'en']

    // ── 幂等样式注入（带 id，卸载残留可重复注入）──
    if (typeof document !== 'undefined' && document.getElementById('dsh-auto-pass-style') === null) {
      const tag = document.createElement('style')
      tag.id = 'dsh-auto-pass-style'
      tag.textContent = [
        '.ap-root{box-sizing:border-box;flex:auto;min-height:0;height:100%;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);font-size:13px}',
        // 对话区面板：内容列与消息列同宽并居中（--dsh-chat-content-width 由会话根元素下发，取不到时回退 748px）
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
        '.ap-list{flex:auto;min-height:0;overflow-y:auto;margin:0;padding:4px 0 12px;list-style:none}',
        '.ap-row{border-bottom:1px solid var(--dsw-alias-border-l1)}',
        '.ap-rowHead{width:100%;appearance:none;border:0;background:0 0;font:inherit;text-align:left;color:inherit;display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer}',
        '.ap-rowHead:hover{background:var(--dsw-alias-bg-layer-2)}',
        '.ap-time{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:11px;line-height:16px}',
        '.ap-tool{flex:none;font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:12px}',
        '.ap-badge{flex:none;border-radius:8px;padding:0 6px;font-size:11px;line-height:16px}',
        '.ap-badgeOk{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}',
        '.ap-badgeWarn{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary)}',
        '.ap-badgeMuted{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-base)}',
        '.ap-chevron{flex:none;color:var(--dsw-alias-label-tertiary)}',
        '.ap-detail{padding:0 12px 10px;display:flex;flex-direction:column;gap:4px}',
        '.ap-field{display:flex;gap:6px;align-items:baseline}',
        '.ap-fieldKey{flex:none;min-width:5.5em;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
        '.ap-fieldVal{min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere;white-space:pre-wrap}',
        '.ap-mono{font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:11px}',
        '.ap-empty{color:var(--dsw-alias-label-tertiary);padding:16px 12px}',
        '.ap-error{color:var(--dsw-alias-state-warn-primary);padding:6px 12px;font-size:11px}',
        '.ap-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding-top:4px}',
        '.ap-actionsLabel{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;min-width:5.5em}',
        '.ap-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
        '.ap-rowMain{flex:auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
        '.ap-rowTop{display:flex;align-items:center;gap:8px;min-width:0}',
        '.ap-opinion{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-align:left;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
        // 命中名单的提示行：折叠态就要看得见命中的是白名单还是黑名单、哪一条规则
        '.ap-hitRow{display:flex;align-items:center;gap:6px;min-width:0}',
        '.ap-hitText{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;min-width:0;overflow-wrap:anywhere}',
        '.ap-sectionTitle{font-size:12px;font-weight:600;line-height:18px}',
        '.ap-subTitle{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:4px}',
        '.ap-ruleList{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}',
        '.ap-rule{display:flex;align-items:baseline;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:4px 6px}',
        '.ap-ruleLabel{min-width:0;flex:auto;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
        '.ap-input{appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:0 0;color:inherit;font:inherit;font-size:12px;line-height:18px;padding:2px 8px;width:5em}',
        '.ap-row2{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
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
     * placement 状态：唯一真值在宿主（config 默认值 + 设置命名空间覆盖）。
     * 设置页卡片、审批设置面板与挂载逻辑共用它，任何变更都会广播给订阅者重新挂载。
     */
    const placementStore = {
      value: 'all',
      writable: false,
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
      set(value) {
        if (this.value === value) return
        this.value = value
        for (const listener of [...this.listeners]) listener(value)
      },
      async load() {
        try {
          const response = await fetch(API_CONFIG, { headers: { accept: 'application/json' } })
          const data = await response.json()
          if (typeof data?.placement === 'string' && PLACEMENTS.includes(data.placement)) this.set(data.placement)
          this.writable = data?.writable === true
        } catch (error) {
          console.warn(LOG, '读取宿主 placement 失败，沿用默认 all', error)
        }
        return this.value
      },
      async save(next) {
        const response = await fetch(API_CONFIG, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ placement: next }),
        })
        const data = await response.json()
        if (data?.ok !== true) throw new Error(String(data?.error ?? 'save failed'))
        this.set(typeof data.placement === 'string' ? data.placement : next)
      },
    }

    /** 客户端上下文：applyInner 时捕获，供组件里访问宿主客户端服务（sessions 等）。 */
    let clientCtx

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
     * 把一条审批记录升级/降级成规则。规则文本由宿主依据记录里的模型建议产出，
     * 没有建议时精确回落到该次动作签名——客户端只负责发起与刷新。
     */
    async function promoteRecord(recordId, scope, list) {
      const response = await fetch(API_RULE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recordId, scope, list }),
      })
      const data = await response.json()
      if (data === null || typeof data !== 'object' || data.ok !== true) {
        throw new Error(String(data?.error ?? 'rule write failed'))
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

    /** 把一组字段渲染成详情行。 */
    function Field({ label, value, mono }) {
      if (value === undefined || value === null || value === '') return null
      return react.createElement('div', { className: 'ap-field' },
        react.createElement('span', { className: 'ap-fieldKey' }, label),
        react.createElement('span', { className: 'ap-fieldVal' + (mono === true ? ' ap-mono' : '') }, String(value)))
    }

    /** 结论徽标：插件自身只可能给 allow，其余都是转交用户。 */
    function VerdictBadge({ record }) {
      const allow = record.verdict === 'allow'
      const label = record.verdict === 'allow'
        ? t.autoApproved
        : record.verdict === 'deny' ? t.referred : t.reviewFailed
      return react.createElement('span', {
        className: 'ap-badge ' + (allow ? 'ap-badgeOk' : 'ap-badgeWarn'),
        title: record.rationale ?? '',
      }, label)
    }

    /** 最终结果徽标：转人工的记录才需要展示人工侧结果。 */
    function OutcomeBadge({ record }) {
      if (record.verdict === 'allow') return null
      const map = {
        'allowed-once': [t.outcomeAllowed, 'ap-badgeOk'],
        rejected: [t.outcomeRejected, 'ap-badgeWarn'],
        unavailable: [t.outcomeUnavailable, 'ap-badgeMuted'],
        cancelled: [t.outcomeCancelled, 'ap-badgeMuted'],
      }
      const hit = map[record.outcome]
      if (hit === undefined) return null
      return react.createElement('span', { className: 'ap-badge ' + hit[1] }, hit[0])
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
      const run = (list, scope) => {
        setBusy(true)
        setError('')
        promoteRecord(record.id, scope, list)
          .then(() => { if (typeof onDone === 'function') onDone() })
          .catch(cause => setError(String(cause?.message ?? cause)))
          .finally(() => setBusy(false))
      }
      const scopeButtons = (list, className) => ['project', 'global'].map(scope => react.createElement('button', {
        key: list + ':' + scope,
        type: 'button',
        className: 'ap-btn ' + className,
        disabled: busy || typeof record.id !== 'string',
        onClick: () => run(list, scope),
      }, scope === 'project' ? t.scopeProject : t.scopeGlobal))
      return react.createElement('div', { className: 'ap-actions' },
        react.createElement('span', { className: 'ap-actionsLabel' }, t.promote),
        ...scopeButtons('allow', 'ap-btnPrimary'),
        react.createElement('span', { className: 'ap-actionsLabel' }, t.demote),
        ...scopeButtons('deny', 'ap-btnDanger'),
        busy && react.createElement('span', { className: 'ap-note' }, t.working),
        error !== '' && react.createElement('span', { className: 'ap-note' }, error))
    }

    /** 单条记录：折叠只显示概要，展开显示风险/授权/理由/动作，以及升级/降级操作。 */
    function RecordRow({ record, open, onToggle, onChanged }) {
      const route = record.route === undefined ? undefined : record.route.provider + '/' + record.route.model
      const suggested = record.suggestedRule === undefined
        ? undefined
        : record.suggestedRule.label + '（' + kindLabel(record.suggestedRule.match?.kind) + '：' + String(record.suggestedRule.match?.value ?? '') + '）'
      const applied = record.ruleApplied === undefined
        ? undefined
        : scopeLabel(record.ruleApplied.scope) + ' / ' + (record.ruleApplied.list === 'allow' ? t.allowList : t.denyList) + ' · ' + String(record.ruleApplied.label ?? '')
      const promoted = record.promotedRule === undefined
        ? undefined
        : scopeLabel(record.promotedRule.scope) + ' · ' + String(record.promotedRule.label ?? '')
      const hit = record.policy === undefined
        ? undefined
        : scopeLabel(record.policy.scope) + ' · ' + String(record.policy.label ?? '')
      const hitBadge = record.policy === undefined
        ? undefined
        : record.policy.list === 'allow' ? t.hitAllow : t.hitDeny
      const hitClass = record.policy?.list === 'allow' ? 'ap-badgeOk' : 'ap-badgeWarn'
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
      return react.createElement('li', { className: 'ap-row' },
        react.createElement('button', {
          type: 'button', className: 'ap-rowHead', 'aria-expanded': open,
          onClick: onToggle,
        },
          react.createElement('span', { className: 'ap-chevron', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
          react.createElement('span', { className: 'ap-rowMain' },
            react.createElement('span', { className: 'ap-rowTop' },
              react.createElement('span', { className: 'ap-time', title: String(record.time ?? '') }, formatTime(record.time)),
              react.createElement('span', { className: 'ap-tool' }, String(record.toolName ?? '?')),
              react.createElement('span', { className: 'ap-grow' }, ''),
              react.createElement(VerdictBadge, { record }),
              react.createElement(OutcomeBadge, { record })),
            opinion !== undefined && react.createElement('span', { className: 'ap-opinion' }, opinion),
            hitBadge !== undefined && react.createElement('span', { className: 'ap-hitRow' },
              react.createElement('span', { className: 'ap-badge ' + hitClass }, hitBadge),
              react.createElement('span', { className: 'ap-hitText' }, hit)))),
        open === true && react.createElement('div', { className: 'ap-detail' },
          react.createElement(Field, { label: t.risk, value: record.riskLevel }),
          react.createElement(Field, { label: t.authorization, value: record.userAuthorization }),
          react.createElement(Field, { label: t.rationale, value: record.rationale }),
          react.createElement(Field, { label: t.reason, value: record.reason }),
          react.createElement(Field, { label: t.action, value: record.action, mono: true }),
          react.createElement(Field, { label: t.signature, value: record.signature === undefined ? undefined : record.signature.text, mono: true }),
          react.createElement(Field, { label: t.suggestedRule, value: suggested }),
          react.createElement(Field, { label: t.policyHit, value: hit }),
          react.createElement(Field, { label: t.applied, value: applied }),
          react.createElement(Field, { label: t.promoted, value: promoted }),
          react.createElement(Field, { label: t.approvals, value: approvals }),
          react.createElement(Field, { label: t.denials, value: record.denials === undefined || record.denials === 0 ? undefined : String(record.denials) }),
          react.createElement(Field, { label: t.ruleAsk, value: declined }),
          react.createElement(Field, { label: t.latency, value: record.latencyMs === undefined ? undefined : String(record.latencyMs) + ' ms' }),
          react.createElement(Field, { label: t.reviewer, value: [record.reviewerSessionId, record.steps === undefined ? undefined : record.steps + ' steps'].filter(Boolean).join(' · ') }),
          react.createElement(Field, { label: t.time, value: record.time }),
          // 升级/降级需要记录的签名或模型建议；更早版本留下的老记录两者都没有，不显示死按钮
          (record.signature !== undefined || record.suggestedRule !== undefined)
            && react.createElement(RuleActions, { record, onDone: onChanged })))
    }

    /** 一组规则的列表：显示标签、来源、匹配条件，并可删除。 */
    function RuleList({ scope, list, title, rules, onRemove }) {
      return react.createElement('div', null,
        react.createElement('div', { className: 'ap-subTitle' }, title),
        rules.length === 0
          ? react.createElement('div', { className: 'ap-note' }, t.emptyList)
          : react.createElement('ul', { className: 'ap-ruleList' },
            rules.map(rule => react.createElement('li', { className: 'ap-rule', key: String(rule.id) },
              react.createElement('span', { className: 'ap-ruleLabel' }, String(rule.label ?? '')),
              react.createElement('span', { className: 'ap-badge ap-badgeMuted' }, sourceLabel(rule.source)),
              react.createElement('span', { className: 'ap-badge ap-badgeMuted' }, kindLabel(rule.match?.kind)),
              react.createElement('span', { className: 'ap-mono' }, String(rule.match?.value ?? '').slice(0, 48)),
              react.createElement('button', {
                type: 'button', className: 'ap-btn', onClick: () => onRemove(scope, list, rule.id),
              }, t.remove)))))
    }

    /** 设置页卡片 / 审批设置面板共用的放置位置选择器。 */
    function PlacementControl() {
      const [value, setValue] = react.useState(() => placementStore.value)
      const [error, setError] = react.useState('')
      react.useEffect(() => placementStore.subscribe(setValue), [])
      const choose = (next) => {
        setError('')
        const previous = placementStore.value
        setValue(next)
        placementStore.save(next).catch(cause => {
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

    /** 设置页卡片：选择面板显示在哪里（写宿主设置命名空间，即时重挂）。 */
    function PlacementCard() {
      return card('li', t.cardName, t.placementDesc, react.createElement(PlacementControl, null))
    }

    /**
     * 对话标签页「审批设置」：连续放行阈值 + 项目/全局两级的白名单与黑名单。
     * 时间线不在这里——它只在右侧栏，两者刻意分开，避免对话区被审批噪声占满。
     */
    function ApprovalSettingsPanel(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const [cwd, setCwd] = react.useState(() => workspaceOf(sessionId))
      const [error, setError] = react.useState('')
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
        policyStore.post({ op: 'remove', scope, list, id, cwd })
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
              react.createElement(RuleList, { scope: 'global', list: 'allow', title: t.allowList, rules: globalRules.allow, onRemove: remove }),
              react.createElement(RuleList, { scope: 'global', list: 'deny', title: t.denyList, rules: globalRules.deny, onRemove: remove }),
            ]),
            cwd === undefined
              ? card('section', t.projectScope, t.projectUnknown, null)
              : card('section', t.projectScope + ' · ' + cwd, undefined, [
                react.createElement(RuleList, { scope: 'project', list: 'allow', title: t.allowList, rules: projectRules?.allow ?? [], onRemove: remove }),
                react.createElement(RuleList, { scope: 'project', list: 'deny', title: t.denyList, rules: projectRules?.deny ?? [], onRemove: remove }),
              ]),
            card('section', t.placementTitle, undefined, react.createElement(PlacementControl, null)),
            (error !== '' || policyStore.error !== '')
              && react.createElement('div', { className: 'ap-note' }, error !== '' ? error : policyStore.error))))
    }

    /** 右侧栏「审批时间线」：倒序记录，展开即可把某条记录升级/降级成规则。 */
    function ApprovalTimelinePanel(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined
      // 右侧栏 tab 隐藏时暂停轮询；对话标签页没有这个信号，保持轮询。
      const visible = info === undefined || info?.tab?.visible !== false
      const [scope, setScope] = react.useState('session')
      const [state, setState] = react.useState({ records: [], error: '', loaded: false })
      const [openId, setOpenId] = react.useState('')

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
        const tick = () => {
          if (alive && (visible || state.loaded === false)) void load()
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [key, visible, load, state.loaded])

      const records = state.records
      const auto = records.filter(record => record.verdict === 'allow').length
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
        records.length === 0
          ? react.createElement('div', { className: 'ap-empty' }, state.loaded ? t.empty : t.loading)
          : react.createElement('ul', { className: 'ap-list' },
            records.map(record => react.createElement(RecordRow, {
              key: String(record.id ?? record.time),
              record,
              open: openId === String(record.id ?? record.time),
              onToggle: () => setOpenId(previous => previous === String(record.id ?? record.time) ? '' : String(record.id ?? record.time)),
              onChanged: refresh,
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
      clientCtx = ctx
      const slots = ctx.get('slots')
      if (slots === undefined) {
        beacon('no-slots')
        console.warn(LOG, '没有 slots 服务，审批面板未注册')
        return
      }
      const mounted = { tab: undefined, sidebar: undefined }
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
      void placementStore.load().then(remount)
      void policyStore.load(undefined)

      ctx.effect(() => slots.inject('settings.plugin.item', () => {
        try {
          const dispose = slots.register({
            name: 'settings.plugin.item',
            key: 'dsh-auto-pass',
            id: 'dsh-auto-pass',
          }, () => react.createElement(PlacementCard))
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
      }, 'dsh-auto-pass: panel mounts')
      console.log(LOG, 'client loaded, placement=' + placementStore.value)
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
