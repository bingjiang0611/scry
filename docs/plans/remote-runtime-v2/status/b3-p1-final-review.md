# Batch 3 · P1 final review 修复记录

## R1 能力诚实性——完成

先扩展 `host-process.test.ts`，通过真实 mTLS-over-unix 读取 desktop info 与 Provider metadata。旧实现失败：daemon 明明只会抛 `daemon_capability_unavailable`，却广告 `sessionActions/sessionFork/sessionDelete`。

修复后，`RemoteHostRuntime` 的 session action/fork/delete 能力为可选；`createHostRuntime` 只有拿到真实实现才向 controller 注册对应 handler。Electron main 仍提供原实现，行为不变；daemon 不再提供 throwing stub，并让 Provider discovery 的 `forkSession` 恒为 false。测试同时断言 desktop info 不含三个 capability，Codex metadata 不含 `forkSession: true`。

门禁：main+daemon+host-runtime 2905 passed（3 skipped）；typecheck、build、完整 `test:desktop-remote`、串行重建后的 `--dev` security smoke 全绿。

## R2 daemon 启动恢复——完成

先加 `startup-recovery-imports.test.ts`。旧实现沿 `startup-recovery.ts -> electron` 失败，证明 daemon 不能复用 App 的恢复入口。

`runStartupRecovery` 现在注入 `userDataDir`、recorder CLI 路径和轻量 trace 接口，不再读取 Electron `app`。App adapter 继续传原来的 userData、packaged private CLI 和 `PerformanceTrace`。daemon 在运行管线构造后立即建立并 `await startupManagedRecovery`，完成 DB outbox、atomic temp、conversation、trace/managed-turn 与 commit-hook redelivery 后，才创建 `RemoteHostService` 和 `local.sock`。

`host-process.test.ts` 在 userData 预置 `app-sessions.json.tmp`；daemon host 返回且 socket 可见时，该文件必须已经清理。导入图测试带 Electron main 自检。

门禁：main+daemon+host-runtime 2907 passed（3 skipped）；typecheck、build、完整 `test:desktop-remote`、串行重建后的 `--dev` security smoke 全绿。

## R3 SIGKILL 与共享 lease 进程身份——完成

先扩展 `recover-dead-lease.test.ts`。旧实现失败：活 PID 即永久判定 `owner_alive`，不能识别 PID reuse；process snapshot 缺失也不能给出 `identity_unverifiable`。

新增 `remote-lease-owner.ts`：用 `LC_ALL=C`、`TZ=UTC` 的 `ps lstart` 写入 `startedAt + identityKey`。Pairing、session ledger、run output 三个 file store 都写该身份。恢复时先用 signal 0 判断明确死亡；活 PID 必须重新读取 UTC 身份：完全匹配才拒绝为 `owner_alive`，不同身份才证明 PID reuse，缺失、读取失败或旧 lease 没有身份时一律 `remote_lease_identity_unverifiable`。原有永久 claim 目录、hard-link inode fence、fsync 顺序和 identity-changed 拒绝全部保留。

这**改变了 App 与 daemon 共用的 remote lease 语义**：二者使用相同三个 file store；现在都能安全接管 PID reused 的旧 lease，也都在无法确定身份时 fail closed。

新增构建产物验收 `scripts/daemon-sigkill-restart.mjs`：用 Electron binary + `ELECTRON_RUN_AS_NODE=1` 启动 `out/main/daemon.js`，确认三个 lease 含 UTC 身份，真实 `SIGKILL`，同 userData 重启并等待新 socket inode/新 lease owner，最后 SIGTERM exit 0 且所有 active lease 清理。结果：`{"firstSignal":"SIGKILL","restartReady":true,"secondCode":0,"leaseIdentity":true}`；daemon 日志 `/tmp/b3-r3-sigkill-gate.log`。

门禁：main+daemon+host-runtime 2909 passed（3 skipped）；typecheck、build、构建产物 SIGKILL/restart、完整 `test:desktop-remote`、串行重建后的 `--dev` security smoke 全绿。

## R4 路径 / 版本 / 环境 + R5 supervisor——完成

R4 先扩展模板测试：旧 launchd/systemd 文件缺 `APP_PATH/RESOURCES_PATH/APP_VERSION/PACKAGED`，断言失败。新增 `daemon-config.ts` 作为 daemon 与 supervisor 共用的 fail-closed 解析器；STATE、USER_DATA、APP、RESOURCES、VERSION、PACKAGED 任一缺失或 PACKAGED 非 0/1 都在入口 exit 2，不再从 cwd、`process.resourcesPath` 或硬编码 `0.2.237` 猜测。模板写齐所有变量；`daemon-config-smoke.mjs` 用构建后的两个入口逐项删除变量，12/12 均 exit 2 并返回对应机器错误码。

