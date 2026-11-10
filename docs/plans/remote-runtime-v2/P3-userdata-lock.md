# P3 · userData 独占锁

状态：维护者 2026-11-10 决定「现在做，只在开关打开时生效；不属于 B4-S 的删除工作」（[STATUS-BATCH4](STATUS-BATCH4.md)）。本文是设计；「开关打开」部分已实现，「开关关闭」部分（情形 1）只设计，等维护者决定。

## 要防的事

同一个 userData 目录同时有两个写者。SQLite 的文件锁只保证单条事务不撕裂，挡不住两边各自跑迁移、重放 outbox、恢复会话账本、清理对方正在写的原子临时文件、重复投递 commit hook。

## 谁拥有什么

| 文件 | 开关关闭 | 开关打开 |
|---|---|---|
| `scry.db`（含 `-wal`/`-shm`）、`db-turn-outbox/` | App main | daemon |
| `app-sessions.json`、会话账本、trace 归档、`usage.jsonl`、managed turn 日志、trace turn 进度、commit hook 重投 | App main | daemon |
| 远程台账与 lease（remote host） | App main | daemon（App 侧 remote host 已关，见 `remote-defaults.ts`） |
| `daemon/`（`daemon.lock`、本机授权、`supervisor-failure.json`） | — | daemon |
| `performance/`、`desktop-connections/`、Electron 自身文件（`SingletonLock` 等） | App main | App main |
| `diagnostics/run-timing.ndjson`（`SCRY_RUN_TIMING=1` 才写） | App main | 两边追加，设计如此（同一把墙钟对齐） |

开关打开时，判断标准是 `daemon/host-process.ts` 装配了什么：它调用 `initDb()` 与 `runStartupRecovery()`，凡是这两步与它装配的 store 写的文件都归 daemon。

## 锁

- **文件**：`<userData>/scry-userdata.lock`，0600。放在 userData 根而不是 `daemon/` 下：`SCRY_DAEMON_STATE_DIR` 与 `SCRY_DAEMON_USER_DATA_DIR` 是两个独立变量，`daemon.lock` 只保证「每个状态目录一个 daemon」，两个状态目录不同、userData 相同的 daemon 都能拿到各自的 `daemon.lock`。
- **格式**：与 `daemon.lock` 相同的 JSON 记录 `{ pid, startedAt, identityKey, startedBy, role }`，`role` 现在只有 `daemon`；`app` 留给情形 1 的选项 B。
- **实现**：复用 `ledger-lock.ts` 的 `acquireDaemonLock`，只加三个选项：锁文件名（接管互斥文件随之为 `<name>.takeover`）、不收紧已有目录权限（userData 由 Electron 创建，不顺手改成 0700）、`role`。没有第二套锁实现。
- **获取**：daemon 启动时先拿 `daemon.lock`，再拿 userData 锁，两把都拿到才构造 host（`lifecycle.ts` 的 `startDaemon`）。`daemon.lock` 已被占时照旧退出码 3，不碰 userData 锁。
- **释放**：`dispose` 先关 host，再放 userData 锁，最后放 `daemon.lock`。释放只删仍描述本进程的记录（pid + startedAt 都相同），继任者已接管的记录不动。
- **崩溃与过期**：沿用 `daemon.lock` 的身份规则——持有者不存在、是僵尸、或同 pid 但可比较的启动身份不同（pid 被复用），才算过期并在接管互斥内重写；身份格式无法比较而命令行像 Scry 时，按「无法证明已死」拒绝（fail closed）。接管只是文件操作，从不向持有者或复用该 pid 的进程发信号。
- **同步 I/O**：锁沿用 `ledger-lock.ts` 的同步文件调用。它只在 daemon 进程启动、host 构造之前跑一次，不在 IPC 或用户交互路径上。

## 平台

- 身份来自 `readProcessIdentitySync`：Linux 用 `/proc` 的 boot_id + starttime（精确），macOS 用 `TZ=UTC` 的 `ps lstart`（秒级，内核绝对启动时间，改时区不变）。
- 互斥依赖本地文件系统上 `open(..., 'wx')` 的原子性（APFS、ext4、btrfs 都满足）。userData 放在网络文件系统上不在保证范围内。
- 不用 `flock`：Node 标准库没有，引入原生依赖不值得；与 `daemon.lock` 用同一套证据也让两把锁的判断一致。

## 冲突时发生什么

| 情形 | 结果 | 用户看到 |
|---|---|---|
| 1. 开关关闭的 App 启动，旧的开关打开会话留下的 daemon 仍活着 | **未关闭**，需维护者决定（下文） | — |
| 2. 开关打开的 App，main 启动时自己打开/写 daemon 的文件 | 已关闭：开关打开时 main 不调用 `initDb()`、不跑 `runStartupRecovery()`（`app-startup-writers.ts`）。其余启动步骤逐项核对见下 | 无变化；统计类通道本来就由 daemon 回答 |
| 3a. 两个 daemon，同一状态目录 | `daemon.lock` 已覆盖：`ledger-lock.test.ts`「refuses a second daemon while the holder is alive」与 L2「lets exactly one daemon replace a stale lock」，`lifecycle.test.ts`「a second start exits without touching the lock」 | 第二个以退出码 3 安静退出 |
| 3b. 两个 daemon，状态目录不同、userData 相同 | 已关闭：第二个拿不到 userData 锁，放掉自己的 `daemon.lock`，以 `daemon_userdata_owned` 失败（退出码 4，supervisor 不重试） | daemon 日志 `daemon.userdata-owned holderPid=… holderRole=… reason=…`；`supervisor-failure.json` 记 `daemon_userdata_owned`；App 不再干等 10 s 超时，直接报 `daemon_unavailable:daemon_userdata_owned` |
| 4. 开发/测试实例用另一个 userData | 不受影响：锁在各自 userData 里 | — |

