# dsh-auto-pass

[English](README.md) | 中文

`dsh-auto-pass` 为 DeepSeek Harness 的 WebUI 增加 `🚦 Auto Approve` 权限档位。每个需要审批的动作都会先交给一个全新且受限的 DSH 子 Agent 审查，插件只自动放行审查通过（allow）的请求；模型拒绝、宿主安全降级和审查失败一律交回 DSH 原生人工审批链，由用户决定——插件绝不代替用户拒绝。

在此之上还有两层「权限记忆」：**白名单**（以后直接放行，不再叫模型）与**黑名单**（以后直接转人工，不再叫模型），以及**连续放行自动升级**——同一个项目下同一权限被人工连续放行若干次后，插件自动把它升级成免审查规则。白/黑名单分**项目**与**全局**两级，规则来源可以是你在时间线上手动升级/降级，也可以是 Reviewer 模型在审查时给出的建议规则。

当前版本只支持 WebUI。

## 截图

选择 `🚦 Auto Approve` 权限档位（DSH 0.1.5-rc.1，中文界面）：

![中文界面的 Auto Approve 权限档位](docs/images/auto-approve-permission.zh.jpg)

Reviewer 允许有限的只读操作：

![Auto Approve 允许有限的只读操作](docs/images/auto-approve-allowed.png)

## 工作方式

```mermaid
flowchart TD
    action["动作"] --> sandbox{"在 workspace-write<br/>允许范围内？"}
    sandbox -- 是 --> execute["直接执行"]
    sandbox -- "否：申请提权" --> review["🧐 Auto Approve"]
    review -- 允许 --> approved["仅放行本次动作"]
    review -- "拒绝 / 审查失败" --> deferred["交回用户审批（ask）"]
    exact["解析出权限签名"] --> lists{"命中白名单？"}
    lists -- 是 --> approved
    lists -- "命中黑名单" --> deferred
    lists -- 都没有 --> review
```

选择 `Auto Approve` 后，`workspace-write` 允许范围内的普通操作直接执行，不调用 Reviewer。图中展示的是沙箱提权流程；其他工具审批规则也可能触发 Auto Approve。

- 只有会话选择 `Auto Approve` 时，插件才接管 `approval/request`；其他权限档位继续使用 DSH 原有审批链。
- 每次审批只启动一个 `spawn` Reviewer 会话。有限的 `read`、`glob`、`grep` 调查和最终结构化结果都由 DSH 自己的 agent loop 处理，插件不再实现另一套模型/工具循环。
- 子 Agent 创建时会被固定为只读沙箱与 `approval/policy = never`。执行层 guard 会拒绝 `read`、`glob`、`grep` 和当前会话专用结构化输出工具以外的一切工具；它不能继续创建子 Agent，最多执行四个调查步骤和一个最终回答步骤。只有最小范围的只读检查可能改变决定时，才可以检查敏感文件。
- Reviewer 会收到精确待审批动作、approval reason、当前权限、按预算截取的原始 session events、主 Agent 已装配的 system 指令，以及 AGENTS.md 等工作区指令。稳定指令会单独序列化为可缓存前缀，位于 session 标识、transcript、权限和动作数据之前。直接用户消息、`ask_user_question` 返回的人工回答、已装配的 system 指令和工作区指令都可以构成授权；assistant 内容和其他工具结果仍是不可信证据。
- 结构化结果只强制要求 `outcome`。简写 `{"outcome":"allow"}` 默认表示 low 风险、unknown 授权；deny 缺少其他字段时默认表示 high 风险、unknown 授权。完整结果还可以包含 `risk_level`、`user_authorization` 和 `rationale`。宿主一定拒绝 critical 风险，也会拒绝用户授权低于 medium 的 high 风险。无效输出、动作参数缺失、超时、非父请求取消导致的基础设施失败和工具失败都不会变成自动拒绝，而是把请求交回用户。
- 模型 deny 不会重新审查，也不会变成自动拒绝：插件会调用下一个审批应答器，让请求继续走 DSH 原生审批链，由用户决定。插件自身唯一会给出的结论就是 `allowed-once`。
- **名单优先于模型审查**：命中黑名单直接转人工、命中白名单直接放行，两者都不启动 Reviewer（不花模型）。黑名单永远压过白名单；项目级规则优先于全局级。
- **权限签名**由「工具名 + 归一化关键参数」得出，与调用 id、时间无关：命令类工具取命令文本（折叠空白），文件类工具取路径参数，其余取按键排序的参数 JSON；提权标记等额外参数也进签名，所以「提权重试」不会被当成普通调用。签名才是"相似权限"的判定单位。
- **连续放行自动升级**只统计「你亲自放行」的次数（插件自己放行的不算，命中名单后的人工放行也不算）：同一项目下同一签名连续放行达到阈值（默认 3，可在面板改）后，自动写出一条**精确签名**的记忆规则并清零计数；你一旦拒绝一次，连续计数立刻清零。
- 拿不到精确动作（例如审批请求先于 `tool/call` 到达）时**不建立签名**，这类请求既不参与名单匹配，也不参与计数——否则它们会塌缩成同一个空签名，几次放行后把「所有解析不出参数的调用」一起放行。
- 默认 90 秒总时限覆盖子 Agent 创建、所有模型步骤、本地只读调查和最终结构化输出。不同审批仍使用彼此隔离的 Reviewer 子会话。

