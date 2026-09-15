/**
 * @description 审批记录仓库（host 侧）。维护一次进程内的记录列表并原子写入 JSON 文件，
 *   供右侧栏「审批记录」时间轴读取；对外一律按时间倒序返回。
 *   **记录按工作区分文件**（`$DSH_HOME/dsh-auto-pass/records/<slug>.json`），条数上限也按工作区各算：
 *   一个工作区刷屏不会把别的工作区的历史挤掉，工作区之间也不互相污染。
 *   读取时把所有工作区合并成一条时间线（面板行为不变）。IO 失败只告警，绝不打断审批流程。
 * @author simon300000
 * @date 2026-09-15
 * @modify 2026-09-15 记录按工作区分文件存储（workspaceSlug），启动时把旧的单文件
 *   `approvals.json` 拆分后删除（全部写成功才删，绝不因为迁移丢历史）
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 落盘文件格式版本，便于以后迁移。 */
export const RECORD_FILE_VERSION = 1

/** 默认保留的记录条数上限（**按工作区各算**）。 */
export const DEFAULT_MAX_RECORDS = 1_000

/** 单条记录里动作参数的最大保存长度：足够辨认是什么操作，又不至于把大 payload 塞进日志。 */
export const MAX_RECORD_ACTION_CHARS = 500

/** DSH home：`DSH_HOME` 优先，未设置时回退 `~/.dsh`（DSH 自己的 home 约定）。 */
function dshHome(env = process.env) {
  return typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
}

/**
 * 记录文件默认**目录**：`$DSH_HOME/dsh-auto-pass/records`，一个工作区一个文件。
 */
export function defaultRecordDir(env = process.env) {
  return join(dshHome(env), 'dsh-auto-pass', 'records')
}

/**
 * 旧的单文件路径：`$DSH_HOME/dsh-auto-pass/approvals.json`。
 * 只在显式配置 `logFile`（单文件模式）与「拆分旧文件」时用到。
 */
export function defaultLogFile(env = process.env) {
  return join(dshHome(env), 'dsh-auto-pass', 'approvals.json')
}

/**
 * 工作区目录名：由会话工作目录推导，同一个 cwd 永远得到同一个 slug（不需要索引文件）。
 * 只保留 `[a-z0-9]`，其余折叠成 `-`（Windows 大小写不敏感，统一小写）；过长时截断并补 8 位哈希，
 * 保证不同的 cwd 不会撞名。没有 cwd 的记录进 `unknown.json`。
 * @param cwd 会话工作目录
 * @returns {string} 文件名里用的 slug（不含 .json）
 */
export function workspaceSlug(cwd) {
  const text = typeof cwd === 'string' ? cwd.trim().replace(/\\/g, '/').toLowerCase() : ''
  if (text === '') return 'unknown'
  const base = text.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (base === '') return 'unknown'
  if (base.length <= 48) return base
  return base.slice(0, 40).replace(/-+$/, '') + '-' + createHash('sha1').update(text).digest('hex').slice(0, 8)
}

/** 记录的去重键：字符串与数字 id 都认（真实记录是 UUID，测试夹具里是数字）。 */
function recordKeyOf(record) {
  const id = record?.id
  if (typeof id === 'string' && id !== '') return id
  if (typeof id === 'number' && Number.isFinite(id)) return 'n:' + String(id)
  return undefined
}

/** 空仓库：未启用记录能力（如单元测试默认）时使用，保证调用点无需判空。 */
export const noopRecordStore = Object.freeze({
  enabled: false,
  dir: undefined,
  file: undefined,
  add: record => record,
  list: () => [],
  size: () => 0,
  get: () => undefined,
  update: () => undefined,
})

/**
 * 创建记录仓库。
 * @param options.dir 按工作区分文件的目录（默认形态，见 {@link defaultRecordDir}）
 * @param options.file 单文件路径（显式配置 `logFile` 时的兼容形态；给了 file 就不分工作区）
 * @param options.legacyFile 需要拆分掉的旧单文件（只在 dir 形态下生效，默认同级目录的 approvals.json）
 * @param options.limit 每个工作区保留的条数上限，超出后丢弃最旧的记录
 * @param options.warn 告警回调（读写失败时调用）
 */
