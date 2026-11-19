# P7 Antigravity 设计评审（独立评审，2026-11-19）

对象：`P7-antigravity-provider.md`、`-integration.md`、`-plan.md`（提交 `9fe29da4`）。结论：方向可行；A1 之前要改 6 个阻塞项，其中 B1、B2、B5 依赖真机 A0 的答案。T3 路径相对 T3 Code 源码（`8cf97b5f`）。

## 阻塞

- **B1 协议版本**：T3 注明 Antigravity 报 `protocolVersion: 2` 但用 v1 的 `agentInfo`/`agentCapabilities` 形状（`packages/effect-acp/src/client.ts:1109-1111`，夹具 `antigravity-initialize.json`），T3 自己发 2（`AcpSessionRuntime.ts:2122`）。按响应形状判定，不要写死 `=== 1`；A0 记录发 1 和发 2 的原始响应。`agentInfo.version`（如 `agy_acp_server_1.1.1`）不是 CLI 版本，版本下限只用 `agy --version`。
- **B2 是否调用 `authenticate`**：T3 对 Antigravity 固定 `authenticateEagerly: true`（`AntigravityAcpSupport.ts:141-142`），并按 method 选凭据（`AcpSessionRuntime.ts:127`、`:2302-2303`）。`-32603 No browser is available here` 是 `authenticate` 的应答（`antigravityAuthSupport.ts:166`），不是 `session/new` 的。登录提示让用户跑 `agy acp --login`，`agy acp` 可能有独立于交互式 `agy` 的登录态。A0 必须回答：不调 `authenticate` 时 `session/new` 是否可用；已有凭据时调 `authenticate(methodId)` 是否静默；各 method 的行为。
- **B3 环境变量链路**：`src/main/claude-locate.ts:135-138` 的 `LOGIN_SHELL_ENV_PREFIXES` 没有 `GEMINI_`/`AGY_`/`ANTIGRAVITY_`，从 Finder 或 launchd 启动时捕获不到 shell 里的这些变量；设计 §2.3、§2.4 的描述只在从终端启动时成立，改动清单漏了这里。`AGY_*` 整体放行与「默认清洗、显式放行」矛盾（如 `AGY_ADC_AUTH=true` 会静默切到 ADC）。T3 还清掉 `AGY_ACP_ENABLE_OAUTH`、`AGY_ACP_CCPA_PROJECT`、`GEMINI_HOME`、`ANTIGRAVITY_HARNESS_PATH`、`GCLOUD_PROJECT`、`CLOUDSDK_CORE_PROJECT`、`BROWSER`（`antigravityAuthSupport.ts:61-81`）。改为精确名单：凭据或身份选择类变量一律默认清洗、逐个放行。
- **B4 trust 门禁接线**：调用点在 `src/main/bootstrap/run-admission.ts:192-201`、`run-fork.ts:186-227`（按 `providerId === 'codex'` 分支），只加 `trust.ts` 的函数不会被调用。建议把 hook/配置指纹门禁放进 adapter `run()` 的启动边界、fail closed，grant 存储用独立模块，避免改编排文件。`providerMcpConfigPaths`（`mcp-config.ts:133-138`）对未知 id 落到 OpenCode 分支：A1 加 ProviderId 时必须同时加显式分支（哪怕返回空），否则会去读 `opencode.json`。
- **B5 门禁文件集不完整**：除 `.agents/hooks.json`、`.agents/mcp_config.json` 外，还要覆盖工作区 `.gemini/settings.json`、旧 `.agent/` 目录、plugin/extension 目录、cwd 上级目录（agy 是否向上找到 git 根未核实）。若 agy 认工作区级 `toolPermission`，不可信仓库能让 `default` 静默变成全放行。未证实「不加载」之前，所有候选路径都进指纹；含权限类键的工作区设置拒绝启动或显式展示。A0 第 12 项扩成逐路径加载矩阵。「未测版本不阻断」等于对未知配置面 fail open：未验证版本只在实验开关下可用，清单参照 Qoder/Pi 把高于已验证线的版本标 `unsupported`（`provider-compatibility-manifest.ts:48,57`）。
- **B6 停止合同**：阶段由 `RunStopLifecycle` 拥有（`src/main/run-stop-lifecycle.ts:64-140`），只有 `interrupt()` 与 `forceKill()`，窗口取自 `STOP_ESCALATION_WINDOWS`（`:15-21`）。SIGTERM→SIGKILL 要在一次 `forceKill` 内完成；给 `antigravity_acp` 加窗口条目并定 `gracefulMs`（T3 是等 PromptResponse）。还要写明：cancel 时未决的 `request_permission` 一律回 `cancelled`；`initialize`/`session/new` 阶段无会话可 cancel，`interrupt` 直接走进程；cancel 后收到 `end_turn` 或 JSON-RPC 错误如何判定。

## 应修（摘要）

