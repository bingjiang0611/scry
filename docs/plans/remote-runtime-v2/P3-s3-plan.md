# P3 · S3 执行清单：删除 Electron main 进程内运行时（**已完成**，2026-11-22）

> 本文 §1–§6 为 2026-11-20 的盘点与计划（替代 [P3-s1s3-plan.md](P3-s1s3-plan.md) 的旧盘点）；执行结果见 **§7**。
> 维护者已决定无需再保留一个发布周期（当前没有用户），S3 直接删除进程内路径与 `SCRY_HOST_DAEMON=0` 逃生开关。

---

## 1. 需要维护者决定

**已定（维护者 2026-11-20，按核验方推荐）**：
- 开发构建与 `SCRY_TEST_APP=1` 测试实例改为默认走后台服务，作为 S3 第一步（迁移 14 个 smoke 夹具）。
- 逃生开关 `SCRY_HOST_DAEMON=0` 再保留一个发布版本：先带着它（以及 W10 的修复）发一个版本，下一个版本再删除进程内代码。

下面两条保留为原始问题记录。

1. **开发版与测试实例默认模式**：当前 `src/main/daemon-mode-default.ts` 仅对 `isPackaged === true` 且未设 `SCRY_TEST_APP=1` 与 `SCRY_HOST_DAEMON` 的启动默认设 `SCRY_HOST_DAEMON=1`。S3 执行前需决定：**开发构建（`npm run dev`）和 `SCRY_TEST_APP=1` 测试实例是否也改为默认走后台服务？**（若改为默认走后台服务，需同步迁移下表 14 个 `SCRY_TEST_APP` smoke 脚本的夹具。）
2. **逃生开关 `SCRY_HOST_DAEMON=0` 去留**：S3 是一步删除 `SCRY_HOST_DAEMON=0`（与进程内代码一起移除），还是先保留一个发布周期再删？（保留则 S3 期间无法删除进程内代码，只能冻结棘轮。）

---

## 2. 现状盘点（esbuild metafile 实测，2026-11-20）

以 `node scripts/main-import-boundary.mjs` 对 `src/main/index.ts` 做 `--bundle --platform=node --packages=external --metafile` 扫描：

- **总可达模块**：**639 个**（较 2026-11-12 的 535 个增长 104 个，主要来自 Antigravity ACP 适配器、login-start 模板、billing/usage 拆文件与 conversation 侧聊）。
- **Layer 3 单写者边界（`src/host-runtime/orchestration/**`）**：**0 违规**（永久硬门禁，不允许入基线）。
- **禁用包（S3 后 `main` 不应再直接或动态加载）**：
  - `@anthropic-ai/claude-agent-sdk`
  - `@opencode-ai/sdk/v2`
  - `@qoder-ai/qoder-agent-sdk`
  - `node-pty`（动态 `require`）
  - `better-sqlite3`（动态 `require`）
- **S3 待移除的进程内运行时入口模块（15 个核心锚点，覆盖约 260+ 传递模块）**：
  - Provider 与执行：`src/main/agent-runner.ts`、`src/main/providers/{claude,codex-app-server,opencode-server,qoder-launch,pi-rpc,antigravity-launch}.ts`（含 `src/main/providers/**` 下 75 个模块中的执行侧；只读投影/校验如 `claude-jsonl-projector`、`pi-jsonl-projector`、`pi-native-parse`、`mcp-auth-security` 按需留存）
  - 运行管线与远程宿主：`src/host-runtime/create-run-pipeline.ts`、`src/host-runtime/host-runtime.ts`、`src/main/remote/{remote-host-service,session-ledger,session-ledger-file}.ts`
  - 终端、Git 与 SQLite：`src/main/terminal-manager.ts`、`src/main/source-control/service.ts`、`src/main/db.ts`

### 2.1 `main` 可达的 `child_process` 导入（21 个，逐一归类）