情形 2 的逐项核对（开关打开时 main 在 `app-lifecycle.ts` 里的启动步骤）：

- `initDb()`：打开 `scry.db` 并跑迁移，**是写者** → 开关打开时跳过。main 里读写 SQLite 的通道（`agent:stats`、`agent:usageAnalytics`、`agent:billingState` 等）都经 `handleTrusted` → `gateDaemonChannel`，开关打开时转给 daemon 或按名拒绝，进程内 handler 不会执行；万一有遗漏，`db` 为空时这些查询本就返回 unavailable，不会显示成 0。
- `runStartupRecovery()`：重放 outbox、清理原子临时文件（可能删掉 daemon 正在写的临时文件）、恢复会话账本、managed turn 恢复、commit hook 重投（会执行 hook），**是写者** → 开关打开时跳过，daemon 的 host 已经跑同一个函数。启动计时记 `recovery_owned_by_daemon` 后结束，不伪造恢复阶段。
- `startRemoteHostIfEnabled`：开关打开时已关（`remote-defaults.ts`）。
- `startPerformanceRecording`、`desktop-connections` 恢复：App 自己的文件。
- `configureRunStageTiming`：见上表，设计上两边追加。
- 退出路径：`settleRunsForShutdown` 只处理 main 登记的 run，开关打开时 main 不跑 run（管线 `execution: 'daemon'` 拒绝启动）；`sourceControl.dispose()` 只冲刷本进程收到的草稿，开关打开时这些通道不在本进程执行。

## 情形 1：需维护者决定

开关关闭的 App 现在不看任何锁，只有 Electron 的单实例锁。旧会话的 daemon（以及能把它拉起来的 supervisor）仍在时，两边都会写 `scry.db` 等文件。`supervisor.ts` 已能生成 launchd/systemd 登录服务定义（目前只写文件、不注册）；一旦注册，登录时自动拉起的 daemon 会让这种情形更常见。只靠开关打开一侧关不上：daemon 无法区分 userData 的另一个使用者是开关打开还是关闭的 App（两者都持有 Electron 的 `SingletonLock`），也不能靠 App 传 pid（supervisor 重启 daemon 时沿用旧环境）。

选项（都只在开关关闭时改变行为，都需维护者同意）：

- **A. 关闭开关的 App 启动时只读检查 `scry-userdata.lock`**，在 `initDb()` 之前。持有者经身份核实仍活着且 `role: daemon` → 不进入进程内写路径，弹窗说明「后台服务（pid N）正在使用这个数据目录」，提供「停止后台服务」或「退出」。停止只对重新核实过身份的那个 pid 发 SIGTERM，等锁释放；核实失败或超时就退出，不 fallback 到继续写。过期锁按无人持有处理。
- **B. 关闭开关的 App 也持有 `scry-userdata.lock`（`role: app`）直到退出。** 这样之后被孤儿 supervisor 拉起的 daemon 会以 `daemon_userdata_owned` 拒绝启动。单独用 B 不解决「daemon 已经先拿到锁」，所以与 A 一起用。
- **C. 维持现状**，在文档里写明风险。

建议 A + B。代价：开关关闭的 App 启动多一次锁文件读写和一次进程身份读取（Linux 读 `/proc`，macOS 一次 `ps`），放在 `whenReady` 里 `initDb()` 之前。

## 实现位置（开关打开部分）

- `src/daemon/ledger-lock.ts`：加 `name`、`restrictDirectory`、`role` 三个选项，默认值保持 `daemon.lock` 原行为。
- `src/daemon/userdata-lock.ts`：userData 锁；`src/daemon/lifecycle.ts`：`startDaemon` 必须带 `userDataDir`，按上文顺序获取与释放；`src/daemon/main.ts` 传入。
- `src/main/bootstrap/app-startup-writers.ts` + `app-lifecycle.ts`：开关打开时跳过 `initDb()` 与 `runStartupRecovery()`。
- `src/main/daemon-launch-failure.ts` + `daemon-supervisor.ts` 的 `launchFailure` + `daemon-run-mode.ts` 接线：等待 daemon 就绪期间读到本次启动之后写下的机器码失败就立即返回。
- 测试：`src/daemon/userdata-lock.test.ts`、`src/daemon/lifecycle-userdata.test.ts`、`src/main/bootstrap/app-startup-writers.test.ts`、`src/main/daemon-launch-failure.test.ts`，全部用临时 userData。

## 不覆盖

- 只读者：锁只约束写者。开关打开时 App 经闸门不读 daemon 的文件，但锁本身不阻止读。
- 同一 macOS/Linux 用户下的并发恶意进程（与 CLAUDE.md 的信任模型一致）：它可以直接删锁或写文件。
- Electron 自身在 userData 下的文件、`performance/`、`desktop-connections/`。
- 独立的 `scry-turn-recorder` CLI：它只写工作区 `.scry/`，不写 userData。
- daemon 拉起的子进程（Provider、hook）：它们在持锁者的授权下运行，不另行加锁。
- App 现在等 daemon 时仍会对其它启动失败报 `daemon_ready_timeout`；只有 supervisor 记下的机器码失败（`daemon_*`/`remote_*`）才会被提前报出。
