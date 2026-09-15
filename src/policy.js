/**
 * @description 审批策略仓库（host 侧）。把「相似权限」归一化成**确定性签名**，维护项目级 /
 *   全局级两套白名单（放行）与黑名单（转人工）规则，并对每次审批结果计数：同一项目下
 *   同一签名连续放行 / 连续被拒达到阈值时，**只返回一条升级建议**，由调用方走
 *   「DSH 模型优化 → ask 询问用户 → 落盘」，绝不静默放宽或收紧权限。
 *   匹配器只认三种闭集条件（精确签名 / 命令前缀 / 路径前缀），规则文本由 DSH 模型产出，
 *   插件只做确定性匹配；任何 IO 失败都只告警，绝不改变审批结论。
 * @author simon300000
 * @date 2026-09-15
 * @modify 2026-09-15 计数分白/黑两侧、达阈值改为返回建议（不再自动落盘），新增 dismiss
 * @modify 2026-09-15 查重改成语义包含：comparableValue 归一化比对值（空白/大小写）+ ruleCovers 覆盖判定——重复添加=更新、被已有规则覆盖=不写入（covered）、覆盖窄规则=合并（merged）
 * @modify 2026-09-15 计数键再抹掉命令里第一个管道及其后面（countingCommand，跳过引号内的 |）：同一条命令换输出截断不再各算一条
 * @modify 2026-09-15 计数键继续归一化：结尾的纯输出重定向（2>&1 等）一并抹掉、workdir/cwd 不进计数键（精确签名里按路径归一化保留）；新增 canonicalMemoryKey + canonicalizeCounters 把历史死键折算到当前口径
 * @modify 2026-09-15 新增 updateRule：按 id 原地改一条已有规则（id/位置不变、source 记 user、与 addRule 同口径合并重复或更窄的规则）
 * @modify 2026-09-15 路径前缀支持单层通配：matchRule 认最后一段里的 *（不跨目录），validatePathPattern 明确拒绝 ** / ? / [] / 中段 * / 无目录的通配
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 策略文件格式版本，便于以后迁移。 */
export const POLICY_FILE_VERSION = 1

/** 连续放行多少次后，询问是否加入白名单（默认值，策略文件里可覆盖）。 */
export const DEFAULT_AUTO_APPROVE_AFTER = 3

/** 连续被拒多少次后，询问是否加入黑名单（默认值，策略文件里可覆盖）。 */
export const DEFAULT_AUTO_DENY_AFTER = 3

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

/**
 * 只决定「在哪儿执行」的参数：取值按路径归一化。
 * 实测（approvals.json）：同一条 `pnpm test` 因为 workdir 写成 `D:\\work\\x`、`D:/work/x`
 * 或干脆不传，被算成 2–3 种权限（6 组），连续计数永远攒不到阈值。
 */
const WORKDIR_ARG_KEYS = Object.freeze(['workdir', 'cwd'])

/**
 * 命令结尾的「纯输出重定向」：只决定输出往哪儿去（终端 / 空设备），不改变在授权什么。
 * `2>&1` / `>nul` / `2>/dev/null` 这类留在计数键里，同一条命令换个写法就各算一条。
 */
const OUTPUT_REDIRECT_TAIL = /(?:\s|^)(?:\d?>{1,2}\s*(?:&1|&2|nul|\/dev\/null)|&>{1,2}\s*(?:nul|\/dev\/null))$/i

/** 前缀之后必须出现分隔符才算命中：`git status --short` 合法，`git statusx` 不合法。 */
const PREFIX_BOUNDARY = /^[\s;&|<>)"']/

/**
 * 只影响展示或执行管道、不改变「这次到底在授权什么」的参数。
 * 实测（approvals.json）：同一条 `pnpm test` 的两次自动放行，因为 description / justification /
 * timeoutMs 不同而拿到不同的精确签名——连续计数永远攒不到阈值，记忆功能等于死代码。
 * 所以计数另用一个「记忆键」（抹掉这些噪声），而**规则匹配仍用精确签名**：
 * 用户手动升级某条记录时写下的仍是那条精确规则，不会因为计数变粗而放宽。
 */
export const NOISE_ARG_KEYS = Object.freeze(['description', 'justification', 'timeoutMs', 'timeout_ms'])

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