| 模块 | S3 处置 | 理由 |
|---|---|---|
| `src/main/bootstrap/daemon-launch.ts` | **留（白名单）** | App 拉起/重连本机 daemon |
| `src/daemon/supervisor.ts` | **留（白名单）** | App 检查/管理 daemon supervisor 进程 |
| `src/daemon/login-start/exec.ts` | **留（白名单）** | 本机登录自启动 `launchctl`/`systemctl` 管理 |
| `src/main/process-diagnostics.ts` | **留（白名单）** | 按 PID + 启动时间核对进程归属（`ps`） |
| `src/main/remote/desktop-transport.ts` | **留（白名单）** | 桌面客户端连远端宿主（SSH 隧道客户端） |
| `src/main/llm-network-configuration.ts` | **留（白名单）** | 读取系统代理设置 |
| `src/main/providers/claude.ts` | **删** | Provider 子进程归 daemon |
| `src/main/providers/codex-app-server.ts` | **删** | Provider 子进程归 daemon |
| `src/main/providers/opencode-server.ts` | **删** | Provider 子进程归 daemon |
| `src/main/providers/qoder-launch.ts` | **删** | Provider 子进程归 daemon |
| `src/main/providers/pi-rpc.ts` | **删** | Provider 子进程归 daemon |
| `src/main/providers/antigravity-launch.ts` | **删** | Provider 子进程归 daemon（W8 新增） |
| `src/main/agent-runner.ts` | **删** | 通用 Agent 运行入口归 daemon |
| `src/main/source-control/process.ts` | **删** | Git 操作归 daemon `SourceControlService` |
| `src/core/turn-recorder/git-command.ts` | **删** | Recorder 提交归 daemon |
| `src/core/turn-recorder/commit-hook-process.ts` | **删** | Commit hook 归 daemon |
| `src/core/turn-recorder/host-process.ts` | **删** | Recorder 宿主探测归 daemon |
| `src/main/recorder-cli-runtime.ts` | **删** | 私有 CLI 启动归 daemon |
| `src/main/login-shell-env.ts` | **删** | 登录 Shell 环境预热归 daemon（App 仅 UI） |
| `src/main/mcp-config.ts` | **删** | MCP 探测/执行归 daemon |
| `src/main/pi-agent-profiles.ts` | **删** | Pi profile 探测归 daemon |

### 2.2 开关分支、IPC 处理器与依赖 `SCRY_HOST_DAEMON=0` / `SCRY_TEST_APP=1` 的测试

- **`daemonModeEnabled()` 生产代码分支**：共 **11 个文件**：
  `src/main/index.ts`、`src/main/daemon-channel-gate.ts`、`src/main/remote/remote-defaults.ts`、`src/main/bootstrap/app-startup-writers.ts`、`src/main/bootstrap/app-agent.ts`、`src/main/bootstrap/conversation.ts`、`src/main/bootstrap/daemon-run-mode.ts`、`src/main/bootstrap/history-runtime.ts`、`src/main/bootstrap/provider-handlers.ts`、`src/main/bootstrap/session-deletion.ts`、`src/main/bootstrap/workspace.ts`。
- **文案与状态**：`src/main/background-service-copy.ts`、`src/renderer/background-service-view.ts`、`src/main/bootstrap/userdata-owner-messages.ts`。
- **显式依赖 `SCRY_HOST_DAEMON=0` 的文件（6 处）**：
  - `src/main/daemon-mode-default.ts`、`src/main/daemon-mode-default.test.ts`
  - `scripts/b4v/app.mjs`、`scripts/b4v/cli.test.mjs`
  - `scripts/session-open-bench-mode.mjs`、`scripts/session-open-bench-mode.test.mjs`
- **依赖 `SCRY_TEST_APP=1`（当前默认走进程内）的 smoke 脚本（14 个）**：
  `scripts/concurrent-performance.mjs`、`scripts/desktop-remote-host-smoke/harness.mjs`、`scripts/desktop-remote-ui-smoke.mjs`、`scripts/electron-security-smoke.mjs`、`scripts/external-links-smoke.mjs`、`scripts/fixtures/concurrency-trace-live-host.mjs`、`scripts/login-start-macos-acceptance.mjs`、`scripts/login-start-smoke.mjs`、`scripts/performance-soak.mjs`、`scripts/renderer-crash-recovery-smoke.mjs`、`scripts/session-concurrency-bench.mjs`、`scripts/session-open-bench-mode.mjs`、`scripts/session-restore-provider-smoke.mjs`、`scripts/workflow-session-open-bench.mjs`。

---

## 3. P4 `off` 与 S3 的先后关系

**明确顺序：先做 S3（从 Electron `main` 删除进程内运行时），再删 P4 的 `off` 模式。**

