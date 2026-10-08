/**
 * @description 设置模型契约测试：宿主 settings（SettingsForms）在**模块顶层**读
 *   `entry.fiber.runtime.Config` 判断插件行可不可配置，写回只认标了 `.volatile()` 的字段。
 *   2026-10-08 真机踩到「审批设置里保存失败：No configurable plugin entry "dsh-auto-pass"」，
 *   根因就是缺这份 schema。这里钉住三件事：字段清单与默认值、volatile 版本门禁
 *   （schemastery ≥3.18.4 才有 .volatile()）、以及 volatile 引用的实时读与类型兜底。
 * @author simon300000
 * @date 2026-10-08
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildSettingsConfig,
  Config,
  loadSchemastery,
  plainSettingValue,
  plainSettings,
  effectiveReviewEffort,
  resolveConfig,
  routePairProblem,
  SETTING_KINDS,
  supportsVolatile,
  VOLATILE_SETTINGS,
} from '../src/index.js'

/**
 * 造一个 volatile 引用：宿主 resolveConfig 把标了 .volatile() 的字段解析成引用对象
 * （cosmokit createVolatile 的形状：Object.freeze({ get, [write] })），这里用同形状的替身。
 * @param {*} initial 初始值
 * @returns {{get: Function, set: Function}} 引用
 */
function volatileRef(initial) {
  let current = initial
  return Object.freeze({
    get: () => current,
    set: value => { current = value },
  })
}

/** 极简 schemastery 替身：只记录 type 与 meta，用来钉住 Config 的字段清单（CI 上没有宿主副本）。 */
function stubSchemastery() {
  const make = (type, meta) => {
    const node = {
      type,
      meta,
      /** 记下默认值（链式返回新节点，与 schemastery 一样不改原节点）。 */
      default(value) { return make(type, { ...meta, default: value }) },
      /** 记下 volatile 标记：宿主正是靠 meta.volatile 判定这个字段能不能写。 */
      volatile() { return make(type, { ...meta, volatile: true }) },
      // 数字字段的量纲约束（step / min）：替身只保留链式形状
      step() { return node },
      min() { return node },
    }
    return node
  }
  return {
    object: dict => ({ type: 'object', dict }),
    boolean: () => make('boolean', {}),
    string: () => make('string', {}),
    number: () => make('number', {}),
    union: list => make('union', { list }),
  }
}

/** 仓库自己装到的 schemastery（optional peer；装不到就 undefined）。 */
function repoModule() {
  try {
    return createRequire(import.meta.url)('@deepseek-ai/schemastery')
  } catch {
    return undefined
  }
}

/** 本机 DSH Desktop 的宿主副本位置（缺席时只是少跑一条真码校验，不影响别的断言）。 */
const HOST_PROBES = [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'DSH Desktop', 'resources', 'app', 'package.json'),
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DSH Desktop', 'resources', 'app', 'package.json'),
]

describe('设置 Config（宿主 settings 的模块级 schema）', () => {
  it('十个可写字段都在（界面偏好 + 审查模型配置），且全部标了 volatile', () => {
    const schema = buildSettingsConfig(stubSchemastery())
    expect(Object.keys(schema.dict)).toEqual([...VOLATILE_SETTINGS])
    for (const key of VOLATILE_SETTINGS) {
      expect(schema.dict[key].meta.volatile).toBe(true)
    }
    expect(schema.dict.placement.meta.list).toEqual(['auto', 'tab', 'sidebar', 'all'])
    expect(schema.dict.notice.meta.type ?? schema.dict.notice.type).toBe('boolean')
    expect(schema.dict.timeoutMs.type).toBe('number')
    expect(schema.dict.reviewerProvider.type).toBe('string')
  })

  it('带默认值的字段与运行时 DEFAULTS 一致；路由/强度不带默认值（未设置=跟随会话）', () => {
    const schema = buildSettingsConfig(stubSchemastery())
    const defaults = resolveConfig({})
    for (const key of VOLATILE_SETTINGS) {
      if (SETTING_KINDS[key] === 'route' || SETTING_KINDS[key] === 'optionalString') {
        expect(schema.dict[key].meta.default).toBeUndefined()
        continue
      }
      expect(schema.dict[key].meta.default).toEqual(defaults[key])
    }
  })

  it('版本门禁：没有 .volatile() 的 schemastery 一律不采用（降级为 undefined，不报错）', () => {
    expect(supportsVolatile(undefined)).toBe(false)
    expect(supportsVolatile({ object: () => ({}) })).toBe(false)
    expect(supportsVolatile({ object: () => ({}), boolean: () => ({}) })).toBe(false)
    expect(supportsVolatile({ object: () => ({}), boolean: () => ({ volatile: () => ({}) }) })).toBe(true)

    // 仓库自己那份（pnpm 装到的版本）支持与否，必须与门禁结论一致
    const repoCopy = repoModule()
    if (repoCopy !== undefined) {
      const supported = typeof repoCopy.boolean().volatile === 'function'
      const found = loadSchemastery([new URL('../node_modules/@deepseek-ai/schemastery/package.json', import.meta.url).href])
      expect(found === undefined).toBe(!supported)
    }
  })

  it('宿主自带的 schemastery（≥3.18.4）能造出真 Config：meta.volatile 真的落在 schema 上', () => {
    const found = loadSchemastery(HOST_PROBES)
    if (found === undefined) {
      // 没有宿主副本（CI / 别的布局）：字段清单已由上面的替身用例覆盖
      return
    }
    // toJSON() 给的是 { uid, refs } 引用图（宿主 dsh-settings 也是 new z(json) 复原后再走 dict），
    // 所以这里同样复原一份再看字段 meta
    const rehydrated = new found.schema(buildSettingsConfig(found.schema).toJSON())
    for (const key of VOLATILE_SETTINGS) {
      expect(rehydrated.dict[key].meta.volatile).toBe(true)
    }
    expect(rehydrated.dict.notice.meta.default).toBe(true)
  })

  it('模块顶层导出 Config：拿不到 schema 时是 undefined（不能是 null，宿主会 TypeError）', () => {
    expect(Config === undefined || typeof Config.toJSON === 'function').toBe(true)
  })
})