recorder CLI 只由注入的 `resourcesPath` 解析为 `<resources>/bin/scry`，不再回退 PATH/global npm CLI；测试把 PATH 指向 fake scry，结果仍是 private absolute path。Provider shell 环境改为复用 App 的 `warmShellEnv`，不直接使用 launchd/systemd 的贫瘠 `process.env`。`check-packaged-app.mjs` 检查打包 main 运行图含全部必需环境接线和 fail-closed 校验，并继续验证 Resources 私有 CLI 可执行。

R5 同批：supervisor 的异常重启预算在一次运行达到 60 s 后归零；exit 2 是确定性配置失败，只启动一次并写失败记录。子进程 stderr 改为 bounded pipe，只提取 `daemon_[a-z0-9_]+` 机器码，正文不进入结果或 failure JSON。failure 仍不含路径、prompt、证书或错误正文。

门禁：main+daemon+host-runtime 2920 passed（3 skipped）；typecheck/build、构建入口缺变量 12 项 smoke、真实 SIGKILL/restart、security smoke、`pack:artifact` 全绿。完整 `test:desktop-remote` 首轮在 composer-history fixture 的键盘 completion 等待超时；同一 focused campaign 随即通过，完整门禁复跑通过，首轮失败没有删除或隐藏。

## R6 renderer UI 归属——完成

按核验要求使用 detached worktree、共享当前 `node_modules`，每个 revision 先 `npm run build`，再单跑完全相同的命令：

| revision | 命令 | exit | 日志 |
|---|---|---:|---|
| `59fa817dd86482617ffde6f3cfee78d29bb53d00` | `node scripts/session-capability-ui-smoke.mjs --performance-only` | 1 | `/tmp/b3-r6-pre-p1-performance.log` |
| `577995bce9bbcc03d10a5b95e03ae51df8caa072` | `node scripts/session-capability-ui-smoke.mjs --performance-only` | 1 | `/tmp/b3-r6-batch3-start-performance.log` |

两次都是 `Renderer: Uncaught Error: Performance control obscured: #performance-empty`。对应 revision 记录在 `/tmp/b3-r6-pre-p1-revision.log`、`/tmp/b3-r6-batch3-start-revision.log`，exit code 在同名前缀的 `*-exit-code.log`，构建日志在 `*-build.log`。因此该 renderer gate 失败至少从 Batch 3 起点就存在，不由 P1 引入；仍如实标为失败，不宣称门禁通过，也不在本批顺带修改 UI。

## N1 跨平台进程身份 + N4 启动路径——实现完成，Linux 实机门禁待环境

失败测试先证明旧恢复逻辑会在「同一 pid、`lstart` 只差 1 秒、command 是 Scry」时接管仍存活的 lease；daemon 锁也固定了同一用例。现在 Linux 身份使用 `/proc/sys/kernel/random/boot_id` + `/proc/<pid>/stat` 第 22 字段 starttime，command 从 `/proc/<pid>/cmdline` 读取；macOS 保留 `LC_ALL=C`、`TZ=UTC` 的单 pid `ps -p`。remote lease 与 daemon ledger lock 共用同一 reader/key。精确 Linux key 相同即拒绝、boot_id 或 starttime 不同才证明 PID reuse；legacy/macOS 身份漂移但 command 仍是 Scry 时 fail closed 为 `identity_unverifiable`。

N4 同批：本进程身份进程内记忆化，pairing/ledger/output store 不再各自同步 spawn；外部 pid 查询从全表 `ps -axo` 改为 `ps -p <pid>`，Linux 完全不 spawn `ps`。受控定向计时通过 timing-run 锁执行，日志 `/tmp/b3-n4-lease-timing.log`：20 次旧全表 ps 782.39 ms，20 次单 pid 143.71 ms，2000 次 memoized lease owner 2.43 ms。8 核机器，load 2.46→2.46，`highLoad:false`；这是本机 L2 定向数据，不代表所有机器。

本机门禁：main+daemon+host-runtime 2924 passed（3 skipped）、typecheck、build、构建产物真实 SIGKILL/restart、完整 desktop-remote、dev security smoke 均通过。当前 macOS 主机没有 Docker/Podman/Lima/QEMU，也没有可用 Linux 远端，因此核验要求的 Linux 实机/容器构建产物 SIGKILL 尚未执行；Linux `/proc` 身份有注入式单元测试，但不冒充实机验收。
