/**
 * @description dsh-auto-pass 客户端半冒烟测试：加载 bundle、校验注册的 id/槽位/标签，
 *   并把面板组件真正渲染到稳定状态——客户端代码不进构建流水线，只有这一步能抓到
 *   未定义标识符、漏闭合花括号、以及「拉到记录后」那一轮渲染里的问题。
 * @author simon300000
 * @date 2026-09-15
 * @modify 2026-09-15 支持反复渲染（状态 + 副作用），覆盖时间线的审批意见与命中名单显示；
 *   加入 document 替身，覆盖权限档位「盾牌 + A」图标的注入与打标记；
 *   加入会话列表快照替身，覆盖「全部会话」下每条记录底部的会话名（含不在快照时的 id 短名兜底）；
 *   覆盖时间线快捷筛选（白名单 / 黑名单 / 自动 / 人工）的条数徽标、多选叠加与筛空空态
 */
import { describe, expect, it, vi } from 'vitest'

/** 会话列表快照里存在的会话：底部小字应显示它的 displayTitle。 */
const SESSION_KNOWN = 'session-1f3c9a2e-0000-4000-8000-000000000001'
/** 不在快照里的会话（历史会话的真实情形）：底部小字退回 id 短名。 */
const SESSION_UNKNOWN = 'session-2b7d4c11-0000-4000-8000-000000000002'
/** 快捷筛选 chip 的 data-filter 顺序：全部 + 四个筛选键。 */
const FILTER_CHIPS = ['all', 'allow', 'deny', 'auto', 'human']

/**
 * 策略快照里那条指纹规则的值：形态与真实权限指纹一致（工具\u0000cmd:命令\u0000x:额外参数）。
 * 界面上不该直接显示这串机器码，而要显示摊开后的「bash · npm test · sandbox_permissions=…」。
 */
const FINGERPRINT_KEY = 'bash\u0000cmd:npm test\u0000x:{"sandbox_permissions":"danger-full-access"}'

/** 时间线样例记录：白名单命中、黑名单命中、人工放行、模型自动放行各一条，用来验证行内展示与筛选口径。 */
function sampleRecords() {
  return [
    {
      id: 'record-allow',
      time: '2026-09-15T04:00:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'bash',
      verdict: 'allow',
      outcome: 'allowed-once',
      rationale: '用户明确要求运行测试。',
      steps: 0,
      latencyMs: 3,
      decidedBy: 'auto',
      signature: { toolName: 'bash', key: 'bash:npm test', text: 'bash · npm test' },
      // 故意不写 source：这条记录的规则来源要靠策略快照反查（老记录的真实情形）
      policy: { list: 'allow', scope: 'global', ruleId: 'rule-1', label: 'bash · npm test', kind: 'signature' },
    },
    {
      id: 'record-deny',
      time: '2026-09-15T04:01:00.000Z',
      sessionId: SESSION_UNKNOWN,
      toolName: 'bash',
      verdict: 'defer',
      outcome: 'rejected',
      rationale: '该命令已列入黑名单。',
      steps: 0,
      // 人工拒绝后追问问到的理由：只在展开详情里显示
      rejectReason: '这次不需要提权，先别动。',
      policy: { list: 'deny', scope: 'project', ruleId: 'rule-2', label: 'bash · rm -rf', kind: 'signature', source: 'user' },
    },
    {
      id: 'record-human',
      time: '2026-09-15T04:02:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'write',
      verdict: 'defer',
      outcome: 'allowed-once',
      rationale: '已转交人工并由用户放行。',
      steps: 2,
    },
    {
      id: 'record-model',
      time: '2026-09-15T04:03:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'read',
      verdict: 'allow',
      outcome: 'allowed-once',
      rationale: '模型判定为只读操作，直接放行。',
      steps: 0,
      decidedBy: 'auto',
      signature: { toolName: 'read', key: 'read:package.json', text: 'read · package.json' },
    },
  ]
}

/**
 * 极简 react 替身：带「渲染帧」概念，可以反复渲染同一个组件直到状态稳定。
 * 一轮 = 重置游标 → 求值组件树 → 跑本轮新出现的副作用 → 等微任务 → 有 setState 就再来一轮。
 */
function fakeReact() {
  const frames = []
  /** 取当前渲染帧（组件树里所有 hook 共用一帧）。 */
  const frame = () => frames[frames.length - 1]
  /**
   * 当前组件的路径（`evaluate` 在每个组件求值前设置），hook 槽位按**它**分：
   * 早先的实现按「整棵树第几个 hook」分（单一扁平游标），那是错的——前面任何一个组件
   * 按条件增减 hook（例如展开「加入名单」表单会多挂 4 个），后面所有组件的槽位都会串位，
   * 于是别的行读到别人的状态。真机 React 的状态属于组件实例，按路径分才与它一致。
   */
  let key = ''
  /** 取一个 hook 在本组件内的序号并前进游标（游标每轮渲染重置，槽位跨轮复用）。 */
  const nextIndex = field => {
    const current = frame()
    const index = current[field][key] ?? 0
    current[field][key] = index + 1
    return index
  }
  /**
   * 与 React 同口径：children 同时进 `props.children`（一个子节点就是它本身，多个是数组）。
   * 少了这一步，`createElement(Comp, props, child)` 这种写法的组件在替身里读不到 children——
   * 真机照常渲染、测试里却什么都不渲染（本轮 `.ap-blockCard` 的展开内容就栽在这）。
   * 渲染树仍保留 `children` 数组，断言照旧按它遍历子节点。
   */
  const createElement = (type, props, ...children) => ({
    type,
    props: children.length === 0
      ? props
      : { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
    children,
  })
  return {
    createElement,
    useState: value => {
      const current = frame()
      const slot = key + '#' + String(nextIndex('cursors'))
      if (!(slot in current.slots)) current.slots[slot] = typeof value === 'function' ? value() : value
      return [current.slots[slot], next => {
        current.slots[slot] = typeof next === 'function' ? next(current.slots[slot]) : next
        current.dirty = true
      }]
    },
    useEffect: effect => {
      const current = frame()
      const slot = key + '$' + String(nextIndex('effectCursors'))
      if (current.registered.has(slot)) return
      current.registered.add(slot)
      current.effects.push({ key: slot, effect })
    },
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
    /** 开一帧（同一组件反复渲染共用这一帧，状态才留得住）。 */
    __pushFrame: () => {
      const current = {
        slots: {},
        cursors: {},
        effectCursors: {},
        effects: [],
        registered: new Set(),
        cleanups: [],
        ran: new Set(),
        dirty: false,
      }
      frames.push(current)
      return current
    },
    __popFrame: () => frames.pop(),
    /** 进入一个组件：把当前路径切到它（hook 按路径分槽），返回还原函数。 */
    __enter: next => {
      const previous = key
      key = next
      return () => {
        key = previous
      }
    },
    /** 每轮渲染前重置 hook 游标（hook 顺序必须一致，重置后才能按序号复用状态）。 */
    __resetCursor: () => {
      const current = frame()
      current.cursors = {}
      current.effectCursors = {}
    },
  }
}

/** 最近一次安装的 document 替身，供断言读取注入的样式与打标记结果。 */
let domStub = null

/**
 * /log 的返回可被单个用例接管：自动打开时间线的观察器要「先给历史记录、再给一条新记录」，
 * 用默认的样例记录表达不了这两个时刻。null = 用 sampleRecords()。
 */
let logResponder = null

/** POST /rule 的回执同理可被单个用例接管（升级/降级的查重文案用例要用三种不同的回执）。 */
let ruleResponder = null

/** POST /rule/draft（换条件后让模型按该条件重新生成）的回执，同样可被单个用例接管。 */
let draftResponder = null

/** POST /rule/revert（撤销这次加入）的回执，同样可被单个用例接管。 */
let revertResponder = null

/** 剪贴板替身收到的文本：指纹的「复制指纹」按钮要把**原始串**（含 NUL）整串写进去。 */
let clipboardWrites = []

/** POST /policy（改阈值 / 加删改规则）的回执：用例接管它验证「已更新 / 已合并」文案。 */
let policyResponder = null

/**
 * /config 的请求流水（断言「这个开关写的是本工作区还是全局」用）：
 * 每项 { method, cwd, body }；body 只在 POST 时有。
 */
let configRequests = []

/**
 * 模拟「某个工作区在项目策略文件里单独存过 prefs.autoOpenTimeline」：cwd -> boolean。
 * /config 带 cwd 时据此给出 workspace 段（与宿主的 configSnapshot 同口径）。
 */
let workspaceAutoOpen = {}

/** 观察器用例里那个当前会话的工作区（harness 的 sessions 快照里的 cwd）。 */
const WORKSPACE_CWD = 'D:\\work\\github\\dsh-auto'

/** /config 的回执替身：全局那份 + （带 cwd 时）本工作区的生效值。 */
function configPayload(cwd) {
  const globalAuto = true
  const scoped = cwd === undefined ? undefined : workspaceAutoOpen[cwd]
  return {
    ok: true,
    settings: { placement: 'all', notice: true, denyDirect: false, autoOpenTimeline: globalAuto, askRejectReason: true },
    ...(cwd === undefined ? {} : {
      workspace: {
        cwd,
        autoOpenTimeline: typeof scoped === 'boolean' ? scoped : globalAuto,
        scoped: typeof scoped === 'boolean',
      },
    }),
    writable: true,
  }
}

/** 渲染帧之间的「等一轮」：默认真时钟；观察器用例切到假时钟后必须改写，否则永远等不到。 */
const defaultWaitTick = () => new Promise(resolve => setTimeout(resolve, 0))
let waitTick = defaultWaitTick

/**
 * 极简 document 替身：捕获注入的样式文本，并按「档位名 span」的四种形态造候选节点
 * （chip / 菜单项 / 名字更长 / 里面还有元素），用来验证图标只打在该打的那个上、且变量按宿主分两套。
 * @returns {{styled: string[], marked: object[], candidates: object[]}} 捕获到的数据
 */
function installDocumentStub() {
  const styled = []
  const marked = []
  /**
   * 造一个 span 替身；classList / closest / style 只实现用到的部分。
   * @param {string} text 文本
   * @param {object[]} children 子元素
   * @param {string|null} ariaLabel 所属 button 的 aria-label（chip 才有，菜单项为 null）
   */
  const span = (text, children, ariaLabel) => {
    const vars = {}
    return {
      tagName: 'SPAN',
      textContent: text,
      children,
      closest: tag => (tag === 'button' ? { getAttribute: name => (name === 'aria-label' ? ariaLabel : null) } : null),
      style: { setProperty: (name, value) => { vars[name] = value } },
      vars,
      classList: {
        names: new Set(),
        contains(name) { return this.names.has(name) },
        add(name) {
          this.names.add(name)
          // vars 存引用而不是快照：断言时读的是 mark() 跑完后的最终值
          marked.push({ text, classes: [...this.names], vars })
        },
      },
    }
  }
  const candidates = [
    span('自动审批', [], '访问模式，当前：自动审批'),
    span('自动审批', [], null),
    span('自动审批面板', [], null),
    span('自动审批', [{}], null),
  ]
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: tag => styled.push(String(tag.textContent)) },
    documentElement: { appendChild: () => {} },
    body: {},
    querySelectorAll: () => candidates,
  }
  globalThis.MutationObserver = class { observe() {} }
  return { styled, marked, candidates }
}

/** 安装最小浏览器替身：fetch 与 localStorage 都返回可控的假结果，避免噪声。 */
function installBrowserStubs() {
  logResponder = null
  ruleResponder = null
  draftResponder = null
  revertResponder = null
  policyResponder = null
  configRequests = []
  workspaceAutoOpen = {}
  const store = new Map()
  globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: key => { store.delete(key) },
  }
  domStub = installDocumentStub()
  // 界面语言与剪贴板：语言写死 zh-CN（不依赖跑测试那台机器的 locale），剪贴板用它断言「复制的是完整指纹」
  clipboardWrites = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      language: 'zh-CN',
      clipboard: { writeText: async text => { clipboardWrites.push(String(text)) } },
    },
  })
  globalThis.fetch = vi.fn(async (url, options) => {
    const target = String(url)
    if (target.includes('/policy')) {
      // 写策略（改阈值 / 加删改规则）：用例可以接管回执，验证「已更新 / 已合并了哪些」的文案
      if (options?.method === 'POST') {
        const payload = typeof policyResponder === 'function' ? policyResponder(target) : { ok: true }
        return { json: async () => payload }
      }
      // 规则带上 source：命中 chip 的「自动 / 手动」由它反查出来
      return {
        json: async () => ({
          ok: true,
          thresholds: { allow: 3, deny: 3 },
          global: {
            allow: [{ id: 'rule-1', source: 'model', list: 'allow', scope: 'global', tool: 'bash', label: 'bash · npm test', match: { kind: 'signature', value: FINGERPRINT_KEY } }],
            deny: [],
          },
          project: {
            allow: [],
            deny: [{ id: 'rule-2', source: 'user', list: 'deny', scope: 'project', tool: 'bash', label: 'bash · rm -rf', match: { kind: 'command_prefix', value: 'rm -rf' } }],
          },
        }),
      }
    }
    if (target.includes('/log')) {
      const records = typeof logResponder === 'function' ? logResponder(target) : sampleRecords()
      return { json: async () => ({ ok: true, records }) }
    }
    // 换匹配条件时让模型按该条件重新生成（POST /rule/draft）：默认「生成不了」，
    // 也就是保留客户端本地推导的值；要用例接管就塞 draftResponder
    if (target.includes('/rule/draft')) {
      const payload = typeof draftResponder === 'function'
        ? draftResponder(target)
        : { ok: false, error: 'no draft responder' }
      return { json: async () => payload }
    }
    // 撤销这次加入（POST /rule/revert）：必须排在 /rule 之前，否则会被那条分支吃掉
    if (target.includes('/rule/revert')) {
      const payload = typeof revertResponder === 'function'
        ? revertResponder(target)
        : { ok: true, restored: [] }
      return { json: async () => payload }
    }
    // 时间线的升级/降级 POST /rule：用例可以接管回执，验证「已更新 / 已被覆盖 / 已合并」三种文案
    if (target.includes('/rule')) {
      const payload = typeof ruleResponder === 'function' ? ruleResponder(target) : { ok: true }
      return { json: async () => payload }
    }
    // 界面偏好：placement + 四个行为开关。自动打开时间线按工作区区分——带 ?cwd= 或 body.cwd
    // 的请求拿到 workspace 段；POST 带 cwd 就是「写这个工作区那份」（替身记下来供断言）
    if (target.includes('/config')) {
      const body = options?.body === undefined ? undefined : JSON.parse(String(options.body))
      const fromQuery = target.includes('?cwd=')
        ? decodeURIComponent(target.slice(target.indexOf('?cwd=') + 5))
        : undefined
      const cwd = body?.cwd ?? fromQuery
      if (body !== undefined && typeof body.autoOpenTimeline === 'boolean' && cwd !== undefined) {
        workspaceAutoOpen[cwd] = body.autoOpenTimeline
      }
      configRequests.push({ method: options?.method ?? 'GET', cwd, body })
      return { json: async () => configPayload(cwd) }
    }
    return { json: async () => configPayload(undefined) }
  })
}

