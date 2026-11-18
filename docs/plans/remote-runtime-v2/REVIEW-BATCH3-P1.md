# Batch 3 核验（M2-5、P1-1）

核验对象：`f1c8780..34b5f6b`。提交身份全部正确。

## M2-5（`33741ec`）：接受
`run-*.ts`、`trace-runtime.ts`、`create-run-pipeline.ts` 里已经没有 `webContents`、`getWindow`、`BrowserWindow`，seams 测试守住了这一点。M2 到此完成。

## P1-1（`34b5f6b`）：入口和 exit 5 的处理方式接受，锁有两个问题必须修

宿主还没接上时取锁后以 exit 5 退出，不假装在服务，这个做法是对的。缺少 `SCRY_DAEMON_STATE_DIR` 时直接失败、不去猜 userData，也是对的。

**L1 PID 被复用后，daemon 会永远起不来。**
锁里记录的 pid 还活着、但 `startedAt` 不同时，返回 `identity-changed` 并以 exit 4 退出。可是 `startedAt` 不同恰好证明：写这把锁的那个 daemon 已经不在了，现在占着这个 pid 的是别的进程。重启机器之后 pid 很容易被复用，这时 daemon 每次启动都会 exit 4，只能手工删锁。
CLAUDE.md 的规则是「只停止登记且重验 identity 的进程」，它约束的是**发信号**，不是**接管锁**。
修法：这种情况按 stale 处理，接管锁并记日志（`daemon.took-over reason=pid-reused`）；对那个 pid 永远不发任何信号。

**L1 的附带风险：`lstart` 是本地时间。**
`process-diagnostics.ts` 的 lister 固定了 `LC_ALL=C`，但没有固定 `TZ`。daemon 运行期间如果系统时区变了，同一个活着的 daemon 再读出来的 `lstart` 文本会不同，修完 L1 后它会被当成 stale 接管，变成两个写者。
修法：锁使用的身份读取固定 `TZ=UTC`；另外，如果 `startedAt` 不同、但那个 pid 的 command 就是本 daemon 入口，并且指向同一个 state dir，就无法判断是不是同一个进程，这时按 `already-running` 处理，宁可不启动也不双写。只改锁的调用路径，不改 `process-diagnostics` 其他调用方的行为。

**L2 并发接管 stale 锁会出现两个持有者。**
`wx` 创建是原子的，但 stale 接管走的是「读 → 判断 → `writeFileSync` 覆盖」。两个 daemon 同时遇到 stale 锁时，两个都会判断为 stale、都覆盖写入、都返回 `replaced-stale`。supervisor 重启加上用户手动启动，就足以触发这种情况。
修法：接管必须放进一个原子临界区，例如先用 `wx` 创建 `daemon.lock.takeover` 作为短时互斥；拿到后**重新读取并重新校验**锁记录，再写入，然后删除互斥文件。互斥文件存在超过 10 s 视为残留，可以清理。
测试：通过注入 lister 让两次 `acquireDaemonLock` 在判断之后、写入之前交错执行，断言恰好一个成功，另一个是 `already-running`。

## P1-2 的提醒（宿主装配）

`historyHandlers`、`toolPanels`、`usageAnalytics` 目前由 main 提供。daemon 里如果暂时拿不到其中某一项，对应接口必须返回明确的 `unavailable` envelope 并说明原因，不能返回空数组或 0，否则远程设备会把「没有能力」显示成「没有数据」（CLAUDE.md 第 1 条）。为这种降级加测试。