- S3 只改变「谁运行 Agent/终端/台账」（统一归 daemon，不再在 Electron main 进程内跑）；
- daemon 内部在 S3 之后仍同时保留 `SCRY_ORCHESTRATION=off | shadow | on`，直到 `on` 在真机和灰度中验证稳定后再删除 `off` 与 `shadow`。
- 这样可以独立回滚：P4 的回退开关与 S3 的进程边界互不绑死。

---

## 4. 静态检查与棘轮（W9 已落地，不改变任何运行时行为）

- 脚本：[scripts/main-import-boundary.mjs](../../../scripts/main-import-boundary.mjs)
- 基线：[scripts/main-import-boundary-baseline.json](../../../scripts/main-import-boundary-baseline.json)
- 自测：[scripts/main-import-boundary.test.ts](../../../scripts/main-import-boundary.test.ts)（注入 `node-pty`、`better-sqlite3`、非白名单 `node:child_process`、`src/host-runtime/orchestration/*` 均必失败）
- 用法：
  - S3 前/进行中（棘轮模式，只减不增）：`node scripts/main-import-boundary.mjs`
  - S3 完成后（严格模式，0 违规）：`node scripts/main-import-boundary.mjs --strict`

---

## 5. S3 提交顺序与每步验证（已执行，见 §7）

每步独立提交并同步缩减 `scripts/main-import-boundary-baseline.json`；前一步验证未过，不进下一步（仅断开 `main` 导入图，daemon 共用模块保留在仓内）：

1. ✅ **Step 1 — 迁移 `SCRY_TEST_APP=1` 夹具到 daemon 模式**（若维护者确认默认走 daemon）：逐个确认 14 个 smoke 脚本在 `SCRY_HOST_DAEMON=1` 下通过。
2. ✅ **Step 2 — 断开 `main` 的进程内远程宿主与运行管线**：移除 `bootstrap/remote-host.ts`、`create-run-pipeline.ts`、`host-runtime.ts` 在 `src/main/index.ts` 的引用；跑 `node scripts/main-import-boundary.mjs` + `npm run typecheck` + daemon 集成单测。
3. ✅ **Step 3 — 断开 `main` 的 Provider 运行时与终端 PTY**：移除 `bootstrap/provider-runtime.ts`、`bootstrap/terminal-runtime.ts`、`bootstrap/run-execution.ts` 在 `main` 的引用；确认 `@anthropic-ai/claude-agent-sdk`、`@opencode-ai/sdk/v2`、`@qoder-ai/qoder-agent-sdk`、`node-pty` 与 7 个 Provider/runner `child_process` 导入全部从基线清零。
4. ✅ **Step 4 — 断开 `main` 的 SQLite、台账写者与 `SourceControlService`**：移除 `db.ts`、`SourceControlService`、`recentStore`/`projectStore` 写者与 `turn-recorder` 执行侧在 `main` 的引用；确认 `better-sqlite3` 与其余非白名单 `child_process` 清零。
5. ✅ **Step 5 — 移除 `daemonModeEnabled()` 死分支与文案，切换严格门禁**：删除 11 个文件中的进程内死分支与 `SCRY_HOST_DAEMON=0`（按维护者决定），在 CI 中启用 `node scripts/main-import-boundary.mjs --strict`；跑完整 `node` + `unit` + `daemon-orchestration` + macOS 打包 smoke。

## 6. 回滚策略

- 每步都是独立提交，单步出现回归可直接 `git revert <step-sha>`，不影响其他步骤和 daemon 侧代码；
- S3 不删 `src/daemon/` 任何逻辑，也不改 `orchestration.db` 或 H1 文件格式，回滚无数据迁移风险。

---

## 7. 执行记录（2026-11-21，分支 `s3-remove-in-process`）

### 7.1 结果

- `node scripts/main-import-boundary.mjs --strict`：**reachable=192**（原 639），orchestration=0，禁用包 0，禁用模块 0，非白名单 `child_process` 0；`main` 仅剩白名单内的 `child_process` 导入（`daemon-launch`、`daemon/supervisor`、`login-start/exec`、`process-diagnostics`、`remote/desktop-transport`）。外部包只剩 `electron`、`@peculiar/x509`、`reflect-metadata`。
- 基线 `scripts/main-import-boundary-baseline.json` 清空（三类均为 `[]`）；CI `node` 作业新增 `Main import boundary (strict)`；自测改为 strict 断言，`FORBIDDEN_MODULES` 另加 provider registry/provider-runtime/terminal-runtime/run-execution/session-catalog/conversation-store/db-connection/source-control process/recorder-cli-runtime。
- CI 删除 `unit-in-process` 作业与 `npm run test:in-process`（`Check` 汇总改为 8 个作业）；`daemon-orchestration` 作业不变。