/** 加载客户端 bundle，返回它交给 __ModuleLoader__ 的注册项。 */
async function loadClient() {
  const registrations = []
  vi.resetModules()
  installBrowserStubs()
  globalThis.window = { __ModuleLoader__: { load: options => registrations.push(options) } }
  await import('../src/client.js')
  expect(registrations).toHaveLength(1)
  return registrations[0]
}

/**
 * 造一个够客户端半用的假宿主：记录槽位注册、可提供右侧栏座位。
 * @param {object} [options] 选项
 * @param {boolean} [options.legacySidebar] 右侧栏服务不给 isExpanded（模拟老宿主）
 */
function harness(options = {}) {
  const slotRegistrations = []
  const tabRegistrations = []
  const slots = {
    inject: (name, callback) => callback(),
    // 契约是 register(definition, component)：两个都要留下，否则渲染断言是空转的
    register: (definition, component) => {
      slotRegistrations.push({ definition, component })
      return () => {}
    },
  }
  const sidebarTabs = {
    register: definition => {
      tabRegistrations.push(definition)
      return () => {}
    },
  }
  // 会话列表快照替身：时间线在「全部会话」下靠它把 sessionId 翻成会话名（与 DSH 左侧列表同一份投影）；
  // current 是「当前会话」，审批观察器靠它决定看哪个会话的记录
  const sessions = {
    list: {
      getSnapshot: () => ({
        current: SESSION_KNOWN,
        byId: {
          [SESSION_KNOWN]: { displayTitle: '审批面板改造', cwd: 'D:\\work\\github\\dsh-auto' },
        },
      }),
    },
  }
  // 右侧栏导航面替身：自动打开时间线就是调它的 openTab(kind)；isExpanded 模拟宿主
  // 「整栏是否展开」——收起才允许自动展开，展开着（= 用户停在其他侧边工具上）不许抢。
  // 真实 openTab 内部会 planSetExpanded(true)（读 dsh-client-ui-sidebar-right 源码确认），替身照做。
  const openTabs = []
  const sidebar = { expanded: false }
  const sidebarRight = options.legacySidebar === true
    ? { openTab: kind => { openTabs.push(kind); sidebar.expanded = true } }
    : {
      openTab: kind => { openTabs.push(kind); sidebar.expanded = true },
      isExpanded: () => sidebar.expanded,
    }
  const ctx = {
    get: name => (name === 'slots' ? slots
      : name === 'sessions' ? sessions
        : name === 'sidebarRight' ? sidebarRight : undefined),
    inject: (names, callback) => {
      if (names.includes('sidebarRightTabs')) callback({ slots, sidebarRightTabs: sidebarTabs })
      return { dispose: () => {} }
    },
    effect: fn => fn(),
  }
  return { ctx, slots, slotRegistrations, tabRegistrations, openTabs, sidebar }
}

/**
 * 把整棵元素树求值到宿主元素（字符串 type）：槽位里注册的往往是包装组件，而且
 * 文案藏在嵌套的子组件里，只求值根节点会漏掉——那正是这个冒烟测试要抓的东西。
 * depth 上限只是防御性的，正常组件树很浅。
 */
function evaluate(element, depth = 0, react = undefined, path = 'root') {
  // 注册进槽位的组件通常是包装组件（`props => <Panel {...props}/>`），一层包装就吃掉两层深度；
  // 上限太小会把深层徽标原样返回（函数类型的 type 还会被 JSON.stringify 丢掉），断言就变成空转。
  if (depth > 14) return element
  if (Array.isArray(element)) return element.map((child, index) => evaluate(child, depth + 1, react, path + '.' + String(index)))
  if (element === null || typeof element !== 'object') return element
  if (typeof element.type === 'function') {
    // hook 槽位按组件路径分（见 fakeReact）：求值组件体之前把「当前组件」切到它，求值完再还原
    const here = path + ':' + componentName(element.type)
    const leave = react?.__enter === undefined ? undefined : react.__enter(here)
    try {
      return evaluate(element.type(element.props ?? {}), depth + 1, react, here)
    } finally {
      if (leave !== undefined) leave()
    }
  }
  return {
    type: element.type,
    props: element.props,
    children: Array.isArray(element.children)
      ? element.children.map((child, index) => evaluate(child, depth + 1, react, path + '.' + String(index)))
      : element.children,
  }
}

/** 组件名（匿名组件退回 anon）：路径里带上它，同一位置换了组件类型就不会串用槽位。 */
function componentName(type) {
  return typeof type.name === 'string' && type.name !== '' ? type.name : 'anon'
}

/**
 * 渲染一个面板到稳定状态：反复求值并跑副作用，直到没有新的 setState（最多 8 轮）。
 * 时间线的记录是异步拉回来的，不求到稳定状态就只会看到「加载中」。
 * 上限给到 8：规则表单里「切匹配条件 → 填值 → 点按钮 → 渲染结果」各占一轮，
 * 而权限指纹那档没有值输入框，必须先切条件才拿得到输入框（5 轮会不够）。
 */
async function renderStable(react, component, props, interact) {
  const frame = react.__pushFrame()
  let tree
  try {
    for (let pass = 0; pass < 8; pass += 1) {
      frame.dirty = false
      react.__resetCursor()
      tree = evaluate(component(props), 0, react)
      // 每轮渲染后给用例一次驱动机会（例如点「全部会话」）：面板内部的 setState 只能这样触发
      if (typeof interact === 'function') interact(tree)
      // 只跑本轮新注册的副作用（例如拉记录），重复渲染不会重复订阅（按组件路径去重）
      for (const entry of frame.effects) {
        if (frame.ran.has(entry.key)) continue
        frame.ran.add(entry.key)
        const cleanup = entry.effect()
        if (typeof cleanup === 'function') frame.cleanups.push(cleanup)
      }
      await waitTick()
      if (frame.dirty !== true) break
    }
  } finally {
    react.__popFrame()
  }
  return { tree, cleanups: frame.cleanups }
}

/** 在求值后的元素树里按条件收集节点（组件已展开成字符串 type，直接遍历即可）。 */
function findNodes(node, predicate, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findNodes(child, predicate, found)
    return found
  }
  if (predicate(node) === true) found.push(node)
  findNodes(node.children, predicate, found)
  return found
}

/**
 * 时间线列表里的记录节点（`.ap-item`）：类名上还挂着 isFirst / isLast / open / gap，
 * 所以不能按类名全等匹配，得按分词判断（`findChip` 用 data-filter 是同一套思路）。
 * @param {*} node 求值后的元素树
 * @returns {Array} 记录节点（按出现顺序）
 */
function findRows(node) {
  return findNodes(node, candidate => typeof candidate?.props?.className === 'string'
    && candidate.props.className.split(' ').includes('ap-item'))
}

/** 展开详情里某个字段的值（Field 渲染成 .ap-field：键 span + 值 span）。 */
function fieldValue(node, label) {
  const field = findNodes(node, candidate => candidate?.props?.className === 'ap-field'
    && candidate.children?.[0]?.children?.[0] === label)[0]
  return field?.children?.[1]?.children?.[0]
}

/** 找文案完全匹配的 button：用于点开「全部会话」。 */
function findButton(node, label) {
  return findNodes(node, candidate => candidate.type === 'button'
    && Array.isArray(candidate.children)
    && candidate.children.length === 1
    && candidate.children[0] === label)[0]
}

/**
 * 找「自动加入名单」标识（客户端 RuleAutoBadge 渲染的胶囊）：className 里带 ap-badge，
 * 文案是短标记 `+白名单` / `+黑名单`，或覆盖命中的 `白名单已覆盖` / `黑名单已覆盖`
 * （2026-09-18 行头压到两行后由长句改短句，条件来源挪进 tooltip）。折叠态与展开态都能找到。
 * @param {*} node 求值后的元素树
 * @returns {*} 找到的标识元素；没找到返回 undefined
 */
function findAutoBadge(node) {
  return findNodes(node, candidate => {
    const className = candidate?.props?.className
    if (typeof className !== 'string' || className.split(' ').includes('ap-badge') !== true) return false
    const label = candidate.children?.[0]
    return typeof label === 'string' && (label === '+白名单' || label === '+黑名单' || label.endsWith('已覆盖'))
  })[0]
}

/**
 * 找一个**默认收起**的入口按钮（「排查信息」/「加入名单」）：它的文案带箭头或在开/合之间变化，
 * 不能按文案完全匹配去找，所以用稳定的 `data-ui` 属性定位（与 findChip 用 data-filter 同一套思路）。
 * @param {*} node 求值后的元素树
 * @param {string} key 'debug-info' | 'rule-entry'
 * @returns {*} 找到的入口按钮；没找到返回 undefined
 */
function findUiToggle(node, key) {
  return findNodes(node, candidate => candidate?.props?.['data-ui'] === key)[0]
}

/**
 * 交互动作序列：renderStable 每轮渲染只执行**下一个**动作，且一个动作一个渲染轮次
 * ——前一个动作的效果（setState）要下一轮才可见，同一轮里接着点会把旧值发出去。
 * 动作返回 false 表示「这一轮还轮不到它」（目标还没出现），下一轮重试。
 * @param {...Function} actions 动作函数数组
 * @returns {Function} renderStable 的 interact 回调
 */
function steps(...actions) {
  let index = 0
  return tree => {
    if (index >= actions.length) return
    if (actions[index](tree) === false) return
    index += 1
  }
}

/** 展开第 index 条记录的详情（默认第一条）。 */
function expandRow(index = 0) {
  return tree => {
    const head = findNodes(tree, node => node?.props?.className === 'ap-rowHead')[index]
    if (head === undefined) return false
    head.props.onClick()
    return true
  }
}

/** 点开一个默认收起的入口（'debug-info' 排查信息 / 'rule-entry' 加入名单）。 */
function openToggle(key) {
  return tree => {
    const toggle = findUiToggle(tree, key)
    if (toggle === undefined) return false
    toggle.props.onClick()
    return true
  }
}

/** 点一个文案完全匹配的按钮（复用 findButton 的定位口径）。 */
function clickButton(label) {
  return tree => {
    const button = findButton(tree, label)
    if (button === undefined) return false
    button.props.onClick()
    return true
  }
}

/** 点「加入名单」表单里的匹配条件按钮（data-kind）。 */
function clickKind(kind) {
  return tree => {
    const button = findNodes(tree, node => node?.type === 'button' && node?.props?.['data-kind'] === kind)[0]
    if (button === undefined) return false
    button.props.onClick()
    return true
  }
}

/** 往一个按 aria-label 定位的输入框里填值。 */
function fillInput(label, value) {
  return tree => {
    const input = findNodes(tree, node => node?.type === 'input' && node?.props?.['aria-label'] === label)[0]
    if (input === undefined) return false
    input.props.onChange({ target: { value } })
    return true
  }
}

/**
 * 点「加入名单」表单里的写入动作按钮（`以后直接放行` / `以后直接转人工`）。
 * 2026-09-18 起表单是「先选作用域、再点动作」，作用域按钮不再触发写入（见 clickScopeButton）。
 */
function clickFormAction(label) {
  return tree => {
    const actions = findNodes(tree, node => node?.props?.className === 'ap-actions')[0]
    if (actions === undefined) return false
    const button = findNodes(actions, node => node?.type === 'button' && node.children?.[0] === label)[0]
    if (button === undefined) return false
    button.props.onClick()
    return true
  }
}