/**
 * 计数用的命令文本：砍掉第一个**不在引号内**的管道（`|`）及其后面的部分。
 * 管道后面只决定「怎么显示输出」（`| Select-Object -Last 40`、`| Select-String …`），
 * 不改变在授权什么；不砍掉的话「同一件事换了个输出截断」就成了两条权限，
 * 「连续放行 N 次」永远攒不到阈值（2026-09-15 真机踩到：用户连续批准了 4 次
 * `pnpm vitest run tests/client.spec.js 2>&1 | Select-Object -Last 60/45/30/26`，一次都没触发询问）。
 * 之后再抹掉结尾的纯输出重定向（`2>&1` / `>nul` / `2>/dev/null`）：它只决定输出往哪儿去。
 * 只影响**计数键**，不影响精确签名：规则匹配仍然逐字比对（`key` 里原样保留）。
 * @param {string} command 命令文本
 * @returns {string} 砍掉管道之后与结尾输出重定向的命令文本
 */
export function countingCommand(command) {
  let text = normalizeText(command)
  const cut = firstPipeOutsideQuotes(text)
  if (cut !== -1) text = normalizeText(text.slice(0, cut))
  // 结尾的输出重定向继续抹（可能有多个）：`pnpm test 2>&1` → `pnpm test`
  for (let guard = 0; guard < 8; guard += 1) {
    const next = normalizeText(text.replace(OUTPUT_REDIRECT_TAIL, ''))
    if (next === text) break
    text = next
  }
  return text
}

/** 找第一个不在引号里的 `|`；找不到返回 -1（引号内的竖线常见于正则，不该当成管道）。 */
function firstPipeOutsideQuotes(text) {
  let quote = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== '') {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '|') return index
  }
  return -1
}

/**
 * 归一化「命令/路径之外」的参数（它们照样进签名，例如提权标记）：
 * `workdir` / `cwd` 按路径归一化——`D:\\x` 与 `D:/x` 是同一个目录，不该算两种权限。
 * 这里是**纯函数**（只看参数本身）：绝不拿会话工作目录去补齐缺省值，否则同一组参数
 * 会因为调用点知不知道 cwd 而得到不同的签名，规则匹配会莫名其妙失效。
 * @param args 原始参数
 * @returns {object} 归一化后的参数副本
 */
function normalizeExtraArgs(args) {
  const copy = { ...args }
  for (const key of WORKDIR_ARG_KEYS) {
    const value = copy[key]
    if (typeof value !== 'string' || value.trim() === '') continue
    copy[key] = normalizePath(value)
  }
  return copy
}

/** 复制一份参数并抹掉「在哪儿执行」的键（只给计数键用，见 signatureOf）。 */
function withoutDirArgs(args) {
  const copy = { ...args }
  for (const key of WORKDIR_ARG_KEYS) delete copy[key]
  return copy
}

