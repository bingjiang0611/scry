# Batch 3 核验（P1-2 至 P1-6，P1 收尾）

核验对象：`59fa817..8d4626c`（8 个提交）。提交身份全部是 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。

方法：逐个读 diff，并对照 App 侧的同名路径（`index.ts`、`remote-host.ts`、`startup-recovery.ts`、`recover-dead-lease.ts`、`host-controller-desktop-reads.ts`）。本轮**没有重跑测试**，核验环境没有安装依赖。下面每条结论都附了代码位置，可以直接复查。

## 结论

**P1 不能按“完成”关闭。** 骨架是对的：锁 → 宿主 → 本机通道的生命周期、只开 unix socket、worker URL 注入、tool panel 的 unavailable envelope、真实 mTLS-over-unix 的端到端测试，这些都接受。

但有四个问题必须修（R1–R4），还有一项门禁归属需要重新验证（R6）。在此之前，`STATUS-BATCH3.md` 里 B3-P1 应改回“未完成”。

## 接受

| 项 | 说明 |
|---|---|
| `startDaemon` + `startHost` | 只有拿到锁以后才构造宿主；构造失败会释放锁；`dispose` 先停宿主，再在 `finally` 里释放锁。顺序正确 |
| 本机通道 | 复用同一个 inner-mTLS host，只有 `daemon/local.sock`，没有 TCP 监听，relay 关闭有断言 |
| tool panel unavailable（`6199f2f`） | 补齐了 `ToolPanelPayload.unavailable` 这个已有契约，不是新增一种降级默认值；测试也断言了不带数据字段 |
| 平台注入（`c3bc8b5`） | `session-state`、`session-catalog`、`provider-runtime` 的值导入图里已经没有 electron，有先失败的测试守着 |
| worker URL 注入 | 修掉了 chunk 化以后 `import.meta.url` 解析错位的问题，worker 协议本身没动 |
| supervisor 的 exit 3 | 已有写者时不重启。模板设置了 `KeepAlive=false`/`Restart=no`，只生成文件，不安装 |
| P1-6 端到端 | 设备配对 → submit → long watch → trace chunk 全程走真实 daemon host，没有直接调 controller 的捷径 |
| `daemonEntry` 改成绝对路径 | 已按上轮建议完成 |

## 必须修

### R1 daemon 宣告了它没有的能力（CLAUDE.md 第 1、2 条）

`host-process.ts:202-205,220,234-235` 用 `unavailable()` 抛错来实现 fork、delete、session metadata、open/trash。但这些函数都会**无条件**传进 `createHostRuntime`（`host-runtime.ts:94-121`），所以 `host-controller-surface.ts:250-252` 算出来 `canSessionActions`、`canSessionFork`、`canSessionDelete` 全是 true。`readDesktop` 因此会告诉设备 `sessionActions: true`、`sessionFork: true`、`sessionDelete: true`（`host-controller-desktop-reads.ts:37-39`）。另外，`host-process.ts:184` 的 `supportsForkSession` 也会按 Provider 宣告支持 fork。

结果是：远程设备会显示重命名、存档、fork、删除按钮，用户一点就收到 `daemon_capability_unavailable:*`。这正是“声称有能力、实际没有”。

修法：
- `RemoteHostRuntime` 和 `createHostRuntime` 的输入里，把这几项改成可选。
- daemon 不提供这些项，让 `sessionAction`、`sessionFork`、`sessionDelete` 保持 `undefined`。这样 controller 会走已有的 `desktop_session_fork_unsupported` 分支，info 里也不会出现对应标志。
- daemon 的 `supportsForkSession` 返回 `false`。
- workbench 里的 open/trash 也按同样方式处理，或者在 info 中明确声明不可用。

测试要求：先写一个失败测试，通过 daemon 的 `local.sock` 读取 `desktop info`，断言上面三个标志都不存在，并且 provider discovery 的 `forkSession` 是 false。

