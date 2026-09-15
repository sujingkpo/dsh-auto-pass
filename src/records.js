/**
 * @description 审批记录仓库（host 侧）。维护一次进程内的记录列表并原子写入
 *   JSON 文件，供右侧栏「审批记录」时间轴读取；对外一律按时间倒序返回。
 *   IO 失败只告警，绝不打断审批流程。
 * @author simon300000
 * @date 2026-09-15
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 落盘文件格式版本，便于以后迁移。 */
export const RECORD_FILE_VERSION = 1

/** 默认保留的记录条数上限。 */
export const DEFAULT_MAX_RECORDS = 1_000

/** 单条记录里动作参数的最大保存长度：足够辨认是什么操作，又不至于把大 payload 塞进日志。 */
export const MAX_RECORD_ACTION_CHARS = 500

/**
 * 记录文件默认路径：`$DSH_HOME/dsh-auto-pass/approvals.json`；
 * `DSH_HOME` 未设置时回退到 `~/.dsh`（DSH 自己的 home 约定）。
 */
export function defaultLogFile(env = process.env) {
  const home = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'dsh-auto-pass', 'approvals.json')
}

/** 空仓库：未启用记录能力（如单元测试默认）时使用，保证调用点无需判空。 */
export const noopRecordStore = Object.freeze({
  enabled: false,
  file: undefined,
  add: record => record,
  list: () => [],
  size: () => 0,
})

/**
 * 创建记录仓库。
 * @param options.file 落盘路径，默认 {@link defaultLogFile}。
 * @param options.limit 保留条数上限，超出后丢弃最旧的记录。
 * @param options.warn 告警回调（读写失败时调用）。
 */
export function createRecordStore(options = {}) {
  const file = options.file ?? defaultLogFile()
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0
    ? options.limit
    : DEFAULT_MAX_RECORDS
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  let records = readFromDisk()

  /** 读盘：文件缺失、损坏或格式不符时视作空仓库，并告警说明原因。 */
  function readFromDisk() {
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      // 首次运行没有文件属于正常情况，不告警。
      if (error?.code !== 'ENOENT') warn(`dsh-auto-pass: 审批记录读取失败 ${file}：${errorMessage(error)}`)
      return []
    }
    try {
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : parsed?.records
      if (!Array.isArray(list)) {
        warn(`dsh-auto-pass: 审批记录格式不符，已按空仓库启动 ${file}`)
        return []
      }
      return list.filter(record => record !== null && typeof record === 'object').slice(-limit)
    } catch (error) {
      warn(`dsh-auto-pass: 审批记录解析失败，已按空仓库启动 ${file}：${errorMessage(error)}`)
      return []
    }
  }

  /** 落盘：先写临时文件再改名，避免进程中断留下半截 JSON。 */
  function persistToDisk() {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ version: RECORD_FILE_VERSION, records }, null, 2)}\n`, 'utf8')
      renameSync(temporary, file)
    } catch (error) {
      warn(`dsh-auto-pass: 审批记录写入失败 ${file}：${errorMessage(error)}`)
    }
  }

  return {
    enabled: true,
    file,
    limit,
    /** 追加一条记录（自动截断到上限）并落盘。 */
    add(record) {
      records.push(record)
      if (records.length > limit) records = records.slice(-limit)
      persistToDisk()
      return record
    },
    /** 倒序列出记录；`session` 给定时只返回该会话的记录。 */
    list(filter = {}) {
      const session = filter.session
      const selected = session === undefined || session === ''
        ? records
        : records.filter(record => record.sessionId === session)
      return selected.slice().reverse()
    },
    size() {
      return records.length
    },
  }
}

/** 统一取出错误信息文本。 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
