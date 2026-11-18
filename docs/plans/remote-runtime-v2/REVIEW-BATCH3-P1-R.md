# Batch 3 核验（P1 final review 修复：R1–R6）

核验对象：`8d4626c..8d73bc2`（7 个提交）。所有提交的 author 与 committer 都是 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。

方法：逐个提交读 diff，对照被调用方（`claude-locate.ts`、`trust.ts`、`process-diagnostics.ts`、`desktop-workbench.ts`、三个 file store 的 `assertLease`）核对。本轮**没有重跑测试**，核验环境没有安装依赖。R6 引用的日志在执行机的 `/tmp` 下，我无法查看。

## 结论

R1–R6 的主体可以接受，但 **P1 仍不能关闭**。还剩两个必须修的问题：

- **N1**：Linux 上 lease 身份可能误判，导致一个仍在运行的持有者的 lease 被抢走。
- **N2**：R4 中 recorder CLI 的修复只覆盖了启动恢复；状态文档的说法超出了实际改动，对应测试也无法证明这一点。

另有两项应修（N3、N4）。

## 接受

| 项 | 说明 |
|---|---|
| R1 会话能力 | `sessionAction`、`sessionFork`、`sessionDelete` 只有在 runtime 真正提供实现时才注册；daemon 不再传入会抛错的 stub，discovery 中的 `forkSession` 固定为 false。测试经真实 socket 读取 info，旧实现在该测试上失败 |
| R2 启动恢复 | `runStartupRecovery` 改为注入 userData，不再依赖 Electron。daemon 在打开 `local.sock` 之前就 `await` 恢复完成，所以设备不可能在恢复期间提交 run，这一点由结构保证。App 侧的行为不变 |
| R3 恢复逻辑 | pid 已死时直接接管；pid 活着时按 UTC 身份比对，比对一致才视为 `owner_alive`，比对不一致说明 pid 被复用；身份缺失或读取失败一律 fail closed。原有的 claim fence、inode 校验和 fsync 顺序都保留。提交说明写明了这改变了 App 与 daemon 共用的 lease 语义 |
| R3 真实 SIGKILL | `daemon-sigkill-restart.mjs` 用 Electron 二进制跑构建产物，验证了 lease 带身份、`kill -9` 后能重启，并在之后干净退出 |
| R4 配置 | 6 个变量任一缺失都 exit 2；模板写齐全部变量；不再出现 `process.cwd()` 或写死的 `0.2.237`；shell 环境改为复用 `warmShellEnv` |
| R5 | 进程稳定运行 60 s 后重启预算清零；exit 2 不重试；stderr 读取有上限，只提取 `daemon_*` 机器码，不保留正文 |
| R6 | 归属已查清：P1 之前的 `59fa817` 与 Batch 3 起点 `577995b` 上同一条命令同样失败，记录了 revision、命令和 exit code。renderer gate 仍如实标为失败 |

## 必须修

### N1 Linux 上 `ps lstart` 不稳定，仍在运行的持有者可能被当成 pid 复用（CLAUDE.md 第 3 条“执行 trust gate 必须 fail closed”，以及 macOS/Linux 共同维护）

`remote-lease-owner.ts` 和 `recover-dead-lease.ts` 用 `ps lstart` 作为进程身份，判定标准是 `startedAt` 必须完全相等。在 macOS 上，`lstart` 来自内核记录的绝对启动时间，是稳定的。

Linux 不同：procps 的 `lstart` 等于 `/proc/stat` 的 `btime` 加上进程的 starttime 计数，而 `btime` 是读取时用“当前墙钟 − 开机以来时长”算出来的。NTP 调整时钟或手动改时间后，`btime` 会漂移，**同一个活进程**再次读到的 `lstart` 会差一秒或更多。按现在的逻辑，这会被判为“身份不同，pid 已复用”，于是把仍在运行的 App 的 lease 删掉，并由新进程接管。

原持有者的 `assertLease` 会在下一次读写时发现 inode 变了，抛出 `*_lease_lost`，所以不会长期出现双写者。但存在两个问题：

- 在“对方完成 unlink”和“原持有者下一次 assert”之间，有一个窗口；
- 原持有者的远程宿主会因此失效。

App 与 daemon 之间要互相隔开，靠的正是这道 fence。daemon 锁（L1）不受这个影响，因为它有“command 是 daemon 入口就判为 `identity-unverifiable`”的兜底；lease 没有这个兜底。

修法（二选一，推荐第一种）：

1. Linux 改用精确身份：`/proc/sys/kernel/random/boot_id` 加上 `/proc/<pid>/stat` 第 22 字段（自开机以来的 starttime 计数），两者组成 identityKey；macOS 继续用 UTC `lstart`。同一套身份最好也用到 daemon 锁上，避免两套规则。这样 Linux 上也不用再 spawn `ps`。
2. 至少加上兜底：pid 还活着、身份不同，但它的 command 是 Scry 的 Electron 二进制或 daemon 入口时，判为 `remote_lease_identity_unverifiable`，拒绝接管。

测试：
- 注入一个 lister，让同一 pid 的 `startedAt` 相差 1 s、command 是 Scry 二进制，断言**拒绝**接管。这条在当前实现上应该失败。
- 如果采用方案 1，增加 Linux 下 boot_id 或 starttime 不同时接管、相同时拒绝的用例。