/** 复制一份参数并抹掉噪声键，供记忆键使用。 */
function withoutNoise(args) {
  const copy = { ...args }
  for (const key of NOISE_ARG_KEYS) delete copy[key]
  return copy
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
 * @returns 冻结的 { toolName, key, memoryKey, command, paths, text }；缺少动作参数时 key 仍可用（空参签名）。
 */
export function signatureOf(request, action) {
  const toolName = String(request?.toolName ?? action?.toolName ?? 'unknown')
  const args = parseArguments(action?.arguments)
  const command = pickCommand(args)
  const paths = pickPaths(args)
  // 先归一化「在哪儿执行」，再拆成 base 与 x: 两段（计数键的折算也按同一套算法）
  const normalized = normalizeExtraArgs(args)
  const structured = { ...normalized }
  for (const key of [...COMMAND_ARG_KEYS, ...PATH_ARG_KEYS]) delete structured[key]
  // 除命令/路径之外的参数（例如提权标记）同样进签名：提权重试不该与普通调用算作同一种权限。
  const extra = stableJson(structured)
  const base = COMMAND_TOOLS.includes(toolName.toLowerCase()) && command !== undefined
    ? 'cmd:' + command
    : 'args:' + stableJson(normalized)
  // 记忆键：同样去掉噪声参数，命令再砍掉管道之后（只换了输出截断的同一条命令归到同一个计数）；
  // 提权标记这类真会改变授权范围的参数保留，提权重试不会与普通调用混在一起计数。
  const memoryCommand = command === undefined ? undefined : countingCommand(command)
  // 计数键再抹掉「在哪儿执行」：计数键本身已经带 `<cwd>` 前缀，同一个工作区里的目录差异
  // （`workdir` 写没写、D:\\x 还是 D:/x）只该算同一条权限，否则连续计数永远攒不到阈值。
  const memoryBase = COMMAND_TOOLS.includes(toolName.toLowerCase()) && memoryCommand !== undefined
    ? 'cmd:' + memoryCommand
    : 'args:' + stableJson(withoutNoise(withoutDirArgs(normalized)))
  return Object.freeze({
    toolName,
    key: toolName + '\u0000' + base + '\u0000x:' + extra,
    memoryKey: toolName + '\u0000' + memoryBase + '\u0000x:' + stableJson(withoutNoise(withoutDirArgs(structured))),
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
  // 路径前缀支持**单层通配**（用户 2026-09-15 要求）：只允许一个 * 出现在最后一段（文件名部分）。
  // 跨目录的 ** 会一条规则放行任意位置的同类文件（包括 DSH 自身），明确拒绝；? 与 [] 也不支持。
  if (match.kind === 'path_prefix') {
    const checked = validatePathPattern(match.value)
    if (checked.ok !== true) return checked
  }
  return {
    ok: true,
    rule: { tool: value.tool.trim(), match: { kind: match.kind, value: match.value }, label: value.label.trim() },
  }
}

/**
 * 校验路径前缀里的通配符（只认单层 `*`）：
 * - `**` 一律拒绝——跨目录通配太宽，等于「任意位置的这类文件都放行」；
 * - `?` / `[` / `]` 不支持（不做正则语义，避免写出看不懂的规则）；
 * - `*` 只允许出现在**最后一段**（文件名），且去掉通配符后仍要满足最短长度。
 * @param value 规则里的路径模式
 * @returns {{ok: boolean, error?: string}} 合法时 ok=true
 */
export function validatePathPattern(value) {
  const pattern = normalizePath(value)
  if (pattern.includes('**')) {
    return { ok: false, error: 'rule.match.value must not use ** (cross-directory wildcards are too broad)' }
  }
  if (/[?[\]]/.test(pattern)) {
    return { ok: false, error: 'rule.match.value only supports * as a wildcard (no ? or [])' }
  }
  const star = pattern.indexOf('*')
  if (star !== -1) {
    const head = pattern.slice(0, star)
    // 通配符前面必须有目录，否则就是 `*.js` 这种相对模式——真实路径都是绝对路径，它一条也命不中
    if (!head.includes('/')) {
      return { ok: false, error: 'rule.match.value: a wildcard needs a directory in front of it (e.g. D:/repo/src/*.js)' }
    }
    if (head.trim().length < MIN_PREFIX_CHARS) {
      return { ok: false, error: 'rule.match.value must be at least ' + String(MIN_PREFIX_CHARS) + ' characters before the wildcard' }
    }
    if (pattern.slice(star + 1).includes('/')) {
      return { ok: false, error: 'rule.match.value: * is only allowed in the last path segment' }
    }
  }
  if (pattern.replace(/\*/g, '').trim().length < MIN_PREFIX_CHARS) {
    return { ok: false, error: 'rule.match.value must be at least ' + String(MIN_PREFIX_CHARS) + ' characters for prefix conditions' }
  }
  return { ok: true }
}

/**
 * 单层通配：`*` 匹配同一段里的任意字符（含空），其余字符按字面量。
 * 只用于 path_prefix 的**最后一段**；调用前已经保证没有 `**` 与其它元字符。
 */
function matchPathSegment(pattern, text) {
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp('^' + source + '$').test(text)
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
    // 老记录（从记录重建签名时不带 paths）没有路径可比：直接不命中，绝不因为字段缺失而放行
    if (!Array.isArray(signature.paths)) return false
    if (prefix.includes('*')) {
      // 单层通配（校验阶段已保证 * 只在最后一段）：目录部分按前缀、文件名部分按 * 匹配，
      // 且**不跨目录**——D:/x/src/*.js 命中 D:/x/src/a.js，不命中 D:/x/src/sub/a.js
      const slash = prefix.lastIndexOf('/')
      const dir = slash === -1 ? '' : prefix.slice(0, slash + 1)
      const pattern = prefix.slice(slash + 1)
      return signature.paths.some(candidate => {
        const path = normalizePath(candidate).toLowerCase()
        if (!path.startsWith(dir)) return false
        const rest = path.slice(dir.length)
        return !rest.includes('/') && matchPathSegment(pattern, rest)
      })
    }
    const base = prefix.endsWith('/') ? prefix : prefix + '/'
    return signature.paths.some(candidate => {
      const path = normalizePath(candidate).toLowerCase()
      return path === prefix || path.startsWith(base)
    })
  }
  return false
}

/**
 * 「是不是同一条规则」的比对值：先折叠空白去首尾空格；前缀类条件再按匹配器的口径
 * （matchRule 对命令/路径都忽略大小写）折叠大小写，签名条件保持精确。
 * 实测踩过的坑（~/.dsh/dsh-auto-pass/policy.json）：模型每次生成的规则文本会有
 * 「pnpm test」与「pnpm test 」（尾部多一个空格）这种差异，按原始字符串比对判不出重复，
 * 名单里就会留下两条同义规则，用户只能手动删一条。
 */
export function comparableValue(rule) {
  const value = rule?.match?.value
  if (typeof value !== 'string') return ''
  // 签名是机器产出的精确 key（含 NUL 与参数 JSON），必须逐字比对：折叠空白会把
  // args:{"content":"a  b"} 与 args:{"content":"a b"} 判成同一条，替换掉旧规则会让
  // 那条签名失去覆盖（审批面变大）。前缀类条件则按 matchRule 的口径忽略大小写。
  if (rule.match.kind === 'signature') return value
  return normalizeText(value).toLowerCase()
}

/**
 * 从签名 key 里取出命令文本（key 形如 `tool\u0000cmd:<command>\u0000x:<参数JSON>`）。
 * 非命令类签名（`args:` 开头）返回 undefined。
 */
function commandOfSignature(key) {
  const head = String(key).split('\u0000')[1]
  return typeof head === 'string' && head.startsWith('cmd:') ? head.slice('cmd:'.length) : undefined
}

/** 前缀是否覆盖给定命令：相等，或命令更长且多出来的部分以分隔符起头（与 matchRule 同一套边界规则）。 */
function prefixCovers(prefix, command) {
  const narrow = normalizeText(prefix).toLowerCase()
  const full = normalizeText(command).toLowerCase()
  if (narrow.length < MIN_PREFIX_CHARS) return false
  if (narrow === full) return true
  if (!full.startsWith(narrow)) return false
  return PREFIX_BOUNDARY.test(full.slice(narrow.length))
}

/**
 * 覆盖判定：规则 left 是否完整覆盖规则 right——凡 right 能命中的动作，left 一定也命中。
 * 只处理三种闭集条件的确定性情形，判不出来一律返回 false（宁可多留一条窄规则，也绝不误删）。
 * - signature：两边都是 signature，且比对值相等。
 * - command_prefix：right 是 command_prefix（更窄的前缀），或 right 是 signature（从 key 里取命令）。
 * - path_prefix：right 是 path_prefix，且位于 left 目录之内（或相等）。
 * @param left 候选的覆盖者（名单里已有的规则）
 * @param right 被判定者（这次要写进去的规则）
 * @returns {boolean} left 覆盖 right 时为 true
 */
export function ruleCovers(left, right) {
  if (left === null || typeof left !== 'object' || right === null || typeof right !== 'object') return false
  if (typeof left.tool !== 'string' || left.tool !== right.tool) return false
  const leftKind = left.match?.kind
  const rightKind = right.match?.kind
  if (leftKind === undefined || rightKind === undefined) return false
  // 匹配值必须是字符串：手搓/损坏的规则文件里可能是数字或缺失，别让它退化成 "undefined" 前缀
  if (typeof left.match.value !== 'string' || typeof right.match.value !== 'string') return false
  if (leftKind === 'signature') return rightKind === 'signature' && comparableValue(left) === comparableValue(right)
  if (leftKind === 'command_prefix') {
    const command = rightKind === 'command_prefix' ? right.match?.value : commandOfSignature(right.match?.value)
    return typeof command === 'string' && prefixCovers(left.match?.value, command)
  }
  if (leftKind === 'path_prefix') {
    if (rightKind !== 'path_prefix') return false
    const wide = normalizePath(left.match?.value).toLowerCase()
    const narrow = normalizePath(right.match?.value).toLowerCase()
    if (wide === narrow) return true
    return narrow.startsWith(wide.endsWith('/') ? wide : wide + '/')
  }
  return false
}

/** 计数用的键：记忆键抹掉了 description / justification / timeoutMs 这类噪声，取不到时退回精确签名。 */
export function memoryKeyOf(signature) {
  return signature?.memoryKey ?? signature?.key
}

/**
 * 把一条**历史**记忆键折算成当前算法会产出的形状（拿它和原键比：不一样就是死键）。
 * 老键里可能带未归一化的 workdir、管道之后的整段、结尾的 `2>&1`——现在的 signatureOf
 * 再也产不出这些形状，它们既不复位也不命中，只会让「count 看起来不准」。
 * 折算不出来（格式不认识）时返回 undefined，调用方按原样保留。
 * @param memoryKey 记忆键（`<tool>\u0000<base>\u0000x:<json>`）
 * @returns {string|undefined} 折算后的记忆键
 */
export function canonicalMemoryKey(memoryKey) {
  if (typeof memoryKey !== 'string' || memoryKey === '') return undefined
  const parts = memoryKey.split('\u0000')
  if (parts.length < 3) return undefined
  const base = parts[1]
  const extraText = parts.slice(2).join('\u0000')
  if (!extraText.startsWith('x:')) return undefined
  let extra
  try {
    extra = JSON.parse(extraText.slice(2))
  } catch {
    return undefined
  }
  if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) return undefined
  let canonicalBase
  if (base.startsWith('cmd:')) {
    canonicalBase = 'cmd:' + countingCommand(base.slice('cmd:'.length))
  } else if (base.startsWith('args:')) {
    let raw
    try {
      raw = JSON.parse(base.slice('args:'.length))
    } catch {
      return undefined
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    canonicalBase = 'args:' + stableJson(withoutNoise(withoutDirArgs(normalizeExtraArgs(raw))))
  } else {
    return undefined
  }
  return parts[0] + '\u0000' + canonicalBase + '\u0000x:' + stableJson(withoutNoise(withoutDirArgs(normalizeExtraArgs(extra))))
}

/** 把一个计数条目归一化成 { allow, deny, dismissed? }（兼容早期只有 count 的形态）。 */
function counterValue(raw) {
  const entry = { allow: 0, deny: 0 }
  if (raw === null || typeof raw !== 'object') return entry
  if (Number.isSafeInteger(raw.count) && raw.count > 0) entry.allow = raw.count
  if (Number.isSafeInteger(raw.allow) && raw.allow > 0) entry.allow = raw.allow
  if (Number.isSafeInteger(raw.deny) && raw.deny > 0) entry.deny = raw.deny
  if (raw.dismissed !== null && typeof raw.dismissed === 'object') entry.dismissed = { ...raw.dismissed }
  return entry
}

/** 合并两个计数条目：两侧各取**较大值**（不求和）——折算历史不该凭空攒出新的连续次数。 */
function mergeCounterEntries(left, right) {
  if (left === undefined) return right
  const merged = { allow: Math.max(left.allow, right.allow), deny: Math.max(left.deny, right.deny) }
  if (left.dismissed !== undefined || right.dismissed !== undefined) {
    merged.dismissed = { ...(left.dismissed ?? {}), ...(right.dismissed ?? {}) }
  }
  return merged
}

/**
 * 一次性折算整张计数表：历史键（带管道、带未归一化 workdir、带 `2>&1`）合并到当前口径的键上。
 * 折算过的键数由调用方写日志；键本来就规范时原样保留（不产生任何变化）。
 * @param counters 计数表
 * @returns {{counters: object, moved: number}} 折算后的计数表与被折算掉的键数
 */
export function canonicalizeCounters(counters) {
  const next = {}
  let moved = 0
  for (const [key, value] of Object.entries(counters ?? {})) {
    const at = key.indexOf('\u0000')
    const canonical = at === -1 ? undefined : canonicalMemoryKey(key.slice(at + 1))
    const target = canonical === undefined ? key : key.slice(0, at + 1) + canonical
    if (target !== key) moved += 1
    next[target] = mergeCounterEntries(next[target], counterValue(value))
  }
  return { counters: next, moved }
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
  return { version: POLICY_FILE_VERSION, rules: { allow: [], deny: [] }, counters: {}, thresholds: {} }
}

/** 未启用策略能力时的替身：一律「没有命中」，写入静默失败。 */
export const noopPolicyStore = Object.freeze({
  enabled: false,
  globalFile: undefined,
  threshold: list => (list === 'deny' ? DEFAULT_AUTO_DENY_AFTER : DEFAULT_AUTO_APPROVE_AFTER),
  match: () => undefined,
  observe: () => Object.freeze({ approvals: 0, denials: 0, suggestion: null }),
  dismiss: () => false,
  snapshot: () => Object.freeze({
    thresholds: Object.freeze({ allow: DEFAULT_AUTO_APPROVE_AFTER, deny: DEFAULT_AUTO_DENY_AFTER }),
    global: Object.freeze({ allow: [], deny: [] }),
    project: undefined,
  }),
  addRule: () => ({ ok: false, error: 'policy store disabled' }),
  removeRule: () => false,
  setThreshold: (value, list = 'allow') => (list === 'deny' ? DEFAULT_AUTO_DENY_AFTER : DEFAULT_AUTO_APPROVE_AFTER),
})

/**
 * 创建策略仓库。
 * @param options.globalFile 全局策略文件路径，默认 defaultPolicyFile()。
 * @param options.autoApproveAfter 阈值缺省值（全局文件里没写阈值时用它）。
 * @param options.warn 告警回调（读写失败时调用）。
 */
export function createPolicyStore(options = {}) {
  const globalFile = options.globalFile ?? defaultPolicyFile()
  const fallbackThresholds = {
    allow: Number.isSafeInteger(options.autoApproveAfter) && options.autoApproveAfter >= 1
      ? options.autoApproveAfter
      : DEFAULT_AUTO_APPROVE_AFTER,
    deny: Number.isSafeInteger(options.autoDenyAfter) && options.autoDenyAfter >= 1
      ? options.autoDenyAfter
      : DEFAULT_AUTO_DENY_AFTER,
  }
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  const info = typeof options.info === 'function' ? options.info : () => {}
  const docs = new Map([[globalFile, read(globalFile)]])
  // 启动时折算一次历史计数键：老的形状（管道之后、未归一化的 workdir、结尾的 2>&1）
  // 在当前算法下再也产不出来，留着只会让计数看着不准——折算到当前口径后原键即消失。
  {
    const doc = docs.get(globalFile)
    const canonical = canonicalizeCounters(doc.counters)
    if (canonical.moved > 0) {
      doc.counters = canonical.counters
      write(globalFile, doc)
      info('dsh-auto-pass: 已折算 ' + String(canonical.moved) + ' 个历史计数键 ' + globalFile)
    }
  }

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
        // 阈值按名单分开：allow=白名单（连续放行），deny=黑名单（连续被拒）。
        // 早期版本只有一个 threshold 字段（白名单阈值），这里按白名单阈值兼容读取。
        if (Number.isSafeInteger(parsed.thresholds?.allow) && parsed.thresholds.allow >= 1) doc.thresholds.allow = parsed.thresholds.allow
        if (Number.isSafeInteger(parsed.thresholds?.deny) && parsed.thresholds.deny >= 1) doc.thresholds.deny = parsed.thresholds.deny
        if (Number.isSafeInteger(parsed.threshold) && parsed.threshold >= 1) doc.thresholds.allow = parsed.threshold
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

  function currentThreshold(list = 'allow') {
    const value = docs.get(globalFile)?.thresholds?.[list]
    return Number.isSafeInteger(value) && value >= 1 ? value : fallbackThresholds[list]
  }

  /** 取计数条目；兼容早期 { count } 形态（当时只统计白名单一侧）。 */
  function counterEntry(doc, key) {
    const raw = doc.counters[key]
    const entry = { allow: 0, deny: 0 }
    if (raw === null || typeof raw !== 'object') return entry
    if (Number.isSafeInteger(raw.count) && raw.count > 0) entry.allow = raw.count
    if (Number.isSafeInteger(raw.allow) && raw.allow > 0) entry.allow = raw.allow
    if (Number.isSafeInteger(raw.deny) && raw.deny > 0) entry.deny = raw.deny
    if (raw.dismissed !== null && typeof raw.dismissed === 'object') entry.dismissed = { ...raw.dismissed }
    return entry
  }

  /**
   * 同一工具 + 同 kind + 同「比对值」（空白与大小写已归一）视为同一条规则。
   * 归一化是必须的：模型每次生成的规则文本可能只差一个尾部空格，按原始字符串比对
   * 判不出重复，用户会在名单里看到两条同义规则。
   */
  function sameTarget(left, right) {
    return left.tool === right.tool
      && left.match?.kind === right.match?.kind
      && comparableValue(left) === comparableValue(right)
  }

  /**
   * 写入前统一处理：查重（同一条规则 = 更新；被已有规则覆盖 = 不重复写入）、合并更窄的旧规则、
   * 把新规则追加到名单末尾、同一签名存在人工规则时清掉计数。同一个「工具 + 匹配条件」在
   * 同一个（文件 × 名单）里永远只会留下一条，覆盖它的窄规则也不会同时存在。
   * @param file 目标策略文件
   * @param scope project / global
   * @param list allow / deny
   * @param fields 已校验的规则字段（tool / match / label）
   * @param rawRule 原始规则输入（取 source / note）
   * @returns {{rule: object, replaced: boolean, covered?: boolean, merged?: number}|undefined}
   *   - replaced：同一条规则已存在，这次是**更新**（调用方提示「已更新同名规则」）；
   *   - covered：已有规则完整覆盖这次的动作，**没有写入**（rule 指向那条已有规则）；
   *   - merged：这次写入顺带合并掉的更窄旧规则条数。
   *   写入失败返回 undefined。
   */
  function commit(file, scope, list, fields, rawRule) {
    const doc = docFor(file)
    const rules = doc.rules[list]
    const created = createRule({
      ...fields,
      scope,
      list,
      source: rawRule.source ?? 'user',
      ...(rawRule.note === undefined ? {} : { note: rawRule.note }),
    })
    const replaced = rules.some(candidate => sameTarget(candidate, created))
    // 已有的某条规则把这次的新规则整个盖住时，新规则带不来任何新覆盖范围：
    // 不写重复条目，如实把那条规则回报给调用方（用户看到「已被 … 覆盖」而不是又加了一条）。
    if (replaced === false) {
      const covering = rules.find(candidate => ruleCovers(candidate, created))
      if (covering !== undefined) return { rule: covering, replaced: false, covered: true, merged: 0 }
    }
    const merged = rules.filter(candidate => !sameTarget(candidate, created) && ruleCovers(created, candidate))
    doc.rules[list] = [
      ...rules.filter(candidate => !sameTarget(candidate, created) && !merged.includes(candidate)),
      created,
    ]
    if (created.match.kind === 'signature') delete doc.counters[(fields.cwd ?? '') + '\u0000' + created.match.value]
    return write(file, doc) ? { rule: created, replaced, covered: false, merged: merged.length } : undefined
  }

  /**
   * 落一条规则。项目作用域写不进盘（目录只读等）时降级写全局，并把实际作用域返回给调用方。
   * 同一个「工具 + 匹配条件」已在同一名单里时**更新那一条**，并用 replaced 如实回报；
   * 升级/降级同一条规则因此永远不会在名单里留下两条。
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
    const committed = commit(target, scope, spec.list, { ...checked.rule, cwd }, spec.rule)
    if (committed !== undefined) {
      return {
        ok: true,
        rule: committed.rule,
        replaced: committed.replaced,
        covered: committed.covered === true,
        merged: committed.merged ?? 0,
        scope,
        file: target,
      }
    }
    if (scope === 'project') {
      warn('dsh-auto-pass: 项目策略写入失败，已改为写入全局策略')
      return addRule({ ...spec, scope: 'global' }, cwd)
    }
    return { ok: false, error: 'policy write failed', file: target }
  }

  /**
   * 改一条已有规则（按 id）：匹配条件与标签换成新的，**id 与位置不变**（时间线/记录里的
   * ruleId 仍指得回来，createdAt 保留原始时间）。
   * 新条件若与名单里另一条重复，或把更窄的规则整个盖住，就按 addRule 的同一套口径合并掉——
   * 名单里依旧不会出现互相覆盖的两条。用户手改过的规则 source 一律记 user。
   * @param spec { scope, list, id, rule }（rule 走 validateRuleInput）
   * @returns {{ok: boolean, error?: string, rule?: object, replaced?: boolean, merged?: number}}
   */
  function updateRule({ scope, list, id, rule }, cwd) {
    if (!POLICY_LISTS.includes(list) || !POLICY_SCOPES.includes(scope)) {
      return { ok: false, error: 'invalid scope or list' }
    }
    const checked = validateRuleInput(rule)
    if (!checked.ok) return { ok: false, error: checked.error }
    const file = scope === 'project' ? projectPolicyFile(cwd) : globalFile
    const doc = docFor(file)
    if (doc === undefined) return { ok: false, error: 'policy store disabled' }
    const rules = doc.rules[list]
    const index = rules.findIndex(candidate => candidate.id === id)
    if (index === -1) return { ok: false, error: 'rule not found' }
    const updated = Object.freeze({
      ...rules[index],
      tool: checked.rule.tool,
      match: Object.freeze({ kind: checked.rule.match.kind, value: checked.rule.match.value }),
      label: checked.rule.label,
      source: 'user',
      note: '用户在面板里手动调整过匹配条件',
    })
    const others = rules.filter((candidate, at) => at !== index)
    const merged = others.filter(candidate => sameTarget(candidate, updated) || ruleCovers(updated, candidate))
    doc.rules[list] = [...others.filter(candidate => !merged.includes(candidate)), updated]
    if (updated.match.kind === 'signature') delete doc.counters[(cwd ?? '') + '\u0000' + updated.match.value]
    if (write(file, doc) !== true) return { ok: false, error: 'policy write failed', file }
    return {
      ok: true,
      rule: updated,
      replaced: merged.some(candidate => sameTarget(candidate, updated)),
      merged: merged.length,
      scope,
      file,
    }
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
    /** 阈值写入全局文件（阈值是跨项目的用户偏好）。list 省略时写白名单阈值。 */
    setThreshold(value, list = 'allow') {
      if (!POLICY_LISTS.includes(list)) return currentThreshold('allow')
      if (!Number.isSafeInteger(value) || value < 1) return currentThreshold(list)
      const doc = docs.get(globalFile)
      doc.thresholds = { ...(doc.thresholds ?? {}), [list]: value }
      write(globalFile, doc)
      return value
    },
    /** 快照：两侧阈值 + 全局/项目两级白黑名单与文件路径，供「审批设置」面板展示。 */
    snapshot(cwd) {
      const project = projectDoc(cwd)
      return {
        thresholds: { allow: currentThreshold('allow'), deny: currentThreshold('deny') },
        global: view(docs.get(globalFile)),
        ...(project === undefined ? {} : { project: view(project.doc) }),
        globalFile,
        ...(project === undefined ? {} : { projectFile: project.file }),
      }
    },
    /** 命中查询：黑名单优先（deny 永远压过 allow），其次项目、最后全局。 */
    /** 落一条白/黑名单规则（时间线升级/降级与记忆自动升级都走这里）。 */
    addRule,
    /** 改一条已有规则（面板里微调匹配条件/标签，按 id 原地更新）。 */
    updateRule,
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
     * 记录一次审批结果并维护两侧连续计数：
     * - signal='pass'（最终放行：插件自动放行或人工放行）→ 白名单侧 +1；
     * - signal='reject'（模型判定 deny 或人工拒绝）→ 黑名单侧 +1；
     * 相反信号打断另一侧的「连续」。达到阈值时**不自行落规则**，只把建议返回给调用方，
     * 由它走「模型优化 → ask 询问用户 → 落盘」：静默放宽权限正是要避免的事。
     * 用户拒绝过的建议记进 dismissed，之后既不再计数也不再询问（避免反复打扰）。
     */
    observe({ signature, cwd, signal }) {
      const steady = { approvals: 0, denials: 0, suggestion: null }
      if (signature === undefined || memoryKeyOf(signature) === undefined) return steady
      if (signal !== 'pass' && signal !== 'reject') return steady
      const doc = docs.get(globalFile)
      const counterKey = (cwd ?? '') + '\u0000' + String(memoryKeyOf(signature))
      const entry = counterEntry(doc, counterKey)
      const list = signal === 'pass' ? 'allow' : 'deny'
      if (entry.dismissed?.[list] === true) {
        return { approvals: entry.allow, denials: entry.deny, suggestion: null }
      }
      entry[signal === 'pass' ? 'deny' : 'allow'] = 0
      entry[list] += 1
      const threshold = currentThreshold(list)
      const triggered = entry[list] >= threshold
      // 触发后清零：无论用户是否同意，都不该由同一次累积重复触发
      if (triggered) entry[list] = 0
      doc.counters[counterKey] = entry
      write(globalFile, doc)
      return {
        approvals: entry.allow,
        denials: entry.deny,
        suggestion: triggered ? Object.freeze({ list, count: threshold }) : null,
      }
    },
    /** 用户在询问里选了「不加入」：该签名该名单不再计数、不再询问。 */
    dismiss({ signature, cwd, list }) {
      if (signature === undefined || memoryKeyOf(signature) === undefined) return false
      if (!POLICY_LISTS.includes(list)) return false
      const doc = docs.get(globalFile)
      const counterKey = (cwd ?? '') + '\u0000' + String(memoryKeyOf(signature))
      const entry = counterEntry(doc, counterKey)
      entry[list] = 0
      entry.dismissed = { ...(entry.dismissed ?? {}), [list]: true }
      doc.counters[counterKey] = entry
      return write(globalFile, doc)
    },
  }
}

/** 统一取出错误信息文本。 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
