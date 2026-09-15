/**
 * @description 审批策略仓库（host 侧）。把「相似权限」归一化成**确定性签名**，维护项目级 /
 *   全局级两套白名单（放行）与黑名单（转人工）规则，并对每次「人工放行」计数：
 *   同一项目下同一签名连续人工放行达到阈值后，自动把该签名升级为免审查规则。
 *   匹配器只认三种闭集条件（精确签名 / 命令前缀 / 路径前缀），升级规则由 DSH 模型产出，
 *   插件只做确定性匹配；任何 IO 失败都只告警，绝不改变审批结论。
 * @author simon300000
 * @date 2026-09-15
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 策略文件格式版本，便于以后迁移。 */
export const POLICY_FILE_VERSION = 1

/** 连续人工放行多少次后自动升级为免审查规则。 */
export const DEFAULT_AUTO_APPROVE_AFTER = 3

/** 前缀类条件的最短长度：太短的前缀等于全放行，必须挡住。 */
export const MIN_PREFIX_CHARS = 3

/** 匹配条件闭集：signature=精确签名，command_prefix=命令前缀，path_prefix=路径前缀。 */
export const MATCH_KINDS = Object.freeze(['signature', 'command_prefix', 'path_prefix'])

/** 规则所属名单：allow=白名单（直接放行），deny=黑名单（直接转人工）。 */
export const POLICY_LISTS = Object.freeze(['allow', 'deny'])

/** 规则作用域：project=当前项目（会话 cwd），global=全局。 */
export const POLICY_SCOPES = Object.freeze(['project', 'global'])

/** 规则来源：user=用户手动升级/降级，model=模型产出，memory=连续放行自动升级。 */
export const RULE_SOURCES = Object.freeze(['user', 'model', 'memory'])

/** 按「命令文本」取签名的工具：这类工具的关键参数是一条命令。 */
const COMMAND_TOOLS = Object.freeze(['pwsh', 'bash', 'shell', 'sh', 'zsh', 'cmd', 'powershell'])

/** 视为命令的参数名。 */
const COMMAND_ARG_KEYS = Object.freeze(['command', 'script', 'cmd'])

/** 视为路径的参数名（用于路径前缀条件）。 */
const PATH_ARG_KEYS = Object.freeze(['file_path', 'filePath', 'path', 'paths', 'target', 'destination'])

/** 前缀之后必须出现分隔符才算命中：`git status --short` 合法，`git statusx` 不合法。 */
const PREFIX_BOUNDARY = /^[\s;&|<>)"']/

/** 签名里保留的剩余参数 JSON 上限，避免超长 payload 撑爆策略文件。 */
const MAX_SIGNATURE_ARGS_CHARS = 400

/** 归一化任意文本：折叠空白并去首尾空格。 */
export function normalizeText(value) {
  return String(value).replace(/\s+/g, ' ').trim()
}

/** 归一化路径：统一分隔符、折叠空白、去掉尾部分隔符。 */
export function normalizePath(value) {
  const text = normalizeText(value).replace(/\\/g, '/')
  return text.length > 1 ? text.replace(/\/+$/, '') : text
}

/** 稳定序列化：键排序，保证同一组参数永远得到同一字符串。 */
function stableJson(value) {
  return JSON.stringify(sortValue(value)).slice(0, MAX_SIGNATURE_ARGS_CHARS)
}

/** 递归按键排序，供稳定序列化使用。 */
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value === null || typeof value !== 'object') return value
  const sorted = {}
  for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key])
  return sorted
}

/** 从参数对象里挑出命令文本，没有则返回 undefined。 */
function pickCommand(args) {
  for (const key of COMMAND_ARG_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return normalizeText(value)
  }
  return undefined
}

/** 从参数对象里挑出全部路径型参数。 */
function pickPaths(args) {
  const paths = []
  for (const key of PATH_ARG_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') paths.push(normalizePath(value))
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim() !== '') paths.push(normalizePath(item))
      }
    }
  }
  return Object.freeze(paths)
}

