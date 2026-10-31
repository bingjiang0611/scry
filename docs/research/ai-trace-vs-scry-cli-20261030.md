# AI Trace 与 Scry CLI：采集范围及真实样本对比

日期：2026-10-30。目的：给另一个 Agent 提供可复核的对比和脱敏证据，不替代隐私审计或端到端验收。

## 结论

- **AI Trace 偏多工具采集、代码采纳统计和集中上报；Scry CLI 偏工作区内、逐轮保存执行证据。** 两者都可能保存正文，不是只采元数据。
- 本机 AI Trace 的主要内容上报开关关闭，但 **Token 用量上报仍开启**。不能把“内容上报关闭”理解为“完全不采集、不联网”。
- 找到了 **3 条真实的历史 Codex 代码修改记录**。公开样本保留字段结构和少量枚举值，移除了代码、身份、路径等内容；不是伪造的演示数据，也不是未经修改的原始响应。
- Scry 当前源码默认 `capture.toolOutput=full`，保存收到的工具原文，**不自动脱敏**。local-first 不是保密承诺；配置外部回调后，数据还可能被上传。

## 1. 版本、范围与证据等级

| 对象 | 本次检查范围 | 不应扩大为 |
| --- | --- | --- |
| AI Trace | 本机 managed 模式，SDK `1.3.147`；配置页、FAQ、只读 HTTP 接口、运行中 sidecar 的相关实现片段 | 所有版本、所有接入工具的行为或服务端实收数据 |
| Scry CLI | 包版本 `0.2.52`；源码基线 [`c4a4153d`](https://github.com/bingjiang0611/scry/commit/c4a4153dafb99c92601d9965361a6870dc678d27) | 本机已安装 CLI 的版本/行为，或桌面 App 独有能力 |
| 真实样本 | 一次 `code-detail` 查询的第一页，3 条 Codex 记录 | 全量历史、全部 Provider、当前开关下新生成的结果 |

[机器可读证据附件](ai-trace-scry-cli-evidence-20261030.json) 包含：

- `configurationProjection`：配置接口的白名单投影，不是全量配置导出。
- `codeDetailSummary`：本地接口返回的总计数字。
- `codeDetailSample`：查询范围、分页状态、3 条脱敏记录及原始 diff 的 UTF-8 字节数。
- `aiTrace.localBundleSha256`：所检查本地 bundle 的指纹；**不附内部 bundle 源码**。

本文区分三种证据：**接口观察**是当时接口返回的值；**源码观察**是相关实现允许/约束的行为；**未验证**指未执行的外部结果或接入路径。配置、历史记录与网络接收不是同一层证据。

## 2. 支持采集什么

下表描述能力，不代表本机已全部开启，也不代表所有 Provider 都提供同样的数据。

| 数据类别 | AI Trace | Scry CLI |
| --- | --- | --- |
| 会话与消息 | 会话标识、输入输出；有会话上报与本地 capture 控制 | 逐轮用户输入、助手回复、会话/轮次标识、起止时间、完成/失败/取消等状态 |
| 工具 | Tool、MCP 调用记录；Codex V2 路径支持每轮工具定义 | 工具输入输出、状态、错误、时序、父子关联；可区分普通工具、MCP、Skill、子 Agent，覆盖依 Provider 而异 |
| 代码 | AI 代码变更、代码明细、代码采纳相关数据 | 文件读写足迹、轮次前后 diff、仓库发现范围；**不是代码采纳率系统**，也不是完整文件审计 |
| 用量与耗时 | Token 上报，可包含输入/输出/缓存/推理用量；事件可关联用户、会话、工具和仓库 | Token、缓存、模型、费用、部分 Credits、API/模型耗时；不可用或估算数据有相应标记 |
| 环境 | 环境快照合同包含 OS、主机/用户、环境变量相关信息、PATH、Agent 指令/配置/plugin、Workspace、Git、dirty patch | 工作区、Provider/模型、仓库及本轮执行上下文；另有上传环境 allowlist 的私有旁路快照，不是通用环境全量扫描 |
| Skill / Memory | 支持 Skill 调用、清单、正文，以及受支持工具的 Memory 正文 | Skill 调用证据；没有独立的全量 Skill 库/Memory 采集栏目，但正文仍可能随工具输出或 transcript 进入记录 |
| 诊断 | 多入口运行状态、自检、上报状态和错误 | Hook、错误、危险操作线索、压缩事件、模型文本/思考片段等；具体字段取决于来源 |
| 覆盖 | 配置列出 53 个入口，混合 IDE、CLI、Hook 和不同通道；**不是 53 个独立产品** | Claude、Codex、Qoder、OpenCode、Pi 等现有接入；不承诺 capability parity |
| 保存与发送 | 本地代码明细，并有远端上报路径；不同通道可能投影/裁剪字段 | 默认工作区 `.scry/`，逐轮 records 与正文引用；可配置 commit callback 交给外部程序继续处理 |

AI Trace 环境快照中的 `os.env_vars` 只证明存在这类能力，本文**没有验证具体变量白名单或全部变量是否会被读取/发送**。不要据此断言“读取所有环境变量”。

### Scry 的正文与证据语义

源码依据：

- [记录字段合同](../../src/shared/turn-record-contracts.ts)：`AgentTurnRecord`、`TurnEvidence`、`TurnCall`、`TurnUsage`。
- [配置默认值](../../src/core/turn-recorder/config.ts)：`resolveCapture` 默认开启 prompt、assistant、diff、hooks，工具正文默认为 `full`。
- [CLI 采集说明](../../packages/turn-recorder-cli/README.md#采集什么)及[正文/存储说明](../../packages/turn-recorder-cli/docs/storage-and-performance.md)。
- [回调与集成说明](../../packages/turn-recorder-cli/docs/integrations-and-updates.md)。

关键边界：

1. `available/partial/disabled/unavailable` 和 `exact/estimated/inferred/unavailable` 表达证据语义，不是显示样式。
2. 完整工具正文可存入 `.scry/content/sha256/`，通过 `contentRef` 引用。8 KiB 单字段、128 KiB 单轮默认预算是 inline 预览预算，**不是完整正文的总磁盘上限**。
3. 新采集的工具正文不自动脱敏；旧 `full-redacted` 配置在当前源码里是 `full` 的迁移别名，不再代表保密承诺。显式 `none/summary` 仍有效。
4. 无 `scry.config.json` 的工作区不会因此自动启用 recorder。本文没有采集本机 Scry 私人 records，也没有做两者同一轮任务的对照实验。
5. Hook、MCP、文件足迹等字段存在，不代表每个 Provider 都提供完整证据。例如 Codex rollout 不包含原生 Hook 事件。
6. Scry 还把每轮开始时的上传环境 allowlist 保存到 `.scry/record-environments/<recordId>.json`。它不进入 record/export/support bundle，但旁路文件不加密，可能包含敏感值，不能原样分享；归档也不代表它已被删除。
7. 有效的仓库 commit callback 默认自动授权，仍须通过路径/指纹检查，并以本机用户权限运行。回调可读取完整记录；退出码 0 是接管合同的 ACK，不是远端实收证明。Scry 不是安全沙箱。

## 3. 本机配置快照

来源：附件 `configurationProjection`；读取时间为 2026-10-30。环境配置值保留接口返回的字符串形式，例如 `"true"`，未改写成测得的运行结果。

| 项目 | 观察值 | 能证明什么 |
| --- | --- | --- |
| 会话/环境/Skill/Memory 上报 | 均为 `false` | 这些配置项关闭，不是本地数据已删除 |
| 代码变更与采纳上报 | `false` | 对应上报开关关闭 |
| Token 用量上报 | **`true`** | 策略允许这一类上报；不是当前发送成功的证据 |
| 本地会话 capture | `true` | 总开关未关，实际执行还受各工具控制 |
| Codex V2 / Tools | `false` | 此开关关闭 |
| 增强工具提示 | `true` | 允许为相关新会话保留提示注入 |
| 工具模式 | 52 个 `off`、1 个 `auto`、0 个 `on` | 唯一 `auto` 为 MiniMax Code；当时未发现可读数据源 |
| runtime | `codex-shell-hook: Running` | 不等同于 Shell 代码采集开启，见下文 |
| 排除目录 | 2 个，公开附件不含路径 | 页面说明过滤这些目录及子目录的 AI 代码记录 |

源码观察：Codex Hook 的需求由“代码采集”或“增强提示”共同决定。采集关闭、提示开启时，可以保留 `promptOnly` 的 SessionStart Hook。因此 `Running` 与工具开关 `off` 不必矛盾。

**目录过滤不能扩大解释为所有会话、Token、环境数据均受排除。** 配置页明确说明的是这些目录的 AI 代码记录不进入本地明细和后续上报。本文没有验证每类数据的目录过滤覆盖。

## 4. 找到的真实 AI Trace 采集结果

### 4.1 总计与取样方式

只读请求：

```text
GET http://127.0.0.1:43124/v1/config/code-detail?summary=total
GET http://127.0.0.1:43124/v1/config/code-detail?startTime=<unix-ms>&endTime=<unix-ms>&limit=3&offset=0
```

- 总计接口返回 `{"totalCount":113840}`。这是本地 summary 值，不能当作远端成功接收总数。
- 样本接口要求 `startTime` 和 `endTime`。首次省略这两个参数返回 HTTP 400；读取 handler 合同后补齐，未修改服务配置。
- 实际查询时间范围、`limit=3`、`offset=0` 保存在附件。响应 `count=3`、`hasMore=true`、`nextOffset=3`。**只取这一页，未遍历后续历史。**
- 没有启动 Agent、生成新会话、触发重传或打开上报开关。历史记录不能用于证明当前关闭状态下仍在生成相同数据。

### 4.2 三条记录的观察结果

| 样本 | clientType / source | actionType | toolName / originalToolName | 本地 uploadStatus / 尝试数 | 原始 inlineDiffMessage UTF-8 字节数 |
| --- | --- | --- | --- | --- | --- |
| 1 | `codex-cli` | `ACCEPT_INLINE_DIFF_CHAT` | `replace_in_file` / `exec` | `success` / 1 | 3696 |
| 2 | `codex-cli` | `ACCEPT_INLINE_DIFF_CHAT` | `replace_in_file` / `exec` | `success` / 1 | 2490 |
| 3 | `codex-cli` | `ACCEPT_INLINE_DIFF_CHAT` | `replace_in_file` / `exec` | `success` / 1 | 680 |

三条 `payload.content` 都是 `null`，但 `payload.inlineDiffMessage` 都有非空正文。**只检查 `content` 是否为空，会漏掉已经保存的代码 diff。** `toolName` 与 `originalToolName` 也不同，不能把归一化名称直接当成原始工具名。

每条真实记录的结构包括：

- 外层：`id`、`source`、`receivedAt`、`payload`、`raw`。
- `payload`：动作/工具/客户端类型；文件路径；时间；用户、仓库、分支、commit、会话及调用标识；`content`、`inlineDiffMessage`；上传状态、次数、错误；`extra`。
- `raw`：上传状态、次数、错误和事件指纹。

完整字段结构见附件 `codeDetailSample.items[].record`。字符串 `[REDACTED]` 是**本次公开导出替换的值**，不是 AI Trace 原本存储或脱敏后的值。没有发布原始用户数据库、会话文本、diff 正文、身份、仓库地址或本机目录。

### 4.3 上传状态不等于网络载荷

这三条记录的本地状态确实是 `success`，`lastError=null`；但本文没有抓包，也没有服务端查询权限证据，不能独立确认远端实收字段、保存时长或最终可见性。

相关源码还表明，**某条 code-generation 发送路径会移除 `filePath`、`content`、`inlineDiffMessage`**。这说明不能把本地明细原样视作某个远端请求；也不能反过来断言所有上报通道都去除了这些字段。会话、环境、Skill、Memory、代码/采纳等通道需分别核对。

## 5. 给下一位 Agent 的复核入口

先读本文和附件，再按问题定位，避免把样本当全量或把配置当执行结果：

1. **核对默认采集与隐私语义**：在上述 Scry 固定 commit 查看 `resolveCapture`、正文存储与回调说明。不要把当前源码当成本机已安装版本。
2. **核对记录粒度**：这 3 条 AI Trace 样本是代码动作记录；Scry 的 canonical record 是一轮。比较条数前先确定分母，不能直接比较 113,840 与轮次数。
3. **核对正文位置**：AI Trace 不只有 `content`，还有 `inlineDiffMessage`；Scry 不只有摘要，还有 `inputContent/outputContent`、`contentRef` 等。比较前明确是否追踪引用正文。
4. **核对上报链路**：拿到授权的本机环境后，用同一版本只读接口确认配置和样本；若需要证明远端收到了什么，另行取得网络或服务端证据，不通过重传私人数据来补证。
5. **核对跨 Provider 能力**：本次只有 Codex 代码明细样本，不能据此证明 Claude、Pi、OpenCode 等路径的字段完整性。若要同任务对照，应使用获授权的临时工作区与无敏感内容任务。
6. **核对 Token 口径**：区分 canonical usage、缓存字段、reasoning 和重复通道，不直接把所有字段相加，也不把缺失值写成 0。

AI Trace 的源码观察定位符为 `DATA_REPORTING_KEYS`、`SLS_EVENT_REPORTING_SCOPES`、`SESSION_OTEL_ENV_SNAPSHOT_FIELD_IDS`、`resolveCodexHookControl`、`CodeDetailHandler` 和 `redactCodeGenerationFields`。这些名称仅用于有权访问同一 bundle 的人复核；本文未附私有源码，公共仓库读者无法仅凭附件独立复算其实现。

## 6. 本次边界

- 本文和 JSON 是只读调查材料，不参与构建、测试 fixture 或产品运行。不改变 Scry 或 AI Trace 的采集/上报行为。
- 没有公开内部源码、内部服务地址、令牌、身份或原始代码/会话正文。公开记录是明确标注的脱敏派生物；不是逐字原始证据。
- 已核对 JSON 可解析、保留值与本地响应一致、正文长度按 UTF-8 计算、引用路径存在以及 Markdown diff 无空白错误。
- 未执行产品单测、构建、安装或同任务双采集实验；纯文档不需要这些检查。没有证明实时网络流量、服务端接收、完整历史覆盖或其他 Provider 的端到端行为。
