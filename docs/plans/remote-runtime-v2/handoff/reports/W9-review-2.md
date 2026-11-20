结论：第五轮需修改（默认路径基本安全；3 项阻塞，修法明确）

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

