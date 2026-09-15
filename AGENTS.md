# AGENTS.md

> 本文件是本仓库（dsh-auto-pass）的活文档，只记录已验证的事实；改动代码后请同步更新对应小节。

## 项目概览

- `dsh-auto-pass`：给 DSH WebUI 增加 `🚦 Auto Approve` 权限档位。入口 `src/index.js`，在 `approval/request` waterfall 上注册应答器。
- **核心语义**：插件自身唯一会给出的结论是 `allowed-once`（只自动放行 Reviewer 判定 `outcome: allow` 的请求）；模型 deny、宿主安全降级（critical / high 授权不足）、审查失败（超时、无审查路由、拿不到精确动作、输出非法、子 Agent 异常）一律调用 `next()` 转回 DSH 原生人工审批链（ask），由用户决定。
- 审查提示词与安全策略在 `prompts/policy-template.md`、`prompts/policy.md`（两种语言下策略正文都保持中文）。
- **权限记忆（`src/policy.js`）**：白名单（直接放行）/黑名单（直接转人工）分项目与全局两级，命中名单**不启动 Reviewer**；同一项目同一签名连续人工放行达到阈值（默认 3，可在面板改）后自动升级为免审查规则。匹配器只认三种闭集条件：`signature`（精确签名）/ `command_prefix` / `path_prefix`。规则文本由 Reviewer 模型在可选字段 `rule` 里给出（**不会**自动生效），用户在时间线上点升级/降级才落盘；没有模型建议时精确回落到该次签名。

## 命令（已验证）

- 安装依赖：`pnpm install`（Node ≥ 22.19；`~/.npmrc` 的 registry 为 npmmirror，装 vitest 约 2 秒）。
- 跑测试：`pnpm test`（= `vitest run`，当前 83 个用例全绿：`auto-approve` 23 + `records` 10 + `package` 4 + `policy` 25 + `policy-gate` 18 + `client` 3）。
- **客户端半只有 `tests/client.spec.js` 覆盖**：它不进构建流水线。测试用假 `window.__ModuleLoader__` + 带「渲染帧」的假 react 加载 bundle，把组件**渲染到稳定状态**（反复求值 + 跑副作用 + 等微任务，直到没有新的 `setState`）——漏定义变量、漏闭合花括号、以及「异步拉到记录之后」那一轮渲染里的问题就靠它兜住（都真的漏过）。
- `tests/auto-approve.spec.js` 文件名沿用权限档位名 `auto-approve`，与包名 `dsh-auto-pass` 不同，改名时不要误删。
- **受限沙箱下 `pnpm test` 会 `spawn EPERM`**（vite 会 `exec("net use")`、vitest 默认 forks 池也要 spawn 子进程）；需要以更宽权限运行，否则测试跑不起来。

## 架构事实（读源码确认）