/** 点「加入名单」表单里的作用域按钮（本项目 / 全局；`data-scope` 定位，点它只切作用域不写入）。 */
function clickScopeButton(name) {
  return tree => {
    const button = findNodes(tree, node => node?.type === 'button' && node?.props?.['data-scope'] === name)[0]
    if (button === undefined) return false
    button.props.onClick()
    return true
  }
}

/**
 * 拨一个行为开关（原生 checkbox 承载状态）：按出现顺序取第 index 个，
 * 顺序与 `behaviorSwitchSpecs` 一致 —— 0=注入审批结果，1=黑名单直接拒绝，
 * 2=自动打开审批时间线，3=拒绝后追问理由。
 * @param index 第几个开关
 * @param checked 拨到开 / 关
 */
function toggleSwitch(index, checked) {
  return tree => {
    const input = findNodes(tree, node => node?.type === 'input' && node?.props?.type === 'checkbox')[index]
    if (input === undefined) return false
    input.props.onChange({ target: { checked } })
    return true
  }
}

/**
 * 「权限指纹」那一行显示的紧凑文案。2026-09-18 起排查区里的指纹行不是纯文本，
 * 而是 `FingerprintValue`（可视化 span + 「复制指纹」按钮），所以不能再用 fieldValue。
 * @param {*} node 求值后的元素树
 * @returns {string|undefined} 形如 `pwsh · pnpm test · sandbox_permissions=…` 的文案
 */
function fingerprintRowText(node) {
  const row = findNodes(node, candidate => candidate?.props?.className === 'ap-field'
    && candidate.children?.[0]?.children?.[0] === '权限指纹')[0]
  return row?.children?.[1]?.children?.[0]?.children?.[0]?.children?.[0]
}

/**
 * 找快捷筛选 chip：chip 里除了文字还有一个条数 span，所以不能按 findButton 那套
 * 「只有一个字符串子节点」来找，改用 data-filter 属性定位。
 * @param {*} node 求值后的元素树
 * @param {string} key 'all' | 'allow' | 'deny' | 'auto' | 'human'
 * @returns {*} 找到的 chip 元素；没找到返回 undefined
 */
function findChip(node, key) {
  return findNodes(node, candidate => candidate.type === 'button'
    && candidate.props?.['data-filter'] === key)[0]
}

/** chip 上的条数（文本节点）；chip 不在时为 undefined。 */
function chipCount(node, key) {
  const chip = findChip(node, key)
  if (chip === undefined) return undefined
  const span = chip.children.find(child => child?.props?.className === 'ap-chipCount')
  return span === undefined ? undefined : span.children[0]
}

/** 取出某个槽位注册项（def 是 register 的第一个参数，component 是第二个）。 */
function slot(slotRegistrations, name, key) {
  return slotRegistrations.find(entry => entry.definition.name === name
    && (key === undefined || entry.definition.key === key || entry.definition.id === key))
}