### 7.2 Step 2–4：App 主进程装配

`src/main/index.ts` 只装配窗口、界面与系统交互：trace 视图（`createTraceRuntime`，只读登记表与 run 级流）、dock badge（`bootstrap/attention-state.ts`，与 daemon 共用）、窗口自身通道、后台服务控制、登录启动桥、host-admin 通知、W10/W17 执行目标与 workbench pump（`appDaemonModeDeps` → `createLazyDaemonRunSurface`）、连接其它宿主的桌面客户端。

- 不再构建：run pipeline、进程内远程宿主（`bootstrap/remote-host.ts` 已删）、Provider registry/runtime、Pi profile runtime、terminal manager/PTY、SQLite（`initDb`）、`SourceControlService`、session catalog/conversation store/service、history runtime、startup recovery、userData 锁认领（`userdata-owner-dialog/messages.ts` 已删，`userdata-owner.ts` 只剩信号前校验）。
- daemon 拥有的 109 个通道（local op 89 + forward 20）由 `bootstrap/daemon-owned-channels.ts` 直接从 `daemon-channel-gate.ts` 的表注册，监听器永不执行，由闸门转发；App 自身 63 个通道与 9 个 run 通道照旧注册。与 S3 前的 daemon 模式逐通道一致（181 个，等于 preload 调用集）。
- 各通道的 App 侧守卫/结果处理照旧安装：选择框（`project-daemon.ts`）、会话生命周期对话框（新 `session-dialogs.ts`）、`agent:loadSession` 选择回写（新 `history-daemon.ts`）、`agent:newSession` 视图（新 `new-session-daemon.ts`）、Provider context cwd、MCP OAuth、recorder content、terminal、workbench、conversation send。
- `conversation:setViewed` 只读会话台账文件（新 `conversation-ledger-read.ts`，与 `ConversationStore.read` 共用），已知项目改问 daemon（`daemonKnownProjectDirectory`），不再读 App 自带的 recent/project/session 副本。
- 为切断导入链抽出的纯模块：`remote/desktop-workbench-query.ts`、`remote/execution-target-error.ts`、`source-control/request-values.ts`、`bootstrap/project-cwd.ts`。
- App 启动不再：`warmShellEnv`（登录 shell 采集）、`configureStorage`、`configureProviderEventLog`、`setBillingEnvProvider`；退出时不再 settle 进程内 run、dispose Provider/SourceControl/transcript parser（S3 前 daemon 模式下它们本就闲置）。

### 7.3 Step 5：开关、死分支与文案

- `daemonModeEnabled()`/`DAEMON_MODE_ENV` 删除；`gateDaemonChannel` 无条件生效。`ipc-trust.ts` 拆出 `registerTrustCheckedListener`（只做信任校验，供测试驱动共享 handler 表）。
- `SCRY_HOST_DAEMON=0`：**忽略并打印一行警告**，不崩溃、不改写环境（`daemon-mode-default.ts` 的 `applyAppStartupGuards` / `retiredDaemonModeWarning`）；`SCRY_TEST_APP=1` 的隔离 userData 守卫保留。
- 删除：`background-service-*` 与 login-start manager 的 `daemonMode` 参数、`daemon_mode_disabled` 原因与文案、`BackgroundServiceStatus` 的 `in-process` 形态、`DaemonRunModeResult` 的 `disabled`、`inProcessRemoteHostEnabled`、`app-startup-writers.ts`、`provider-handlers.ts`、`session-deletion.ts`（其测试改为直接驱动共享的 `createSessionLifecycle`）、`remote-host-network.ts`。
- IPC 矩阵：`collectChannels` 额外读取闸门表（`gateTableChannels`），矩阵与生成文档不变（181 通道）。

### 7.4 脚本