- `ctx.on('approval/request', handler, { prepend: true })`（`src/index.js` 的 `apply`）：靠 `prepend` 抢在 `@deepseek-ai/dsh-api-remotes`（把审批转发给 WebUI 人工应答）之前，**不依赖 bundles 顺序**。
- 审批 waterfall 的返回值只能取自 `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（`@deepseek-ai/dsh-user-approval` 的 `OUTCOMES`，非闭集值会被归一化为 `unavailable`）。**没有 `'ask'` 这个返回值**：所谓「转 ask」= 不返回结论、调用 `next()` 让后续应答器接手。
- `ApprovalService.decide()` 先看会话 `approval/policy`：为 `never` 时直接返回 `'rejected'` 且**不分发 waterfall**，因此本插件只在 policy ≠ never 时才会被调用。
- Reviewer 子 Agent 隔离：`agent/created` 时 append `sandbox/mode=read-only` 与 `approval/policy=never`，装工具 guard（放行 `read`/`glob`/`grep`/`run_code`/结构化输出），并在 `agent/pre-step` 限制调查步数。
- **ptc 档位必须放行 `run_code`（踩过坑）**：ptc 档位下模型唯一能直接调用的是 `run_code`，`read`/`glob`/`grep`/`structured_output` 都要写在里面。早期 guard 只放行后四个 → Reviewer 查不了也交不了结论，`turn/end reason=blocked`，插件只能按「审查失败→转人工」处理（表现为一串 `refusal`/`error` 通知）。内层调用仍逐个过 guard，所以放行 `run_code` 不放宽实际权限。
- 排查材料：客户端信标 `GET /api/dsh-auto-pass/beacon?stage=&detail=` 把 boot 阶段写进宿主日志；Reviewer 子会话落在 `~/.dsh/sessions/<workspace>/<sessionId>/session.v3.jsonl.zstd`（按 zstd magic `28 b5 2f fd` 分帧逐帧解压）。
- 通知通过 `agent.inject({ source: { kind: 'plugin', plugin: 'dsh-auto-pass', form: 'notice' } })` 写进父 session；allow 与转人工用不同 headline/summary。
- `maxConsecutiveDenials` 与 turn 中断逻辑已删除：拒绝不再阻断，交给用户后可继续审批。
- **审批前的判定顺序（`createAutoApprovalHandler`）**：`action === undefined` → 直接转人工（且**不建立签名**）；否则先查名单，`deny` 命中直接 `next()`、`allow` 命中直接 `allowed-once`（两者都不建 Reviewer）；都没命中才走模型审查；`tests/policy-gate.spec.js` 用「`ctx.subagents.start` 一次都没被调用」把这一点钉死，并要求记录里带上 `policy.{list,scope,label}`（时间线据此显示命中名单）。
- **签名的三条安全性质（防过的坑）**：① `action` 拿不到时不建签名——否则所有解析不出参数的请求塌缩成同一个空签名，会被一起自动放行；② 计数只认 `fromHuman`（插件自己放行不算）**且** `decision.policyHit === undefined`（刚被黑名单拦下的动作，用户这一次放行是单次决定，不该长成记忆规则）；③ 记忆规则只写 `signature`（精确）条件，只有用户手动升级才可能带 `command_prefix`/`path_prefix`。黑名单永远压过白名单。
- `signatureOf` 会把字符串形态的 `arguments` 解析一层：`tool/call` 事件里 `arguments` 时而对象时而 JSON 字符串，字符串若不解析会退化成空参数签名，等于把一条规则放大到整个工具。
- 策略文件：全局 `$DSH_HOME/dsh-auto-pass/policy.json`（阈值 + 全局名单 + 计数），项目 `<cwd>/.dsh-auto-pass/policy.json`（项目名单）。计数统一放全局文件、键带 `cwd` 前缀，所以项目目录只在真的写了项目规则时才多出 `.dsh-auto-pass/`。项目写盘失败自动降级写全局；策略 IO 失败只告警，绝不影响审批结论。
- HTTP：`GET/POST /api/dsh-auto-pass/policy`（快照 / `op=threshold|add|remove`）、`POST /api/dsh-auto-pass/rule {recordId, scope, list}`（由记录一键升级/降级，并回写记录的 `ruleApplied`）。

## 客户端半与审批记录（读源码确认）

- 客户端半是 `src/client.js`，由 `package.json` 的 `exports["./client"]` + `dsh.client = { platform: 'web', inject: [...] }` 声明；载体把它变成 `/plugins/dsh-auto-pass/client.js`，文件本身必须是 `window.__ModuleLoader__.load({ id, factory })` 形式（`id` 必须是包名），factory 里用 `require('react')` 取基座 React，导出 `inject` + `apply`。`dsh.client.inject` 列的是必须**先于**本插件加载的包（这里：`dsh-api-remotes`、`dsh-client-ui-conversation`、`dsh-client-ui-sidebar-right`——后两个提供我们要用的槽）。
- **必须导出 `exports["./package.json"]`（踩过坑，代价是四次重启）**：合成器 `dsh-client-modules` 的 `locatePkgJson` 在拿不到 loader `internal.resolveSync` 时走回退分支 `createRequire(baseUrl).resolve('<pkg>/package.json')`；本机 loader 恰好走的就是这条。`exports` 一旦是受限白名单（只有 `.` 与 `./client`），该调用抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，被 `catch { return }` 吞掉 → `pkgMeta` 缓存 `null` → **本插件静默不入图：不报错、宿主日志无任何 warn、渲染器也不报 boot failed**，表现就是「各入口完全不存在」。已核对：图里 66 个 row 的第三方插件（dsh-context / dsh-todo-guard / dsh-change-review / dsh-better-sidebar / dsh-notify-me …）**全部**导出了 `./package.json`。`tests/package.spec.js` 把它钉成断言。
- 排查「为什么不入图」的判定链（可复用）：宿主日志 probe 报 `graphEntries=66 graphHas=false` 且**无** client-modules 报错 → 不是 throw（throw 会 FATAL 掉整个 clientModules 服务，graphEntries 会变 0），只能是 `resolveMeta` 静默返回 `null`；再比对渲染器缓存里的 boot 清单（`__DSH_BOOT__` 内联在首屏 HTML 里，落在 `%APPDATA%\DSH Desktop\Partitions\dsh-desktop-renderer\Cache\Cache_Data`）确认 row 真的不在图里，而不是加载后才掉队。
- **两个面板刻意分开**：对话区标签页 = 「审批设置」（阈值 + 项目/全局 × 白/黑名单），右侧栏 tab = 「审批时间线」（倒序记录 + 每条可升级/降级）。`placement` 的 `tab`/`sidebar` 现在各只留一处；`all` 两处都注册；`auto` 优先右侧栏、无座位退回对话区。
- **布局要与对话等宽（读源码确认）**：对话区面板 = `.ap-frame`（`padding:16px calc(var(--dsh-composer-side-clearance,16px) + 16px) 24px`、`align-items:center`）里的 `.ap-col`（`width:100%;max-width:var(--dsh-chat-content-width,748px)`），再往里是一张张 `.ap-card`。这两个变量由会话根元素 `._0cyzDW_root` 下发（`publishWidths` 用 ResizeObserver 写 `--dsh-conversation-column-width`，`--dsh-chat-content-width = clamp(680px, column*0.64, 920px)`）；`conversation.view` 的内容渲染在 `._0cyzDW_viewArea` 里、是该根元素的后代，所以变量能继承到。官方插件 `dsh-client-ui-approval` / `dsh-client-ui-user-questions` 用的是同一套写法（照抄它们的对齐方式，别自己拍宽度）。
- **设置页卡片必须渲染 `<li>`（踩过坑）**：`settings.plugin.item` 的宿主容器是 `ul.JMEyFa_cards`（外层 section `max-width:760px`），**整张卡片由插件自己拥有**。早期用 `<div>` + 内联 style，卡片样式一条都没生效，表现就是「设置里只有一段裸文字」。现在用 `card('li', …)` 复刻内置插件卡 `.TKtcza_card` 的外观（`.5px` 描边 `--dsw-alias-border-l4`、底色 `--dsw-alias-bg-layer-3`、16px 圆角、标题 15px/600 + 13px 说明）。
- **时间线行内展示**：折叠态除时间/工具/结论外，还显示**审批意见**（`record.rationale`，CSS 两行截断）与**命中名单**徽标（`record.policy.list` → 白名单/黑名单 + 作用域 + 规则标签），所以命中名单时不展开也能看出为什么放行或转人工。
- 项目目录的客户端来源：优先宿主 `sessions` 服务的 `list.getSnapshot().byId[sessionId].cwd`（照 dsh-context 的 `workspaceOf` 写法），拿不到就用本会话最新一条审批记录里的 `cwd`。**不要**把 `sessions` 写进 `exports.inject`——它只是可选探测，注入一个不存在的服务会让插件挂起。
- 两处放置位置（参照 dsh-context 0.52.1 的实现）：
  - 对话标签页：`ctx.slots.inject('conversation.view', () => ctx.slots.register({ name:'conversation.view', id, order, label }, Cmp))`，出现位置就在「对话 / 轨迹」旁边。
  - 右侧栏 tab：`ctx.inject(['sidebarRightTabs'], raw => ...)`（**延迟注入，座位按契约可选**）→ `raw.sidebarRightTabs.register({ id, kind, title, guide:[{ order, title, description, icon }] })` + `raw.slots.inject('sidebar.right.pane.tab', () => raw.slots.register({ name:'sidebar.right.pane.tab', key: id }, Cmp))`。`id` 同时是正文席位的 key；tab 一次都没打开过时它只出现在引导页/加号菜单里。
  - `slots.inject` 返回**幂等 disposer（函数）**；cordis 的 `ctx.inject` 返回带 `.dispose()` 的 handle，两者的卸载方式不同。
- 面板数据来自 host 的 `GET /api/dsh-auto-pass/log?session=&limit=`（记录，倒序）、`/api/dsh-auto-pass/policy?cwd=`（阈值 + 两级名单）、`/api/dsh-auto-pass/config`（`placement`）；客户端每 3 秒轮询一次。
- 放置策略 `placement: auto | tab | sidebar | all`，默认 **all**（与 dsh-context 一致：对话标签页 + 右侧栏 tab 都注册）；`auto` 表示 `ctx.get('sidebarRightTabs')` 存在就挂右侧栏，否则退回对话标签页。
- **设置页卡片的渲染条件（踩过坑）**：设置 → 插件 只为**宿主侧 `settings.register(命名空间, schema)` 注册过的命名空间**渲染卡片，并按 `entryKey = 命名空间` 派发 `settings.plugin.item`。只注册客户端卡片不会显示任何东西。本插件 host 半用动态 `import('@deepseek-ai/schemastery')`（软依赖，失败只丢卡片）注册命名空间 `dsh-auto-pass`，客户端卡片 key 与它同名。
- 放置位置的唯一真值在宿主：`placement` config 是默认值，用户在设置页改过的值存在设置命名空间里（`GET/POST /api/dsh-auto-pass/config`），设置页写的值优先。客户端启动时拉一次 config、并订阅 `placementStore` 变更即时重挂。
- 记录仓库在 `src/records.js`：内存列表 + JSON 原子落盘（`.tmp` + rename），默认 `$DSH_HOME/dsh-auto-pass/approvals.json`（无 `DSH_HOME` 时 `~/.dsh`），上限 `maxRecords`（默认 1000），`list({session})` 返回倒序。`createAutoApprovalHandler(ctx, config, records)` 的第三个参数默认 `noopRecordStore`；`finish()` 里对 `records.add` 做 try/catch，**写记录失败绝不影响审批结论**。

## 部署（本机 desktop profile）

- 依赖形态：`C:\Users\czy\.dsh\profiles\desktop\package.json` 里写 `"dsh-auto-pass": "link:D:/work/github/dsh-auto"`，`dsh.profile.bundles` 末位是 `dsh-auto-pass`；`node_modules\dsh-auto-pass` 是指向本仓库的**符号链接**（等价于 pnpm 对 `link:` 依赖的物化结果，参照同 profile 的 `dsh-change-review`）。`pnpm-lock.yaml` 的 importer 段已同步为 link 形式，旧的 `dsh-auto@github:...` 条目已删除。
- `dsh plugin <args>`（= 在 profile 目录转发 pnpm）在本机**当前不可用**：不加 `-w` 报 `ERR_PNPM_ADDING_TO_ROOT`（profile 有 `pnpm-workspace.yaml`），加了 `-w` 报 `ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF`（`node_modules/.modules.yaml` 记录 `virtualStoreDirMaxLength: 60`，而 shim 的 pnpm 9.15.9 默认值不同）。要重建依赖需显式带上该配置值（未验证）。
- 本机默认 `reviewerProvider: deepseek-official` 无凭证，必须由 profile 的 `cordis.patch.yml` 用 `- id: dsh-auto-pass` 覆盖审查模型；profile 层按 id 覆盖会**整体替换** config，所以要重述全部键。
- 改插件代码、`cordis.patch.yml` 或策略后必须重启 DSH Desktop 才生效（客户端半也要重启，HMR 只在 dev:web 下生效）。
- profile 的 `cordis.patch.yml` 覆盖里没有新键（`maxRecords`/`placement`/`autoApproveAfter`/`policyFile`）也无需改：profile 按 id 覆盖时未列出的键回落到代码默认值。
- 策略文件不在 profile 里，运行时才创建：全局 `C:\Users\czy\.dsh\dsh-auto-pass\policy.json`、项目 `<会话 cwd>\.dsh-auto-pass\policy.json`。调试时可以删掉全局文件让阈值与计数归零（项目名单会一起消失）。
- 回滚来源：`%APPDATA%\DSH Desktop\health-snapshots\<hash>\slot-N\` 保存了 profile 的副本（含 `pnpm-lock.yaml`、`package.json`）。

## 工具坑（本机实测）

- `read` 单次调用有上限：`limit` 最大 2000 行，且会被输出预算提前截断（96 KB 的 `pnpm-lock.yaml` 一次只返回约 1130 行）。**大文件必须按 600 行左右分块读并拼接**，否则写回会静默丢内容。
