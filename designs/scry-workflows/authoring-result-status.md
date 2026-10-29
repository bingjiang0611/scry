# 受限规划参数与 canonical SDK 结果：有界实施记录

状态：**本文冻结的 Claude 离线检查仍未通过；后续已由 Qoder 生产路径取得真实受限规划证据，但不改写本记录中的原失败。** 本文续接 [ConversationService 拆分](conversation-service-extraction-status.md) 与 [Claude settings 来源](claude-settings-source-status.md)，不替代总台账或此前冻结证据。

## 2026-10-29 后续：Qoder 生产路径

- Provider registry 现在为 Qoder 声明 `workflowAuthoring`，来源为成功 `result` 消息中的 JSON object。普通 Qoder run 不变。
- authoring query 使用默认权限、全新非持久 session、`tools: []`、拒绝任意工具调用的 `canUseTool`、空 skills/settings/MCP，并拒绝 resume、历史和附件。Main 仍执行 WorkflowProgram/schema 校验；普通助手文本和无法解析的 JSON 不提升为候选。
- 当前隔离 App 使用 Qoder `auto` 真实生成一 call + return 程序。预览为 ready，显式批准后 worker 实际模型为 `auto`，终态 completed，最终输出 `SCRY_M6_QODER_AUTHORING_OK`。可读汇总为 `~/.local/state/rotom/verification-evidence/scry-m6-native-default-20261029-093728/m6-current-authoring-typesafe-summary.json`。
- 该证据关闭“只有 Claude 声明、当前机器不可执行”的 Provider 缺口；不把本文原 Claude 离线超时改写成成功，也不证明所有 Provider 具备同等能力。

## 当前实现

- `WorkflowServicePlanning.admitPlanningOutput()` 抽出已有模型响应之后的程序校验与草案保存。原调用继续拥有规划 intent、结果持久化、slot、最终收据和退出收敛；没有增加第二次 `planCommand()` 或模型调用。
- `RunOpts.authoringSchema` 是 main 内部选项。SDK 参数构造拒绝非默认权限、resume、历史工具，设置空 tools / settingSources / MCP / plugins / skills / hooks，禁用配置 Hook、自动记忆和 autoDream，并设置 JSON schema、`maxTurns: 1` 与拒绝宿主工具的回调。
- 上述参数目前只有选项合同和 mock 证明。**没有新增 Provider authoring capability 声明，没有接入聊天路由，也没有把此选项接到普通 App 规划调用。** 不能据此称当前规划已实现宿主工具隔离。
- `agent-runner.ts` 仅为该显式 purpose 捕获成功 SDK result 的 `structured_output`。JSON 只序列化一次并成为不可变字符串；UTF-8 超过既有 4 MiB 上限时拒绝，不截断。错误、缺失、普通 purpose 或中断不产生 canonical 候选。
- main 内部 `ProviderStructuredOutput` 保留 `source: claude_sdk_success_result`。结果经现有 Claude adapter、Registry、`runProvider()` 到 `WorkflowTerminalResult`，不借用旁路观察事件或 assistant 文本作为权威来源。新 JSON 字段本身不等于已通过 WorkflowProgram 校验。
- `projectSettledWorkflowTerminal()` 集中原终态展示投影。它只在 main 已完成 scope 收敛的位置调用；纯函数不是物理退出证明。交互阻断、记录失败、非成功状态或未提交归档都不能公开 canonical 候选；保留原取消状态映射及普通输出行为。
- `claude-mcp-auth.ts` 与 `claude-runtime.ts` 承接已有 MCP 登录及调用环境职责。默认登录函数、超时、环境和 held-input 元数据查询保持；原公开 MCP helper 继续 re-export。没有额外 SDK loop、singleton、配置开关或 scheduler。

当前 `claude.ts` 19,709 B，`agent-runner.ts` 14,691 B，`app-run-start.ts` 2,364 B；`index.ts` 仍为 229,800 B，**不是 staging-ready**。

## 实际检查

证据根为 `/tmp/scry-workflow-template-editor.ZnkC6L/`。