主 session 会记录审批事件和简短插件通知：自动放行的动作给出 `允许` 通知，转交用户处理的请求给出说明「未自动批准」以及 Reviewer 理由的通知。Reviewer 子 session 使用 `_auto-approve:<callId>` label，并记录消息、调查工具调用与结果、最终 assessment 和 turn end。Console 只记录 session/call 标识、模型路由、步骤数、停止原因、风险、授权和结果，不默认输出完整 prompt 或文件内容。

## 审批面板：审批设置 + 审批时间线

每次审批都会记一条记录。两个面板刻意分开，避免对话区被审批噪声占满：**对话区标签页放「审批设置」，右侧栏放「审批时间线」**。宿主通过 `/api/dsh-auto-pass/log`、`/policy`、`/rule` 提供数据，由插件的客户端半渲染。

「审批设置」包含：连续放行阈值（改完即生效，写入策略文件的全局段）、面板显示位置，以及**全局**与**项目**两级的白名单/黑名单列表（每条规则显示标签、来源（手动/模型/记忆）、匹配条件，可单独删除）。能管理项目规则的前提是能确定当前项目目录——插件会先问宿主会话列表，拿不到就退回本会话最新一条审批记录里的 `cwd`。

「审批时间线」展开任意一条记录，即可把它**升级为白名单**或**降级为黑名单**，作用域可选「本项目」或「全局」。规则文本优先采用 Reviewer 在本次审查里给出的**建议规则**（模型产出，可覆盖同类动作，例如 `command_prefix: pnpm test`）；记录里没有模型建议时（例如审查未完成就转人工），精确回落到该次动作的签名——宁可窄，不要宽。