### R2 daemon 不做启动恢复，新 run 也不等恢复完成（CLAUDE.md 第 1、5 条）

App 启动时会运行 `runStartupRecovery`：conversation `recoverAll`、trace turn progress、managed trace turns/progress，以及 recorder commit hooks。新的 run 通过 `getStartupManagedRecovery` 等这一步完成后才被接纳。

daemon 的 `startupManagedRecovery` 一开始就是 `Promise.resolve()`（`host-process.ts:134`），从来没有运行过恢复。可是 P1-5 要处理的正是 SIGKILL 场景，被杀时正在进行的 managed recorder 两阶段提交会一直挂着。daemon 重启后又会立刻接纳新 run，这就是“悄悄降级”。

P1-6 表格里“证据收敛”这一行的依据只是“daemon 使用同一个 `startRun`”，覆盖不到崩溃后的恢复路径。

修法：
- 用 M1/M2 的同一手法，把 `runStartupRecovery` 里的 `app.getPath('userData')` 改成注入。
- daemon 在 `service.start()` 之前启动恢复，并把 promise 交给 `getStartupManagedRecovery`。
- 恢复失败时保持和 App 一样的行为：记录日志，不阻断宿主。新 run 仍然要等恢复结束。

测试要求：在临时 userData 里放一个 pending 的 managed turn journal，创建 daemon host 以后断言它被处理了。再断言 submit 在恢复完成前不会 dispatch。

### R3 P1-5 测的不是 SIGKILL；而且锁下面一层的 lease 也有 L1 同样的问题

`host-process.test.ts:87` 在“重启”之前调用了 `ledgerStore.close()`，lease 文件已经被正常删除，所以测到的是**正常关闭**，不是 SIGKILL。

真实 SIGKILL 以后，`session-ledger.lock`、`pairing-state.lock`、`run-output.lock` 都会留在磁盘上，要靠 `recoverDeadRemoteLease` 处理。这个函数只用 `process.kill(pid, 0)` 判断进程是否还在（`recover-dead-lease.ts:53`）：pid 不存在就接管，pid 还在（或者 EPERM）就抛错。

重启机器以后 pid 被复用的情况，上轮 L1 已经修过 daemon 锁，但这三个 lease 还是旧逻辑。结果 daemon 拿到了自己的锁，构造宿主时却抛出 `remote_lease_owner_alive`，进程 exit 1，supervisor 重试 4 次后放弃。这和 L1 是同一个症状，只是下移了一层。App 现在也有同样的问题，是既有问题；但 daemon 的主要使用场景就是开机自启，所以这里必须修。

修法：
- lease 记录里加入和 daemon 锁同一套 UTC 进程身份（`startedAt`/`identityKey`）。
- 身份不一致时，按 stale 处理并接管。
- 无法判定时仍然 fail closed。
- 保留 `recover-dead-lease.ts` 注释里“不按存活时间或沉默推断进程死亡”的规则，也保留 claim fence。
- 旧格式的 lease（没有身份字段）沿用现有逻辑。

这改的是 App 和 daemon 共用的持久化边界。改动范围要写进提交说明。

测试要求：
- 用构建产物真实跑一遍：启动 daemon，`kill -9`，再次启动，断言 `host_restarted`、socket 已就绪、没有第二次 dispatch。
- 单元测试：lease 里的 pid 是一个活着、但身份不同的进程，应该被接管；身份无法读取时应该拒绝。

### R4 supervisor 和模板拉起的 daemon，路径、版本和环境都不对

