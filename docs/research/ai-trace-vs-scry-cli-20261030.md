# AI Trace 与 Scry CLI：采集范围及真实样本对比

初版日期：2026-10-30。后续全量扫描的快照时间为 **2026-10-31 02:58 UTC**（主机当地仍为 10 月 30 日）。目的：给另一个 Agent 提供可复核的对比和脱敏证据，不替代隐私审计或端到端验收。

## 结论

- **两者都能记录 Agent 执行过程。** AI Trace 不只是代码统计：全量扫描确认了轮次、消息、thinking、工具输入输出、工作区 patch、部分缺失原因和有状态投递。不能把这些笼统称为 Scry 独有。
- AI Trace 偏多入口、关系表及集中上报；Scry CLI 偏工作区逐轮文件、正文引用及统一 evidence envelope。现有证据不足以判断谁每轮采得更完整、归因更准确或隐私保护更好。
- 初版配置快照中，主要内容上报关闭，但 **Token 用量上报仍开启**。这是当时的配置，不是实时发送证明。
- 公开材料保留 **3 条脱敏代码样本**，并新增 **37 张表、272,170 行和 1,889 个文件的全量结构扫描统计**。不发布数据库、正文、身份、凭据或本机路径；全量解析不是逐字阅读全部会话。
- Scry 当前源码默认 `capture.toolOutput=full`，保存收到的工具原文，**不自动脱敏**。local-first 不是保密承诺；配置外部回调后，数据还可能被上传。

## 1. 版本、范围与证据等级