export function createRecordStore(options = {}) {
  const dir = typeof options.dir === 'string' && options.dir.trim() !== '' ? options.dir : undefined
  const singleFile = dir === undefined ? (options.file ?? defaultLogFile()) : undefined
  const legacyFile = dir === undefined
    ? undefined
    : (options.legacyFile ?? join(dirname(dir), 'approvals.json'))
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0
    ? options.limit
    : DEFAULT_MAX_RECORDS
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  /** slug -> { file, records }：一个工作区一个桶（单文件形态只有一个空 slug 的桶）。 */
  const buckets = new Map()
  /** 记录对象 -> 载入/追加顺序：合并多文件排序时的稳定 tiebreak（避免同毫秒记录乱序）。 */
  const order = new WeakMap()
  let nextOrder = 0

  /** 取（必要时新建）某个工作区的桶。 */
  function bucketFor(slug) {
    let bucket = buckets.get(slug)
    if (bucket === undefined) {
      bucket = { file: dir === undefined ? singleFile : join(dir, slug + '.json'), records: [] }
      buckets.set(slug, bucket)
    }
    return bucket
  }

  /** 收下一条记录（截断到上限）并登记顺序。 */
  function adopt(bucket, record) {
    nextOrder += 1
    order.set(record, nextOrder)
    bucket.records.push(record)
    if (bucket.records.length > limit) bucket.records = bucket.records.slice(-limit)
  }

  /** 读一个记录文件：缺失、损坏或格式不符时按空仓库处理，并告警说明原因。 */
  function readList(file) {
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      // 首次运行没有文件属于正常情况，不告警。
      if (error?.code !== 'ENOENT') warn('dsh-auto-pass: 审批记录读取失败 ' + file + '：' + errorMessage(error))
      return []
    }
    try {
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : parsed?.records
      if (!Array.isArray(list)) {
        warn('dsh-auto-pass: 审批记录格式不符，已按空仓库启动 ' + file)
        return []
      }
      return list.filter(record => record !== null && typeof record === 'object').slice(-limit)
    } catch (error) {
      warn('dsh-auto-pass: 审批记录解析失败，已按空仓库启动 ' + file + '：' + errorMessage(error))
      return []
    }
  }

  /** 落盘：先写临时文件再改名，避免进程中断留下半截 JSON；失败返回 false（只告警）。 */
  function writeList(file, records) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temporary = file + '.tmp'
      writeFileSync(temporary, JSON.stringify({ version: RECORD_FILE_VERSION, records }, null, 2) + '\n', 'utf8')
      renameSync(temporary, file)
      return true
    } catch (error) {
      warn('dsh-auto-pass: 审批记录写入失败 ' + file + '：' + errorMessage(error))
      return false
    }
  }

  /**
   * 把旧的单文件记录拆到各工作区文件里（一次性）。**全部写成功才删旧文件**：
   * 中途失败就原样留着下次再试，绝不因为迁移丢历史（也绝不把没写完的半成品当成功）。
   */
  function migrateLegacyFile() {
    if (legacyFile === undefined) return
    let raw
    try {
      raw = readFileSync(legacyFile, 'utf8')
    } catch {
      return
    }
    let list
    try {
      const parsed = JSON.parse(raw)
      const records = Array.isArray(parsed) ? parsed : parsed?.records
      if (!Array.isArray(records)) throw new Error('unexpected shape')
      list = records.filter(record => record !== null && typeof record === 'object')
    } catch (error) {
      warn('dsh-auto-pass: 旧的审批记录文件无法拆分，已保留原样 ' + legacyFile + '：' + errorMessage(error))
      return
    }
    const targets = new Map()
    for (const record of list) {
      const slug = workspaceSlug(record.cwd)
      let target = targets.get(slug)
      if (target === undefined) {
        const ids = new Set()
        const merged = []
        for (const item of readList(join(dir, slug + '.json'))) {
          const key = recordKeyOf(item)
          if (key !== undefined) {
            if (ids.has(key)) continue
            ids.add(key)
          }
          merged.push(item)
        }
        target = { ids, records: merged }
        targets.set(slug, target)
      }
      const key = recordKeyOf(record)
      if (key !== undefined) {
        if (target.ids.has(key)) continue
        target.ids.add(key)
      }
      target.records.push(record)
    }
    for (const [slug, target] of targets) {
      if (writeList(join(dir, slug + '.json'), target.records.slice(-limit)) !== true) {
        warn('dsh-auto-pass: 旧记录拆分写入失败，已保留原文件 ' + legacyFile)
        return
      }
    }
    try {
      rmSync(legacyFile, { force: true })
    } catch (error) {
      warn('dsh-auto-pass: 旧记录文件删除失败 ' + legacyFile + '：' + errorMessage(error))
    }
  }

  /** 已经装载过的记录 id：旧文件被写回、迁移跑过两次时，同一份历史会出现在两处。 */
  const seenIds = new Set()

  /** 装载一条记录：id 重复时只留先读到的那条（去重只发生在装载路径，add 永远照收）。 */
  function adoptLoaded(bucket, record) {
    const key = recordKeyOf(record)
    if (key !== undefined) {
      if (seenIds.has(key)) return
      seenIds.add(key)
    }
    adopt(bucket, record)
  }

  /** 启动装载：单文件形态读那一个文件，目录形态读目录下所有工作区文件。 */
  function load() {
    if (dir === undefined) {
      const bucket = bucketFor('')
      for (const record of readList(singleFile)) adoptLoaded(bucket, record)
      return
    }
    let names
    try {
      names = readdirSync(dir)
    } catch (error) {
      if (error?.code !== 'ENOENT') warn('dsh-auto-pass: 审批记录目录读取失败 ' + dir + '：' + errorMessage(error))
      return
    }
    for (const name of names.filter(entry => entry.endsWith('.json')).sort()) {
      const bucket = bucketFor(name.slice(0, -'.json'.length))
      for (const record of readList(bucket.file)) adoptLoaded(bucket, record)
    }
  }

  migrateLegacyFile()
  load()

  return {
    enabled: true,
    /** 按工作区分文件的目录（单文件形态下是 undefined）。 */
    dir,
    /** 单文件路径（目录形态下是 undefined）。 */
    file: singleFile,
    limit,
    /** 追加一条记录（按它的 cwd 落到对应工作区，自动截断到上限）并落盘。 */
    add(record) {
      const bucket = bucketFor(dir === undefined ? '' : workspaceSlug(record?.cwd))
      adopt(bucket, record)
      writeList(bucket.file, bucket.records)
      return record
    },
    /** 按 id 取一条记录（时间线上的「升级/降级」要用它的签名与建议规则）。 */
    get(id) {
      if (id === undefined || id === null) return undefined
      for (const bucket of buckets.values()) {
        const found = bucket.records.find(record => record.id === id)
        if (found !== undefined) return found
      }
      return undefined
    },
    /** 就地合并字段并落盘；记录不存在时返回 undefined。 */
    update(id, patch) {
      if (id === undefined || id === null) return undefined
      for (const bucket of buckets.values()) {
        const index = bucket.records.findIndex(record => record.id === id)
        if (index === -1) continue
        bucket.records[index] = { ...bucket.records[index], ...patch }
        writeList(bucket.file, bucket.records)
        return bucket.records[index]
      }
      return undefined
    },
    /** 倒序列出**所有工作区**合并后的记录；`session` 给定时只返回该会话的记录。 */
    list(filter = {}) {
      const session = filter.session
      const all = []
      for (const bucket of buckets.values()) {
        for (const record of bucket.records) {
          if (session !== undefined && session !== '' && record.sessionId !== session) continue
          all.push(record)
        }
      }
      all.sort((left, right) => {
        const byTime = String(left.time ?? '').localeCompare(String(right.time ?? ''))
        return byTime !== 0 ? byTime : (order.get(left) ?? 0) - (order.get(right) ?? 0)
      })
      return all.reverse()
    },
    /** 记录总数（所有工作区之和）。 */
    size() {
      let total = 0
      for (const bucket of buckets.values()) total += bucket.records.length
      return total
    },
  }
}

/** 统一取出错误信息文本。 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
