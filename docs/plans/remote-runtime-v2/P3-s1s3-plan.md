# P3 · B4-S S1 + S3 执行清单：默认打开与删除进程内路径（草案，待 S0 全部通过后执行）

维护者 2026-11-12 决定一步到位：S0 全部通过后，默认打开（S1）和删除进程内路径（S3）一起做，没有逃生开关和观察期（[P3-b4s-plan](P3-b4s-plan.md)）。本文是动手前的清单：删什么、按什么顺序提交、每步怎么验证、静态检查怎么写。**本文不改变任何代码；S0 没有全部通过之前不执行。**

## 现状：App 主进程现在会加载什么

用 esbuild 从 `src/main/index.ts` 打包并读 metafile（`--packages=external`，2026-11-12，`f5024e0`）：可达 535 个模块。按「S3 之后 main 不应再有」的类别统计（同一模块只计一次）：

| 类别 | 可达模块数 | 从哪里进来（main 的第一层） |
|---|---:|---|
| Provider 适配器与 SDK（`@anthropic-ai/claude-agent-sdk`、`@opencode-ai/sdk/v2`、`@qoder-ai/qoder-agent-sdk`，`providers/*`、`agent-runner`） | 72 | `bootstrap/provider-runtime.ts`（40）、`bootstrap/startup-channels.ts`（19，经 `providers/pi.ts`）、`bootstrap/session-catalog.ts`（5）、`bootstrap/trust.ts`（3）、其他各 1 |
| 运行管线 | 2 | `bootstrap/run-execution.ts`、`host-runtime/create-run-pipeline.ts` |
| 终端运行时（`node-pty` 经 `require`） | 2 | `bootstrap/terminal-runtime.ts` → `terminal-manager.ts` |
| SQLite（`better-sqlite3` 经 `require`） | 3+ | `db.ts` → `db-connection.ts`、`db-outbox.ts`、`db-turns.ts`、迁移 |
| 台账与 store | 6 | `db.ts` 经 `db-turns`（span、billing ledger）、`remote/session-ledger(-file)` |
| `SourceControlService` | 1 | `source-control/service.ts` |
| 进程内远程宿主 | 2 | `bootstrap/remote-host.ts` → `host-runtime/host-runtime.ts` → `remote/remote-host-service.ts` |

开关分支（`daemonModeEnabled()`）在生产代码里 11 个文件、15 处：`index.ts`（2）、`daemon-channel-gate.ts`（放行）、`remote/remote-defaults.ts`、`bootstrap/workspace.ts`（3）、`history-runtime.ts`、`app-startup-writers.ts`、`session-deletion.ts`、`app-agent.ts`、`daemon-run-mode.ts`、`conversation.ts`、`provider-handlers.ts`（2）。另有文案：`background-service-copy.ts` 的 `daemon_mode_disabled`、`renderer/background-service-view.ts` 的「后台服务模式未启用」、`userdata-owner-messages.ts`。

**不是所有 `providers/` 下的模块都要删。** 下面这些在 App 里是只读解析或校验，可以留：`claude-jsonl-projector`、`pi-jsonl-projector`、`pi-native-parse`、`pi-native-stream/history`（侧聊读原生 transcript）、`providers/mcp-auth-security`（App 打开 OAuth URL 前复核）、`providers/historical-input`（历史解析）。判据见下文的静态检查：能不能 spawn、能不能写。

### main 可达的 `child_process` 导入（18 个）

需要逐个归类，S3 之后留下的进入白名单并写明理由：

| 模块 | 初判 |
|---|---|
| `bootstrap/daemon-launch.ts`、`daemon/supervisor.ts` | 留：App 拉起后台服务 |
| `process-diagnostics.ts` | 留：按 pid + 启动时间复核身份（`ps`） |
| `remote/desktop-transport.ts` | 待查：连接别的宿主（可能是 ssh 隧道），属于「客户端」，大概率留 |
| `llm-network-configuration.ts` | 待查：读系统代理设置的话留 |
| `claude-locate.ts`、`pi-agent-profiles.ts`、`mcp-config.ts`、`recorder-cli-runtime.ts` | 待查：可能只被进程内路径用；若 App 仍需结果，改问后台服务 |
| `providers/claude.ts`、`providers/codex-app-server.ts`、`providers/opencode-server.ts`、`providers/qoder-launch.ts`、`providers/pi-rpc.ts`、`agent-runner.ts` | 删：Provider spawn |
| `source-control/process.ts` | 删：git 归后台服务 |
| `core/turn-recorder/git-command.ts`、`commit-hook-process.ts` | 删：recorder 提交归后台服务 |

## 提交顺序

每一步都单独提交，单独跑验证；前一步不过，不进下一步。删除只针对 **main 的导入图**：共用工厂和模块后台服务还在用，文件本身不一定删。