describe('客户端半加载与注册', () => {
  it('bundle 以包名注册，导出 inject 与 apply', async () => {
    const registration = await loadClient()
    expect(registration.id).toBe('dsh-auto-pass')
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return fakeReact()
      throw new Error('unexpected require: ' + specifier)
    })
    expect(moduleExports.inject).toEqual(['slots'])
    expect(typeof moduleExports.apply).toBe('function')
  })

  it('apply 注册对话区「审批设置」、右侧栏时间线与设置页卡片', async () => {
    const registration = await loadClient()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return fakeReact()
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations, tabRegistrations } = harness()
    moduleExports.apply(ctx)

    // 对话区只放审批设置：标签是「审批设置」，不再是审批记录时间线
    const view = slot(slotRegistrations, 'conversation.view', 'dsh-auto-pass')
    expect(view).toBeDefined()
    expect(view.definition.label()).toBe('审批设置')

    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')
    expect(pane).toBeDefined()

    // chip 的标题席位：没有它右侧栏标题就只有文字、没有图标
    const tabTitle = slot(slotRegistrations, 'sidebar.right.pane.tab.title', 'dsh-auto-pass')
    expect(tabTitle).toBeDefined()

    const card = slot(slotRegistrations, 'settings.plugin.item', 'dsh-auto-pass')
    expect(card).toBeDefined()

    expect(tabRegistrations).toHaveLength(1)
    expect(tabRegistrations[0].id).toBe('dsh-auto-pass')
    expect(tabRegistrations[0].title()).toBe('审批时间线')
    expect(typeof tabRegistrations[0].guide[0].icon).toBe('function')
  })

  it('给权限档位名补「盾牌 + A」图标：只认纯文字且完全匹配的 span', async () => {
    const registration = await loadClient()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return fakeReact()
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx } = harness()
    moduleExports.apply(ctx)

    // DSH 只给三个内置 id 图标，我们的档位靠注入的这条 CSS：几何全走 --ap-glyph-* 变量
    const css = domStub.styled.join('\n')
    expect(css).toContain('.ap-presetGlyph{display:inline-flex;align-items:center;gap:var(--ap-glyph-gap,8px)}')
    expect(css).toContain('.ap-presetGlyph::before')
    expect(css).toContain('width:var(--ap-glyph-box,16px)')
    expect(css).toContain('-webkit-mask-size:var(--ap-glyph-icon,16px) var(--ap-glyph-icon,16px)')
    expect(css).toContain('-webkit-mask-image:url("data:image/svg+xml;charset=utf-8,')
    // chip（按钮带 aria-label）与菜单项各写一套变量；「自动审批面板」与带子元素的 span 都不该被打标记
    expect(domStub.marked).toEqual([
      {
        text: '自动审批',
        classes: ['ap-presetGlyph'],
        vars: { '--ap-glyph-box': '14px', '--ap-glyph-icon': '14px', '--ap-glyph-gap': '4px', '--ap-glyph-color': 'currentColor' },
      },
      {
        text: '自动审批',
        classes: ['ap-presetGlyph'],
        vars: {
          '--ap-glyph-box': '16px',
          '--ap-glyph-icon': '16px',
          '--ap-glyph-gap': '8px',
          '--ap-glyph-color': 'var(--dsw-alias-label-tertiary,currentColor)',
        },
      },
    ])
  })

  it('三个面板都能渲染到稳定状态（抓到未定义标识符与异步渲染问题）', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    moduleExports.apply(ctx)

    const view = slot(slotRegistrations, 'conversation.view', 'dsh-auto-pass')
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')
    const card = slot(slotRegistrations, 'settings.plugin.item', 'dsh-auto-pass')
    const cleanups = []
    const trees = []
    for (const entry of [view, pane, card]) {
      expect(typeof entry.component).toBe('function')
      const rendered = await renderStable(react, entry.component, { sessionId: 'session-1' })
      cleanups.push(...rendered.cleanups)
      trees.push(JSON.stringify(rendered.tree))
    }
    // 设置页的容器是 ul：卡片必须是 li，否则一行卡片样式都拿不到
    expect(await rootType(react, card.component)).toBe('li')
    // 右侧栏标题：图标 + 文案，两者缺一 chip 就与内置插件不一致
    const tabTitle = slot(slotRegistrations, 'sidebar.right.pane.tab.title', 'dsh-auto-pass')
    const titleRendered = await renderStable(react, tabTitle.component, {})
    cleanups.push(...titleRendered.cleanups)
    const titleTree = titleRendered.tree
    expect(titleTree.type).toBe('span')
    expect(titleTree.children.some(child => child?.type === 'svg')).toBe(true)
    expect(JSON.stringify(titleTree)).toContain('审批时间线')
    for (const cleanup of cleanups) cleanup()

    // 对话区标签页只放审批设置：有阈值输入，没有时间线的东西
    expect(trees[0].includes('连续放行阈值')).toBe(true)
    expect(trees[0].includes('连续被拒阈值')).toBe(true)
    expect(trees[0].includes('黑名单 · 直接转人工')).toBe(true)
    // 「审批设置」里有个开关叫「自动打开审批时间线」，所以只能断言时间线那两处独有的东西不在对话区标签页
    expect(trees[0].includes('ap-list')).toBe(false)
    // 右侧栏是审批时间线：没有阈值输入，也没有「本次会话 / 全部会话」切换
    // （用户 2026-09-18：切换不要了，面板固定看本次会话；记录里的 sessionId 等字段照旧保留）
    expect(trees[1].includes('审批时间线')).toBe(true)
    expect(trees[1].includes('本次会话')).toBe(false)
    expect(trees[1].includes('全部会话')).toBe(false)
    expect(trees[1].includes('连续放行阈值')).toBe(false)
    // 时间线行内要能看见审批意见，以及命中的是白名单还是黑名单（含规则标签）
    expect(trees[1].includes('用户明确要求运行测试。')).toBe(true)
    expect(trees[1].includes('白名单')).toBe(true)
    expect(trees[1].includes('bash · npm test')).toBe(true)
    // 一行标签 = 「名单·决策来源」：命中白名单且模型自动审批；命中黑名单则是人工介入
    expect(trees[1].includes('白名单·自动')).toBe(true)
    expect(trees[1].includes('黑名单·人工')).toBe(true)
    // 没命中名单时只显示决策来源与其含义
    expect(trees[1].includes('人工审批 · 已批准')).toBe(true)
    // 命中黑名单的那条：chip 与说明文字都在同一行
    expect(trees[1].includes('bash · rm -rf')).toBe(true)
    // 设置页卡片是放置位置选择器 + 四个行为开关（注入审批结果 / 黑名单直接拒绝 / 自动打开时间线 / 拒绝后追问理由）
    expect(trees[2].includes('面板显示位置')).toBe(true)
    expect(trees[2].includes('注入审批结果到上下文')).toBe(true)
    expect(trees[2].includes('黑名单直接拒绝')).toBe(true)
    expect(trees[2].includes('自动打开审批时间线')).toBe(true)
    expect(trees[2].includes('拒绝后追问理由')).toBe(true)
    // 开关是真正的 switch（原生 checkbox 承载状态）：默认 notice 开、denyDirect 关、autoOpenTimeline / askRejectReason 开
    const switches = findNodes(JSON.parse(trees[2]), node => node?.type === 'input' && node?.props?.type === 'checkbox')
    expect(switches.map(node => node.props.checked)).toEqual([true, false, true, true])
    // 「审批设置」面板里也要有同一组开关（用户要求两处都能改）
    expect(trees[0].includes('注入审批结果到上下文')).toBe(true)
    expect(trees[0].includes('黑名单直接拒绝')).toBe(true)
    expect(trees[0].includes('自动打开审批时间线')).toBe(true)
    expect(trees[0].includes('拒绝后追问理由')).toBe(true)
    expect(findNodes(JSON.parse(trees[0]), node => node?.type === 'input' && node?.props?.type === 'checkbox')).toHaveLength(4)
    // 会话名那行小字随「全部会话」视图一起删掉了（记录字段仍在，只是界面上不再有那个视图）
    expect(trees[1].includes('ap-session')).toBe(false)
  })

  it('快捷筛选：五个 chip 都带当前范围的条数，默认「全部」点亮', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN })
    for (const cleanup of rendered.cleanups) cleanup()

    // 样例四条记录：白名单 1、黑名单 1（没写 decidedBy，兜底算人工）、模型自动放行 1、人工放行 1
    expect(FILTER_CHIPS.map(key => chipCount(rendered.tree, key))).toEqual(['4', '1', '1', '1', '1'])
    // 四类互不重叠：四个 chip 的条数相加 = 总数（白名单那条 decidedBy 是 auto，但只算「白名单」）
    const counts = FILTER_CHIPS.slice(1).map(key => Number(chipCount(rendered.tree, key)))
    expect(Number(chipCount(rendered.tree, 'all'))).toBe(counts.reduce((sum, value) => sum + value, 0))
    // 默认不筛选：「全部」点亮，另外四个都不亮，列表是完整三条
    expect(findChip(rendered.tree, 'all').props['data-on']).toBe('1')
    expect(FILTER_CHIPS.slice(1).map(key => findChip(rendered.tree, key).props['data-on'])).toEqual(['0', '0', '0', '0'])
    expect(findRows(rendered.tree)).toHaveLength(4)
  })

  it('展开记录时能看到人工补的拒绝理由', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    // 只点一次：interact 每轮渲染都会被调用，不做标志会反复切换
    let clicked = false
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN }, tree => {
      if (clicked) return
      // 黑名单那条记录：折叠态里有它的命中规则文案，用它定位行头
      const row = findRows(tree)
        .find(candidate => JSON.stringify(candidate).includes('rm -rf'))
      if (row === undefined) return
      const head = findNodes(row, node => node?.props?.className === 'ap-rowHead')[0]
      if (head === undefined) return
      clicked = true
      head.props.onClick()
    })
    expect(clicked).toBe(true)
    for (const cleanup of rendered.cleanups) cleanup()

    // 展开详情里多一行「人工拒绝理由」：追问卡的回答要能在时间线上核对
    const dump = JSON.stringify(rendered.tree)
    expect(dump).toContain('人工拒绝理由')
    expect(dump).toContain('这次不需要提权，先别动。')
  })

  it('按天分组：日期进组标题，行头只留时分秒，轮次步数不再占折叠行', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    /** 本地时间的「N 天前 HH:04:05」：分组按本地零点切，所以这里也用本地时间构造。 */
    const at = (daysAgo, hour) => {
      const now = new Date()
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour, 4, 5).toISOString()
    }
    // 同一时间戳既进夹具也做断言：写死日期的话这份用例只在当天是绿的（2026-09-20 实测被它绊住）
    const todayTop = at(0, 10)
    logResponder = () => [
      { id: 'today-1', time: todayTop, sessionId: SESSION_KNOWN, toolName: 'bash', verdict: 'allow', rationale: '今天第一条。', turn: 2, step: 40, decidedBy: 'auto' },
      { id: 'today-2', time: at(0, 9), sessionId: SESSION_KNOWN, toolName: 'bash', verdict: 'defer', outcome: 'rejected', rationale: '今天第二条。' },
      { id: 'yesterday-1', time: at(1, 23), sessionId: SESSION_KNOWN, toolName: 'read', verdict: 'allow', rationale: '昨天那条。', decidedBy: 'auto' },
    ]
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN })
    for (const cleanup of rendered.cleanups) cleanup()
    logResponder = null
    const rows = findRows(rendered.tree)
    const first = JSON.stringify(rows[0])

    // 组标题：今天 / 昨天（同一天不再重复一个标题）
    expect(findNodes(rendered.tree, node => node?.props?.className === 'ap-dayGroup')
      .map(node => node.children[0])).toEqual(['今天', '昨天'])
    // 折叠行第一行只显示时分秒：日期交给组标题（完整时间戳仍挂在 title 上，悬停可核对）
    const clock = findNodes(rows[0], node => node?.props?.className === 'ap-time')[0]
    expect(clock.children[0]).toBe('10:04:05')
    expect(clock.props.title).toBe(todayTop)
    // 「第几轮第几步」不再占折叠行（技术字段收在排查信息里，展开那一块才看得到）
    expect(first).not.toContain('第 2 轮')
    // 轨道竖线首尾修剪：每组第一条从圆点起、每组最后一条到圆点止（昨天那组只有一条，两头都要剪）
    expect(rows.map(row => row.props.className.split(' ').filter(name => name === 'isFirst' || name === 'isLast').join('+')))
      .toEqual(['isFirst', 'isLast', 'isFirst+isLast'])
  })

  it('「加入名单」/「排查信息」是卡头即入口：底部不再有第二行文字入口', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    // 只展开第一条记录：两个开关都在卡头行上，正文默认收起
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN }, steps(expandRow()))
    for (const cleanup of rendered.cleanups) cleanup()
    const dump = JSON.stringify(rendered.tree)
    // 详情容器换了名字（整块背景 + 分割线那一套），旧的底部入口行彻底没了
    expect(dump).toContain('ap-detailBox')
    expect(dump).not.toContain('ap-detailFoot')
    expect(dump).not.toContain('ap-btnGhost')
    expect(dump).not.toContain('加入名单…')
    expect(dump).not.toContain('收起名单设置')
    // 卡头即开关：卡片在、正文不在
    expect(dump).toContain('ap-blockCard')
    expect(findUiToggle(rendered.tree, 'rule-entry')).toBeDefined()
    expect(findUiToggle(rendered.tree, 'debug-info')).toBeDefined()
    expect(dump).not.toContain('ap-debugBody')
    expect(findUiToggle(rendered.tree, 'debug-info').props['aria-expanded']).toBe(false)

    // 点开排查信息：仍是同一张卡（卡头还在），正文出现在卡片里
    const opened = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN }, steps(expandRow(), openToggle('debug-info')))
    for (const cleanup of opened.cleanups) cleanup()
    expect(JSON.stringify(opened.tree)).toContain('ap-debugBody')
    expect(findUiToggle(opened.tree, 'debug-info').props['aria-expanded']).toBe(true)
  })

  it('排查区里的「权限指纹」就是规则表单生成的签名，摊开的明细只留命令与额外参数', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    const key = 'pwsh\u0000cmd:pnpm test\u0000x:{"sandbox_permissions":"danger-full-access"}'
    logResponder = () => [{
      id: 'record-key',
      time: '2026-09-16T01:00:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'pwsh',
      verdict: 'allow',
      outcome: 'allowed-once',
      decidedBy: 'auto',
      rationale: '只读测试命令。',
      signature: { toolName: 'pwsh', key, text: 'pwsh: pnpm test', command: 'pnpm test', paths: [] },
    }]
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    // 展开记录 → 打开「排查信息」→ 打开「加入名单」：指纹与规则表单都在默认收起的区域里（用户 2026-09-18）
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN },
      steps(expandRow(), openToggle('debug-info'), openToggle('rule-entry')))
    for (const cleanup of rendered.cleanups) cleanup()
    logResponder = null
    expect(findUiToggle(rendered.tree, 'debug-info').props['aria-expanded']).toBe(true)
    expect(findUiToggle(rendered.tree, 'rule-entry').props['aria-expanded']).toBe(true)

    // 排查区里的「权限指纹」是**渲染后的可视化 + 「复制指纹」按钮**（原始串含 NUL，糊在界面上会被浏览器画成方框＝乱码）
    expect(fingerprintRowText(rendered.tree)).toBe('pwsh · pnpm test · sandbox_permissions=danger-full-access')
    const fingerprintValue = findNodes(rendered.tree, node => node?.props?.className === 'ap-fingerprintValue')[0]
    expect(fingerprintValue.props.title).toBe(key)
    // 2026-09-18 去重：「签名摘要」与「工具」两行删了（前者与「工具 + 命令」同义，后者并进指纹行本身）
    expect(fieldValue(rendered.tree, '签名摘要')).toBeUndefined()
    expect(fieldValue(rendered.tree, '工具')).toBeUndefined()
    // 指纹是机器串，排查区里按它的结构摊开剩下的两行（命令 / 额外参数），人才能管理名单
    expect(fieldValue(rendered.tree, '命令')).toBe('pnpm test')
    expect(fieldValue(rendered.tree, '额外参数')).toBe('sandbox_permissions=danger-full-access')
    // 表单里：指纹**没有**可编辑的值输入框（不许手改），而是一个「复制指纹」按钮 + 一行说明
    expect(findNodes(rendered.tree, node => node?.type === 'input'
      && node?.props?.['aria-label'] === '匹配值')).toHaveLength(0)
    expect(JSON.stringify(rendered.tree)).toContain('pwsh · pnpm test · sandbox_permissions=danger-full-access')
    expect(JSON.stringify(rendered.tree)).toContain('权限指纹由插件算出、不能手改')
    // 表单里的指纹值走「折行全显示」（用户 2026-09-18 从预览页选定）：值那一行的宽度必须是确定的
    // （ap-fieldFill）——.ap-field 是 fit-content 的 flex 行，长指纹在那里会溢出卡片右缘、把
    // 「复制指纹」整个挤出卡外（真机截图复现）；值自己占满一行再折（ap-fingerprintText）
    expect(findNodes(rendered.tree, node => node?.props?.className === 'ap-field ap-fieldFill').length)
      .toBeGreaterThan(0)
    const wrapValue = findNodes(rendered.tree, node => node?.props?.className === 'ap-fingerprintValue ap-fingerprintWrap')
    expect(wrapValue.length).toBeGreaterThan(0)
    expect(wrapValue[0].props.title).toBe(key)
    expect(findNodes(rendered.tree, node => node?.props?.className === 'ap-mono ap-fingerprintText').length)
      .toBeGreaterThan(0)
    // 排查区那一行故意保持单行截断：那儿只要一眼核对，不跟表单一起折行
    expect(findNodes(rendered.tree, node => node?.props?.className === 'ap-mono ap-fingerprintShort').length)
      .toBeGreaterThan(0)
  })

  it('展开详情先给决定依据：技术字段收在默认收起的「排查信息」里', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    logResponder = () => [{
      id: 'record-layered',
      time: '2026-09-18T09:00:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'pwsh',
      verdict: 'allow',
      outcome: 'allowed-once',
      decidedBy: 'auto',
      riskLevel: 'low',
      userAuthorization: 'high',
      reason: 'escalate sandbox to danger-full-access: 跑测试',
      rationale: '只读测试命令，提权只为让子进程能启动。',
      latencyMs: 1234,
      steps: 0,
      usage: { inputTokens: 212, outputTokens: 112, totalTokens: 1220 },
      route: { provider: 'p', model: 'm' },
      signature: { toolName: 'pwsh', key: FINGERPRINT_KEY, text: 'pwsh: pnpm test', command: 'pnpm test', paths: [] },
    }]
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN }, steps(expandRow()))
    for (const cleanup of rendered.cleanups) cleanup()
    logResponder = null

    // 明面第一眼是结论条（用户 2026-09-18 从预览页选定的「融合版」）：结论 + 风险/授权 chip
    const callouts = findNodes(rendered.tree, node => node?.props?.className === 'ap-callout')
    expect(callouts).toHaveLength(1)
    expect(callouts[0].props['data-tone']).toBe('ok')
    const dump = JSON.stringify(rendered.tree)
    expect(dump).toContain('自动批准 · 低风险')
    expect(findNodes(rendered.tree, node => node?.props?.className === 'ap-kvChip')
      .map(node => node.children?.[0])).toEqual(['风险 low', '授权 high'])
    // 结论条下面是「依据」分组：审查意见与申请原因各一行
    expect(dump).toContain('依据')
    expect(fieldValue(rendered.tree, '审批意见')).toBe('只读测试命令，提权只为让子进程能启动。')
    expect(fieldValue(rendered.tree, '审批原因')).toBe('escalate sandbox to danger-full-access: 跑测试')
    // 两个默认收起的入口并排右对齐，且都没展开
    expect(findUiToggle(rendered.tree, 'debug-info').props['aria-expanded']).toBe(false)
    expect(findUiToggle(rendered.tree, 'rule-entry').props['aria-expanded']).toBe(false)
    // 技术字段一个都不在明面上（这正是「乱」的来源）：指纹 / Token / 耗时 / Reviewer / 匹配值输入框
    expect(fieldValue(rendered.tree, '权限指纹')).toBeUndefined()
    expect(fieldValue(rendered.tree, 'Token 消耗')).toBeUndefined()
    expect(fieldValue(rendered.tree, 'Reviewer')).toBeUndefined()
    expect(dump).not.toContain('1234 ms')
    expect(JSON.stringify(findNodes(rendered.tree, node => node?.type === 'input'
      && node?.props?.['aria-label'] === '匹配值'))).toBe('[]')
  })

  it('「排查信息」分两组（这次动作 / 审查与用量），指纹行可复制、重复行已去', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    logResponder = () => [{
      id: 'record-debug-groups',
      time: '2026-09-18T10:00:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'bash',
      verdict: 'allow',
      outcome: 'allowed-once',
      decidedBy: 'auto',
      riskLevel: 'low',
      userAuthorization: 'high',
      rationale: '只读测试命令。',
      latencyMs: 900,
      signature: { toolName: 'bash', key: FINGERPRINT_KEY, text: 'bash: npm test', command: 'npm test', paths: [] },
      route: { provider: 'p', model: 'm' },
      suggestedRule: { tool: 'bash', match: { kind: 'command_prefix', value: 'npm test' }, label: '跑测试' },
      promotedRule: { id: 'rule-old', scope: 'global', list: 'allow', label: '老字段' },
    }]
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN },
      steps(expandRow(), openToggle('debug-info')))
    for (const cleanup of rendered.cleanups) cleanup()
    logResponder = null

    // 两组小标题（用户 2026-09-18 选定「分组 + 去重」）
    const body = findNodes(rendered.tree, node => node?.props?.className === 'ap-debugBody')[0]
    expect(findNodes(body, node => node?.props?.className === 'ap-debugGroupCaption')
      .map(node => node.children?.[0])).toEqual(['这次动作', '审查与用量'])
    // 去掉的四行：工具（并进指纹行本身）、签名摘要（与工具 + 命令同义）、已自动升级（恒空）、Reviewer 的「0 steps」
    expect(fieldValue(rendered.tree, '工具')).toBeUndefined()
    expect(fieldValue(rendered.tree, '签名摘要')).toBeUndefined()
    expect(fieldValue(rendered.tree, '已自动升级')).toBeUndefined()
    expect(fieldValue(rendered.tree, 'Reviewer')).toBeUndefined()
    // 审查模型只留路由（原先那行是「路由 · 会话 · 0 steps」）
    expect(fieldValue(rendered.tree, '审查模型')).toBe('p/m')
    // 指纹行能一键复制整串：排查时最常做的就是拿它去核对
    expect(findButton(rendered.tree, '复制指纹')).toBeDefined()
  })

  it('结论条：转人工 + 极高风险用警告色，人工侧结论与命中名单都收进 chip', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    logResponder = () => [{
      id: 'record-risk',
      time: '2026-09-18T09:30:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'pwsh',
      verdict: 'deny',
      outcome: 'rejected',
      decidedBy: 'human',
      riskLevel: 'critical',
      userAuthorization: 'low',
      reason: '清理构建产物：rm -rf dist && rm -rf D:/build-cache',
      rationale: '命令会删除工作区外的目录，且不可撤销。',
      rejectReason: '产物留着排查，先别动。',
      policy: { list: 'deny', scope: 'project', ruleId: 'rule-2', label: '删除构建产物', kind: 'signature' },
      signature: { toolName: 'pwsh', key: 'k2', text: 'pwsh: rm -rf dist', command: 'rm -rf dist', paths: [] },
    }]
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN }, steps(expandRow()))
    for (const cleanup of rendered.cleanups) cleanup()
    logResponder = null

    const callout = findNodes(rendered.tree, node => node?.props?.className === 'ap-callout')[0]
    expect(callout.props['data-tone']).toBe('warn')
    expect(JSON.stringify(callout)).toContain('转人工 · 极高风险')
    // chip 顺序：人工侧结论 → 风险 → 授权 → 命中名单（连续计数为 0 时不显示）
    expect(findNodes(callout, node => node?.props?.className === 'ap-kvChip').map(node => node.children?.[0]))
      .toEqual(['已拒绝', '风险 critical', '授权 low', '命中 本项目 · 删除构建产物'])
    // 你写的拒绝理由在「依据」里，用警示色与模型意见分开
    expect(fieldValue(rendered.tree, '人工拒绝理由')).toBe('产物留着排查，先别动。')

    // 没有 risk_level 的记录（命中黑名单直接转人工 / 审查失败的老记录）：结论条不能写成「转人工 · ?风险」
    logResponder = () => [{
      id: 'record-no-risk',
      time: '2026-09-18T09:40:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'bash',
      verdict: 'defer',
      outcome: 'rejected',
      decidedBy: 'human',
      rationale: '这条命令已列入黑名单。',
      policy: { list: 'deny', scope: 'project', ruleId: 'rule-2', label: 'bash · rm -rf', kind: 'signature' },
    }]
    const second = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN }, steps(expandRow()))
    for (const cleanup of second.cleanups) cleanup()
    logResponder = null
    const secondCallout = findNodes(second.tree, node => node?.props?.className === 'ap-callout')[0]
    expect(JSON.stringify(secondCallout)).toContain('转人工')
    expect(JSON.stringify(secondCallout)).not.toContain('?风险')
  })

  it('「复制指纹」复制的是完整原始串（含 NUL），不是在界面上选中那行渲染', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    const key = 'pwsh\u0000cmd:pnpm test\u0000x:{"sandbox_permissions":"danger-full-access"}'
    logResponder = () => [{
      id: 'record-copy',
      time: '2026-09-16T01:02:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'pwsh',
      verdict: 'deny',
      outcome: 'allowed-once',
      decidedBy: 'human',
      rationale: '这次先放行。',
      signature: { toolName: 'pwsh', key, text: 'pwsh: pnpm test', command: 'pnpm test', paths: [] },
    }]
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    // 「复制指纹」按钮在默认收起的「加入名单」表单里：展开记录 → 打开表单 → 点复制
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN },
      steps(expandRow(), openToggle('rule-entry'), clickButton('复制指纹')))
    for (const cleanup of rendered.cleanups) cleanup()
    logResponder = null

    // 整串写进剪贴板：NUL 分隔符一个不少（界面上的渲染文案是另一回事）
    expect(clipboardWrites).toEqual([key])
    expect(clipboardWrites[0]).toContain('\u0000cmd:pnpm test\u0000x:')
    expect(JSON.stringify(rendered.tree)).toContain('已复制完整指纹')
  })

  it('设置面板：指纹规则的值只读，列表与编辑行都给出摊开后的文案', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    moduleExports.apply(ctx)
    const view = slot(slotRegistrations, 'conversation.view', 'dsh-auto-pass')

    let listDump = ''
    let clicked = false
    const rendered = await renderStable(react, view.component, { sessionId: SESSION_KNOWN }, tree => {
      const row = findNodes(tree, node => node?.props?.className === 'ap-rule'
        && JSON.stringify(node).includes('bash · npm test'))[0]
      // 规则列表里直接显示摊开后的指纹（机器码含 NUL，人读不了）
      if (row !== undefined && listDump === '') listDump = JSON.stringify(tree)
      if (clicked || row === undefined) return
      const edit = findNodes(row, node => node?.type === 'button' && node.children?.[0] === '编辑')[0]
      if (edit === undefined) return
      clicked = true
      edit.props.onClick()
    })
    for (const cleanup of rendered.cleanups) cleanup()
    expect(clicked).toBe(true)
    expect(listDump).toContain('bash · npm test · sandbox_permissions=danger-full-access')

    // 指纹规则：值只读（可以选中复制），指纹按钮本身就是当前条件、不禁用；说明与紧凑文案都在
    // 指纹规则：编辑行里没有值输入框（不许手改），给的是渲染后的可视化 + 「复制指纹」
    expect(findNodes(rendered.tree, node => node?.type === 'input'
      && node?.props?.['aria-label'] === '匹配值')).toHaveLength(0)
    expect(findButton(rendered.tree, '复制指纹')).toBeDefined()
    const fingerprintButton = findNodes(rendered.tree, node => node?.type === 'button'
      && node?.props?.['data-kind'] === 'signature')[0]
    expect(fingerprintButton.props.disabled).toBeFalsy()
    const dump = JSON.stringify(rendered.tree)
    expect(dump).toContain('bash · npm test · sandbox_permissions=danger-full-access')
    expect(dump).toContain('权限指纹由插件算出、不能手改')
    // 编辑行里的指纹与时间线那块表单同一套控件：同样折行全显示（长串不再溢出编辑行）
    expect(findNodes(rendered.tree, node => node?.props?.className === 'ap-mono ap-fingerprintText').length)
      .toBeGreaterThan(0)
  })

  it('设置面板：命令前缀规则切不成「权限指纹」（没有指纹可填，按钮禁用且点了也不动）', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    moduleExports.apply(ctx)
    const view = slot(slotRegistrations, 'conversation.view', 'dsh-auto-pass')

    let editing = false
    let clicked = false
    let rerendered = false
    const rendered = await renderStable(react, view.component, { sessionId: SESSION_KNOWN }, tree => {
      if (editing === false) {
        const row = findNodes(tree, node => node?.props?.className === 'ap-rule'
          && JSON.stringify(node).includes('bash · rm -rf'))[0]
        if (row === undefined) return
        const edit = findNodes(row, node => node?.type === 'button' && node.children?.[0] === '编辑')[0]
        if (edit === undefined) return
        editing = true
        edit.props.onClick()
        return
      }
      if (clicked === false) {
        const fingerprintButton = findNodes(tree, node => node?.type === 'button'
          && node?.props?.['data-kind'] === 'signature')[0]
        if (fingerprintButton === undefined) return
        clicked = true
        // 按钮是禁用的；这里直接调 handler，等于绕过浏览器兜一层——守卫必须自己挡住
        fingerprintButton.props.onClick()
        return
      }
      rerendered = true
    })
    for (const cleanup of rendered.cleanups) cleanup()
    expect(editing).toBe(true)
    expect(clicked).toBe(true)
    expect(rerendered).toBe(true)

    const fingerprintButton = findNodes(rendered.tree, node => node?.type === 'button'
      && node?.props?.['data-kind'] === 'signature')[0]
    expect(fingerprintButton.props.disabled).toBe(true)
    // 条件仍是命令前缀，值也仍可改（它是手写的条件）
    const prefixButton = findNodes(rendered.tree, node => node?.type === 'button'
      && node?.props?.['data-kind'] === 'command_prefix')[0]
    expect(prefixButton.props['data-on']).toBe('1')
    const value = findNodes(rendered.tree, node => node?.type === 'input' && node?.props?.['aria-label'] === '匹配值')[0]
    expect(value.props.readOnly).toBeFalsy()
  })

  it('模型建议里的假签名不当默认值：回落到本次动作的权限指纹，与详情那一行一致', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    const key = 'pwsh\u0000cmd:pnpm vitest run\u0000x:{"sandbox_permissions":"danger-full-access"}'
    logResponder = () => [{
      id: 'record-fake-signature',
      time: '2026-09-16T01:05:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'pwsh',
      verdict: 'defer',
      outcome: 'allowed-once',
      decidedBy: 'human',
      rationale: '这次先放行。',
      signature: { toolName: 'pwsh', key, text: 'pwsh: pnpm vitest run', command: 'pnpm vitest run', paths: [] },
      // 真机里的样子（~/.dsh/dsh-auto-pass/records）：模型把「签名」写成了一句描述，一个动作都命不中
      suggestedRule: { tool: 'pwsh', match: { kind: 'signature', value: 'escalation=danger-full-access' }, label: '提权重试' },
    }]
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    // 展开记录 → 打开「排查信息」（比对详情那一行）→ 打开「加入名单」（比对表单草稿）
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN },
      steps(expandRow(), openToggle('debug-info'), openToggle('rule-entry')))
    for (const cleanup of rendered.cleanups) cleanup()
    logResponder = null
    expect(findUiToggle(rendered.tree, 'debug-info').props['aria-expanded']).toBe(true)
    expect(findUiToggle(rendered.tree, 'rule-entry').props['aria-expanded']).toBe(true)

    // 假签名不当默认值：条件仍是权限指纹，值回落到本次签名 key（点了才不会被宿主 400 not-covering 拒）
    const kind = findNodes(rendered.tree, node => node?.type === 'button' && node?.props?.['data-kind'] === 'signature')[0]
    expect(kind.props['data-on']).toBe('1')
    // 指纹没有输入框（不许手改），界面上是渲染后的文案；点「复制指纹」拿到的才是原始 key
    expect(findNodes(rendered.tree, node => node?.type === 'input'
      && node?.props?.['aria-label'] === '匹配值')).toHaveLength(0)
    expect(fingerprintRowText(rendered.tree)).toBe('pwsh · pnpm vitest run · sandbox_permissions=danger-full-access')
    // 那条建议仍如实展示在「模型建议规则」里，只是不再填空
    expect(JSON.stringify(rendered.tree)).toContain('escalation=danger-full-access')
    expect(JSON.stringify(rendered.tree)).toContain('默认是本次动作的权限指纹')
  })

  it('模型建议里的签名等于本次签名时，照旧当默认值', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    const key = 'pwsh\u0000cmd:pnpm test\u0000x:{}'
    logResponder = () => [{
      id: 'record-real-signature',
      time: '2026-09-16T01:10:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'pwsh',
      verdict: 'defer',
      outcome: 'allowed-once',
      decidedBy: 'human',
      rationale: '只读测试命令。',
      signature: { toolName: 'pwsh', key, text: 'pwsh: pnpm test', command: 'pnpm test', paths: [] },
      suggestedRule: { tool: 'pwsh', match: { kind: 'signature', value: key }, label: '只跑这条测试' },
    }]
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    // 展开记录 → 打开「加入名单」：表单默认收起（用户 2026-09-18）
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN },
      steps(expandRow(), openToggle('rule-entry')))
    for (const cleanup of rendered.cleanups) cleanup()
    logResponder = null
    expect(findUiToggle(rendered.tree, 'rule-entry').props['aria-expanded']).toBe(true)

    // 建议确实覆盖本次动作：照旧当默认值（连标签一起），提示语也仍是「来自模型建议」
    // 指纹条件的值不给手改，界面上显示的是渲染后的文案（原始串可由「复制指纹」复制）
    expect(JSON.stringify(rendered.tree)).toContain('pwsh · pnpm test')
    const label = findNodes(rendered.tree, node => node?.type === 'input' && node?.props?.['aria-label'] === '规则标签')[0]
    expect(label.props.value).toBe('只跑这条测试')
    expect(JSON.stringify(rendered.tree)).toContain('默认来自这次审查的模型建议')
  })

  it('快捷筛选：点亮「白名单」后只剩命中白名单的那条', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    // 只点一次：interact 每轮渲染都会被调用，不做标志会反复切换
    let clicked = false
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN }, tree => {
      if (clicked) return
      const chip = findChip(tree, 'allow')
      if (chip === undefined) return
      clicked = true
      chip.props.onClick()
    })
    expect(clicked).toBe(true)
    for (const cleanup of rendered.cleanups) cleanup()

    const rows = findRows(rendered.tree)
    expect(rows).toHaveLength(1)
    const dump = JSON.stringify(rendered.tree)
    expect(dump).toContain('bash · npm test')
    expect(dump).not.toContain('bash · rm -rf')
    // 选中态转移：「白名单」亮、「全部」灭
    expect(findChip(rendered.tree, 'allow').props['data-on']).toBe('1')
    expect(findChip(rendered.tree, 'all').props['data-on']).toBe('0')
  })

  it('快捷筛选：「自动」只筛模型自动放行，不含命中白名单的那条', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    let clicked = false
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN }, tree => {
      if (clicked) return
      const chip = findChip(tree, 'auto')
      if (chip === undefined) return
      clicked = true
      chip.props.onClick()
    })
    expect(clicked).toBe(true)
    for (const cleanup of rendered.cleanups) cleanup()

    expect(findRows(rendered.tree)).toHaveLength(1)
    const dump = JSON.stringify(rendered.tree)
    expect(dump).toContain('模型判定为只读操作')
    // 命中白名单那条 decidedBy 也是 auto，但命中名单的记录只算「白名单」，不再落进「自动」
    expect(dump).not.toContain('bash · npm test')
  })

  it('快捷筛选：多选叠加时显示并集（白名单 + 黑名单 = 两条）', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    // 两轮各点一个 chip：验证第二个是**叠加**而不是替换掉第一个
    let step = 0
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN }, tree => {
      const key = step === 0 ? 'allow' : step === 1 ? 'deny' : undefined
      if (key === undefined) return
      const chip = findChip(tree, key)
      if (chip === undefined) return
      step += 1
      chip.props.onClick()
    })
    expect(step).toBe(2)
    for (const cleanup of rendered.cleanups) cleanup()

    expect(findRows(rendered.tree)).toHaveLength(2)
    expect(findChip(rendered.tree, 'allow').props['data-on']).toBe('1')
    expect(findChip(rendered.tree, 'deny').props['data-on']).toBe('1')
    expect(findChip(rendered.tree, 'auto').props['data-on']).toBe('0')
  })

  it('快捷筛选：筛空时提示筛选条件，而不是「还没有审批记录」', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    // 只返回那条白名单记录：点「黑名单」必然筛空
    const originalFetch = globalThis.fetch
    globalThis.fetch = async url => String(url).includes('/log')
      ? { json: async () => ({ ok: true, records: [sampleRecords()[0]] }) }
      : originalFetch(url)
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    let clicked = false
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN }, tree => {
      if (clicked) return
      const chip = findChip(tree, 'deny')
      if (chip === undefined) return
      clicked = true
      chip.props.onClick()
    })
    expect(clicked).toBe(true)
    for (const cleanup of rendered.cleanups) cleanup()

    const dump = JSON.stringify(rendered.tree)
    expect(dump).toContain('没有符合筛选条件的记录')
    expect(dump).not.toContain('还没有审批记录')
    // 条数徽标不受筛选影响：黑名单仍是 0 条，说明「点了也不会有结果」
    expect(chipCount(rendered.tree, 'deny')).toBe('0')
  })
})

