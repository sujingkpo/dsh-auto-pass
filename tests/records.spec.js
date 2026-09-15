/**
 * @description dsh-auto-pass 审批记录仓库与记录路由的单元测试：落盘、倒序、
 *   上限、会话过滤、损坏文件容错，以及 /api/dsh-auto-pass 两条查询路径。
 * @author simon300000
 * @date 2026-09-15
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'
import { createRecordStore, defaultLogFile, noopRecordStore, RECORD_FILE_VERSION } from '../src/records.js'

const tempDirs = []

/** 建一个互不干扰的临时目录，返回其中的文件路径。 */
function tempFile(name = 'approvals.json') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auto-pass-'))
  tempDirs.push(dir)
  return join(dir, name)
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true })
})

/** 造一条最小可用记录。 */
function record(id, sessionId = 'session-1') {
  return { id, sessionId, time: `2026-09-15T00:00:0${id}.000Z`, toolName: 'bash', verdict: 'allow', outcome: 'allowed-once' }
}

/** 造一个只实现审批记录所需面的假宿主 ctx。 */
function fakeContext() {
  const routes = []
  const listeners = new Map()
  return {
    routes,
    listeners,
    ctx: {
      logger: { info: vi.fn(), warn: vi.fn() },
      on: (name, listener) => {
        listeners.set(name, listener)
        return () => {}
      },
      effect: fn => fn(),
      get: () => undefined,
      inject: (names, callback) => {
        if (names.includes('webServer')) {
          callback({
            effect: fn => fn(),
            webServer: { register: registration => { routes.push(registration); return () => {} } },
          })
        }
        return { dispose: () => {} }
      },
    },
  }
}

/** 造一个最小 http req/res，返回响应内容与状态码。 */
function fakeHttp(method, url) {
  const state = { code: 0, body: '' }
  return {
    state,
    req: { method, url },
    res: {
      writeHead(code) { state.code = code },
      end(body) { state.body = String(body ?? '') },
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
    expect(JSON.parse(config.state.body)).toMatchObject({ ok: true, placement: 'sidebar', maxRecords: 5 })
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