| # | 内容 | 主要文件 |
|---|---|---|
| 0 | **静态检查，ratchet 形式**：脚本从 `src/main/index.ts` 打包求可达模块，按下节规则列出违规；把当前违规清单作为基线提交，只许减少。带自检。 | `scripts/main-import-boundary.mjs`（新）、基线 JSON、测试 |
| 1 | **默认打开**：`daemonModeEnabled()` 恒为 true，`SCRY_HOST_DAEMON` 不再被读取；测试里显式设 `SCRY_HOST_DAEMON=0` 的改为删除或迁到 daemon 模式。这一步之后的每一步都在 daemon 模式下验证 | `daemon-channel-gate.ts`、各测试 |
| 2 | 去掉 15 处开关分支里「开关关闭」的一侧；闸门删除「开关关闭时直接放行」 | 上面列出的 11 个文件 |
| 3 | 运行管线与 Provider 运行时：`provider-runtime.ts`、`run-execution.ts`、`create-run-pipeline` 不再从 main 导入；`index.ts` 里组装它们的代码删除 | `index.ts`、`bootstrap/provider-runtime.ts`、`run-execution.ts`、`app-agent.ts` |
| 4 | 启动通道里的 Pi 目录（`startup-channels.ts` 经 `providers/pi.ts`）：App 需要的 profile 列表改问后台服务，或只留纯数据部分 | `startup-channels.ts`、`pi-agent-profiles.ts` |
| 5 | 信任：`bootstrap/trust.ts` 的执行侧（Codex Hook、OpenCode plugin、`opencode-server`）只在后台服务里 | `bootstrap/trust.ts` |
| 6 | 终端运行时：`terminal-runtime.ts`、`terminal-manager.ts` 不再从 main 导入（App 只留 `terminal-daemon.ts`、`daemon-terminal-reader.ts`） | `index.ts` 终端段 |
| 7 | `SourceControlService` 与 git 子进程 | `source-control/service.ts`、`process.ts` 的 main 导入 |
| 8 | SQLite 与启动恢复：`db.ts`、`db-outbox`、迁移、`app-startup-writers`、`startup-recovery` 的 App 侧 | `app-lifecycle.ts`、`app-startup-writers.ts` |
| 9 | 进程内远程宿主：`bootstrap/remote-host.ts` 的宿主部分；`remote-defaults.ts` 简化 | `bootstrap/remote-host.ts` |
| 10 | userData 锁的 App 一侧（A + B）：App 不再写 userData，不再持锁；daemon 一侧保留 | `userdata-owner*.ts`、`app-lifecycle.ts` |
| 11 | 收尾：静态检查基线清零，转为「零违规」门禁；`recentStore` / `projectStore` 写入调用检查；拆分接近 20 KB 的文件；文案里的 `SCRY_HOST_DAEMON` 说明删除 | 检查脚本、`index.ts` 等 |

第 1 步和第 2 步也可以合并：只要第 1 步之后开关关闭的路径已不可达，第 2 步就是纯删除。分开的好处是第 1 步可以单独跑一遍全量测试，先看清哪些测试依赖进程内路径。

## 静态检查

脚本用 esbuild metafile 求 `src/main/index.ts` 的可达模块（与上面的统计同一方法），**不**用正则解析 import（`require` 与动态 `import()` 都要算）。违规规则：

1. 可达模块导入了 Provider SDK 包、`node-pty`、`better-sqlite3`（含 `require('…')`，按源码扫描可达文件）。
2. 可达模块在禁止清单里：`host-runtime/create-run-pipeline`、`terminal-manager`、`db-connection`、`remote/session-ledger-file`、`remote/remote-host-service`、`source-control/service`、`agent-runner`、`providers/{claude,codex-app-server,opencode-server,qoder*,pi-rpc,pi-run}`。
3. 可达模块导入 `child_process`，且不在白名单（白名单每项写理由）。
4. `src/main` 里出现 `recentStore` / `projectStore` 的写入调用（[REVIEW-BATCH4-FD](REVIEW-BATCH4-FD.md)）。

自检：测试里临时生成一个导入 `node-pty` 的模块并接到入口上，检查必须失败；把一个白名单外的 `child_process` 导入接上，也必须失败。

## 每一步的验证

在 Linux 容器里：

- `npx vitest run`（全量；已知的环境失败单列：无头 Chromium 2 项、root 下 chmod 2 项、`owned-app-processes` 1 项），`npm run typecheck`，`npm run build`，`node scripts/daemon-ipc-matrix.mjs`；
- 静态检查（违规只减不增）；
- `xvfb-run node scripts/daemon-mode-smoke.mjs`（非 root 用户）与 `daemon-config-smoke`；
- 改到 `performance-paths.json` 的 `sources` 时跑 `performance:measure`。

B4-V 场景脚本需要真实 Electron 与 Electron ABI 的 better-sqlite3，容器里共用的 `node_modules` 是 Node ABI，所以按领域的场景复验放在 macOS，每两三步一轮；第 11 步之后跑 S4 全量。

## 已知风险

| 风险 | 应对 |
|---|---|
| 测试大量直接构造进程内管线 | 测的是共用模块的，保留（后台服务在用）；测的是「开关关闭时 App 的行为」的，随第 1、2 步删除或改写，提交说明逐个列出依据 |
| `test:renderer:ui`（macOS CI 门禁）里的 App 改为 daemon 模式启动 | 第 1 步之后先在 macOS 上跑一遍，失败先修 |
| 删完之后难以回退 | 按领域提交；回退只能回到切换前的构建（维护者已接受） |
| `index.ts`、`host-process.ts`、`daemon-run-runtime.ts` 接近 20 KB | 删除会腾出空间；第 11 步按职责拆分 |

## 动手前需要的

1. **S0 全部通过**：S0-2 审批与问题表单修复后的真实 Provider 复验（进行中），S0-4 真实数据副本演练（未收到结果），原生对话框真人点击（待定方式），会话打开计时（进行中）。
2. **Linux 证据**：CI 只在 PR 和 main 上触发，这个分支上 Linux 打包 job（含打包产物的 daemon smoke）**从未在真实 runner 上跑过**。按维护者决定第 5 条，Linux 同步打开的前提是 Ubuntu runner 验收通过；要拿到这个证据，需要开一个 PR 触发 CI，或者维护者用别的方式在 Ubuntu 上跑一遍。
3. **S3 之后 Linux 若不过怎么办**：删除之后没有「Linux 保持关闭」的开关可用（[status/b4-s0-linux](status/b4-s0-linux.md) 已提出）。如果 Ubuntu runner 不过，S1 + S3 应整体推迟，而不是只让 Linux 留在进程内路径。
