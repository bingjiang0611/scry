# 执行任务书 · Batch 3（Batch 2 修复 + 本机运行管线去 Electron 化 + daemon 承载宿主）

给执行 agent。先读 [REVIEW-BATCH2.md](REVIEW-BATCH2.md)、[P3b-local-runtime-design.md](P3b-local-runtime-design.md)、[P3-daemon-design.md](P3-daemon-design.md)，再按本文一次做完。工作约定、停止条件、提交与 STATUS 规则与 [EXECUTION.md](EXECUTION.md) 第 0、1 节相同。进度写到新文件 `STATUS-BATCH3.md`（总览表 + `status/b3-*.md`）。

本批目标：**daemon 进程能在独立 userData 下承载完整远程宿主并真正跑 run**，远程设备经它配对、发送、长轮询、停止、拿到 trace，App 进程不参与。App 改经本机通道连 daemon（本机会话也走 daemon）是 Batch 4，本批不做。

## 已采用的决策（维护者可推翻，推翻前按此执行）

- REVIEW-BATCH2「答复」表里的全部决定。
- daemon 运行时：App 自带的 Electron 可执行文件 + `ELECTRON_RUN_AS_NODE=1`（开发期用 `node_modules/.bin/electron`）。如果实测发现更好的方案，先写进设计稿并说明理由再改，不要静默换。
- 不保留新旧兼容版本。`SCRY_HOST_DAEMON=1` 只是开发期开关，默认关闭；默认路径行为与 Batch 2 完全一致。
- daemon 只在独立的 test userData 与临时工作区上验证，任何测试都不得打开用户真实的 DB、`.scry` records 或 transcript。

## 任务

### B3-F1 · 修复：trace 内容读取补尾沿（REVIEW-BATCH2 S1）
两个场景都要覆盖：
1. 自己发起的 run：节流窗口内被跳过的变化，必须在窗口到期时补读一次，不依赖下一次长轮询返回。
2. 跟随别处发起的 run（Mac / 其他设备）：内容读取不挂在 `liveRuns` 长轮询上，run 在屏幕上且 live 时按 `TRACE_REFRESH_FLOOR_MS` 节奏读 `traceDelta`。

要求：读取次数仍满足 S1 的上限（同一 run 每个窗口最多一次，`scripts/remote-trace-read-frequency.mjs` 重测并写进 STATUS，标 L1）；定时器在卸载、换会话、run 结束时清理；页面不可见时暂停。
测试先写并证明在当前实现上失败：「一批事件落在节流窗口内、之后 15 s 无事件，内容在窗口到期后 ≤ 1.2 s 内被读到」；跟随 run 同理。

### B3-F2 · 小修：Mac run 会话绑定发信号（REVIEW-BATCH2 F3 遗留）
Mac run 的 `externalSessionId` 绑定时调用 `runs.notifyChanged()`。测试：绑定后等待中的 `liveRuns` < 1000 ms 返回。

### B3-D · 更正设计稿
按 REVIEW-BATCH2 的三处更正修改 `P3b-local-runtime-design.md`（§7 凭据、daemon 运行时与 ABI、删除共存版本），并在 §8 标明本批做到第几步。纯文档，单独提交。

### B3-M1 · 存储注入化（设计 §8 第 1 步）
`db.ts`、`app-store.ts`、`remote-history.ts`、`mcp-execution-trust.ts` 等不再在模块顶层 import `electron` 或从 `app.getPath` 推导路径，改为显式注入 `userDataDir` / `dbFilePath` / `outboxDir`。Electron main 在启动时注入，行为不变。
验收：现有测试全绿；新增导入图断言覆盖这些模块。

