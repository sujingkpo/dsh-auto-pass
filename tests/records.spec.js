/**
 * @description dsh-auto-pass 审批记录仓库与记录路由的单元测试：落盘、倒序、
 *   上限、会话过滤、损坏文件容错，以及 /api/dsh-auto-pass 两条查询路径。
 * @author simon300000
 * @date 2026-09-15
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'
import {
  createRecordStore,
  defaultLogFile,
  defaultRecordDir,
  noopRecordStore,
  RECORD_FILE_VERSION,
  workspaceSlug,
} from '../src/records.js'

const tempDirs = []

/** 建一个互不干扰的临时目录。 */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auto-pass-'))
  tempDirs.push(dir)
  return dir
}

/** 临时目录里的一个文件路径。 */
function tempFile(name = 'approvals.json') {
  return join(tempDir(), name)
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true })
})

/** 造一条最小可用记录。 */
function record(id, sessionId = 'session-1') {
  return { id, sessionId, time: `2026-09-15T00:00:0${id}.000Z`, toolName: 'bash', verdict: 'allow', outcome: 'allowed-once' }
}

/** 造一个只实现审批记录所需面的假宿主 ctx。 */
function fakeContext(options = {}) {
  const routes = []
  const listeners = new Map()
  const settings = options.settings
  return {
    routes,
    listeners,
    settings,
    ctx: {
      logger: { info: vi.fn(), warn: vi.fn() },
      on: (name, listener) => {
        listeners.set(name, listener)
        return () => {}
      },
      effect: fn => fn(),
      get: name => (name === 'settings' ? settings : undefined),
      inject: (names, callback) => {
        if (names.includes('webServer')) {
          callback({
            effect: fn => fn(),
            webServer: { register: registration => { routes.push(registration); return () => {} } },
          })
        }
        if (names.includes('settings')) {
          callback({ effect: fn => fn(), settings: settings ?? { register: () => {} } })
        }
        return { dispose: () => {} }
      },
    },
  }
}

/** 造一个假的设置服务：记录 update 调用，get 返回给定文档。 */
function fakeSettings(document = {}) {
  const updates = []
  return {
    updates,
    register: vi.fn(),
    get: () => document,
    update: async (namespace, partial) => {
      updates.push([namespace, partial])
      return { ok: true }
    },
  }
}

/** 造一个最小 http req/res，返回响应内容与状态码。 */
function fakeHttp(method, url, body) {
  const state = { code: 0, body: '' }
  return {
    state,
    req: {
      method,
      url,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(body, 'utf8')
      },
    },
    res: {
      writeHead(code) { state.code = code },
      end(chunk) { state.body = String(chunk ?? '') },
    },
  }
}

describe('审批记录仓库', () => {
  it('默认路径跟随 DSH_HOME，未设置时回退 ~/.dsh', () => {
    expect(defaultLogFile({ DSH_HOME: join('D:', 'home') }))
      .toBe(join(join('D:', 'home'), 'dsh-auto-pass', 'approvals.json'))
    expect(defaultLogFile({})).toContain(join('.dsh', 'dsh-auto-pass', 'approvals.json'))
  })

  it('落盘后可跨进程重建，列表按时间倒序并受上限约束', () => {
    const file = tempFile()
    const store = createRecordStore({ file, limit: 3 })
    for (const id of [1, 2, 3, 4]) store.add(record(id))

    expect(store.size()).toBe(3)
    expect(store.list().map(item => item.id)).toEqual([4, 3, 2])

    const persisted = JSON.parse(readFileSync(file, 'utf8'))
    expect(persisted.version).toBe(RECORD_FILE_VERSION)
    expect(persisted.records.map(item => item.id)).toEqual([2, 3, 4])

    const reopened = createRecordStore({ file, limit: 3 })
    expect(reopened.list().map(item => item.id)).toEqual([4, 3, 2])
  })

  it('按会话过滤，只返回该会话的记录', () => {
    const store = createRecordStore({ file: tempFile() })
    store.add(record(1, 'session-a'))
    store.add(record(2, 'session-b'))
    store.add(record(3, 'session-a'))
    expect(store.list({ session: 'session-a' }).map(item => item.id)).toEqual([3, 1])
    expect(store.list({ session: 'missing' })).toEqual([])
    expect(store.list().map(item => item.id)).toEqual([3, 2, 1])
  })

  it('文件损坏时按空仓库启动并告警', () => {
    const file = tempFile()
    writeFileSync(file, '{ not json', 'utf8')
    const warn = vi.fn()
    const store = createRecordStore({ file, warn })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('审批记录解析失败'))
    expect(store.list()).toEqual([])
    // 继续写入会覆盖坏文件
    store.add(record(1))
    expect(JSON.parse(readFileSync(file, 'utf8')).records).toHaveLength(1)
  })

  it('空仓库实现不会抛错', () => {
    expect(noopRecordStore.enabled).toBe(false)
    expect(() => noopRecordStore.add(record(1))).not.toThrow()
    expect(noopRecordStore.list()).toEqual([])
  })
})