- 放置位置沿用 [`dsh-context`](https://github.com/bowenliang123/dsh-context) 的模型：对话区里和「对话/轨迹」并排的标签页（`conversation.view`）放审批设置、右侧栏标签页（`sidebarRightTabs`）放时间线，或两处都放。`placement: all`（默认）两处都注册，对话区标签页立刻可见；`auto` 表示优先右侧栏、右侧栏座位不可用时退回对话标签页——因此不装任何第三方侧边栏插件也能用。只想留一处就用 `tab` / `sidebar`。
- 设置页卡片（`settings.plugin.item`，位于 设置 → 插件）可即时切换位置，选择写进 DSH 设置命名空间 `dsh-auto-pass`、跨重启保留，并优先于 `placement` 配置值。**注意**：设置页只为宿主侧注册过设置命名空间的插件渲染卡片，所以插件的 host 半会注册这个命名空间（客户端卡片的 key 必须与它同名）。
- 每行显示时间、工具名、结论（`自动批准` / `转人工` / `审查未完成`），转人工的还会显示你最终的选择；展开可见风险等级、用户授权、理由、审批原因、动作参数（裁剪到 500 字符）、耗时、Reviewer 会话与调查步数。
- 记录以 JSON 落盘、跨重启保留：`$DSH_HOME/dsh-auto-pass/approvals.json`（默认 `~/.dsh/dsh-auto-pass/approvals.json`），只保留最新 1000 条，先写临时文件再改名。`logFile` 改路径，`maxRecords` 改上限。记录只存本地审批数据，并且只在 localhost 上提供。
- 策略分两个文件：全局 `$DSH_HOME/dsh-auto-pass/policy.json`（阈值、全局名单、连续计数），项目 `<会话 cwd>/.dsh-auto-pass/policy.json`（项目名单）。计数统一记在全局文件里并用 `cwd` 前缀区分项目，所以项目目录只在你真的给它写了项目规则之后才会多出一个 `.dsh-auto-pass/` 目录（该目录已列进本仓库的 `.gitignore`，建议你也忽略它）。写盘失败只告警：项目规则写不进去会自动降级写全局，绝不因为策略落盘失败而改变审批结论。

## 安装

包名为 `dsh-auto-pass`。从 GitHub 安装：

```sh
dsh plugin --profile web add github:sujingkpo/dsh-auto-pass
```

也可以从本地检出安装：

```sh
dsh plugin --profile web add link:/path/to/dsh-auto-pass
```

重启 WebUI 后，在会话的 Permissions 选择器中选择 `Auto Approve`，也可以在 General Settings 中设为默认权限档位。

## 配置

随包配置默认使用 `deepseek-official/deepseek-v4-flash` 与 `high` 推理：

```yaml
- id: dsh-auto-pass
  name: dsh-auto-pass
  config:
    language: auto
    reviewerProvider: deepseek-official
    reviewerModel: deepseek-v4-flash
    reviewerReasoningEffort: high
    timeoutMs: 90000
    maxInvestigationSteps: 4
    maxMessageTranscriptTokens: 4000
    maxToolTranscriptTokens: 3000
    maxMessageEntryTokens: 1000
    maxToolEntryTokens: 512
    maxSystemInstructionTokens: 6000
    maxAgentInstructionTokens: 6000
    maxRecentNonUserEntries: 20
    maxActionChars: 16000
    maxOutputTokens: 8192
    maxRecords: 1000
    placement: all
    autoApproveAfter: 3
    policyFile: ''
```

`language` 可设为 `auto`（默认）、`zh` 或 `en`；非法值会发出警告并回退为 `auto`。自动模式会累计当前 session 中由用户直接发送的消息所含汉字：达到 4 个时选择中文，否则选择英文；Agent 指令、助手消息和工具结果不参与判断。Reviewer 会被明确要求使用直接用户 prompt 的语言书写理由。为避免翻译改变审查语义，两种模式下安全策略正文都保持中文。

`reviewerProvider` 和 `reviewerModel` 必须同时设置。两者都省略时，Reviewer 使用父 session 当前的 provider/model。profile 覆盖会替换同一 bundle 行的完整 `config`，因此应重复写出所有需要保留的值。

`autoApproveAfter` 是连续放行阈值的**缺省值**，面板里改过的值存在策略文件里并优先于它（必须 ≥ 1）。`policyFile` 改全局策略文件路径，留空表示用默认路径。

Reviewer persona 和补充安全规则分别位于 `prompts/policy-template.md` 与 `prompts/policy.md`。修改配置、策略或插件代码后需要重启 DSH。

## 许可证

[MIT](LICENSE)