/** 生成人类可读的动作标签，用于时间线与规则列表展示。 */
function labelOf(toolName, command, paths, args) {
  if (command !== undefined) return (toolName + ': ' + command).slice(0, 120)
  if (paths.length > 0) return (toolName + ': ' + paths[0]).slice(0, 120)
  const json = stableJson(args)
  return json === '{}' ? toolName : (toolName + ': ' + json).slice(0, 120)
}

/**
 * 把一次待审批请求归一化成签名。签名是「相似权限」的判定单位：
 * 同一工具 + 同一关键参数 = 同一签名，与调用 id、时间无关。
 * @param request 审批请求（只用 toolName）。
 * @param action 精确动作（exactAction 的结果，可能为 undefined）。
 * @returns 冻结的 { toolName, key, command, paths, text }；缺少动作参数时 key 仍可用（空参签名）。
 */
export function signatureOf(request, action) {
  const toolName = String(request?.toolName ?? action?.toolName ?? 'unknown')
  const args = parseArguments(action?.arguments)
  const command = pickCommand(args)
  const paths = pickPaths(args)
  const structured = { ...args }
  for (const key of [...COMMAND_ARG_KEYS, ...PATH_ARG_KEYS]) delete structured[key]
  // 除命令/路径之外的参数（例如提权标记）同样进签名：提权重试不该与普通调用算作同一种权限。
  const extra = stableJson(structured)
  const base = COMMAND_TOOLS.includes(toolName.toLowerCase()) && command !== undefined
    ? 'cmd:' + command
    : 'args:' + stableJson(args)
  return Object.freeze({
    toolName,
    key: toolName + '\u0000' + base + '\u0000x:' + extra,
    command,
    paths,
    text: labelOf(toolName, command, paths, args),
  })
}

/**
 * 归一化动作参数。会话里的 tool/call 事件在不同来源下可能是对象、也可能是 JSON 字符串；
 * 若把字符串直接当对象用，所有同类调用都会塌缩成同一个空参数签名——那等于把一条记忆
 * 规则放大成「整个工具以后都放行」。所以这里显式解析一层：JSON 字符串解析成对象，
 * 解析不出来就退化为「整段文本就是命令」。
 */
function parseArguments(raw) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return { command: raw }
  }
}

/** 规则工厂：字段齐全、形状固定，避免各处手搓对象。 */
export function createRule(fields) {
  return Object.freeze({
    id: randomUUID(),
    scope: fields.scope,
    list: fields.list,
    tool: fields.tool,
    match: Object.freeze({ kind: fields.match.kind, value: fields.match.value }),
    label: fields.label,
    source: fields.source,
    createdAt: new Date().toISOString(),
    ...(fields.note === undefined ? {} : { note: fields.note }),
  })
}

/** 校验一条候选规则（来自模型或用户输入）是否合法可存。 */
export function validateRuleInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'rule must be an object' }
  }
  if (typeof value.tool !== 'string' || value.tool.trim() === '') {
    return { ok: false, error: 'rule.tool must be a non-empty string' }
  }
  if (typeof value.label !== 'string' || value.label.trim() === '') {
    return { ok: false, error: 'rule.label must be a non-empty string' }
  }
  const match = value.match
  if (match === null || typeof match !== 'object' || Array.isArray(match)) {
    return { ok: false, error: 'rule.match must be an object' }
  }
  if (!MATCH_KINDS.includes(match.kind)) {
    return { ok: false, error: 'rule.match.kind must be one of ' + MATCH_KINDS.join('/') }
  }
  if (typeof match.value !== 'string' || match.value.trim() === '') {
    return { ok: false, error: 'rule.match.value must be a non-empty string' }
  }
  if (match.kind !== 'signature' && normalizeText(match.value).length < MIN_PREFIX_CHARS) {
    return { ok: false, error: 'rule.match.value must be at least ' + String(MIN_PREFIX_CHARS) + ' characters for prefix conditions' }
  }
  return {
    ok: true,
    rule: { tool: value.tool.trim(), match: { kind: match.kind, value: match.value }, label: value.label.trim() },
  }
}

/**
 * 确定性匹配：一条规则是否覆盖给定签名。白名单与黑名单共用它，行为可预期、可单测。
 * - signature：与签名 key 完全相等。
 * - command_prefix：同工具、签名含命令、命令（忽略大小写）以该前缀开头且后接分隔符或结束。
 * - path_prefix：同工具、任一路径参数等于该前缀或位于该前缀目录之下。
 */
