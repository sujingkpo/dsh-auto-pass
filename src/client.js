/**
 * @description dsh-auto-pass 客户端半：把审批记录注册成「对话区标签页」或「右侧栏标签页」
 *   的时间轴面板（倒序）。放置位置参照 dsh-context：placement=auto 时优先右侧栏座位
 *   （ctx.sidebarRightTabs），座位不可用则退回对话区 conversation.view 标签页；
 *   放置位置默认值来自宿主 config（默认 all），设置页卡片可通过宿主设置命名空间覆盖它。
 * @author simon300000
 * @date 2026-09-15
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
    /** 审批记录接口。 */
    const API_CONFIG = '/api/dsh-auto-pass/config'
    const API_LOG = '/api/dsh-auto-pass/log'
    /** 时间轴轮询间隔（毫秒）。 */
    const POLL_MS = 3_000
    /** 右侧栏 tab 类型标识，同时是正文/标题席位的 key。 */
    const SIDEBAR_ID = 'dsh-auto-pass'
    const SIDEBAR_KIND = 'dsh-auto-pass-log'
    /** 对话区标签页的席位 id（conversation.view 内必须唯一）。 */
    const VIEW_ID = 'dsh-auto-pass'
    const PLACEMENTS = ['auto', 'tab', 'sidebar', 'all']

    /** 界面语言：跟随浏览器语言，简体/繁体中文都用中文文案。 */
    const ZH = /^zh/i.test(typeof navigator === 'object' && navigator !== null ? String(navigator.language ?? '') : '')
    const COPY = {
      zh: {
        tabLabel: '审批记录',
        guideDescription: 'Auto Approve 的自动批准与转人工记录',
        title: '审批记录',
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
        rationale: '理由',
        action: '动作',
        latency: '耗时',
        reviewer: 'Reviewer',
        reason: '审批原因',
        time: '时间',
        settingsTitle: '审批记录位置',
        settingsDesc: 'Auto Approve 审批记录显示在哪里（auto 优先右侧栏，座位不可用时退回对话标签页）',
        placementAuto: '自动',
        placementTab: '对话标签页',
        placementSidebar: '右侧栏',
        placementAll: '两处都显示',
      },
      en: {
        tabLabel: 'Approvals',
        guideDescription: 'Auto Approve auto-approvals and hand-offs',
        title: 'Approval log',
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
        settingsTitle: 'Approval log placement',
        settingsDesc: 'Where Auto Approve records its approvals (auto prefers the right sidebar and falls back to a conversation tab)',
        placementAuto: 'Auto',
        placementTab: 'Conversation tab',
        placementSidebar: 'Right sidebar',
        placementAll: 'Both',
      },
    }
    const t = COPY[ZH ? 'zh' : 'en']

    // ── 幂等样式注入（带 id，卸载残留可重复注入）──
    if (typeof document !== 'undefined' && document.getElementById('dsh-auto-pass-style') === null) {
      const tag = document.createElement('style')
      tag.id = 'dsh-auto-pass-style'
      tag.textContent = [
        '.ap-root{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);font-size:13px}',
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
     * 设置页卡片与挂载逻辑共用它，任何变更都会广播给订阅者重新挂载。
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

    /** 单条记录：折叠只显示概要，展开显示风险/授权/理由/动作等。 */
    function RecordRow({ record, open, onToggle }) {
      const route = record.route === undefined ? undefined : record.route.provider + '/' + record.route.model
      return react.createElement('li', { className: 'ap-row' },
        react.createElement('button', {
          type: 'button', className: 'ap-rowHead', 'aria-expanded': open,
          onClick: onToggle,
        },
          react.createElement('span', { className: 'ap-chevron', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
          react.createElement('span', { className: 'ap-time', title: String(record.time ?? '') }, formatTime(record.time)),
          react.createElement('span', { className: 'ap-tool' }, String(record.toolName ?? '?')),
          react.createElement('span', { className: 'ap-grow' }, ''),
          react.createElement(VerdictBadge, { record }),
          react.createElement(OutcomeBadge, { record })),
        open === true && react.createElement('div', { className: 'ap-detail' },
          react.createElement(Field, { label: t.risk, value: record.riskLevel }),
          react.createElement(Field, { label: t.authorization, value: record.userAuthorization }),
          react.createElement(Field, { label: t.rationale, value: record.rationale }),
          react.createElement(Field, { label: t.reason, value: record.reason }),
          react.createElement(Field, { label: t.action, value: record.action, mono: true }),
          react.createElement(Field, { label: t.latency, value: record.latencyMs === undefined ? undefined : String(record.latencyMs) + ' ms' }),
          react.createElement(Field, { label: t.reviewer, value: [record.reviewerSessionId, record.steps === undefined ? undefined : record.steps + ' steps'].filter(Boolean).join(' · ') }),
          react.createElement(Field, { label: t.time, value: record.time })))
    }

    /** 时间轴面板：对话标签页与右侧栏 tab 共用同一个组件。 */
    function ApprovalLogPanel(props) {
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
      return react.createElement('div', { className: 'ap-root' },
        react.createElement('div', { className: 'ap-head' },
          react.createElement('div', { className: 'ap-grow' },
            react.createElement('div', { className: 'ap-title' }, t.title),
            react.createElement('div', { className: 'ap-sub' }, t.subtitle + ' · ' + auto + '/' + records.length)),
          react.createElement('div', { className: 'ap-seg' },
            react.createElement('button', { type: 'button', 'data-on': scope === 'session' ? '1' : '0', onClick: () => setScope('session') }, t.scopeSession),
            react.createElement('button', { type: 'button', 'data-on': scope === 'all' ? '1' : '0', onClick: () => setScope('all') }, t.scopeAll)),
          react.createElement('button', { type: 'button', className: 'ap-btn', onClick: () => { void load() } }, t.reload)),
        state.error !== '' && react.createElement('div', { className: 'ap-error' }, state.error),
        records.length === 0
          ? react.createElement('div', { className: 'ap-empty' }, state.loaded ? t.empty : t.loading)
          : react.createElement('ul', { className: 'ap-list' },
            records.map(record => react.createElement(RecordRow, {
              key: String(record.id ?? record.time),
              record,
              open: openId === String(record.id ?? record.time),
              onToggle: () => setOpenId(previous => previous === String(record.id ?? record.time) ? '' : String(record.id ?? record.time)),
            }))))
    }

    /** 设置页卡片：选择记录显示在哪里（写宿主设置命名空间，即时重挂）。 */
    function PlacementCard() {
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
      return react.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px 0' } },
        react.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, t.settingsDesc),
        react.createElement('div', { className: 'ap-seg', style: { alignSelf: 'flex-start' } },
          options.map(([id, label]) => react.createElement('button', {
            key: id, type: 'button', 'data-on': value === id ? '1' : '0', onClick: () => choose(id),
          }, label))),
        error !== '' && react.createElement('div', { className: 'ap-error' }, error))
    }

    /** 客户端插件入口：按 placement 决定挂载对话标签页、右侧栏 tab 或两者。 */
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) {
        console.warn(LOG, '没有 slots 服务，审批记录面板未注册')
        return
      }
      const mounted = { tab: undefined, sidebar: undefined }
      let lastKey = ''

      const mountTab = () => {
        if (mounted.tab !== undefined) return
        mounted.tab = slots.inject('conversation.view', () => slots.register({
          name: 'conversation.view',
          id: VIEW_ID,
          order: 30,
          label: () => t.tabLabel,
        }, props => react.createElement(ApprovalLogPanel, props)))
      }
      const mountSidebar = () => {
        if (mounted.sidebar !== undefined) return
        // 右侧栏座位按契约可选：没有该服务的旧版本上回调不触发，插件不因此挂起。
        mounted.sidebar = ctx.inject(['sidebarRightTabs'], raw => {
          const tabs = raw?.sidebarRightTabs
          if (tabs === undefined || typeof tabs.register !== 'function') return
          const disposers = []
          const own = (result) => {
            if (typeof result === 'function') disposers.push(result)
          }
          try {
            own(tabs.register({
              id: SIDEBAR_ID,
              kind: SIDEBAR_KIND,
              title: () => t.tabLabel,
              guide: [{
                order: 30,
                title: () => t.tabLabel,
                description: () => t.guideDescription,
                icon: LogGlyph,
              }],
            }))
            own(raw.slots.inject('sidebar.right.pane.tab', () => raw.slots.register({
              name: 'sidebar.right.pane.tab',
              key: SIDEBAR_ID,
            }, props => react.createElement(ApprovalLogPanel, props))))
          } catch (error) {
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
      void placementStore.load().then(remount)

      ctx.effect(() => slots.inject('settings.plugin.item', () => slots.register({
        name: 'settings.plugin.item',
        key: 'dsh-auto-pass',
        id: 'dsh-auto-pass',
      }, () => react.createElement(PlacementCard))), 'dsh-auto-pass: placement settings card')

      ctx.effect(() => () => {
        unsubscribe()
        unmount()
      }, 'dsh-auto-pass: placement mounts')
      console.log(LOG, 'client loaded, placement=' + placementStore.value)
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