| 检查 | 结果 | 可读证据 |
| --- | --- | --- |
| 复用规划 admission | Node/web、3 文件 63 测试及四个原方法 AST 检查通过；当时 App fixture 通过 | `m2-planning-admission-focused.log`、`m2-planning-admission-equivalence.json`、`m2-planning-admission-production-app.log` |
| SDK 参数构造 | 5 个新增 mock 合同检查及原 settings/options 检查通过 | `m2-authoring-sdk-permission-contract.log` |
| canonical JSON 捕获 | 原实现负控确实缺字段且未拒绝超限；修复后 7 测试通过，含 SDK 对象后续变更、缺失/错误/中断和 UTF-8 上限 | `m2-canonical-sdk-output-negative.log`、`m2-canonical-sdk-shared-contract.log` |
| adapter 字段传递 | 2 个 mock 检查通过，一次原 runner 调用，不补空候选 | `m2-canonical-claude-adapter.log` |
| main 终态投影 | 8 测试通过；故意移除归档 gate 后原检查失败，随后恢复 | `m2-canonical-terminal-gates.log`、`m2-canonical-archive-negative.log` |
| MCP/环境拆分 | 15 个原声明 AST 等价；唯一声明的功能差异为既有结果新增 canonical 字段转发 | `m2-claude-adapter-equivalence.json` |
| 最终本地集合 | Node/web 通过；当前 10 文件 98 测试、构建通过 | `m2-canonical-terminal-gates.log`、`m2-canonical-final-local-gates.log` |

首个字段接线 typecheck 失败是 `runProvider()` 的内联返回类型遗漏了共享 Provider 字段。已改为复用 `ProviderRunResult`，没有增加平行合同。AST 工具首版比较误计了新增 export modifier 的空 SyntaxList；改用语义 AST 子节点，仍比较字面值、操作符及 const/let 标志，没有修改生产代码迁就检查。以上首败均保留。

`performance-paths.json` 仅补充实际迁移模块的 source 归属。现有 feedback 与 catalogue 测试包含在最终集合；没有修改 metric、collector、workload、ratchet 或 deadline。此前实际命令已证明 `send.codex-fixture` collector unavailable；未重试冒充通过。多次执行标记 highLoad，不作毫秒改善结论。

## 隔离 SDK／CLI 尝试：未通过

用户只授权临时 HOME、合成项目和本地假服务中的离线 SDK／CLI 检查；没有真实模型、账号或费用授权。

1. SDK-free 子进程隔离检查通过：指定本地端口可达，另一本地端口及夹具外合成凭据文件读写被拒，夹具内文件可用。真实 SDK／CLI 只能在同一约束继承下启动。此处的 `sandbox-exec` 是测试容器，**不是 Scry 产品安全沙箱承诺**。
2. 隔离范围内实际导入 SDK 0.3.251，并启动 canonical 路径名为 2.1.226 的 CLI。原整体 8,000 ms 限时到达；未观察到 native system/init / result，假服务记录 0 条通过完整校验的请求。原夹具不记录连接、HTTP 到达或校验失败；不能将 0 解释为没有请求到达。system/init 也不是 initialize control response，后者原本没有记录。没有获得宿主工具禁用或 structured-output Native 执行证明。
3. 原超时和清理阶段的 defunct 身份变化均保留。后续独立 `ps` 对登记 PID 1985/2220 及组 2220 分别返回 exit 1、空 stdout/stderr，当前不存在；该检查没有发送信号。只证明登记资源范围，不审计逃逸后代或远程效果。

可读证据：`m2-sdk-isolation-literal-metadata.log`、`m2-authoring-first-native-sdk.log`；实际现场为临时目录 `scry-sdk-isolation-ns3TbO` 与 `scry-sdk-native-authoring-ZrkGvO`，后者有 `failure.json`、`registered-absence.json`、profile 和 stdout。早期 profile 语法、dyld 根目录与父目录 metadata 拒绝也保留；没有复制含私人事件信息的完整系统 crash report。

源码复核没有证明握手死锁：SDK 会发送 initialize control request，也会直接写入字符串 prompt。SDK 包声明对应 CLI 2.1.251，但本次 executable 文件名为 2.1.226；版本差异不是已证实的不兼容。SDK 对收到的 can_use_tool 均调用回调，不能由此推断 Native 会把内部 StructuredOutput 交给此回调，也不能由 maxTurns: 1 推断内部工具必需另一个 assistant turn。

超时原因仍未证实，不能归咎于负载。原清理阶段的命令字符串比较拒绝发生在退出/zombie 转换之后，掩盖了外层原错误；保留 fail-closed，不改为无身份校验发送信号。复核仅覆盖源码；下一项是同一期限、隔离和工作量下的有界协议边界诊断，不是把原失败重跑覆盖为成功。未扩大期限、放宽凭据/网络隔离或调用真实账号。

### 协议边界诊断：仍未取得 Native 候选

