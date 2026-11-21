结论：通过（第六轮；2 项非阻塞应修随 P4-3 前的收尾一起做）

# W9 核验（续，第五轮起）

第一至四轮见 [W9-review.md](W9-review.md)。

## 复核（第五轮，2026-11-21，提交 `f7269dcd`、`9486209b`）

**已成立：**
- 没有 `orchestration.db` 时，默认路径不做任何新操作（`existsSync` 后直接返回，0.01 ms）。
- DB 是目录、是垃圾内容、被其他进程锁住，或在 `on_active=1` 时损坏，都 fail-open：H1 逐字节不变，daemon 正常启动、可以提交。
- 只有 shadow 的 DB（超过 256 条）在 unset、shadow、off 三种模式下，H1 都逐字节不变。
- 单快照 reset：在 1023、1024、1025、2047、2048、2049、3000 处崩溃（共 14 种情况），以及真实 SIGKILL 跨越 1024 边界时，R 都不小于已发出的所有编号，旧游标收到 `reset`，没有 `invalid_cursor`。
- 首 token 前仍只有 1 次提交。初始快照、30 s 重试与状态接口都已实现；`host-admin-runtime.ts` 只加了 2 行，与 W11 兼容。
- 重启期间结束的 run，在桌面端和 iOS 上都能显示为已结束。`bound` 标记丢失属于 on 模式独有的退化，可以接受。
- 检查点在 worker 执行、PATH 失效这两项的测试，变异后都会失败。

**Linux 复跑：**
- `typecheck` 通过。
- orchestration 与 daemon 在三种模式下各 82 个文件、347 个用例全部通过。
- remote 只有以 root 运行导致的那个已知失败。
- `check:cli-runtime` 1,222 个用例全部通过。
- performance baseline 与 abab 10/10 通过。

### 阻塞

1. **B1：存在 DB 时，默认路径每次启动约多 0.65 s。**
   - 原因：`reconcileH1ForOffMode` 先完整执行 `EventSink.open`（integrity_check、迁移、EXCLUSIVE、BEGIN IMMEDIATE），之后才读 `orchestration_on_active`。
   - 实测（33k run、176 MB 的 shadow DB）：未设置模式启动 758–814 ms，短路时只要 116–121 ms。
   - 修法：先用只读连接（`readonly: true, fileMustExist: true, timeout: 0`，放在 try/catch 里）读取 `orch_meta`，值为 `'1'` 时才做完整打开。
   - 另：DB 是 0 字节文件时，未设置模式启动会把它变成一个真正的 143 KB DB。只读读取后，这个问题也一起消失。
2. **B2：on 模式下，例行压缩之后 H1 变成 `ledger_log_corrupt`，状态却仍显示正常。**
   - 原因：`store.compact` 里的 `mirror.enqueueCompact` 用的是 DB 快照，其 `lastSeq` 是正在发出的那条事件之前的编号，而 DB 里已经包含了这条事件的效果，随后追加的事件就成了重复的状态转换。
   - 已复现：日志超过 6 MiB 后再跑一个 run；内存 8,192 条上限也会触发。
   - 性能问题：每次压缩都在 emit 里同步调用 `buildH1SnapshotFromDb`，33k run 时要 280–340 ms，而且会发生在首 token 之前；镜像追上之前，会连续压缩（实测 10 次）。
   - 修法：例行压缩直接用台账自己的 `snapshot` 参数写镜像，它与后续事件一致；只在失败和重试路径上才从 DB 重建。
3. **B3：预留写入失败时，编号仍然被发出。**
   - 原因：`persistReservedUntil` 吞掉了 `setMeta` 的失败（DB 已关闭时直接跳过），`append` 照常继续。
   - 已复现：在 1024→1025 边界让 setMeta 报 SQLITE_FULL，1025 被发出，而持久化的 R 仍是 1024。重启后 `since(1025)` 返回 `invalid_cursor`，新事件再次使用 1025。
   - 修法：持久化尝试之后，如果 `event.seq > reservedUntil`，就抛出 `orchestration_write_indeterminate`。