- **引用与日志**：`maskSecrets` 只用于显示、不得用于证据（`src/shared/trace.ts:466-467`），原生流原样记录；它也不认 Google key（`AIza…`）与 OAuth URL 的 `state`/`code`，登录 URL 用专门的丢弃规则。stderr 尾巴会拼进错误消息并到远程设备，也要处理；非 JSON 的 stdout 行只计数不落日志。`BROWSER` 指向「立即失败的命令」方向反了（T3 `antigravityAuthSupport.ts:54`：helper 必须 exit 0，否则回落到真实浏览器）；后台服务弹浏览器等于 Scry 发起登录，违反维护者决定 3。
- **能力宣告**：`clientCapabilities` 显式 `fs.readTextFile/writeTextFile=false`、`terminal=false`（T3 `AntigravityAcpSupport.ts:150`：宣告写能力会把 diff 编辑换成整文件写）。用量依据来自旧版本（`AntigravityAdapterV2.ts:283,287`），≥1.5.1 要重核。子 Agent 识别在 T3 靠工具标题字符串（`AntigravityProtocol.ts:483-503`）。
- **进程模型**：一 run 一进程在 T3 无先例（T3 是长驻会话进程）。A0 验证：PromptResponse 后关 stdin 是否落盘并自然退出（先等自然退出再发信号）；尾随 `session/update` 的处理；每轮 `resume` 耗时（只有 `load` 时每轮重放全量历史）。后台子 Agent 与 `/goal` 会随进程结束被杀，要写明。
- **审批与提问**：`interaction_` 只是 id 前缀约定，不是身份边界（`docs/agent/change-checklists.md` Trace 小节）；一律按 agy 给的选项原样渲染（`name` + `kind`），同一 kind 多个选项不得取第一个；未先见到 `tool_call` 的 `request_permission` 要能建出逻辑调用。`allow_always` 的持久范围未核实：只在进程内则一 run 一进程下无效，写用户配置则是永久放宽。
- **其他**：单行上限按 16 MiB（T3 `antigravityAuthSupport.ts:37`）；`error-classify.ts` 是全局子串匹配，`unauthorized` 会给出别家 Provider 的提示，需带 provider 参数；目录探测时 `set_config_option(model)` 是否改用户默认模型未核实。
- **安全**：用户全局 `always-proceed` 时，远程上限为 `default` 的 run 实际全放行——有效权限高于所选档位或远程上限时拒绝，turn record 记有效档位。用户级 `mcp_config.json` 进 `providerMcpConfigPaths` 就已进指纹（`mcp-execution-trust.ts:225,247`），与「不门禁」的说法冲突。`~/.gemini` 与 IDE、Gemini CLI 共用，启动前指纹不能防住上一轮获批工具改它，照实写进 Provider 说明，并在 MCP 面板展示用户级 hooks 来源。会话参数（含 MCP headers）可能被 agy 存进 `.meta`/`.db`，token 必须 run 级并在结束后失效，并套 `historyReaderEnvironment`（loopback 的 `NO_PROXY`）。A0 用 `--gemini-dir <空目录>` 探未登录前，先确认凭据是否在钥匙串，避免动到维护者的登录项。
- **给其他 Provider 清洗 `GEMINI_`/`AGY_`/`ANTIGRAVITY_`**：claude/codex/qoder 无使用点；opencode/pi 从终端启动且用 Gemini 模型的用户会受影响，需要 `SCRY_PROVIDER_ENV_ALLOW=pi:GEMINI_API_KEY`——与 pi 已默认丢 `OPENAI_` 同口径，写进变更说明并加测试。
- **证据**：未识别到子 Agent 不等于没有，整轮用量为 partial 或未知，不能整轮 exact；取消或失败的轮次用量为 partial；ACP 不回报实际应答模型，`modelStatus` 为 `unobserved` 并带 `modelOmissionReason`；费用要处理 `billing-ledger.ts:178-185`（默认 `provider_reported`）与 `usage-ledger-repair.ts:53`，否则缺失费用会记成 0；定 `format-usage.ts:7` 的 cache 口径并加测试。
- **清单遗漏**：`provider-detection.ts`、`bootstrap/provider-runtime.ts:42`、`run-stop-lifecycle.ts`、`McpTrustPanel.tsx:208`、`cli/status.ts:15`；含硬编码 Provider 枚举的非测试文件约 50 个，设计只列了约 30 个。
- **文件大小**：门禁对被修改的旧文件同样生效。`claude-locate.ts` 19,975、`smoke.ts` 19,947 字节，加一行就超，要先拆分；`turn-record.ts`（20,412）、`mcp-execution-trust.ts`（34,346）已超；`mcp-config.ts`、`desktop-host-reader.ts` 接近上限。
- **工期**：完整范围更像 6–8 周；4–5 周内可行的是 A0–A5 加 A6 的门禁（不含历史检索），不做 A8。A0 是硬门。

## 对 D1–D8 的意见

D1：维护者已决定使用 CLI 的个人登录态（见核验方记录）；评审建议文案只说「Google 对第三方客户端使用 Antigravity 登录可能有限制，请自行确认方案条款」，不下违规结论。D2 同意（T3 的完全访问是客户端代答，不是原生语义）。D3 有条件：只读一个用户级键不等于有效值，以观测为准，有效档位高于所选或远程上限时拒绝。D4 不同意直接选 a：现有 Provider 都要求可验证的账号身份（`continuation-identity.ts:205-252`、Qoder `host-continuation-identity.ts:212`），先在 A0 找非秘密的账号标识，找不到再选 a 并在界面标「账号未验证」。D5 同意，并加：探测结果缓存、不随界面轮询起进程，探测与同 profile 的 run 互斥。D6、D7 同意。D8 同意，但 `SCRY_EXPERIMENTAL_PROVIDERS` 目前不存在，要同时管住注册、`KNOWN_AGENTS` 探测、远程 discovery，并加入 `LOGIN_START_POLICY_ENV_KEYS`（`policy-env.ts:13-20`）。