### B3-M2 · 运行管线去 Electron 化（设计 §8 第 2 步）
`src/main/bootstrap/run-*.ts`、`conversation.ts`、`app-agent.ts`、`agent-runner.ts`、`trace-runtime.ts`、`user-question.ts`、`run-registry.ts`、`source-control`、`desktop-workbench` 中对 `app`、`BrowserWindow`、`webContents` 的依赖改为接口注入：`paths`（userData、resourcesPath、私有 CLI 绝对路径）、`rendererSink`（trace/状态事件）、`notify`（dock/通知）、`openPath`、`trashItem`。
把 `trace-runtime.ts` 拆成事件源与 renderer 转发两半；App 侧转发保留现有 16 ms 合批与背压。main 仍在本进程调用，**行为不变**。
验收：
- 新的组装入口（例如 `src/host-runtime/create-run-pipeline.ts` + `createHostRuntime`）的值导入图不含 `electron`（复用 B2-P3a 检查器，带自检）。
- 现有 `src/main`、`src/renderer/components`、`scripts/performance-counters` 测试全绿。
- `npm run performance:measure -- --compare 577995b` 无 `worse`；有 `worse` 先说明或修复。
- `npm run test:desktop-remote` 全绿。

### B3-P1 · daemon 进程承载宿主（设计 §8 第 3 步）
- 入口 `src/daemon/main.ts`：启动环境清洗与 App 一致；用 B3-M2 的组装入口建立运行管线与 `createHostRuntime`；开启 B2 的本机通道与远程传输（SSH socket / Relay 按现有宿主配置）。
- 台账锁单写者：同一 userData 只有一个 daemon 持有台账；第二个实例退出且不改台账；锁记录进程身份，`process_identity_changed` 时不误停别的进程（CLAUDE.md：只停止登记且重验 identity 的进程）。
- supervisor：退避重启，次数上限，超过上限后停止并留下可读的失败记录，不静默循环。Linux 用 `systemd --user` unit 模板（只生成、不自动安装到用户系统）；macOS 用 launchd plist 模板（同样只生成）。实际安装托管留到 Batch 4。
- 构建：`npm run build` 产出 daemon 入口；`electron-builder.yml` 的 resource allowlist 只加 daemon 需要的文件，`npm run pack:artifact` 通过并检查产物里 daemon 入口与私有 CLI 路径存在。
- 重启语义：daemon 被 SIGKILL 后重启，`dispatched` 的 run 变 `failed(host_restarted)`，未确认的写报 unknown 且不重放。

验收（全部在独立 userData + 临时工作区 + fake provider fixture 上）：
| 场景 | 断言 |
|---|---|
| 远程设备经 daemon 完成配对、发送、长轮询到 settled、读到 trace | 内容与进程内宿主一致（同一 fixture 对比） |
| 只有 unix socket | daemon 的 server 地址都是 socket 路径，没有 TCP 端口 |
| 两个 daemon 抢同一 userData | 第二个退出，台账未被修改 |
| SIGKILL 后重启 | 上面的重启语义 |
| 证据收敛 | recorder 两阶段提交在 daemon 内仍等 Provider result / hook / diff，不提前提交 |
| trust gate | 仓库 MCP/Hook/plugin 的 canonical cwd + 指纹在 daemon 内重验，指纹变化拒绝执行 |
| 导入图 | `src/daemon/main.ts` 值导入图不含 `electron` |

### B3-V1 · 查清 security smoke 失败归属
在 `a0b2355`（Batch 2 起点）与 `aada148` 上复跑 `node scripts/electron-security-smoke.mjs`，用临时 worktree 与临时 userData。如果起点也失败，二分到引入它的提交并写进 STATUS（若在本分支之外则只报告，不修）；如果起点通过，说明是 Batch 2 引入，修复并加回归。本批结束时 security smoke 必须通过，或有证据证明失败与本分支无关。

## 交付前全局验证
与 Batch 2 同一张表全部重跑（vitest、typecheck、build、build:cli、performance:inventory、performance:measure、test:desktop-remote、electron-security-smoke、pack:artifact、`git diff --check`），外加 `npm run test:renderer:ui`。无法执行的项写 not-run 与原因。不安装、不重启用户的 App，不升版本号，不开 PR。

## 停止条件（在 EXECUTION.md 之外追加）
- B3-M2 若发现某个依赖无法注入而必须改变运行行为（例如 recorder 提交时机、审批语义、trust 判定位置），停下写进 STATUS，不要用近似实现绕过。
- 任何需要改授权语义（grant 字段、trust 策略、权限模式）的地方，停下请维护者决定。