### 应修

1. **`on_active` 门控没有测试覆盖**（变异存活）：补一个「只有 shadow 的 DB 领先于被截断的 H1」的测试，去掉门控时 H1 会被改写。
2. **`since(0).cursor` 的变异存活**：实际行为等价，因为 on 之后 H1 的 lastSeq 一定小于 R，在文档里写明即可。
3. **plan 与决定 H 有矛盾**：第 41 行与 §9 第 2 条仍写着 `legacy.mirror` 是可重放的 effect；§9 第 3 条以 `SCRY_HOST_DAEMON=0` 为理由拒绝单向 on→off，与 §14.5 冲突。
4. **未写明的 fail-open 残余**：`on_active=1`、off 启动时 DB 打不开、上一次 on 被 SIGKILL 且镜像落后时，off 会在陈旧的 H1 上运行。要么写进 data §4.0，要么在 on 启动时（try/catch 内）取 `max(R, H1 lastSeq)`（推荐）。
5. **`parseSelfReport` 遇到 `orchestration.mode` 不是 `on` 时，会丢弃整份自报状态**：改为忽略未知值。



## 复核（第六轮，2026-11-21，提交 `6b965b47`）

结论：**通过**。B1–B3 与应修 1–5 全部修复，没有新的阻塞。

**B1**：
- 只读探测把默认路径启动时的校正耗时从 977–1,169 ms 降到 0.5–2.4 ms（33k run，195 MB shadow DB），DB 与 H1 都逐字节不变。
- 0 字节的 DB 仍保持 0 字节。
- DB 被其他进程以 EXCLUSIVE 锁住时，约 2 ms 内返回 `SQLITE_BUSY`，daemon 正常启动。
- on 被杀后留下 `-wal`、没有 `-shm` 时，能正确读到 `active:true`。
- 目录只读时 fail-open。

**B2**：
- 例行压缩期间，emit 路径不读 DB。
- 让镜像卡住、跨过 8,192 条两次后恢复：没有出现容量错误；H1 的 `lastSeq` 与台账一致（19,046）；16 个 run 的 runState 与 DB 一致。

**B3**：预留写入失败时，整个引擎被封住（fence）。重启后第一个编号是 1025，大于所有已发出的编号。

**应修 4**：H1 损坏时不会阻止 on 启动。

**应修 5**：未知的 `orchestration.mode` 被忽略；W11 的 N1 逻辑保持不变。

**Linux 复跑**：
- `typecheck` 通过。
- orchestration 与 daemon 测试在三种模式下各 83 个文件、354 个用例全部通过。
- remote 测试 643 个用例中 642 个通过，唯一失败的是以 root 运行时的已知用例。
- `check:cli-runtime` 全部通过。
- 4 个变异都会被拦下。

**非阻塞应修**（P4-3 之前做）：
1. 镜像积压超过 2,048 条时，emit 路径仍会同步从 DB 重建快照（`legacy-mirror.ts:247-256`），33k run 时一次 536–594 ms，只在大突发下出现。改为置标记，在 drain 时重建。
2. 应修 4 让每次 on 启动都在主线程同步解析一次 H1（21 MB 时 162–248 ms）。只在 `on_active='1'` 时才做，或放到主线程以外执行。

**小项**：
- 探测会在已有 DB 旁留下 `-shm` 和空的 `-wal`。
- `orchestration` 为 null 时仍会丢弃整份自报状态。
- 引擎被封住时，状态仍显示 `h1FallbackUnavailable:false`。
- plan 第 9 行仍写着开发构建默认走进程内（W15 之后已过时）。

**P4-2 至此代码核验完成。** 合入 main 前还要：维护者 Mac 上的 S1 复测（报告里已有 fullfsync 开启后的两轮数据），以及 on 模式的真机抽验（随最后的停机复验一起做）。