describe('按工作区分文件存储', () => {
  it('默认目录跟随 DSH_HOME', () => {
    expect(defaultRecordDir({ DSH_HOME: join('D:', 'home') }))
      .toBe(join(join('D:', 'home'), 'dsh-auto-pass', 'records'))
  })

  it('workspaceSlug：同一个目录永远同一个名字，空目录归 unknown，超长路径补哈希', () => {
    expect(workspaceSlug('D:\\work\\dsh-auto')).toBe('d-work-dsh-auto')
    expect(workspaceSlug('D:/work/dsh-auto')).toBe(workspaceSlug('D:\\work\\dsh-auto'))
    expect(workspaceSlug('')).toBe('unknown')
    expect(workspaceSlug(undefined)).toBe('unknown')
    const long = 'D:/' + 'a'.repeat(120) + '/x'
    expect(workspaceSlug(long)).toHaveLength(49)
    expect(workspaceSlug(long)).not.toBe(workspaceSlug('D:/' + 'a'.repeat(120) + '/y'))
  })

  it('每条记录按 cwd 落到自己的工作区文件，列表仍合并成一条时间线', () => {
    const dir = tempDir()
    const store = createRecordStore({ dir })
    store.add({ ...record(1), cwd: 'D:\\work\\a', time: '2026-09-15T00:00:01.000Z' })
    store.add({ ...record(2), cwd: 'D:\\work\\b', time: '2026-09-15T00:00:02.000Z' })
    store.add({ ...record(3), cwd: 'D:/work/a', time: '2026-09-15T00:00:03.000Z' })
    expect(store.size()).toBe(3)
    expect(store.list().map(item => item.id)).toEqual([3, 2, 1])

    expect(readdirSync(dir).sort()).toEqual(['d-work-a.json', 'd-work-b.json'])
    expect(JSON.parse(readFileSync(join(dir, 'd-work-a.json'), 'utf8')).records.map(item => item.id)).toEqual([1, 3])

    // 每个工作区一个文件，关掉再打开从各自文件读回
    const reopened = createRecordStore({ dir })
    expect(reopened.list().map(item => item.id)).toEqual([3, 2, 1])
    expect(reopened.get(2).sessionId).toBe('session-1')
  })

  it('条数上限按工作区各算：一个工作区刷屏不会挤掉别的工作区的历史', () => {
    const dir = tempDir()
    const store = createRecordStore({ dir, limit: 2 })
    for (const id of [1, 2, 3]) store.add({ ...record(id), cwd: 'D:/hot', time: `2026-09-15T00:00:0${id}.000Z` })
    store.add({ ...record(4), cwd: 'D:/cold', time: '2026-09-15T00:00:04.000Z' })
    expect(store.list().map(item => item.id)).toEqual([4, 3, 2])
    expect(JSON.parse(readFileSync(join(dir, 'd-hot.json'), 'utf8')).records.map(item => item.id)).toEqual([2, 3])
    expect(JSON.parse(readFileSync(join(dir, 'd-cold.json'), 'utf8')).records.map(item => item.id)).toEqual([4])
  })

  it('旧的单文件记录：启动时按工作区拆开、删除原文件（没有 cwd 的进 unknown）', () => {
    const root = tempDir()
    // 真实布局：旧文件在上一级（$DSH_HOME/dsh-auto-pass/approvals.json），记录目录是它的子目录
    const dir = join(root, 'records')
    const legacy = join(root, 'approvals.json')
    writeFileSync(legacy, JSON.stringify({
      version: RECORD_FILE_VERSION,
      records: [
        { ...record(1), cwd: 'D:/work/a' },
        { ...record(2), cwd: 'D:/work/b' },
        { ...record(3) },
      ],
    }), 'utf8')
    const store = createRecordStore({ dir })
    expect(existsSync(legacy)).toBe(false)
    expect(store.list().map(item => item.id)).toEqual([3, 2, 1])
    expect(readdirSync(dir).sort()).toEqual(['d-work-a.json', 'd-work-b.json', 'unknown.json'])
  })

  it('同一份历史被拆两次（id 重复）时只保留一条，不重复刷屏', () => {
    const root = tempDir()
    const dir = join(root, 'records')
    const legacy = join(root, 'approvals.json')
    const seeded = [{ ...record(1), cwd: 'D:/work/a' }, { ...record(2), cwd: 'D:/work/a' }]
    writeFileSync(legacy, JSON.stringify({ version: RECORD_FILE_VERSION, records: seeded }), 'utf8')
    createRecordStore({ dir })
    // 旧文件又被写回来（例如迁移后被旧版本进程按老路径重建）→ 第二次拆分不该产生重复条目
    writeFileSync(legacy, JSON.stringify({ version: RECORD_FILE_VERSION, records: seeded }), 'utf8')
    const again = createRecordStore({ dir })
    expect(again.list().map(item => item.id)).toEqual([2, 1])
    // 单个文件里混进重复 id（半迁移的历史遗留）也要去重
    writeFileSync(join(dir, 'd-work-a.json'), JSON.stringify({
      version: RECORD_FILE_VERSION,
      records: [seeded[0], seeded[0]],
    }), 'utf8')
    expect(createRecordStore({ dir }).list().map(item => item.id)).toEqual([1])
  })

  it('拆分失败时保留旧文件，绝不因为迁移丢历史', () => {
    const root = tempDir()
    const dir = join(root, 'records')
    // 让「记录目录」这一层是个文件：mkdir 必然失败，于是拆分写不进去
    writeFileSync(dir, 'not a directory', 'utf8')
    const legacy = join(root, 'approvals.json')
    writeFileSync(legacy, JSON.stringify({
      version: RECORD_FILE_VERSION,
      records: [{ ...record(1), cwd: 'D:/work/a' }],
    }), 'utf8')
    const warn = vi.fn()
    const store = createRecordStore({ dir, warn })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('旧记录拆分写入失败'))
    expect(existsSync(legacy)).toBe(true)
    expect(store.list()).toEqual([])
  })
})