describe('升级/降级的查重文案', () => {
  /** 取出这一轮发给宿主的某个接口的请求体（按路径**精确**匹配，/rule 不会把 /rule/draft 也算进来）。 */
  function bodiesOf(path) {
    return globalThis.fetch.mock.calls
      .filter(args => typeof args[1]?.body === 'string' && String(args[0]).split('?')[0].endsWith(path))
      .map(args => JSON.parse(args[1].body))
  }

  it('「加入名单的规则」可以改：手填的匹配条件原样发给宿主', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    ruleResponder = () => ({ ok: true, optimizedBy: 'manual', rule: { label: '运行测试套件' } })
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    // 展开记录 → 打开「加入名单」→ 切到命令前缀（草稿默认是权限指纹，那档没有值输入框）→ 填值 → 点「以后直接放行」写入
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN },
      steps(expandRow(), openToggle('rule-entry'), clickKind('command_prefix'),
        fillInput('匹配值', 'npm test'), clickFormAction('以后直接放行')))
    for (const cleanup of rendered.cleanups) cleanup()

    const posts = bodiesOf('/rule')
    expect(posts).toHaveLength(1)
    expect(posts[0].rule).toEqual({
      tool: 'bash',
      match: { kind: 'command_prefix', value: 'npm test' },
      label: 'bash · npm test',
    })
    expect(JSON.stringify(rendered.tree)).toContain('已按你填写的条件加入')
    // 前缀类条件至少 3 个字符：填太短时按钮直接禁用，不会发出请求
    ruleResponder = null
  })

  it('切换匹配条件时：先按条件本地推导，再让模型按该条件重新生成（条件写进提示词）', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    const command = "pnpm vitest run tests/a.spec.js 2>&1 | Select-Object -Last 20"
    logResponder = () => [{
      id: 'record-cmd',
      time: '2026-09-15T09:00:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'pwsh',
      verdict: 'deny',
      outcome: 'allowed-once',
      decidedBy: 'human',
      rationale: '这次先放行。',
      signature: {
        toolName: 'pwsh',
        key: 'pwsh\u0000cmd:' + command + '\u0000x:{"sandbox_permissions":"danger-full-access"}',
        text: 'pwsh: ' + command,
        command,
        paths: [],
      },
    }]
    // 模型按用户选的条件重新生成：这里故意给一个与本地推导不同的值，验证最终生效的是模型结果
    draftResponder = () => ({
      ok: true,
      rule: { tool: 'pwsh', match: { kind: 'command_prefix', value: 'pnpm vitest run' }, label: '模型给的前缀' },
    })
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    // 展开记录 → 打开「加入名单」→ 切到命令前缀：切换会先本地推导，再请模型按该条件重新生成
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN },
      steps(expandRow(), openToggle('rule-entry'), clickKind('command_prefix')))
    for (const cleanup of rendered.cleanups) cleanup()
    logResponder = null

    // 请求里带着用户选的条件与「本地先推导出来的值」（模型据此改写，提示词由宿主补全）
    const drafts = bodiesOf('/rule/draft')
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      recordId: 'record-cmd',
      kind: 'command_prefix',
      draft: { kind: 'command_prefix', value: 'pnpm vitest run tests/a.spec.js' },
    })
    // 模型回来后就以模型为准
    const value = findNodes(rendered.tree, node => node?.type === 'input' && node?.props?.['aria-label'] === '匹配值')[0]
    expect(value.props.value).toBe('pnpm vitest run')
    const label = findNodes(rendered.tree, node => node?.type === 'input' && node?.props?.['aria-label'] === '规则标签')[0]
    expect(label.props.value).toBe('模型给的前缀')
    expect(JSON.stringify(rendered.tree)).toContain('已让模型按所选条件重新生成')
    draftResponder = null
  })

  it('模型没能重新生成时，保留本地按条件推导出来的值并如实提示', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    // 命令里带引号内的竖线（正则）：草稿按宿主的 firstPipeOutsideQuotes 口径只砍真管道与结尾重定向
    const command = "rg 'a|b' src 2>&1 | Select-Object -Last 12"
    logResponder = () => [{
      id: 'record-fail',
      time: '2026-09-15T09:05:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'pwsh',
      verdict: 'deny',
      outcome: 'allowed-once',
      decidedBy: 'human',
      rationale: '只读命令。',
      signature: { toolName: 'pwsh', key: 'k', text: 'pwsh: ' + command, command, paths: [] },
    }]
    // 宿主回 503（例如没有可用路由）：客户端必须保留本地值，不能把输入框清空
    draftResponder = () => ({ ok: false, error: 'rule regeneration unavailable' })
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    // 展开记录 → 打开「加入名单」→ 切到命令前缀（宿主回 503，模型这次生成不了）
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN },
      steps(expandRow(), openToggle('rule-entry'), clickKind('command_prefix')))
    for (const cleanup of rendered.cleanups) cleanup()
    logResponder = null
    draftResponder = null

    const value = findNodes(rendered.tree, node => node?.type === 'input' && node?.props?.['aria-label'] === '匹配值')[0]
    expect(value.props.value).toBe("rg 'a|b' src")
    expect(JSON.stringify(rendered.tree)).toContain('模型这次没能生成')
  })

  it('路径前缀：提示单层通配口径；写 ** 时按钮禁用并说明原因', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    // 展开记录 → 打开「加入名单」→ 切到路径前缀（草稿默认是权限指纹，那档没有值输入框）→ 填一个 ** 进去
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN },
      steps(expandRow(), openToggle('rule-entry'), clickKind('path_prefix'),
        fillInput('匹配值', 'D:/repo/**/*.js')))
    for (const cleanup of rendered.cleanups) cleanup()

    const dump = JSON.stringify(rendered.tree)
    // 口径说明 + 拒绝原因都在，且写按钮被禁用（** 不会发出去）
    expect(dump).toContain('路径前缀支持单层通配')
    expect(dump).toContain('不支持 **')
    // 写入按钮（「以后直接放行」）在草稿非法时禁用；作用域按钮只是切换、不该被禁用
    expect(findButton(rendered.tree, '以后直接放行').props.disabled).toBe(true)
    expect(findNodes(rendered.tree, node => node?.props?.['data-scope'] === 'project')[0].props.disabled)
      .toBeFalsy()
  })

  it('这次动作没有文件路径时，路径前缀按钮禁用并说明原因（免得生成命不中的规则）', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    // 一条带命令、但没有文件路径的记录（新记录一定带 paths 字段，这里是空数组）
    logResponder = () => [{
      id: 'record-cmd-only',
      time: '2026-09-15T09:30:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'pwsh',
      verdict: 'deny',
      outcome: 'allowed-once',
      decidedBy: 'human',
      rationale: '跑测试。',
      signature: { toolName: 'pwsh', key: 'k', text: 'pwsh: pnpm test', command: 'pnpm test', paths: [] },
    }]
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    // 展开记录 → 打开「加入名单」：两个条件按钮的可用性要在表单里看
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN },
      steps(expandRow(), openToggle('rule-entry')))
    for (const cleanup of rendered.cleanups) cleanup()
    logResponder = null
    expect(findUiToggle(rendered.tree, 'rule-entry').props['aria-expanded']).toBe(true)

    const pathButton = findNodes(rendered.tree,
      node => node?.type === 'button' && node?.props?.['data-kind'] === 'path_prefix')[0]
    const commandButton = findNodes(rendered.tree,
      node => node?.type === 'button' && node?.props?.['data-kind'] === 'command_prefix')[0]
    expect(pathButton.props.disabled).toBe(true)
    expect(commandButton.props.disabled).toBeFalsy()
    expect(JSON.stringify(rendered.tree)).toContain('路径前缀匹配不到这次动作')
  })

  it('命令前缀里写 * 会提示它是字面量（不会像 shell 那样展开）', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    const command = 'pnpm vitest run tests/policy.spec.js'
    logResponder = () => [{
      id: 'record-star',
      time: '2026-09-15T09:40:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'pwsh',
      verdict: 'deny',
      outcome: 'allowed-once',
      decidedBy: 'human',
      rationale: '跑单测。',
      signature: { toolName: 'pwsh', key: 'k', text: 'pwsh: ' + command, command, paths: [] },
    }]
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    // 展开记录 → 打开「加入名单」→ 切到命令前缀 → 前缀里写一个 *
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN },
      steps(expandRow(), openToggle('rule-entry'), clickKind('command_prefix'),
        fillInput('匹配值', 'pnpm vitest run tests/*')))
    for (const cleanup of rendered.cleanups) cleanup()
    logResponder = null
    expect(JSON.stringify(rendered.tree)).toContain('命令前缀里的 * 是字面量')
  })

  it('设置面板里能编辑已有规则，保存时按 id 发 op=update', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    // 改宽之后宿主把被它盖住的窄规则合并掉了：面板要把这件事说出来（名单为什么少了一条）
    policyResponder = () => ({ ok: true, replaced: false, merged: 1, dropped: ['运行 policy.spec.js 单测'] })
    moduleExports.apply(ctx)
    const view = slot(slotRegistrations, 'conversation.view', 'dsh-auto-pass')

    let editing = false
    let renamed = false
    let saved = false
    const rendered = await renderStable(react, view.component, { sessionId: SESSION_KNOWN }, tree => {
      if (editing === false) {
        const button = findNodes(tree, node => node?.type === 'button' && node.children?.[0] === '编辑')[0]
        if (button === undefined) return
        editing = true
        button.props.onClick()
        return
      }
      if (renamed === false) {
        const label = findNodes(tree, node => node?.type === 'input' && node?.props?.['aria-label'] === '规则标签')[0]
        if (label === undefined) return
        renamed = true
        label.props.onChange({ target: { value: '改过的标签' } })
        return
      }
      if (saved) return
      const save = findNodes(tree, node => node?.type === 'button' && node.children?.[0] === '保存修改')[0]
      if (save === undefined) return
      saved = true
      save.props.onClick()
    })
    for (const cleanup of rendered.cleanups) cleanup()
    expect(saved).toBe(true)

    const posts = bodiesOf('/policy')
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({
      op: 'update',
      scope: 'global',
      list: 'allow',
      id: 'rule-1',
      rule: { tool: 'bash', match: { kind: 'signature', value: FINGERPRINT_KEY }, label: '改过的标签' },
    })
    // 顺带告知被顶掉的窄规则（按名字）：名单变少时用户一眼知道是哪条
    expect(JSON.stringify(rendered.tree)).toContain('已合并 1 条被它覆盖的窄规则：运行 policy.spec.js 单测')
    policyResponder = null
  })

  it('「加入名单」表单：三行带可见标签、作用域选一次、两个动作按钮', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    logResponder = () => [{
      id: 'record-form',
      time: '2026-09-18T10:10:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'bash',
      verdict: 'defer',
      outcome: 'allowed-once',
      decidedBy: 'human',
      rationale: '先运行测试。',
      signature: { toolName: 'bash', key: FINGERPRINT_KEY, text: 'bash: npm test', command: 'npm test', paths: [] },
    }]
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN },
      steps(expandRow(), openToggle('rule-entry')))
    for (const cleanup of rendered.cleanups) cleanup()
    logResponder = null

    const form = findNodes(rendered.tree, node => node?.props?.className === 'ap-actions')[0]
    expect(form).toBeDefined()
    // 三行编辑各带**可见标签**（用户 2026-09-18 选定；原先两个输入框只有 aria-label，界面上看不出哪栏是什么）
    // 匹配值那一行在指纹形态下多一个 ap-fieldFill（宽度确定，长指纹才折得对，见下一条用例）
    expect(findNodes(form, node => node?.props?.className === 'ap-field'
      || node?.props?.className === 'ap-field ap-fieldFill')
      .map(row => row.children?.[0]?.children?.[0])).toEqual(['匹配条件', '匹配值', '规则标签'])
    // 作用域只选一次（data-scope），两个动作按钮共用它
    expect(findNodes(form, node => node?.props?.['data-scope'] !== undefined)
      .map(node => node.props['data-scope'])).toEqual(['project', 'global'])
    expect(findButton(form, '以后直接放行')).toBeDefined()
    expect(findButton(form, '以后直接转人工')).toBeDefined()
    // 旧的 4 个作用域按钮与「升级 / 降级」措辞不再出现
    expect(findButton(rendered.tree, '升级为白名单')).toBeUndefined()
    expect(findButton(rendered.tree, '降级为黑名单')).toBeUndefined()
  })

  /**
   * 渲染时间线 → 展开第一条记录 → 打开「加入名单」入口 → 点一次「以后直接放行」，
   * 返回稳定后的元素树。宿主 /rule 的回执由用例给定，用来验证三种查重结果各自的文案。
   * 表单自 2026-09-18 起默认收起，所以这里比过去多一步「点开入口」。
   * @param react 假 react
   * @param pane 时间线面板注册项
   * @param reply 宿主 /rule 的回执（ok 由这里补）
   * @returns {Promise<object>} 稳定后的元素树
   */
  async function promoteOnce(react, pane, reply) {
    ruleResponder = () => ({ ok: true, ...reply })
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN },
      steps(expandRow(), openToggle('rule-entry'), clickFormAction('以后直接放行')))
    for (const cleanup of rendered.cleanups) cleanup()
    return rendered.tree
  }

  it('详情里列出被顶掉的规则，并能一键撤销这次加入', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    let reverted = false
    logResponder = () => [{
      id: 'record-undo',
      time: '2026-09-16T02:00:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'pwsh',
      verdict: 'defer',
      outcome: 'allowed-once',
      decidedBy: 'human',
      rationale: '这次先放行。',
      signature: { toolName: 'pwsh', key: 'k', text: 'pwsh: pnpm test', command: 'pnpm test', paths: [] },
      // 这次加入顶掉了一条更窄的旧规则（命令前缀把那条精确签名的规则盖住了）——记录里带着它的快照
      ruleApplied: {
        scope: 'project',
        list: 'allow',
        ruleId: 'rule-new',
        label: '跑测试',
        optimizedBy: 'signature',
        match: { kind: 'command_prefix', value: 'pnpm test' },
        mergedRules: [{ id: 'rule-old', label: '只跑这一条', match: { kind: 'signature', value: 'k' } }],
      },
      ...(reverted ? { ruleReverted: { at: '2026-09-16T02:01:00.000Z', restored: ['只跑这一条'] } } : {}),
    }]
    // 撤销成功后记录里就带上 ruleReverted（宿主写回），界面据此不再显示按钮
    revertResponder = () => {
      reverted = true
      return { ok: true, restored: ['只跑这一条'] }
    }
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    let expanded = false
    let undone = false
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN }, tree => {
      if (expanded === false) {
        const head = findNodes(tree, node => node?.props?.className === 'ap-rowHead')[0]
        if (head === undefined) return
        expanded = true
        head.props.onClick()
        return
      }
      if (undone) return
      const button = findButton(tree, '撤销这次加入')
      if (button === undefined) return
      undone = true
      button.props.onClick()
    })
    for (const cleanup of rendered.cleanups) cleanup()
    logResponder = null
    revertResponder = null
    expect(undone).toBe(true)

    // 撤销只报 recordId：凭据只认记录里那一份，浏览器不指定要恢复什么
    expect(bodiesOf('/rule/revert')).toEqual([{ recordId: 'record-undo' }])
    const dump = JSON.stringify(rendered.tree)
    expect(dump).toContain('本次加入的规则')
    expect(dump).toContain('只跑这一条')
    expect(dump).toContain('已撤销，名单已还原')
  })

  it('「已有规则覆盖这次动作」没有写入任何条目：详情里说清楚，也不给撤销按钮', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    logResponder = () => [{
      id: 'record-covered',
      time: '2026-09-16T02:05:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'pwsh',
      verdict: 'defer',
      outcome: 'allowed-once',
      decidedBy: 'human',
      rationale: '这次先放行。',
      signature: { toolName: 'pwsh', key: 'k', text: 'pwsh: pnpm test', command: 'pnpm test', paths: [] },
      // 覆盖命中：ruleId 指的是那条**已有**的规则，所以不给撤销入口
      ruleApplied: { scope: 'project', list: 'allow', ruleId: 'rule-existing', label: '跑测试', covered: true },
    }]
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    let expanded = false
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN }, tree => {
      if (expanded) return
      const head = findNodes(tree, node => node?.props?.className === 'ap-rowHead')[0]
      if (head === undefined) return
      expanded = true
      head.props.onClick()
    })
    for (const cleanup of rendered.cleanups) cleanup()
    logResponder = null
    expect(expanded).toBe(true)
    const dump = JSON.stringify(rendered.tree)
    expect(dump).toContain('已有规则已覆盖这个动作，未重复添加')
    expect(findButton(rendered.tree, '撤销这次加入')).toBeUndefined()
  })

  it('达阈值自动写入的记录：折叠行标出「+白名单」，详情里说明未询问，撤销入口照旧给', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    logResponder = () => [{
      id: 'record-auto',
      time: '2026-09-16T18:00:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'pwsh',
      verdict: 'allow',
      outcome: 'allow',
      decidedBy: 'auto',
      rationale: '连续放行达阈值。',
      signature: { toolName: 'pwsh', key: 'k', text: 'pwsh: pnpm test', command: 'pnpm test', paths: [] },
      // 达阈值自动写入（没问过用户）：记录里带 auto 标记与撤销凭据；条件是审查那次的模型建议
      ruleApplied: {
        scope: 'project',
        list: 'allow',
        ruleId: 'rule-auto',
        label: '跑测试',
        auto: true,
        optimizedBy: 'record',
        match: { kind: 'command_prefix', value: 'pnpm test' },
      },
    }]
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    let expanded = false
    let collapsed = ''
    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN }, tree => {
      if (expanded) return
      const head = findNodes(tree, node => node?.props?.className === 'ap-rowHead')[0]
      if (head === undefined) return
      expanded = true
      // 展开**之前**先留一份折叠态：这条记录不展开就该看到「已自动加入白名单」标识
      collapsed = JSON.stringify(tree)
      head.props.onClick()
    })
    for (const cleanup of rendered.cleanups) cleanup()
    logResponder = null
    // 折叠行第一行就给短标识 +白名单（2026-09-18 行头压到两行后由长句改短句），
    // 条件来源（模型建议）与作用域 + 标签一起挂在 tooltip 上
    expect(collapsed).toContain('+白名单')
    const badge = findAutoBadge(rendered.tree)
    expect(badge.props.title).toBe('连续放行达阈值后自动写入白名单，未询问；条件来自审查模型的建议：本项目 · 跑测试')
    const dump = JSON.stringify(rendered.tree)
    // 「没问过你」这件事必须在界面上说清楚，免得看起来像自己加的；撤销入口照旧给
    expect(dump).toContain('连续放行达阈值，自动加入，未询问；条件来自审查模型的建议')
    expect(findButton(rendered.tree, '撤销这次加入')).toBeDefined()
  })

  it('折叠行标出「+白名单」标识；条件来源（模型建议 / 权限指纹 / 没有来源字段的老记录）在 tooltip 里', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    /**
     * 一条「达阈值自动写入」的记录：条件来源（by）与「其实没写条目」（covered）由用例决定。
     * @param {string} id 记录 id（同时用来拼它写进去的规则 id）
     * @param {string} [by] 条件来源：record = 审查模型的建议，signature = 本次动作的权限指纹
     * @param {boolean} [covered] 是否命中「已有规则已覆盖」那条路
     * @returns {object} 审批记录
     */
    const autoRecord = (id, by, covered) => ({
      id,
      time: '2026-09-18T10:00:00.000Z',
      sessionId: SESSION_KNOWN,
      toolName: 'pwsh',
      verdict: 'allow',
      outcome: 'allow',
      decidedBy: 'auto',
      rationale: '连续放行达阈值。',
      signature: { toolName: 'pwsh', key: 'k', text: 'pwsh: pnpm test', command: 'pnpm test', paths: [] },
      ruleApplied: {
        scope: 'project',
        list: 'allow',
        ruleId: 'rule-' + id,
        label: '跑测试',
        auto: true,
        ...(by === undefined ? {} : { optimizedBy: by }),
        ...(covered === true ? { covered: true } : {}),
      },
    })
    logResponder = () => [
      autoRecord('by-model', 'record'),
      autoRecord('by-fingerprint', 'signature'),
      // 加来源字段之前写下的记录：只认 auto 标记，不许瞎标来源
      autoRecord('by-old'),
      // 已有规则覆盖这次动作：一条都没写进去，标识必须说清楚
      autoRecord('by-covered', 'record', true),
    ]
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    const rendered = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN })
    for (const cleanup of rendered.cleanups) cleanup()
    // 注意：logResponder 要留到本用例最后再清 —— 下面还要用同一批记录再渲染一次
    const badges = findNodes(rendered.tree, node => {
      const className = node?.props?.className
      if (typeof className !== 'string' || className.split(' ').includes('ap-badge') !== true) return false
      const label = node.children?.[0]
      return typeof label === 'string' && (label === '+白名单' || label === '+黑名单' || label.endsWith('已覆盖'))
    })
    // 四条记录的折叠行标识：短标记统一是 `+白名单`；覆盖命中那次改口径写明「已覆盖」
    // ——条件来源（模型建议 / 权限指纹）不再挤在标识文字里，改由 tooltip 承载（下面逐条断言）
    expect(badges.map(node => node.children[0])).toEqual([
      '+白名单',
      '+白名单',
      '+白名单',
      '白名单已覆盖',
    ])
    // 覆盖命中那次没新增条目：不能用「已自动加入」的措辞，也不该是提示色
    expect(badges[3].props.className).toContain('ap-badgeMuted')
    expect(badges[0].props.title).toBe('连续放行达阈值后自动写入白名单，未询问；条件来自审查模型的建议：本项目 · 跑测试')
    expect(badges[1].props.title).toContain('条件是本次动作的权限指纹')
    expect(badges[2].props.title).not.toContain('条件是')
    // 覆盖命中的 tooltip 不能照抄「已写入」的说法
    expect(badges[3].props.title).toBe('连续放行达阈值触发了自动写入，但已有规则已覆盖这次动作、未新增条目：本项目 · 跑测试')

    // 覆盖命中那条展开后只说一句「达阈值但已有规则覆盖、未新增」：不能出现「未重复添加」
    // 紧接着「自动加入」这种自相矛盾的读法，也不该给撤销入口（那条规则是别人的）
    let expanded = false
    const opened = await renderStable(react, pane.component, { sessionId: SESSION_KNOWN }, tree => {
      if (expanded) return
      const heads = findNodes(tree, node => node?.props?.className === 'ap-rowHead')
      if (heads.length < 4) return
      expanded = true
      heads[3].props.onClick()
    })
    for (const cleanup of opened.cleanups) cleanup()
    logResponder = null
    const detail = JSON.stringify(opened.tree)
    expect(detail).toContain('（连续放行达阈值，但已有规则覆盖这次动作，未新增条目）')
    expect(detail).not.toContain('未重复添加')
    expect(findButton(opened.tree, '撤销这次加入')).toBeUndefined()
  })

  it('分别提示「已更新同名规则 / 已被已有规则覆盖 / 已合并窄规则」', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    moduleExports.apply(ctx)
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')

    // 同一「工具 + 匹配条件」已存在：这次是更新那条规则
    const updated = JSON.stringify(await promoteOnce(react, pane, {
      optimizedBy: 'model', replaced: true, covered: false, merged: 0, rule: { label: '跑测试' },
    }))
    expect(updated).toContain('已加入（模型优化）')
    expect(updated).toContain('（已更新同名规则）')
    expect(updated).toContain('：跑测试')

    // 已有规则完整覆盖这次动作：没写新条目，如实说明
    const coveredTree = JSON.stringify(await promoteOnce(react, pane, {
      optimizedBy: 'record', replaced: false, covered: true, merged: 0, rule: { label: '跑测试（前缀）' },
    }))
    expect(coveredTree).toContain('（已有规则已覆盖这个动作，未重复添加）')
    expect(coveredTree).toContain('跑测试（前缀）')
    expect(coveredTree).not.toContain('（已更新同名规则）')

    // 新规则顺带合并掉了更窄的旧规则：告诉用户名单为什么少了一条
    const mergedTree = JSON.stringify(await promoteOnce(react, pane, {
      optimizedBy: 'signature', replaced: false, covered: false, merged: 2, rule: { label: '跑测试（权限指纹）' },
    }))
    expect(mergedTree).toContain('已加入（没有可用的模型建议，已回落到本次动作的权限指纹）')
    expect(mergedTree).toContain('（已合并 2 条被它覆盖的窄规则）')
    ruleResponder = null
  })
})