describe('界面偏好的实时读与兜底', () => {
  it('volatile 引用实时读：写回后不重建 config 也立刻生效', () => {
    const notice = volatileRef(true)
    const denyDirect = volatileRef(false)
    const config = resolveConfig({ notice, denyDirect })

    expect(config.notice).toBe(true)
    expect(config.denyDirect).toBe(false)
    notice.set(false)
    denyDirect.set(true)
    expect(config.notice).toBe(false)
    expect(config.denyDirect).toBe(true)
  })

  it('类型兜底：写坏的值回落 DEFAULTS（冻结快照也不影响 getter）', () => {
    const defaults = resolveConfig({})
    expect(resolveConfig({ notice: 'false' }).notice).toBe(defaults.notice)
    expect(resolveConfig({ autoOpenTimeline: 0 }).autoOpenTimeline).toBe(defaults.autoOpenTimeline)
    expect(resolveConfig({ denyDirect: null }).denyDirect).toBe(defaults.denyDirect)

    const notice = volatileRef('false')
    const config = resolveConfig({ notice })
    expect(config.notice).toBe(true)
    notice.set(false)
    expect(config.notice).toBe(false)
  })

  it('placement 只认白名单（解析期非法值照旧抛错，不会静默变成别的档位）', () => {
    expect(resolveConfig({ placement: 'sidebar' }).placement).toBe('sidebar')
    expect(() => resolveConfig({ placement: 'nope' })).toThrow(/placement/)
  })

  it('plainSettings 递归解包 volatile 引用，普通值原样保留', () => {
    expect(plainSettingValue({ get: () => 7 })).toBe(7)
    expect(plainSettingValue('x')).toBe('x')
    expect(plainSettingValue(null)).toBe(null)
    expect(plainSettings({ a: { get: () => ({ b: { get: () => 1 } }) }, c: [{ get: () => 2 }], d: 'x' }))
      .toEqual({ a: { b: 1 }, c: [2], d: 'x' })
  })
})

describe('审查模型配置（面板可写的路由与调用参数）', () => {
  it('路由成对规则：都空 / 都有值都合法，半套抛错（空串与未设置等价）', () => {
    expect(resolveConfig({}).reviewerProvider).toBe('')
    expect(resolveConfig({ reviewerProvider: '', reviewerModel: '' }).reviewerModel).toBe('')
    expect(resolveConfig({ reviewerProvider: 'commandcode', reviewerModel: 'm' }).reviewerProvider).toBe('commandcode')
    expect(routePairProblem(undefined, undefined)).toBeUndefined()
    expect(routePairProblem('', '')).toBeUndefined()
    expect(routePairProblem('  ', '')).toBeUndefined()
    expect(routePairProblem('p', '')).toMatch(/必须同时设置/)
    expect(routePairProblem('', 'm')).toMatch(/必须同时设置/)
    expect(() => resolveConfig({ reviewerProvider: 'p' })).toThrow(/必须同时设置/)
  })

  it('思考强度：空串 = 用模型默认（绝不把空串传给宿主）', () => {
    expect(effectiveReviewEffort(resolveConfig({}))).toBeUndefined()
    expect(effectiveReviewEffort(resolveConfig({ reviewerReasoningEffort: '   ' }))).toBeUndefined()
    expect(effectiveReviewEffort(resolveConfig({ reviewerReasoningEffort: 'high' }))).toBe('high')
    // 写成别的类型：解析期照旧抛错（不静默改成默认）
    expect(() => resolveConfig({ reviewerReasoningEffort: 5 })).toThrow(/reviewerReasoningEffort/)
  })

  it('路由与调用参数都按 volatile 引用实时读，运行期坏值回落默认', () => {
    const reviewerProvider = volatileRef('commandcode')
    const reviewerModel = volatileRef('deepseek/deepseek-v4.1-flash')
    const timeoutMs = volatileRef(1500)
    const config = resolveConfig({ reviewerProvider, reviewerModel, timeoutMs })

    expect(config.reviewerProvider).toBe('commandcode')
    expect(config.timeoutMs).toBe(1500)
    reviewerModel.set('other-model')
    expect(config.reviewerModel).toBe('other-model')

    // 极端情况：运行期被写成 0 —— 读回时回落默认，不让一次坏值把审查超时变成 0
    const defaults = resolveConfig({})
    timeoutMs.set(0)
    expect(config.timeoutMs).toBe(defaults.timeoutMs)
  })
})