- `session-open-bench`：只剩 daemon 模式（`--daemon` 仍可传、无作用），`measurementVersion` 7 → 8，`performance-native.mjs` 改为只接受 `mode: 'daemon'`；阈值未改。native 门禁 base/candidate 跑同一份冻结 harness，因此两边都在 daemon 模式下测。
- `daemon-mode-timing`：删除 `in-process` 臂；B4-V 的 switch-off 对照退役（`modeEnv('switch-off')` 按名拒绝，`--no-controls` 恒开，startup 只剩 `daemon-cold`/`daemon-running`）。
- 单臂基准改为 daemon 模式：`concurrent-performance`、`performance-soak`、`session-concurrency-bench`、`workflow-session-open-bench`、`fixtures/concurrency-trace-live-host`；`desktop-remote-host-smoke` harness 与 `electron-security-smoke` 全部子模式改为 daemon 冒烟夹具。
- 夹具输入（`SCRY_ELECTRON_SMOKE_{CONVERSATIONS,SIDE_CHAT,INPUTS,CALLS,IDENTITY,READER,READS}`）由 `daemon/supervisor.ts` 的 `smokeFixtureEnvironment` 转给 daemon，仅当 `SCRY_DAEMON_SMOKE_PROVIDER=1` 且来自 `SCRY_TEST_APP=1`（App 一跳）或已由本函数配置过的 supervisor（第二跳）；普通启动永不携带。
- 性能预算/棘轮：`performance-budgets.json`、`performance-ratchet.json` 无改动（无进程内专属条目）。

### 7.6 冒烟结果（Linux xvfb、非 root 用户、Chromium sandbox 开启、开发布局）

- 通过：`electron-security-smoke --dev`、`--dev-files-only`、`--dev-pi-history-only`、`--dev-steer-only`、`--dev-conversation-ownership-only`、`--dev-source-control-only`、`--dev-terminal-only`、`--dev-meta-prompts-only`。
- `daemon-mode-smoke`：除 `daemonProcessesAfterRestart: daemon_holder_zombie` 外全部通过；基线 `88480569` 同样失败，属本机环境（VM 的 PID 1 不回收孤儿进程）。
- 暴露的 daemon 侧差异（S3 前这些子模式固定走进程内，daemon 模式下从未验证；本次未改 daemon 行为，需后续处理）：
  - `--dev-unified-conversation-only`：`adoptActiveRun` 对统一对话的 run 不再拒绝（`daemon/local-endpoint.ts` 的 `adopt` 直接返回登记表状态，没有经过 `control.adoptSession()`）。
  - `--dev-unified-conversation-only --workspace-start`：仓库在选择后被改动时，daemon 仍启动 run，没有「仓库已变化」拒绝。
  - `--dev-side-chat-only`：子会话标签页不报告权限待答；App 日志有 `daemon subscribe trace read failed invalid_daemon_response`。
  - `--dev-side-chat-large-history-only`：`conversation:read` 返回 `daemon_outcome_unknown`。
  - `--dev-structure-only`：基线即因裸入口版本冲突失败；修正入口后跑约 10 分钟，失败于「A new child did not take composer focus」。
- 本机无法运行：`--dev-question-only`（需 `--foreground` 与 macOS Dock）、`--dev-file-history-only`（需外部源文件参数）、`desktop-remote-host-smoke --dev`（只认 macOS 的 `Electron.app`）、全部打包冒烟与 native 性能门禁（macOS / 打包）。基准脚本（session-open、concurrent-performance、performance-soak、session-concurrency、workflow-session-open、concurrency-trace live host、daemon-mode-timing）已改为 daemon 模式，未在本机测量。

### 7.7 W18 macOS 收尾（2026-11-22）

- 开发和打包布局的五项重点冒烟全部通过。所有专项、UI 第 3 分片、实际 Dock、远程宿主和 daemon 重启验收通过。
- 同一构建的 S1 原生性能门双向比较通过，八个场景分片皆有样本。daemon 并发基准通过 42 条 shell Hook、2 条生命周期 CLI 和完整归档校验。
- 类型、严格导入和 CLI 门通过。全量 Vitest 通过 7,589 项，5 项原有跳过。一项既有的 Git 分支分页超时按原配置单跑 7/7 通过。
- macOS 验收和已知限制见 [W18 阶段一报告](handoff/reports/W18.md)。

### 7.5 回滚

按提交逐个 `git revert`；不涉及 daemon 数据格式、`orchestration.db`、H1 或远程协议版本（仍为 2）。

