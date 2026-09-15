/**
 * @description dsh-auto-pass 客户端半冒烟测试：加载 bundle、校验注册的 id/槽位/标签，
 *   并把面板组件真正渲染到稳定状态——客户端代码不进构建流水线，只有这一步能抓到
 *   未定义标识符、漏闭合花括号、以及「拉到记录后」那一轮渲染里的问题。
 * @author simon300000
 * @date 2026-09-15
 * @modify 2026-09-15 支持反复渲染（状态 + 副作用），覆盖时间线的审批意见与命中名单显示
 */
import { describe, expect, it, vi } from 'vitest'

/** 时间线样例记录：一条白名单命中、一条黑名单命中，用来验证行内展示。 */
function sampleRecords() {
  return [
    {
      id: 'record-allow',
      time: '2026-09-15T04:00:00.000Z',
      toolName: 'bash',
      verdict: 'allow',
      outcome: 'allowed-once',
      rationale: '用户明确要求运行测试。',
      steps: 0,
      latencyMs: 3,
      signature: { toolName: 'bash', key: 'bash:npm test', text: 'bash · npm test' },
      policy: { list: 'allow', scope: 'global', ruleId: 'rule-1', label: 'bash · npm test', kind: 'signature' },
    },
    {
      id: 'record-deny',
      time: '2026-09-15T04:01:00.000Z',
      toolName: 'bash',
      verdict: 'defer',
      outcome: 'rejected',
      rationale: '该命令已列入黑名单。',
      steps: 0,
      policy: { list: 'deny', scope: 'project', ruleId: 'rule-2', label: 'bash · rm -rf', kind: 'signature' },
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
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: value => {
      const current = frame()
      const index = current.cursor
      current.cursor += 1
      if (!(index in current.slots)) current.slots[index] = typeof value === 'function' ? value() : value
      return [current.slots[index], next => {
        current.slots[index] = typeof next === 'function' ? next(current.slots[index]) : next
        current.dirty = true
      }]
    },
    useEffect: effect => {
      const current = frame()
      const index = current.effectCursor
      current.effectCursor += 1
      if (current.effects[index] === undefined) current.effects[index] = effect
    },
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
    /** 开一帧（同一组件反复渲染共用这一帧，状态才留得住）。 */
    __pushFrame: () => {
      const current = { slots: [], effects: [], cleanups: [], cursor: 0, effectCursor: 0, ran: [], dirty: false }
      frames.push(current)
      return current
    },
    __popFrame: () => frames.pop(),
    /** 每轮渲染前重置 hook 游标（hook 顺序必须一致，重置后才能按序号复用状态）。 */
    __resetCursor: () => {
      const current = frame()
      current.cursor = 0
      current.effectCursor = 0
    },
  }
}

/** 安装最小浏览器替身：fetch 与 localStorage 都返回可控的假结果，避免噪声。 */
function installBrowserStubs() {
  const store = new Map()
  globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: key => { store.delete(key) },
  }
  globalThis.fetch = vi.fn(async url => {
    const target = String(url)
    if (target.includes('/policy')) {
      return { json: async () => ({ ok: true, thresholds: { allow: 3, deny: 3 }, global: { allow: [], deny: [] }, project: { allow: [], deny: [] } }) }
    }
    if (target.includes('/log')) return { json: async () => ({ ok: true, records: sampleRecords() }) }
    return { json: async () => ({ ok: true, placement: 'all', writable: true }) }
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

/** 造一个够客户端半用的假宿主：记录槽位注册、可提供右侧栏座位。 */
function harness() {
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
  const ctx = {
    get: name => (name === 'slots' ? slots : undefined),
    inject: (names, callback) => {
      if (names.includes('sidebarRightTabs')) callback({ slots, sidebarRightTabs: sidebarTabs })
      return { dispose: () => {} }
    },
    effect: fn => fn(),
  }
  return { ctx, slots, slotRegistrations, tabRegistrations }
}

/**
 * 把整棵元素树求值到宿主元素（字符串 type）：槽位里注册的往往是包装组件，而且
 * 文案藏在嵌套的子组件里，只求值根节点会漏掉——那正是这个冒烟测试要抓的东西。
 * depth 上限只是防御性的，正常组件树很浅。
 */
function evaluate(element, depth = 0) {
  if (depth > 8) return element
  if (Array.isArray(element)) return element.map(child => evaluate(child, depth + 1))
  if (element === null || typeof element !== 'object') return element
  if (typeof element.type === 'function') return evaluate(element.type(element.props ?? {}), depth + 1)
  return {
    type: element.type,
    props: element.props,
    children: Array.isArray(element.children)
      ? element.children.map(child => evaluate(child, depth + 1))
      : element.children,
  }
}

/**
 * 渲染一个面板到稳定状态：反复求值并跑副作用，直到没有新的 setState（最多 5 轮）。
 * 时间线的记录是异步拉回来的，不求到稳定状态就只会看到「加载中」。
 */
async function renderStable(react, component, props) {
  const frame = react.__pushFrame()
  let tree
  try {
    for (let pass = 0; pass < 5; pass += 1) {
      frame.dirty = false
      react.__resetCursor()
      tree = evaluate(component(props))
      // 只跑本轮新注册的副作用（例如拉记录），重复渲染不会重复订阅
      for (let index = 0; index < frame.effects.length; index += 1) {
        if (frame.ran[index] === true) continue
        frame.ran[index] = true
        const cleanup = frame.effects[index]()
        if (typeof cleanup === 'function') frame.cleanups.push(cleanup)
      }
      await new Promise(resolve => setTimeout(resolve, 0))
      if (frame.dirty !== true) break
    }
  } finally {
    react.__popFrame()
  }
  return { tree, cleanups: frame.cleanups }
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
    const titleTree = evaluate(tabTitle.component({}))
    expect(titleTree.type).toBe('span')
    expect(titleTree.children.some(child => child?.type === 'svg')).toBe(true)
    expect(JSON.stringify(titleTree)).toContain('审批时间线')
    for (const cleanup of cleanups) cleanup()

    // 对话区标签页只放审批设置：有阈值输入，没有时间线的「本次会话/全部会话」切换
    expect(trees[0].includes('连续放行阈值')).toBe(true)
    expect(trees[0].includes('连续被拒阈值')).toBe(true)
    expect(trees[0].includes('黑名单 · 直接转人工')).toBe(true)
    expect(trees[0].includes('本次会话')).toBe(false)
    // 右侧栏是审批时间线：有会话范围切换，没有阈值输入
    expect(trees[1].includes('审批时间线')).toBe(true)
    expect(trees[1].includes('本次会话')).toBe(true)
    expect(trees[1].includes('连续放行阈值')).toBe(false)
    // 时间线行内要能看见审批意见，以及命中的是白名单还是黑名单（含规则标签）
    expect(trees[1].includes('用户明确要求运行测试。')).toBe(true)
    expect(trees[1].includes('白名单')).toBe(true)
    expect(trees[1].includes('bash · npm test')).toBe(true)
    expect(trees[1].includes('黑名单')).toBe(true)
    expect(trees[1].includes('bash · rm -rf')).toBe(true)
    // 设置页卡片是放置位置选择器
    expect(trees[2].includes('面板显示位置')).toBe(true)
  })
})

/** 单独求值一次根元素类型（不跑副作用，只为断言宿主标签）。 */
async function rootType(react, component) {
  const frame = react.__pushFrame()
  try {
    react.__resetCursor()
    const tree = evaluate(component({ sessionId: 'session-1' }))
    return tree.type
  } finally {
    react.__popFrame()
  }
}