另一次独立离线诊断保留原 SDK query、候选、选项、校验、8,000 ms 限时及权限模板；只增加有界协议/HTTP 观察和必要的可信观察代码文件。不是原首败重跑刷绿。观察器的字节、backpressure 返回值、不提前启动 data listener、还原方法及 64 KiB 日志上限有独立 Node 检查；没有改变送给 SDK 的字节。同步证据写入是新增诊断工作，不作计时或速度结论。

`m2-native-protocol-diagnostic.log` 现场为 `scry-sdk-native-protocol-GQ8RnX`：记录到 initialize control request（369 B）及 user（196 B）的写入尝试，不能证明 Native 已读取。没有收到 Native stdout/stderr 数据，随后两个流 EOF；观察器完整关闭且未截断。Native 先以 SIGKILL 关闭，父夹具随后因 SDK 子进程 exit 1 断言失败，不是该次 8 秒计时器到达。父夹具在该关闭分支没有发送信号，**终止来源仍未知**。

HTTP 到达为 0；TCP 总计 1、SDK 导入前基线 1，唯一连接是正向 canary。此次可以区分到达与校验，不再把它们混为同一个 0。没有 native system/init、result、权限请求或 canonical 候选，因此不能据此证明 StructuredOutput 与 maxTurns 的真实行为。

对登记 PID 14445/14485 和组 14485 的独立 ps 均 exit 1、空输出。`codesign --verify --strict` 对选定 executable exit 0，仅证明磁盘签名检查通过，不证明 Native 可在该 profile 下初始化。目标 PID 的普通/详细系统日志查询未命中；最近一小时对应 CLI 文件名前缀的 crash report 候选为 0，未读取或复制整份系统报告。没有足够证据把原超时归因于签名、版本、profile 或负载。

保留 `m2-native-startup-source-scout.log`、`m2-native-protocol-preservation.json`、`m2-native-protocol-observer-unit.log`、目标元数据 JSON 和原现场；首版 preservation JSON 中硬编码的 originalPreserved 不构成字节历史证明，已保留首版并换为实际观察输入的 SHA。它不是 Native 成功证据。SDK 真实执行仍受阻；不放宽隔离或期限，也不据此发布可用 authoring capability。

## App 首败与产物边界

`m2-canonical-current-build.log` 中 Node/web、9 文件 90 测试和构建通过，但随后原生产 App fixture **失败**：Node TAP 检查在冻结的 5,000 ms 期限到达，实际为 `timed_out`，不是要求的 `incomplete`。不可更改预期让它变绿。

现场 `scry-workflow-node-stop-app-2Tf31Y` 保存原 records、scope、stdout 和截图。stdout 仅包含 `actual body` 的一个成功子测试，没有第二项及完整 footer；产品据此报告 tests unavailable，不能填写 0 或伪造完整统计。记录为 SIGKILL、settled；已执行前缀的 2 次离线 actor 调用、单节点停止、frame inspector 与 native stop 保留。后续 policy、size、冷启动场景没有执行。注册 App closure 为一次 tracked 4，不作整机后代保证。

该失败运行发生在终态投影抽出之前，失败 bundle hash 未保留，后来的构建不能补写为原失败 bundle。`m2-canonical-native-tap-failure.json` 明示此限制及未知因果关系；没有盲目重跑或提高期限。

投影抽出后的**最新源码只完成类型、98 测试和构建，未再次运行真实 App**。当前 main SHA 为 `d18bef4eac99f7be13309a2a4e979e1c6b3797f05b2abde4f16863888f99ad7f`，preload SHA 为 `84f4e880cdc754535dc69474763d829c873cbd8fc4aadea8fab0d9876be8c27f`；详见 `m2-canonical-build-identities.json`。这不是安装或日常实例已更新的证明。

## 后续工作与未关闭项

- 父会话继续 main-owned TaskSubmission、typed source / 命令、会话 off/manual/auto、费用/数据授权和一次 route+plan 的生产入口；不能把本记录的字段接线称作完整入口。
- Native SDK 验证的负责人仍为父会话：先定位限时内未初始化的原因，再决定授权内下一步，不重放结果未知的请求。真实账号与费用仍需用户另行授权。
- 原 default full suite 的 SystemStep 5,000 ms 失败、两项扩大集合 native recovery 5,000 ms 失败和本次 Node TAP 首败仍开放；focused 通过不关闭它们。
- M4/M5/M6 其余质量、图/输出/Recorder、真实账号矩阵与发布 gates，以及大 `index.ts` 的职责拆分继续在总台账内，不提前宣称完成。

本轮未 stage、commit、push、安装、升版本或重启日常 App。旧冻结证据不修改；新检查是独立、有失败记录的 checkpoint，checksum 不是签名，复制的临时夹具不是可恢复执行 authority。
