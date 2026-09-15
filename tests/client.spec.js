/**
 * @description dsh-auto-pass 客户端半冒烟测试：加载 bundle、校验注册的 id/槽位/标签，
 *   并把两个面板组件真正渲染一次——客户端代码不进构建流水线，只有这一步能抓到
 *   未定义标识符、漏闭合花括号之类的问题（曾经真的漏过）。
 * @author simon300000
 * @date 2026-09-15
 */
import { describe, expect, it, vi } from 'vitest'

/** 极简 react 替身：只实现挂载与渲染一次所需的那几个 hook。 */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
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
  globalThis.fetch = vi.fn(async url => ({
    json: async () => (String(url).includes('/policy')
      ? { ok: true, threshold: 3, global: { allow: [], deny: [] }, project: { allow: [], deny: [] } }
      : { ok: true, placement: 'all', writable: true, records: [] }),
  }))
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

    const card = slot(slotRegistrations, 'settings.plugin.item', 'dsh-auto-pass')
    expect(card).toBeDefined()

    expect(tabRegistrations).toHaveLength(1)
    expect(tabRegistrations[0].id).toBe('dsh-auto-pass')
    expect(tabRegistrations[0].title()).toBe('审批时间线')
    expect(typeof tabRegistrations[0].guide[0].icon).toBe('function')
  })

  it('两个面板与设置卡片都能渲染一次（抓到未定义标识符）', async () => {
    const registration = await loadClient()
    const moduleExports = registration.factory(specifier => {
      if (specifier === 'react') return fakeReact()
      throw new Error('unexpected require: ' + specifier)
    })
    const { ctx, slotRegistrations } = harness()
    moduleExports.apply(ctx)

    const view = slot(slotRegistrations, 'conversation.view', 'dsh-auto-pass')
    const pane = slot(slotRegistrations, 'sidebar.right.pane.tab', 'dsh-auto-pass')
    const card = slot(slotRegistrations, 'settings.plugin.item', 'dsh-auto-pass')
    const trees = [view, pane, card].map(entry => {
      expect(typeof entry.component).toBe('function')
      const tree = evaluate(entry.component({ sessionId: 'session-1' }))
      expect(tree.type).toBe('div')
      return JSON.stringify(tree)
    })
    // 对话区标签页只放审批设置：有阈值输入，没有时间线的「本次会话/全部会话」切换
    expect(trees[0].includes('连续人工放行阈值')).toBe(true)
    expect(trees[0].includes('黑名单 · 直接转人工')).toBe(true)
    expect(trees[0].includes('本次会话')).toBe(false)
    // 右侧栏是审批时间线：有会话范围切换，没有阈值输入
    expect(trees[1].includes('审批时间线')).toBe(true)
    expect(trees[1].includes('本次会话')).toBe(true)
    expect(trees[1].includes('连续人工放行阈值')).toBe(false)
    // 设置页卡片是放置位置选择器
    expect(trees[2].includes('面板显示位置')).toBe(true)
  })
})