- 模板（`supervisor.ts` 的 `writeSupervisorTemplates`）只传了 STATE_DIR、USER_DATA_DIR 和 ENTRY。于是 `supervisor-main.ts:20-22` 用 `process.cwd()` 推导 appPath 和 resourcesPath，而 launchd 下 cwd 是 `/`。`isPackaged` 默认是 false，所以 Pi history reader 的路径会变成 `/resources/scry-history/pi-history-reader.mjs`（`provider-runtime.ts:41`）。
- `main.ts:35` 和 `supervisor-main.ts:22` 都把版本写死成 `'0.2.237'`。下一次升版本以后，Provider 兼容性判断（`ProviderCompatibilityStore.scryVersion`）会用错版本，而且不会有任何提示。
- recorder 私有 CLI 走的是 `packagedRecorderCliPath()`，它读的是 `process.resourcesPath`（`claude-locate.ts:631`），不是注入进来的 resourcesPath，等于有两个来源。在 `ELECTRON_RUN_AS_NODE` 下这个值是否存在，目前没有证据。如果拿不到，就会回退到 PATH 上的 `scry`，也就是全局 npm CLI。这违反了“Hook 通过明确的 private CLI 绝对路径运行”。
- `shellEnvironment: async () => process.env`（`host-process.ts:233`）。App 这里用的是 `warmShellEnv`。launchd/systemd 给的 PATH 很少，Provider CLI 可能找不到。

修法：
- daemon 和 supervisor 缺少 APP_PATH、RESOURCES_PATH、APP_VERSION、PACKAGED 中任何一个时，都以 exit 2 退出，和缺路径时的处理一致。
- 模板写入全部变量；版本在构建时注入，或者从包元数据读取。
- recorder CLI 路径改为由注入的 resourcesPath 决定。
- shell 环境复用 App 的解析逻辑；如果做不到，就在 provider discovery 里如实报告 PATH 来源。

测试要求：
- 模板里包含所有必需变量。
- daemon 下 recorder CLI 解析为 `<resources>/bin/scry`，并且 PATH 上放一个假 `scry` 时不会被选中。

## 应修（可以和 R1–R4 同批）

**R5 supervisor 的重启预算从不清零，也不记录失败原因。** `attempts` 只增不减。daemon 连续正常运行几周、期间偶尔崩溃 5 次，supervisor 就会永久停止。另外子进程的 `stdio` 是 `ignore`，failure 文件里只有 exit code。像 “App 正持有 ledger lease” 这种确定性失败，会被重试 4 次，而且看不到原因。

建议：
- 稳定运行一段时间（比如 60 s）以后，重置预算。
- 已知的启动失败映射成不重试的 exit code，并写入只含错误码、不含正文的 reason。

## 门禁归属需要重新验证

**R6 renderer UI 失败的对照点选错了。** 状态里写着“在 P1-2 起点 `743b5e6c` 同样失败”，但 `743b5e6` 本身已经包含了 `c3bc8b5` 和 `6199f2f`。`c3bc8b5` 改了 main→renderer 的推送接线（`agent:dataUpdated`、`agent:unreadSessions`、terminal worker URL），所以“P1 后没有 renderer 文件改动”不能证明这不是回归。

需要在 `59fa817`（P1-2 开始之前）上单独跑 `session-capability-ui-smoke.mjs --performance-only`。如果仍然失败，再到 `577995b`（Batch 3 起点）上跑一遍。同时记录 revision、命令、exit code 和日志路径。

## 可选

**R7** `check-packaged-app.mjs` 的指纹检查从“`index.js` 必须包含”放宽成了“任一 `out/main/*.js` 包含”。合同还在，但可以收紧为“从 `index.js` 可达的 chunk 里包含”。不阻塞。

## 下一步

1. `STATUS-BATCH3.md` 里 B3-P1 改回“未完成（核验 R1–R4、R6）”。
2. 按 R1 → R2 → R3 → R4 的顺序修复，每项先写失败测试；R5 可以同批完成。
3. 做 R6 的归属验证。
4. 每段通过门禁（`src/main` + `src/daemon` + `src/host-runtime`、typecheck、build、`test:desktop-remote`、`--dev` security smoke；R3 和 R4 另外要求构建产物实测，R4 要求 `pack:artifact`）以后推送，并更新 STATUS。
5. 全部完成后停下，等待核验。
