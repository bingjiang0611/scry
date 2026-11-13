# P3 · userData 独占锁

状态：维护者 2026-11-10 决定「现在做，只在开关打开时生效；不属于 B4-S 的删除工作」（[STATUS-BATCH4](STATUS-BATCH4.md)）。「开关打开」部分已实现；「开关关闭」部分（情形 1）维护者 2026-11-11 决定按 A + B 做，已实现（见下文「情形 1」）。

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
- **格式**：与 `daemon.lock` 相同的 JSON 记录 `{ pid, startedAt, identityKey, startedBy, role }`，`role` 为 `daemon`（开关打开时的 daemon）或 `app`（开关关闭的 App，情形 1 的选项 B）。daemon 一侧不看 role：任何经核实仍活着的持有者都让它以 `daemon_userdata_owned` 拒绝；role 只用来让 App 判断持有者是不是可以提出停止的 daemon。
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
| 1. 开关关闭的 App 启动，旧的开关打开会话留下的 daemon 仍活着 | 已关闭（A + B，下文）：App 在任何 userData 写者之前尝试以 `role: app` 拿锁；daemon 持有时先问用户，停止或退出，绝不并行写 | 弹窗「后台服务仍在使用这个数据目录」，按钮「停止后台服务」「退出」；失败时说明原因后退出 |
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

## 情形 1：已实现（A + B）

背景：开关关闭的 App 原来不看任何锁，只有 Electron 的单实例锁。旧会话的 daemon（以及能把它拉起来的 supervisor）仍在时，两边都会写 `scry.db` 等文件。只靠开关打开一侧关不上：daemon 无法区分 userData 的另一个使用者是开关打开还是关闭的 App，也不能靠 App 传 pid（supervisor 重启 daemon 时沿用旧环境）。维护者 2026-11-11 选 A + B（C「维持现状」不采用）。

### 顺序

1. `initializeAppEnvironment` 先拿 Electron 单实例锁（不变）：同一 userData 的第二个 App 在这里就退出，走不到下一步。
2. `whenReady` 里第一步（在性能记录、事件日志、`configureStorage`/`initDb()`、启动恢复、remote host、建窗口之前），开关关闭时调用 `claimAppUserData`（`src/main/bootstrap/userdata-owner.ts`）：直接以 `role: app` 调 `acquireUserDataLock`，A 的「读」与 B 的「拿」是同一次调用。
3. 拿到（无人持有，或持有者已死/僵尸/pid 被复用）→ 照接管规则改写记录，不向任何进程发信号，继续启动，持锁到退出（B）。
4. 被占用时按 `decideUserDataHolder`：
   - 持有者经身份核实仍活着且 `role: daemon` → 弹窗问用户（A）。
   - 身份无法比较（`identity-unverifiable`）、或活着的持有者不是 daemon（`role: app`，例如绕过单实例锁的测试 App；或没有 role 的旧记录）→ 不问、不发信号，说明原因后退出。
5. 用户选「退出」→ `app.exit(0)`，不触发 before-quit 清理（那些 store 本来就没打开）。
6. 用户选「停止后台服务」→ 紧接发信号前重新读锁记录和该 pid 的身份（`checkDaemonBeforeSignal`）：记录必须仍是用户看到的那条（pid、startedAt、identityKey、role 都相同），进程身份必须与记录的 identityKey **精确相同**（比拿锁时更严：不接受旧格式按命令行判断）。通过才对这一个 pid 发一次 SIGTERM。
   - 记录已被删除或进程已退出/僵尸 → 不发信号，直接进入第 8 步。
   - 记录换了持有者（`lock-changed`）、pid 身份变了（`identity-changed`）、身份读不到（`identity-unreadable`）、记录没有 identityKey（`identity-unrecorded`）→ 不发信号，退出。
   - `kill` 报 ESRCH 当作已退出；其它错误（如 EPERM）→ `signal-failed`，退出。