describe('审批触发后自动打开右侧栏时间线', () => {
  /** 与客户端半的 POLL_MS 对齐：观察器每 3 秒看一次当前会话的最新记录。 */
  const POLL = 3_000
  /** 夹具时间戳：staleAt = 10 分钟前（历史记录）；freshAt = 刚发生（2026-09-20 起按新鲜度判）。 */
  const staleAt = () => new Date(Date.now() - 10 * 60_000).toISOString()
  const freshAt = () => new Date().toISOString()

  it('历史记录只记基线；刚发生的审批才自动展开；已显示或停在其他工具上都不抢焦点', async () => {
    vi.useFakeTimers()
    waitTick = () => vi.advanceTimersByTimeAsync(0)
    try {
      const registration = await loadClient()
      const react = fakeReact()
      const moduleExports = registration.factory(specifier => {
        if (specifier === 'react') return react
        throw new Error('unexpected require: ' + specifier)
      })
      const { ctx, slotRegistrations, openTabs, sidebar } = harness()
      /** 当前 /log 的返回：观察器只看当前会话那条记录的 id 与时间。 */
      let records = [{ id: 'record-history', sessionId: SESSION_KNOWN, time: staleAt() }]
      logResponder = () => records
      moduleExports.apply(ctx)
      /** 跑一轮定时器 + 排空微任务队列：观察器是 async 的（fetch → json → …），不等它走完就会误判。 */
      const tick = async (ms) => {
        await vi.advanceTimersByTimeAsync(ms)
        for (let index = 0; index < 12; index += 1) await Promise.resolve()
      }

      // 第一次观测：会话里那批是历史记录（页面刚刷新，10 分钟前）——只记基线，不该把时间线弹开
      await tick(POLL)
      expect(openTabs).toEqual([])

      // 刚发生了一次审批（最新记录的 id 变了、时间就在当下）+ 右侧栏收起着 → 自动展开
      // （真实 openTab 会把侧栏展开，替身照做，后面的用例才和真机同一形态）
      records = [{ id: 'record-fresh', sessionId: SESSION_KNOWN, time: freshAt() }, ...records]
      await tick(POLL)
      expect(openTabs).toEqual(['dsh-auto-pass-log'])
      expect(sidebar.expanded).toBe(true)

      // 时间线已经显示在眼前（面板挂载 + tab 可见）：再来一次审批也不抢焦点
      const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')
      const rendered = await renderStable(react, pane.component, {
        sessionId: SESSION_KNOWN,
        useTabInfo: () => ({ tab: { visible: true } }),
      })
      records = [{ id: 'record-newer', sessionId: SESSION_KNOWN, time: freshAt() }, ...records]
      await tick(POLL)
      expect(openTabs).toEqual(['dsh-auto-pass-log'])

      // 用户切到别的侧边工具（时间线面板卸载，但侧栏整体仍然展开着）：新审批绝不把他切回来
      // —— 这正是 2026-09-18 修掉的「主动聚焦」（宿主 openTab 会 focusTab 回时间线）
      for (const cleanup of rendered.cleanups) cleanup()
      records = [{ id: 'record-switched', sessionId: SESSION_KNOWN, time: freshAt() }, ...records]
      await tick(POLL)
      expect(openTabs).toEqual(['dsh-auto-pass-log'])

      // 用户自己把侧栏整栏收起（没在用侧栏）→ 下一次审批重新自动展开
      sidebar.expanded = false
      records = [{ id: 'record-latest', sessionId: SESSION_KNOWN, time: freshAt() }, ...records]
      await tick(POLL)
      expect(openTabs).toEqual(['dsh-auto-pass-log', 'dsh-auto-pass-log'])
    } finally {
      logResponder = null
      waitTick = defaultWaitTick
      vi.useRealTimers()
    }
  })

  it('老宿主没有 isExpanded 时保持旧行为：时间线没显示就展开', async () => {
    vi.useFakeTimers()
    waitTick = () => vi.advanceTimersByTimeAsync(0)
    try {
      const registration = await loadClient()
      const react = fakeReact()
      const moduleExports = registration.factory(specifier => {
        if (specifier === 'react') return react
        throw new Error('unexpected require: ' + specifier)
      })
      const { ctx, openTabs, sidebar } = harness({ legacySidebar: true })
      let records = [{ id: 'record-history', sessionId: SESSION_KNOWN, time: staleAt() }]
      logResponder = () => records
      moduleExports.apply(ctx)
      const tick = async (ms) => {
        await vi.advanceTimersByTimeAsync(ms)
        for (let index = 0; index < 12; index += 1) await Promise.resolve()
      }

      await tick(POLL)
      expect(openTabs).toEqual([])
      records = [{ id: 'record-fresh', sessionId: SESSION_KNOWN, time: freshAt() }, ...records]
      await tick(POLL)
      expect(openTabs).toEqual(['dsh-auto-pass-log'])
      // 侧栏展开、时间线面板已卸载：拿不到状态就照旧尽力打开
      sidebar.expanded = true
      records = [{ id: 'record-switched', sessionId: SESSION_KNOWN, time: freshAt() }, ...records]
      await tick(POLL)
      expect(openTabs).toEqual(['dsh-auto-pass-log', 'dsh-auto-pass-log'])
    } finally {
      logResponder = null
      waitTick = defaultWaitTick
      vi.useRealTimers()
    }
  })

  it('这个开关按工作区取值：本工作区单独关掉后，即使全局开着也不自动展开', async () => {
    vi.useFakeTimers()
    waitTick = () => vi.advanceTimersByTimeAsync(0)
    try {
      const registration = await loadClient()
      const react = fakeReact()
      const moduleExports = registration.factory(specifier => {
        if (specifier === 'react') return react
        throw new Error('unexpected require: ' + specifier)
      })
      const { ctx, openTabs, sidebar } = harness()
      // 该项目在策略文件里存过 prefs.autoOpenTimeline=false（全局那份仍是 true）
      workspaceAutoOpen = { [WORKSPACE_CWD]: false }
      let records = [{ id: 'record-history', sessionId: SESSION_KNOWN, time: staleAt() }]
      logResponder = () => records
      moduleExports.apply(ctx)
      const tick = async (ms) => {
        await vi.advanceTimersByTimeAsync(ms)
        for (let index = 0; index < 12; index += 1) await Promise.resolve()
      }

      // 观察器读的是**带 cwd** 的那一份（不是全局那份）
      await tick(POLL)
      expect(configRequests.some(item => item.method === 'GET' && item.cwd === WORKSPACE_CWD)).toBe(true)
      expect(sidebar.expanded).toBe(false)
      // 新审批来了：全局开着、本工作区关着 → 不动用户的侧栏
      records = [{ id: 'record-fresh', sessionId: SESSION_KNOWN, time: freshAt() }, ...records]
      await tick(POLL)
      expect(openTabs).toEqual([])
    } finally {
      logResponder = null
      waitTick = defaultWaitTick
      vi.useRealTimers()
    }
  })

  it('首次看到的记录只要是「刚发生」的，照样展开（按新鲜度判，不看是不是第一次看到这个会话）', async () => {
    vi.useFakeTimers()
    waitTick = () => vi.advanceTimersByTimeAsync(0)
    try {
      const registration = await loadClient()
      const react = fakeReact()
      const moduleExports = registration.factory(specifier => {
        if (specifier === 'react') return react
        throw new Error('unexpected require: ' + specifier)
      })
      const { ctx, openTabs } = harness()
      // 刚切到（或刚刷新到）这个会话，而最新那条审批是几秒前发生的
      logResponder = () => [{ id: 'record-just-now', sessionId: SESSION_KNOWN, time: freshAt() }]
      moduleExports.apply(ctx)
      const tick = async (ms) => {
        await vi.advanceTimersByTimeAsync(ms)
        for (let index = 0; index < 12; index += 1) await Promise.resolve()
      }
      await tick(POLL)
      expect(openTabs).toEqual(['dsh-auto-pass-log'])
    } finally {
      logResponder = null
      waitTick = defaultWaitTick
      vi.useRealTimers()
    }
  })

  it('不新鲜的记录一律不弹：这个会话之前看过也一样（只有「刚发生」才展开）', async () => {
    vi.useFakeTimers()
    waitTick = () => vi.advanceTimersByTimeAsync(0)
    try {
      const registration = await loadClient()
      const react = fakeReact()
      const moduleExports = registration.factory(specifier => {
        if (specifier === 'react') return react
        throw new Error('unexpected require: ' + specifier)
      })
      const { ctx, openTabs } = harness()
      let records = [{ id: 'record-history', sessionId: SESSION_KNOWN, time: staleAt() }]
      logResponder = () => records
      moduleExports.apply(ctx)
      const tick = async (ms) => {
        await vi.advanceTimersByTimeAsync(ms)
        for (let index = 0; index < 12; index += 1) await Promise.resolve()
      }
      await tick(POLL)
      expect(openTabs).toEqual([])
      // 记录换了（例如页面被挂起很久、回来才补看到），但它已经不新鲜 → 依然不弹
      records = [{ id: 'record-stale-2', sessionId: SESSION_KNOWN, time: staleAt() }, ...records]
      await tick(POLL)
      expect(openTabs).toEqual([])
    } finally {
      logResponder = null
      waitTick = defaultWaitTick
      vi.useRealTimers()
    }
  })

  it('未读角标：别的会话的新审批也计数，时间线一显示在眼前就清零', async () => {
    vi.useFakeTimers()
    waitTick = () => vi.advanceTimersByTimeAsync(0)
    try {
      const registration = await loadClient()
      const react = fakeReact()
      const moduleExports = registration.factory(specifier => {
        if (specifier === 'react') return react
        throw new Error('unexpected require: ' + specifier)
      })
      const { ctx, slotRegistrations } = harness()
      let records = [{ id: 'history-1', sessionId: SESSION_KNOWN, time: staleAt() }]
      logResponder = () => records
      moduleExports.apply(ctx)
      const tick = async (ms) => {
        await vi.advanceTimersByTimeAsync(ms)
        for (let index = 0; index < 12; index += 1) await Promise.resolve()
      }
      const title = slot(slotRegistrations, 'sidebar.right.pane.tab.title', 'dsh-auto-pass')
      /** 标题席位里现在渲染出来的角标节点（没有就是空数组）。 */
      const badges = async () => findNodes((await renderStable(react, title.component, {})).tree,
        node => node?.props?.className === 'ap-tabBadge')

      // 第一次观测：刷新页面时堆着的历史记录不算未读
      await tick(POLL)
      expect(await badges()).toEqual([])

      // 别的会话来了两条新审批：自动展开按口径不动（不是当前会话），角标照旧提示
      records = [
        { id: 'other-1', sessionId: 'session-other', time: freshAt() },
        { id: 'other-2', sessionId: 'session-other', time: freshAt() },
        ...records,
      ]
      await tick(POLL)
      const shown = await badges()
      expect(shown.length).toBe(1)
      expect(shown[0].children[0]).toBe('2')

      // 时间线显示在眼前 = 你已经看过了 → 清零
      const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')
      const rendered = await renderStable(react, pane.component, {
        sessionId: SESSION_KNOWN,
        useTabInfo: () => ({ tab: { visible: true } }),
      })
      await tick(0)
      expect(await badges()).toEqual([])
      for (const cleanup of rendered.cleanups) cleanup()
    } finally {
      logResponder = null
      waitTick = defaultWaitTick
      vi.useRealTimers()
    }
  })
})