export function matchRule(rule, signature) {
  if (rule === null || typeof rule !== 'object' || signature === undefined || signature === null) return false
  const match = rule.match
  if (match === null || typeof match !== 'object') return false
  if (rule.tool !== signature.toolName) return false
  if (match.kind === 'signature') return match.value === signature.key
  if (match.kind === 'command_prefix') {
    if (typeof signature.command !== 'string') return false
    const prefix = normalizeText(match.value).toLowerCase()
    if (prefix.length < MIN_PREFIX_CHARS) return false
    const command = signature.command.toLowerCase()
    if (!command.startsWith(prefix)) return false
    const rest = command.slice(prefix.length)
    return rest === '' || PREFIX_BOUNDARY.test(rest)
  }
  if (match.kind === 'path_prefix') {
    const prefix = normalizePath(match.value).toLowerCase()
    if (prefix.length < MIN_PREFIX_CHARS) return false
    const base = prefix.endsWith('/') ? prefix : prefix + '/'
    return signature.paths.some(candidate => {
      const path = normalizePath(candidate).toLowerCase()
      return path === prefix || path.startsWith(base)
    })
  }
  return false
}

/** 全局策略文件默认路径：`$DSH_HOME/dsh-auto-pass/policy.json`。 */
export function defaultPolicyFile(env = process.env) {
  const home = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'dsh-auto-pass', 'policy.json')
}

/** 项目策略文件路径：`<cwd>/.dsh-auto-pass/policy.json`；没有工作目录时返回 undefined。 */
export function projectPolicyFile(cwd) {
  return typeof cwd === 'string' && cwd.trim() !== ''
    ? join(cwd, '.dsh-auto-pass', 'policy.json')
    : undefined
}

/** 空策略文档。counters 的键是 `<cwd>\u0000<signatureKey>`，计数始终落在全局文件里。 */
function emptyDoc() {
  return { version: POLICY_FILE_VERSION, rules: { allow: [], deny: [] }, counters: {} }
}

/** 未启用策略能力时的替身：一律「没有命中」，写入静默失败。 */
export const noopPolicyStore = Object.freeze({
  enabled: false,
  globalFile: undefined,
  threshold: () => DEFAULT_AUTO_APPROVE_AFTER,
  match: () => undefined,
  observe: () => Object.freeze({ approvals: 0, promoted: null }),
  snapshot: () => Object.freeze({
    threshold: DEFAULT_AUTO_APPROVE_AFTER,
    global: Object.freeze({ allow: [], deny: [] }),
    project: undefined,
  }),
  addRule: () => ({ ok: false, error: 'policy store disabled' }),
  removeRule: () => false,
  setThreshold: () => DEFAULT_AUTO_APPROVE_AFTER,
})

/**
 * 创建策略仓库。
 * @param options.globalFile 全局策略文件路径，默认 defaultPolicyFile()。
 * @param options.autoApproveAfter 阈值缺省值（全局文件里没写阈值时用它）。
 * @param options.warn 告警回调（读写失败时调用）。
 */