7. 发信号后只观察，最多 10 s（`USERDATA_STOP_TIMEOUT_MS`，每 100 ms 一次）：记录不再描述该持有者，或该 pid 已不是那个进程，就算结束。daemon 的 `dispose` 先删自己的 userData 记录再退出；崩溃留下的记录是过期记录，下一步按接管规则处理。超时 → `stop-timeout`，退出；不发第二次信号，不 SIGKILL。
8. 再拿一次锁。仍被占（例如 supervisor 刚把 daemon 又拉起来）→ `owned-after-stop`，退出，不再循环弹窗。
9. 持锁期间：`app.once('quit')` 释放（Electron 在 before-quit 清理结束、`app.quit()` 之后才发 `quit`），`process.once('exit')` 兜底。释放只删仍描述本进程（pid + startedAt）的记录，可重复调用。App 崩溃留下的记录下次按过期接管。

所有失败都是「不写、说明原因、退出」（fail closed），退出码 1；用户主动退出为 0。

### 用户看到什么

| 情况 | 结果 |
|---|---|
| 没有锁 / 锁已过期 | 无变化，正常启动；userData 多一个 `scry-userdata.lock`（0600，`role: app`） |
| daemon 活着 | 警告框「Scry 后台服务仍在运行 / 后台服务仍在使用这个数据目录」，说明 pid、为什么不能同时写、停止会中断它的任务和配对设备连接；默认与取消都是「退出」 |
| 选「退出」 | App 直接退出，不再弹框 |
| 选「停止后台服务」且成功 | 最多等 10 s（期间没有窗口），然后正常启动 |
| 停止失败或无法核实 | 错误框「Scry 无法启动 / 另一个进程可能正在写入这个数据目录」，写明具体原因（pid 被复用、换了占用者、超时、无权限、锁读写失败等）和「Scry 没有写入这个数据目录，现在退出。」 |

文案在 `userdata-owner-messages.ts`，Electron 弹框在 `userdata-owner-dialog.ts`（此时还没有窗口，框是应用级的）。

### supervisor

supervisor 没有可核实的身份记录（`supervisor-failure.json` 只记失败原因，daemon 的 `startedBy: supervisor:<pid>` 是自由文本，按约定不用于信任），所以 App 不向它发信号。实际后果：

- daemon 收到 SIGTERM 后经 `createDaemonSignalShutdown` 以退出码 0 结束，supervisor 把 0 当作 `stopped` 自己退出，不会重启。
- 若 supervisor 仍拉起新的 daemon（例如上一个 daemon 以非 0 退出），而 App 已经持锁：新 daemon 按 B 以 `daemon_userdata_owned`（退出码 4）拒绝，supervisor 记 `supervisor-failure.json` 后停止。
- 若新 daemon 抢在 App 第二次拿锁之前拿到锁：App 以 `owned-after-stop` 退出并说明，不会并行写。

### 代价

开关关闭的 App 启动多一次锁文件读写和一次本进程身份读取（Linux 读 `/proc`，macOS 一次 `ps`）；有持有者时再加一次持有者身份读取。都是同步调用，与紧随其后的 `initDb()` 一样在 `whenReady` 里只跑一次，不在任何 IPC 路径上。`app.startup` 计时加一个 `userdata_owned` 阶段；弹过框时计时从用户作答后重新开始，不把读框的时间算进启动。

## 实现位置