| 对象 | 本次检查范围 | 不应扩大为 |
| --- | --- | --- |
| AI Trace | 本机 managed 模式，SDK `1.3.147`；配置、相关实现及后续本地数据库/文件扫描 | 每条历史记录都由此版本生成、所有接入工具的行为或服务端实收数据 |
| Scry CLI | 包版本 `0.2.52`；源码基线 [`c4a4153d`](https://github.com/bingjiang0611/scry/commit/c4a4153dafb99c92601d9965361a6870dc678d27) | 本机已安装 CLI 的版本/行为，或桌面 App 独有能力 |
| 初版代码样本 | 一次 `code-detail` 查询的第一页，3 条 Codex 记录 | 样本本身代表全量历史、全部 Provider 或当前开关下的新结果 |
| 后续全量结构扫描 | 本机主数据根：37 张 SQLite 表（含内部表）及 1,889 个其他文件；排除安装依赖目录 | 完整历史从未丢失、逐字语义审阅、所有 Provider 原始 transcript 或远端实收 |

[机器可读证据附件](ai-trace-scry-cli-evidence-20261030.json) 包含：

- `configurationProjection`：配置接口的白名单投影，不是全量配置导出。
- `codeDetailSummary`：本地接口返回的总计数字。
- `codeDetailSample`：查询范围、分页状态、3 条脱敏记录及原始 diff 的 UTF-8 字节数。
- `aiTrace.localBundleSha256`：所检查本地 bundle 的指纹；**不附内部 bundle 源码**。

后续扫描见[全量核验报告与只读复核查询](ai-trace-full-scan-20261031.md)及[全量统计证据 JSON](ai-trace-full-scan-evidence-20261031.json)，不是对旧附件的覆盖或重解释。

本文区分四种证据：**接口观察**是接口返回的值；**源码观察**是实现合同；**本地数据观察**是快照中的字段、内容结构和关联；**未验证**是没有执行的结果。配置、历史记录与网络接收不是同一层证据。

## 2. 支持采集什么

下表描述能力，不代表本机已全部开启，也不代表所有 Provider 都提供同样的数据。

| 数据类别 | AI Trace | Scry CLI |
| --- | --- | --- |
| 会话与消息 | 实有 588 条会话事实、1,348 条轮次事实、43,744 条消息；内容块含 thinking，时序/来源需跨表查看；关联覆盖并不完整 | 逐轮用户输入、助手回复、会话/轮次标识、起止时间、状态及可用的思考片段；完整正文可由引用关联 |
| 工具 | 实有 17,915 个 tool_use 与 17,873 个 tool_result 内容块；去重后 15,892 对 ID 匹配。MCP/工具定义能力不等于已验证完整父子图 | 工具输入输出、状态、错误、时序、父子关联；可区分普通工具、MCP、Skill、子 Agent，覆盖依 Provider 而异 |
| 代码 | 实有 113,840 条代码动作，37,944 条含 tool_call_id；另有 380 个非空工作区 patch 快照。ID 存在不等于归因准确 | 文件读写足迹、轮次前后 diff、仓库发现范围；**不是代码采纳率系统**，也不是完整文件审计 |
| 用量与耗时 | Token 上报，可包含输入/输出/缓存/推理用量；事件可关联用户、会话、工具和仓库 | Token、缓存、模型、费用、部分 Credits、API/模型耗时；不可用或估算数据有相应标记 |
| 环境 | 环境快照合同包含 OS、主机/用户、环境变量相关信息、PATH、Agent 指令/配置/plugin、Workspace、Git、dirty patch | 工作区、Provider/模型、仓库及本轮执行上下文；另有上传环境 allowlist 的私有旁路快照，不是通用环境全量扫描 |
| Skill / Memory | 支持 Skill 调用、清单、正文，以及受支持工具的 Memory 正文 | Skill 调用证据；没有独立的全量 Skill 库/Memory 采集栏目，但正文仍可能随工具输出或 transcript 进入记录 |
| 诊断与证据表达 | 实有缺失原因、partial 工作区快照、来源 offset，以及重试/dead/cancelled 投递状态；不能据此断言每类证据均有统一质量合同 | Hook、错误、危险操作线索等；evidence section 有明确 status/quality/source 与可选省略原因，具体覆盖取决于来源 |
| 覆盖 | 配置列出 53 个入口，混合 IDE、CLI、Hook 和不同通道；**不是 53 个独立产品** | Claude、Codex、Qoder、OpenCode、Pi 等现有接入；不承诺 capability parity |
| 保存与发送 | 本地数据库和文件保存会话/代码等事实，投递状态另存；远端通道可能投影/裁剪字段 | 默认工作区 `.scry/`，逐轮 records 与正文引用；可配置 commit callback 交给外部程序继续处理 |
| 查询与导出 | 有面板和 HTTP 查询；本机还存在 export-session 脚本及说明，未核验其发布来源、实际导出或引用闭包 | 有 turns show、timeline、export-bundle 等合同；导出完整性须按实际来源和正文引用验证 |

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
- 初版查询时间范围、`limit=3`、`offset=0` 保存在旧附件。响应 `count=3`、`hasMore=true`、`nextOffset=3`。**该次 HTTP 查询只取一页**；后续数据库全量扫描另见新报告，不把旧样本说成全量。
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
2. **核对记录粒度**：AI Trace 同时有代码动作、消息、轮次事实和状态表；Scry canonical record 是一轮。不能将 113,840 个代码动作与轮次数比较，也不能把多表行数相加当唯一事件。
3. **核对正文与关联**：AI Trace 的消息 content_json、inlineDiffMessage 和工作区 patch 均可有正文；轮次表 ended_at 为空也不等于其他表没有结束时间。Scry 还需追踪正文引用，不能只看摘要。
4. **核对上报链路**：拿到授权的本机环境后，用同一版本只读接口确认配置和样本；若需要证明远端收到了什么，另行取得网络或服务端证据，不通过重传私人数据来补证。
5. **核对跨 Provider 能力**：全量数据中不同 Provider 的表覆盖不一致，例如轮次事实仅有 Codex，而其他 Provider 仍有消息或代码记录。数据存在不证明端到端完整性；同任务对照需另用获授权的临时工作区。
6. **核对 Token 口径**：区分 canonical usage、缓存字段、reasoning 和重复通道，不直接把所有字段相加，也不把缺失值写成 0。

AI Trace 的源码观察定位符为 `DATA_REPORTING_KEYS`、`SLS_EVENT_REPORTING_SCOPES`、`SESSION_OTEL_ENV_SNAPSHOT_FIELD_IDS`、`resolveCodexHookControl`、`CodeDetailHandler` 和 `redactCodeGenerationFields`。这些名称仅用于有权访问同一 bundle 的人复核；本文未附私有源码，公共仓库读者无法仅凭附件独立复算其实现。

## 6. 对比调查的边界

初版接口样本与后续本地扫描是不同证据层；全量扫描范围和剩余限制见新报告。该次全量扫描未改动 uploader 材料；后续源码修复及独立验证见第 7 节。

- 本文和 JSON 是只读调查材料，不参与构建、测试 fixture 或产品运行。不改变 Scry 或 AI Trace 的采集/上报行为。
- 未附 AI Trace 的内部实现源码、内部服务地址、令牌、身份或原始代码/会话正文。公开记录是明确标注的脱敏派生物；不是逐字原始证据。
- 旧样本已核对保留值及 UTF-8 长度；新附件按白名单从私有统计报告投影，核对计数、字段覆盖、关联和 JSON 结构。报告哈希不是原始数据真实性的独立证明。
- 对比调查部分仅含文档与统计附件，未运行产品单测、构建、安装或同任务双采集实验；uploader 附录的独立验证另列。全表扫描不证明历史从未丢失、实时网络流量、服务端实收或每个 Provider 的端到端完整性。

## 7. 补充：uploader 的公开脱敏源码

按维护者后续授权，附上 [uploader 审阅快照](experiments/scry-uploader-sanitized/README.md)，已同步源版本 `0.2.3` 的 48 个跟踪文件的脱敏副本、完整测试和哈希清单。名称、身份协议标识及 URL 均使用公开占位形式；没有附依赖、历史或真实采集数据。

原版与脱敏副本分别通过构建、87 项测试及打包检查。修复覆盖批次隔离、传输退避、worker/全局并发、多仓恢复、关闭后安全重新开启、ACK 正文保留及 receipt-only held 健康状态。私有安装版另通过真实 launchd/传输验收：新记录有 ACK，关闭期间记录未补传；验收使用合成 hook 记录，不等于实际 Provider 会话验收。公开占位版不连接真实服务。

快照使用 recorder `0.2.53`，与本文对比的 `0.2.52` 不同。公开占位依赖不可直接下载安装，具体替换、失败记录、测试条件与未验证边界见快照 README。先前 `0.2.0` / 27 文件 / 44 测试的基线保留在 PR 历史中。