describe('审批记录路由', () => {
  it('注册前缀路由并提供倒序记录与配置读取', () => {
    const file = tempFile()
    // 先把记录写进文件，apply 建立的仓库启动时会读入它们（路由因此能看到历史）
    const seeded = createRecordStore({ file, limit: 5 })
    seeded.add(record(1, 'session-a'))
    seeded.add(record(2, 'session-b'))

    const { ctx, routes } = fakeContext()
    apply(ctx, { logFile: file, placement: 'sidebar', maxRecords: 5 })
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: '/api/dsh-auto-pass' })

    const all = fakeHttp('GET', '/api/dsh-auto-pass/log')
    routes[0].handler(all.req, all.res)
    const allBody = JSON.parse(all.state.body)
    expect(all.state.code).toBe(200)
    expect(allBody.ok).toBe(true)
    expect(allBody.total).toBe(2)
    expect(allBody.records.map(item => item.id)).toEqual([2, 1])

    const filtered = fakeHttp('GET', '/api/dsh-auto-pass/log?session=session-a&limit=1')
    routes[0].handler(filtered.req, filtered.res)
    expect(JSON.parse(filtered.state.body).records.map(item => item.id)).toEqual([1])

    const config = fakeHttp('GET', '/api/dsh-auto-pass/config')
    routes[0].handler(config.req, config.res)
    // 界面偏好统一放在 settings 里：placement 决定面板挂哪，notice / denyDirect 是两个行为开关
    expect(JSON.parse(config.state.body)).toMatchObject({
      ok: true,
      settings: { placement: 'sidebar', notice: true, denyDirect: false, autoOpenTimeline: true },
      maxRecords: 5,
    })
  })

  it('设置命名空间有值时优先用它，并声明可写', async () => {
    const settings = fakeSettings({ placement: 'tab' })
    const { ctx, routes } = fakeContext({ settings })
    apply(ctx, { logFile: tempFile(), placement: 'all' })

    const config = fakeHttp('GET', '/api/dsh-auto-pass/config')
    await routes[0].handler(config.req, config.res)
    expect(JSON.parse(config.state.body)).toMatchObject({ ok: true, settings: { placement: 'tab' }, writable: true })
  })

  it('POST 写入设置命名空间，非法值 400，没有设置服务时 503', async () => {
    const settings = fakeSettings({})
    const { ctx, routes } = fakeContext({ settings })
    apply(ctx, { logFile: tempFile(), placement: 'all' })

    const saved = fakeHttp('POST', '/api/dsh-auto-pass/config', JSON.stringify({ placement: 'sidebar' }))
    await routes[0].handler(saved.req, saved.res)
    expect(saved.state.code).toBe(200)
    // 回执与 GET 同形状（整份快照）：客户端写完之后要能直接套用，包括本工作区那段
    expect(JSON.parse(saved.state.body)).toMatchObject({
      ok: true,
      settings: { notice: true, denyDirect: false, autoOpenTimeline: true, askRejectReason: true },
      writable: true,
    })
    expect(settings.updates).toEqual([['dsh-auto-pass', { placement: 'sidebar' }]])

    const bad = fakeHttp('POST', '/api/dsh-auto-pass/config', JSON.stringify({ placement: 'nope' }))
    await routes[0].handler(bad.req, bad.res)
    expect(bad.state.code).toBe(400)

    const noService = fakeContext()
    apply(noService.ctx, { logFile: tempFile(), placement: 'all' })
    const refused = fakeHttp('POST', '/api/dsh-auto-pass/config', JSON.stringify({ placement: 'tab' }))
    await noService.routes[0].handler(refused.req, refused.res)
    expect(refused.state.code).toBe(503)
  })

  it('客户端信标写进宿主日志', async () => {
    const { ctx, routes } = fakeContext()
    apply(ctx, { logFile: tempFile() })
    const beacon = fakeHttp('GET', '/api/dsh-auto-pass/beacon?stage=mounted&detail=placement%3Dall')
    await routes[0].handler(beacon.req, beacon.res)
    expect(beacon.state.code).toBe(200)
    expect(JSON.parse(beacon.state.body)).toEqual({ ok: true })
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('client beacon stage=mounted detail=placement=all'))
  })

  it('未知路径 404、非 GET 405', () => {
    const { ctx, routes } = fakeContext()
    apply(ctx, { logFile: tempFile() })
    const missing = fakeHttp('GET', '/api/dsh-auto-pass/unknown')
    routes[0].handler(missing.req, missing.res)
    expect(missing.state.code).toBe(404)

    const post = fakeHttp('POST', '/api/dsh-auto-pass/log')
    routes[0].handler(post.req, post.res)
    expect(post.state.code).toBe(405)
  })
})