- `src/daemon/ledger-lock.ts`：加 `name`、`restrictDirectory`、`role` 三个选项，默认值保持 `daemon.lock` 原行为。
- `src/daemon/userdata-lock.ts`：userData 锁；`src/daemon/lifecycle.ts`：`startDaemon` 必须带 `userDataDir`，按上文顺序获取与释放；`src/daemon/main.ts` 传入。
- `src/main/bootstrap/app-startup-writers.ts` + `app-lifecycle.ts`：开关打开时跳过 `initDb()` 与 `runStartupRecovery()`。
- `src/main/daemon-launch-failure.ts` + `daemon-supervisor.ts` 的 `launchFailure` + `daemon-run-mode.ts` 接线：等待 daemon 就绪期间读到本次启动之后写下的机器码失败就立即返回。
- 开关关闭（情形 1）：`src/main/bootstrap/userdata-owner.ts`（决策与停止流程，无 Electron）、`userdata-owner-messages.ts`（中文文案）、`userdata-owner-dialog.ts`（Electron 弹框）；`app-startup-writers.ts` 的 `userDataLock`；`app-lifecycle.ts` 在 `whenReady` 第一步接线；`userdata-lock.ts` 的 role 加 `app` 并导出 `readUserDataLockRecord`，`ledger-lock.ts` 导出 `readDaemonLockRecord`。
- 测试：`src/daemon/userdata-lock.test.ts`、`src/daemon/lifecycle-userdata.test.ts`、`src/main/bootstrap/app-startup-writers.test.ts`、`src/main/daemon-launch-failure.test.ts`；情形 1 为 `src/main/bootstrap/userdata-owner.test.ts`（真实子进程充当 daemon：退出、停止、身份变化、记录变化、超时、死锁接管、pid 复用接管、App 持锁时 daemon 拒绝）与 `app-userdata-owner.test.ts`（真实启动顺序：锁先于 `initDb()`、「退出」时没有任何写者被调用、「停止」后正常启动、`quit` 时释放、开关打开时不拿锁）。全部用临时 userData。

## 不覆盖

- 只读者：锁只约束写者。开关打开时 App 经闸门不读 daemon 的文件，但锁本身不阻止读。
- 同一 macOS/Linux 用户下的并发恶意进程（与 CLAUDE.md 的信任模型一致）：它可以直接删锁或写文件。
- Electron 自身在 userData 下的文件、`performance/`、`desktop-connections/`。
- 独立的 `scry-turn-recorder` CLI：它只写工作区 `.scry/`，不写 userData。
- daemon 拉起的子进程（Provider、hook）：它们在持锁者的授权下运行，不另行加锁。
- App 现在等 daemon 时仍会对其它启动失败报 `daemon_ready_timeout`；只有 supervisor 记下的机器码失败（`daemon_*`/`remote_*`）才会被提前报出。
- 情形 1 仍未覆盖：
  - supervisor 本身不被停止（没有可核实的身份记录，见上）；它若在 App 第二次拿锁前重启 daemon，App 只能退出。
  - 停止 daemon 会中断它正在执行的 run；SIGTERM 之后 daemon 的 `dispose` 不等 run 收敛（与 daemon 现有关闭语义相同），App 也不接管这些 run。
  - 等待 daemon 退出的最多 10 s 里没有窗口或进度提示。
  - `whenReady` 之前的模块级装配（`index.ts` 里的各 runtime 构造）按现状不写 userData（`bootstrap/` 下没有同步写），Electron 自身的文件照常写；这一点靠现状，不靠锁。
  - App 读不到自己的进程身份（macOS `ps` 失败）或 userData 不可写时，按 `lock-error` 退出，不再像以前那样照常启动。
  - 只在开关关闭时生效；开关打开的 App 仍不拿这把锁（daemon 持有）。
  - 弹框、信号与 macOS `ps lstart` 身份只在 Linux 上由测试覆盖；macOS 上需真机核对（见交付说明）。

## 合入时的调整（2026-11-11）

App 自己拿不到锁时（userData 不可写，或读不到自身进程身份，例如 macOS 上 `ps` 出错），原实现直接退出。合入时改为：

- 锁文件里**没有任何记录**：照常启动，只记一条警告，相当于锁出现之前的行为。此时没有已知的其他写入者；缺的只是 B，即挡住之后再启动的 daemon。
- **有记录但无法判断**，或记录本身读不出来：仍然退出（fail closed）。

这样做是因为开关关闭的路径就是维护者日常使用的 App：身份读取偶发失败时，不应该让 App 打不开。
