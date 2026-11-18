# Batch 3 核验（N1–N4）

核验对象：`8d73bc2..2216d87`（12 个提交）。所有提交的 author 和 committer 都是 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。

方法：逐个提交读 diff，并对照 `ledger-lock.ts`、`recover-dead-lease.ts`、`recorder-cli-runtime.ts`、`trust.ts`、`desktop-workbench.ts` 以及 renderer 中的调用方。我通过 GitHub API 确认了 Linux run `42343454894`：conclusion 为 success，head 为 `15500a22`，执行的 workflow 是 `npm ci`、准备 Electron、`npm run build`，然后跑 `daemon-sigkill-restart.mjs`。临时 workflow 已在 `2216d87` 中删除。本轮**没有在本机重跑测试**。

## 结论

N1–N4 可以接受。还有**一处很小的必须修（M1）**：N1 新加的“command 是 Scry 就拒绝接管”的兜底，在 macOS 上会把“pid 恰好被自己复用”误判为无法核实，这在 R3 版本中原本是能正确处理的。修完 M1 后，P1 可以关闭。

## 接受

| 项 | 说明 |
|---|---|
| N1 Linux 精确身份 | `/proc/sys/kernel/random/boot_id` 加上 `/proc/<pid>/stat` 第 22 字段；从 `)` 之后开始数，下标 19 是对的，进程名里带空格或括号也不会解析错。远程 lease 和 daemon 锁共用 `readProcessIdentitySync`。旧格式记录的 `identityKey` 缺省为 `''`，不会抛错 |
| N1 Linux 实机 | Ubuntu runner 上用构建产物真实 SIGKILL：lease 的 `identityKey` 必须带 `:linux:`，重启后 daemon 锁和三个 lease 都属于新 pid，最后 SIGTERM 干净退出 |
| 启动期 signal 竞态 | `signal-shutdown.ts` 在启动前就登记 SIGTERM/SIGINT，等 dispose 准备好后立即执行。修复前先写了失败的单元测试 |
| N2 | 只有 daemon 会配置 `configureRecorderCliRuntime`：打包环境要求 `<resources>/bin/scry` 必须存在，否则在创建 host 或 socket 之前就以 `daemon_recorder_cli_unavailable` 失败；runtime env 和 trust 走同一来源。App 不配置这一项，`runtimeCliEnv` 只是把原逻辑原样搬进 `buildRuntimeCliEnv`，行为不变。之前那条恒真的测试已删除，改用真实解析函数测试。打包产物也实测过：PATH 上放假 `scry` 时，仍选中私有 CLI |
| N3 协议 | `openPath`/`trashItem` 改为可选；受限的 host 才在 info 里带 `workbenchOps`，所以 App 的响应格式不变；新 client 遇到旧 host 缺这个字段时，按两项都可用处理；直接调用返回带类型的 `desktop_workbench_operation_unavailable:*`。第一次完整测试暴露过一个兼容性回归，失败记录如实保留 |
| N4 | 本进程身份只取一次并缓存；查询其他 pid 时 macOS 用 `ps -p`，Linux 不再 spawn。受控计时显示：全量 `ps` 20 次 782 ms，单 pid 20 次 144 ms，缓存 2000 次 2.4 ms，load 2.46，记录为 L2 定向数据。表述如实 |
| 拆分 | `claude-locate.ts` 按职责拆出 `command-path`、`provider-environment`、`agent-cli-selection`、`recorder-cli-runtime`，拆分后 19,975 B，低于门禁 |

## 必须修

### M1 macOS 上 pid 恰好被自己复用时，被误判为“无法核实”

`ledger-lock.ts:96-100` 和 `recover-dead-lease.ts:80-84` 新加了同一条兜底：身份不一致，但这个 pid 的 command 看起来是 Scry（`Scry.app/`、`/Scry`、`out/main/daemon*.js`），并且不是 Linux 精确身份时，判为 `unverifiable` 或 `identity_unverifiable`，拒绝接管。

问题是**“看起来是 Scry 的进程”可能就是正在做判断的进程自己**。macOS 的 pid 按顺序分配，登录项的启动顺序又比较固定，所以重启后 launchd 拉起的 daemon，或开机自启的 App，很可能拿到和上次一模一样的 pid。上次异常退出（断电、强制关机）后留下的锁或 lease，就会遇到“pid 活着、身份不同、command 是 Scry”的情况，而这个进程正是自己：

- **daemon 锁**：返回 `already-running reason=identity-unverifiable`，exit 3。supervisor 把 exit 3 当作“已有实例在跑”，**不重启、也不写失败记录**。结果这次开机 daemon 一直不启动，状态看上去却很正常。
- **远程 lease**：App 的远程宿主抛出 `remote_lease_identity_unverifiable`，这次启动不可用，要等下次启动换了 pid 才恢复。

R3 版本在这种情况下会判定为 pid 复用并正确接管，所以这是 N1 引入的回归。Linux 不受影响，因为精确身份会直接得出 stale。

修法（最小改动）：
- 两处都在兜底**之前**加一条判断：记录里的 pid 等于当前进程的 pid、但身份不同，就是确定的 pid 复用。当前进程还活着，那条记录不可能是它写的，否则身份会一致。这时按 stale 或 `pid-reused` 接管。
- 原有的 claim fence 和 takeover 互斥区保持不变。

测试（两处各一条，先在当前实现上失败）：
- lister 返回 `pid = 当前 pid`、command 为 `.../Scry.app/...`、`startedAt` 不同：daemon 锁应得到 `replaced-stale reason=pid-reused`，lease 应被恢复。
- 对照用例：pid 不是当前 pid、command 是 Scry、`startedAt` 不同时，仍然拒绝。

## 应修（可在 App 切到 daemon 的批次处理，不阻塞 P1）

- **N3 UI 还没有用上 `workbenchOps`。** client 已经解析这个字段，但 renderer 只看 `catalog?.workbench === 1`（`RemoteChatView.tsx:201-209`），全仓没有其他地方读 `workbenchOps`。连接到受限 host 时，“外部打开”和“移到废纸篓”仍会显示，点了才收到带类型的错误。目前 App 不会连接 daemon host，实际影响要等后续切换时才出现；到时候要把 `workbenchOps` 传进 catalog，隐藏或禁用这两个操作，并说明原因。
- **macOS 的兜底可以收窄。** macOS 的 `lstart` 来自内核记录的绝对启动时间，不会随校时漂移，所以 command 兜底在 macOS 上基本只会带来误拒。修完 M1 之后，可以考虑只对旧格式记录（身份不完整或格式无法识别）启用这条兜底；注释里“macOS drift”的说法也要相应修正。

## 文档

`STATUS-BATCH3.md` 中 B3-P1 那一行标的是“完成”，说明文字却还是“N2 运行时 recorder CLI 待修，N3/N4 可同批”，需要更新。

## 下一步

1. 修 M1，先写失败测试。
2. 门禁：`src/main` + `src/daemon` + `src/host-runtime`、typecheck、build、构建产物 SIGKILL 脚本（macOS）、`--dev` security smoke。M1 只改判断逻辑，Linux 上精确身份走的路径不受影响，不需要再跑一次 Linux runner。
3. 修正 STATUS 中那一行的说明，推送，然后停下等核验。M1 通过后 P1 即可关闭。