export function createPolicyStore(options = {}) {
  const globalFile = options.globalFile ?? defaultPolicyFile()
  const fallbackThreshold = Number.isSafeInteger(options.autoApproveAfter) && options.autoApproveAfter >= 1
    ? options.autoApproveAfter
    : DEFAULT_AUTO_APPROVE_AFTER
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  const docs = new Map([[globalFile, read(globalFile)]])

  /** 读盘：文件缺失按空文档处理；解析失败告警并重置，绝不让坏文件拦住审批。 */
  function read(file) {
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      // 首次运行没有文件属于正常情况，不告警。
      if (error?.code !== 'ENOENT') warn('dsh-auto-pass: 策略文件读取失败 ' + file + '：' + errorMessage(error))
      return emptyDoc()
    }
    try {
      const parsed = JSON.parse(raw)
      const doc = emptyDoc()
      if (parsed !== null && typeof parsed === 'object') {
        for (const list of POLICY_LISTS) {
          const rules = parsed.rules?.[list]
          if (Array.isArray(rules)) doc.rules[list] = rules.filter(rule => rule !== null && typeof rule === 'object')
        }
        if (parsed.counters !== null && typeof parsed.counters === 'object') doc.counters = { ...parsed.counters }
        if (Number.isSafeInteger(parsed.threshold) && parsed.threshold >= 1) doc.threshold = parsed.threshold
      }
      return doc
    } catch (error) {
      warn('dsh-auto-pass: 策略文件解析失败，已重置 ' + file + '：' + errorMessage(error))
      return emptyDoc()
    }
  }

  /** 落盘：临时文件 + rename，避免半截 JSON；失败只告警并返回 false。 */
  function write(file, doc) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temporary = file + '.tmp'
      writeFileSync(temporary, JSON.stringify(doc, null, 2) + '\n', 'utf8')
      renameSync(temporary, file)
      return true
    } catch (error) {
      warn('dsh-auto-pass: 策略文件写入失败 ' + file + '：' + errorMessage(error))
      return false
    }
  }

  /** 取某个策略文件对应的文档（懒加载并缓存）。 */
  function docFor(file) {
    if (file === undefined) return undefined
    let doc = docs.get(file)
    if (doc === undefined) {
      doc = read(file)
      docs.set(file, doc)
    }
    return doc
  }

  /** 项目文档 + 路径；没有 cwd 时返回 undefined。 */
  function projectDoc(cwd) {
    const file = projectPolicyFile(cwd)
    return file === undefined ? undefined : { file, doc: docFor(file) }
  }

  function view(doc) {
    return Object.freeze({
      allow: Object.freeze([...doc.rules.allow]),
      deny: Object.freeze([...doc.rules.deny]),
    })
  }

  function currentThreshold() {
    const value = docs.get(globalFile)?.threshold
    return Number.isSafeInteger(value) && value >= 1 ? value : fallbackThreshold
  }

  /** 同一工具 + 同 kind + 同 value 视为同一条规则（重复升级只更新内容）。 */
  function sameTarget(left, right) {
    return left.tool === right.tool
      && left.match?.kind === right.match?.kind
      && left.match?.value === right.match?.value
  }

  /** 写入前统一处理：去重、把新规则追加到名单末尾、同一签名存在人工规则时清掉计数。 */
  function commit(file, scope, list, fields, rawRule) {
    const doc = docFor(file)
    const created = createRule({
      ...fields,
      scope,
      list,
      source: rawRule.source ?? 'user',
      ...(rawRule.note === undefined ? {} : { note: rawRule.note }),
    })
    doc.rules[list] = [...doc.rules[list].filter(candidate => !sameTarget(candidate, created)), created]
    if (created.match.kind === 'signature') delete doc.counters[(fields.cwd ?? '') + '\u0000' + created.match.value]
    return write(file, doc) ? created : undefined
  }

  /**
   * 落一条规则。项目作用域写不进盘（目录只读等）时降级写全局，并把实际作用域返回给调用方。
   */
  function addRule(spec, cwd) {
    if (!POLICY_LISTS.includes(spec.list) || !POLICY_SCOPES.includes(spec.scope)) {
      return { ok: false, error: 'invalid scope or list' }
    }
    const checked = validateRuleInput(spec.rule)
    if (!checked.ok) return { ok: false, error: checked.error }
    const wantsProject = spec.scope === 'project'
    if (wantsProject && projectPolicyFile(cwd) === undefined) {
      warn('dsh-auto-pass: 当前会话没有工作目录，升级规则改为写入全局策略')
    }
    const file = wantsProject ? projectPolicyFile(cwd) : globalFile
    const scope = file === undefined ? 'global' : spec.scope
    const target = file ?? globalFile
    const created = commit(target, scope, spec.list, { ...checked.rule, cwd }, spec.rule)
    if (created !== undefined) return { ok: true, rule: created, scope, file: target }
    if (scope === 'project') {
      warn('dsh-auto-pass: 项目策略写入失败，已改为写入全局策略')
      return addRule({ ...spec, scope: 'global' }, cwd)
    }
    return { ok: false, error: 'policy write failed', file: target }
  }

  /** 删一条规则（按 id）。返回是否真的删掉了。 */
  function removeRule({ scope, list, id }, cwd) {
    if (!POLICY_LISTS.includes(list) || !POLICY_SCOPES.includes(scope)) return false
    const file = scope === 'project' ? projectPolicyFile(cwd) : globalFile
    const doc = docFor(file)
    if (doc === undefined) return false
    const before = doc.rules[list].length
    doc.rules[list] = doc.rules[list].filter(rule => rule.id !== id)
    if (doc.rules[list].length === before) return false
    write(file, doc)
    return true
  }

  return {
    enabled: true,
    globalFile,
    threshold: currentThreshold,
    /** 阈值写入全局文件（阈值是跨项目的用户偏好）。 */
    setThreshold(value) {
      if (!Number.isSafeInteger(value) || value < 1) return currentThreshold()
      const doc = docs.get(globalFile)
      doc.threshold = value
      write(globalFile, doc)
      return value
    },
    /** 快照：阈值 + 全局/项目两级白黑名单与文件路径，供「审批设置」面板展示。 */
    snapshot(cwd) {
      const project = projectDoc(cwd)
      return {
        threshold: currentThreshold(),
        global: view(docs.get(globalFile)),
        ...(project === undefined ? {} : { project: view(project.doc) }),
        globalFile,
        ...(project === undefined ? {} : { projectFile: project.file }),
      }
    },
    /** 命中查询：黑名单优先（deny 永远压过 allow），其次项目、最后全局。 */
    /** 落一条白/黑名单规则（时间线升级/降级与记忆自动升级都走这里）。 */
    addRule,
    /** 删一条规则（时间线里撤销升级/降级）。 */
    removeRule,
    match({ signature, cwd }) {
      if (signature === undefined) return undefined
      const find = lists => {
        for (const scope of ['project', 'global']) {
          const target = scope === 'project' ? projectDoc(cwd) : { file: globalFile, doc: docs.get(globalFile) }
          if (target === undefined || target.doc === undefined) continue
          for (const list of lists) {
            const rule = target.doc.rules[list].find(candidate => matchRule(candidate, signature))
            if (rule !== undefined) return { list, scope, rule, file: target.file }
          }
        }
        return undefined
      }
      return find(['deny']) ?? find(['allow'])
    },
    /**
     * 记录一次「人工放行/拒绝」并维护计数：
     * - 人工放行 → 计数 +1；达到阈值就把该签名升级为免审查规则（项目作用域优先）。
     * - 人工拒绝 → 计数清零（连续被打破）。
     * 只有 fromHuman 为 true 才计数，插件自己的自动放行不计。
     */
    observe({ signature, cwd, outcome, fromHuman }) {
      if (fromHuman !== true || signature === undefined || signature.key === undefined) {
        return { approvals: 0, promoted: null }
      }
      const doc = docs.get(globalFile)
      const counterKey = (cwd ?? '') + '\u0000' + signature.key
      if (outcome === 'rejected') {
        if (doc.counters[counterKey] !== undefined) {
          delete doc.counters[counterKey]
          write(globalFile, doc)
        }
        return { approvals: 0, promoted: null }
      }
      if (outcome !== 'allowed-once') return { approvals: doc.counters[counterKey]?.count ?? 0, promoted: null }
      const count = (doc.counters[counterKey]?.count ?? 0) + 1
      const threshold = currentThreshold()
      if (count < threshold) {
        doc.counters[counterKey] = { count, updatedAt: new Date().toISOString() }
        write(globalFile, doc)
        return { approvals: count, promoted: null }
      }
      // 达到阈值：升级为项目级免审查规则（没有 cwd 时落全局），并把计数清零。
      delete doc.counters[counterKey]
      write(globalFile, doc)
      const added = addRule({
        scope: typeof cwd === 'string' && cwd !== '' ? 'project' : 'global',
        list: 'allow',
        rule: {
          tool: signature.toolName,
          match: { kind: 'signature', value: signature.key },
          label: signature.text,
          source: 'memory',
          note: '连续 ' + String(threshold) + ' 次人工放行后自动升级',
        },
      }, cwd)
      return { approvals: count, promoted: added?.ok === true ? added.rule : null }
    },
  }
}

/** 统一取出错误信息文本。 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