### N2 recorder CLI 只在启动恢复里改成了注入路径；运行时仍可能回退到 PATH（CLAUDE.md 第 5 条“Hook 通过明确的 private CLI 绝对路径运行”）

`status/b3-p1-final-review.md` 写的是“recorder CLI 只由注入的 `resourcesPath` 解析为 `<resources>/bin/scry`，不再回退 PATH/global npm CLI”。实际改动只有一处：`host-process.ts` 把 `daemonPrivateCliPath(resourcesPath)` 交给了 `runStartupRecovery`。

managed run 运行时解析 recorder CLI 走的是 `claude-locate.ts:631-647`（`packagedRecorderCliPath()` 和 `resolveRecorderCliPath`）以及 `trust.ts:130,154,180`。这些地方仍然读 `process.resourcesPath`，读不到时回退到 PATH 上的 `scry`，本批都没有改。

`daemon-config.test.ts` 里那条 “PATH 指向假 scry” 的测试，调用的是一个只做 `join` 的纯函数，根本不读 PATH，所以无论如何都会通过，证明不了任何事情。

修法：
- 让 daemon 把注入的 resourcesPath 交给 recorder CLI 的解析逻辑。可以像 `configureStorage` 那样在进程启动时配置一次，也可以作为参数一路传下去，确保 `runtimeCliEnv` 和 `trust.ts` 用的是同一个来源。
- App 侧继续使用 `process.resourcesPath`，行为不变。
- 打包的 daemon 在 `<resources>/bin/scry` 不存在时 fail closed，不能回退 PATH。dev 模式沿用 App 现有的 `SCRY_CLI_PATH` 语义，并写清楚。

测试：
- 在 `process.resourcesPath` 为 undefined、PATH 上放一个假 `scry` 的条件下，调用**真实的** `resolveRecorderCliPath` / `runtimeCliEnv`，断言得到的是 `<resources>/bin/scry`。
- 删掉或改写那条恒真的测试。
- 同时更正状态文档里的说法。

## 应修

**N3 workbench 的 open/trash 仍然宣告为可用。** `host-process.ts` 继续把会抛错的 `openPath`/`trashItem` 传进 `createDesktopWorkbench`，info 里仍然是 `workbench: 1`。设备上的“外部打开”和“移到废纸篓”点了会收到 `daemon_capability_unavailable:*`（`desktop-workbench.ts:155,164`）。R1 的要求里写了“open/trash 按同样方式处理，或者在 info 中明确声明不可用”，状态文档没有提到这一项。

修法：二者设为可选，workbench 在 info 中按操作声明能力（例如 `workbenchOps`），旧客户端缺少该字段时按全部可用处理。或者至少让这两个操作返回 typed unavailable，并加一条测试。

**N4 每次创建 lease 都要同步 spawn 一次完整的 `ps -axo`。** `createRemoteLeaseOwner` 每构造一个 store，就用 `execFileSync('/bin/ps', ['-axo', …])` 列出全部进程；recovery 遇到活 pid 时又列一次。在 App 中，pairing 和 ledger 两个 store 都在 main 线程构造，所以启动远程宿主时会同步阻塞两到四次全量进程列表。macOS 上进程多的时候，每次要几十毫秒。

修法：
- 本进程的身份在进程内是常量，记忆化后只取一次。
- 查询单个 pid 时用 `ps -p <pid> -o lstart=`，不要列全量；Linux 采用 N1 方案 1 后直接读 `/proc`，不需要 spawn。

这条属于启动路径，建议补一次 `performance:measure` 或定向计时，并注明机器负载。

## 可选或记录

- **R5 只完成了一部分。** 已知的确定性启动失败（例如 App 正持有 lease，抛出 `remote_lease_owner_alive`）仍然以 exit 1 退出，会被重试 4 次。而 reason 的正则只匹配 `daemon_` 前缀，所以 failure 文件里没有原因。建议把 `remote_lease_*` 映射为不重试的退出码，并把 `remote_` 前缀也纳入提取。
- **SIGKILL 的覆盖分在两处。** 构建产物脚本证明了 lease 恢复，但被杀前没有正在进行的 run。`host_restarted` 加“不二次 dispatch”的证明仍来自单元测试，而单元测试里 lease 是正常关闭的。两部分合起来逻辑上能闭合，可以接受；请在状态文档中写明覆盖是这样拆分的，或者在脚本中让被杀前就有一个已 dispatch 的 run。
- **R2 的测试只证明了 atomic temp 被清理**，没有用 pending managed journal 作为 fixture。因为恢复是在 socket 打开之前 await 的，结构上已经足够，可以不补。
- R6 的日志只在执行机的 `/tmp` 下，不在仓库里，下次重启可能丢失。如需留档，可以把摘要（revision、命令、exit code、首条错误）写进状态文件。

## 下一步

1. `STATUS-BATCH3.md` 中 B3-P1 改为“未完成（核验 N1、N2）”。
2. 先修 N1，再修 N2，每项先写失败测试。N3、N4 可以同批完成。
3. 门禁：`src/main` + `src/daemon` + `src/host-runtime`、typecheck、build、`test:desktop-remote`、`--dev` security smoke。另外：
   - N1 需要在 Linux 实机或容器中跑一次构建产物 SIGKILL 脚本；
   - N2 需要 `pack:artifact` 和打包后 daemon 解析出的 recorder 路径实测；
   - N4 需要计时证据。
4. 每段通过门禁后推送并更新 STATUS；全部完成后停下，等待核验。