describe('「自动打开审批时间线」按工作区区分（2026-09-18 用户要求）', () => {
  it('面板读写的是本工作区（带 cwd），设置页卡片读写的是全局默认（不带 cwd）', async () => {
    const registration = await loadClient()
    const react = fakeReact()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    moduleExports.apply(ctx)

    // 「审批设置」面板：知道当前工作区 → 读数带 ?cwd=，写数带 cwd（落进该项目的策略文件）
    const view = slot(slotRegistrations, 'conversation.view', 'dsh-auto-pass')
    const panel = await renderStable(react, view.component, { sessionId: SESSION_KNOWN }, steps(toggleSwitch(2, false)))
    for (const cleanup of panel.cleanups) cleanup()
    expect(configRequests.some(item => item.method === 'GET' && item.cwd === WORKSPACE_CWD)).toBe(true)
    const scopedWrite = configRequests.filter(item => item.method === 'POST').pop()
    expect(scopedWrite.cwd).toBe(WORKSPACE_CWD)
    expect(scopedWrite.body).toEqual({ autoOpenTimeline: false, cwd: WORKSPACE_CWD })
    // 面板里那句说明是「本工作区」版（设置页那份是所有工作区的默认值）
    expect(JSON.stringify(panel.tree)).toContain('本工作区：有刚发生的审批且右侧栏整栏收起时自动展开时间线')

    // 设置页卡片：没有工作区上下文 → 读写全局那份（所有工作区的默认值）
    const card = slot(slotRegistrations, 'settings.plugin.item', 'dsh-auto-pass')
    const settings = await renderStable(react, card.component, {}, steps(toggleSwitch(2, false)))
    for (const cleanup of settings.cleanups) cleanup()
    const globalWrite = configRequests.filter(item => item.method === 'POST').pop()
    expect(globalWrite.cwd).toBeUndefined()
    expect(globalWrite.body).toEqual({ autoOpenTimeline: false })
    expect(JSON.stringify(settings.tree)).toContain('这里是所有工作区的默认值')
  })
})

/** 单独求值一次根元素类型（不跑副作用，只为断言宿主标签）。 */
async function rootType(react, component) {
  const frame = react.__pushFrame()
  try {
    react.__resetCursor()
    const tree = evaluate(component({ sessionId: 'session-1' }), 0, react)
    return tree.type
  } finally {
    react.__popFrame()
  }
}
