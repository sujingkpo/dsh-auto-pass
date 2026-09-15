# AGENTS.md

> 本文件是本仓库（dsh-auto-pass）的活文档，只记录已验证的事实；改动代码后请同步更新对应小节。

## 项目概览

- `dsh-auto-pass`：给 DSH WebUI 增加 `🚦 Auto Approve` 权限档位。入口 `src/index.js`，在 `approval/request` waterfall 上注册应答器。
- **核心语义**：插件自身唯一会给出的结论是 `allowed-once`（只自动放行 Reviewer 判定 `outcome: allow` 的请求）；模型 deny、宿主安全降级（critical / high 授权不足）、审查失败（超时、无审查路由、拿不到精确动作、输出非法、子 Agent 异常）一律调用 `next()` 转回 DSH 原生人工审批链（ask），由用户决定。
- 审查提示词与安全策略在 `prompts/policy-template.md`、`prompts/policy.md`（两种语言下策略正文都保持中文）。

## 命令（已验证）

- 安装依赖：`pnpm install`（Node ≥ 22.19；`~/.npmrc` 的 registry 为 npmmirror，装 vitest 约 2 秒）。
- 跑测试：`pnpm test`（= `vitest run`，当前 18 个用例全绿）。
- 测试文件是 `tests/auto-approve.spec.js`：文件名沿用权限档位名 `auto-approve`，与包名 `dsh-auto-pass` 不同，改名时不要误删。

## 架构事实（读源码确认）

- `ctx.on('approval/request', handler, { prepend: true })`（`src/index.js` 的 `apply`）：靠 `prepend` 抢在 `@deepseek-ai/dsh-api-remotes`（把审批转发给 WebUI 人工应答）之前，**不依赖 bundles 顺序**。
- 审批 waterfall 的返回值只能取自 `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（`@deepseek-ai/dsh-user-approval` 的 `OUTCOMES`，非闭集值会被归一化为 `unavailable`）。**没有 `'ask'` 这个返回值**：所谓「转 ask」= 不返回结论、调用 `next()` 让后续应答器接手。
- `ApprovalService.decide()` 先看会话 `approval/policy`：为 `never` 时直接返回 `'rejected'` 且**不分发 waterfall**，因此本插件只在 policy ≠ never 时才会被调用。
- Reviewer 子 Agent 隔离：`agent/created` 时 append `sandbox/mode=read-only` 与 `approval/policy=never`，装工具 guard（只放行 `read`/`glob`/`grep`/结构化输出），并在 `agent/pre-step` 限制调查步数。
- 通知通过 `agent.inject({ source: { kind: 'plugin', plugin: 'dsh-auto-pass', form: 'notice' } })` 写进父 session；allow 与转人工用不同 headline/summary。
- `maxConsecutiveDenials` 与 turn 中断逻辑已删除：拒绝不再阻断，交给用户后可继续审批。

## 部署（本机 desktop profile）

- 依赖形态：`C:\Users\czy\.dsh\profiles\desktop\package.json` 里写 `"dsh-auto-pass": "link:D:/work/github/dsh-auto"`，`dsh.profile.bundles` 末位是 `dsh-auto-pass`；`node_modules\dsh-auto-pass` 是指向本仓库的**符号链接**（等价于 pnpm 对 `link:` 依赖的物化结果，参照同 profile 的 `dsh-change-review`）。`pnpm-lock.yaml` 的 importer 段已同步为 link 形式，旧的 `dsh-auto@github:...` 条目已删除。
- `dsh plugin <args>`（= 在 profile 目录转发 pnpm）在本机**当前不可用**：不加 `-w` 报 `ERR_PNPM_ADDING_TO_ROOT`（profile 有 `pnpm-workspace.yaml`），加了 `-w` 报 `ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF`（`node_modules/.modules.yaml` 记录 `virtualStoreDirMaxLength: 60`，而 shim 的 pnpm 9.15.9 默认值不同）。要重建依赖需显式带上该配置值（未验证）。
- 本机默认 `reviewerProvider: deepseek-official` 无凭证，必须由 profile 的 `cordis.patch.yml` 用 `- id: dsh-auto-pass` 覆盖审查模型；profile 层按 id 覆盖会**整体替换** config，所以要重述全部键。
- 改插件代码、`cordis.patch.yml` 或策略后必须重启 DSH Desktop 才生效。
- 回滚来源：`%APPDATA%\DSH Desktop\health-snapshots\<hash>\slot-N\` 保存了 profile 的副本（含 `pnpm-lock.yaml`、`package.json`）。

## 工具坑（本机实测）

- `read` 单次调用有上限：`limit` 最大 2000 行，且会被输出预算提前截断（96 KB 的 `pnpm-lock.yaml` 一次只返回约 1130 行）。**大文件必须按 600 行左右分块读并拼接**，否则写回会静默丢内容。
