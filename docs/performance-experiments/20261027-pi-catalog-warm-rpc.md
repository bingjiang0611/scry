# Pi 目录探测：常驻 RPC 进程复用

状态：L1 已验证；L2（真实 `pi` 毫秒）未测；未合入 main、未构建安装。

## 慢在哪

运行中 build 的日常记录：`pi.catalog.probe` p50 1996 ms，阶段拆分
`environment_ready` 11.5 ms、`spawned` 1.4 ms、`first_response` 2081 ms。
也就是说**时间几乎全花在冷启动 `pi --mode rpc` 上**，四条能力读取本身是毫秒级。
原先每次读取都新建进程，四次读取完成后立刻 `terminate()`，下一次读取（模型目录、
命令目录、run controls、history enrich）再付一次冷启动。

## 改法

`src/main/providers/pi-catalog.ts` 增加按 `profile.id + executable + cwd` 停放的探测进程：

- 读取结束后不再关闭，而是放进空闲池，60 s 空闲（`PI_CATALOG_IDLE_MS`）后关闭。
- 下一次读取优先复用停放进程，**仍然重新发送同样四条 RPC**：`get_state`、
  `get_available_models`、`get_available_thinking_levels`、`get_commands`。
  不复用任何已固化的能力快照，模型/扩展/项目信任的变化照旧能看到。
- 复用条件：进程 `reusable()` 且环境变量与本次解析结果深度相等；否则丢弃旧进程再起新的
  （失败或正在关闭的进程不会被留下来）。
- 每次操作切换自己的 trace（`PiRpcProcess.attachCatalogTrace`，并重置响应计数），
  复用的读取只报告它真正做的事：没有 spawn、没有 exit 阶段。
- `disposePiCatalog()` 关闭并等待退出；adapter 的 `dispose()` 与 `invalidateContext()`
  调用它，并已在该处先关闭再走 rotom 池。

## 计数变化（L1）

`scripts/performance-counters/pi-probe.counters.test.ts` 的固定负载从「1 次读取」改为
「2 次读取共用 1 个子进程」，工作负载标记同步改为
`offline-readonly-rpc=1;probes=2;queries=8;eof-idle-handle=1;parked-process=1`。

| 指标 | 改前（1 次读取） | 改后（2 次读取） |
|---|---:|---:|
| `subprocess.rpc` | 1 | 1 |
| `rpc.responses` | 4 | 8 |

即：同样 4 次读取的工作量，启动次数减半。合并说明中已写明这是测量改动，
必须能说明减少的工作去了哪里——这里是真的不做了（不再为同一 profile+cwd 重复冷启动）。

## 测试合同的变化（已显式修改）

旧测试断言「探测结束后子进程必须已优雅退出」。新的合同是「在 dispose 或空闲 TTL 边界退出」，
因此：

- `src/main/providers/catalog-performance.test.ts`：冷探测阶段为
  `environment_ready, spawned, first_response, responses_received`（不再有 `closed`）；
  第二次读取复用后无新 spawn，阶段为 `environment_ready, first_response, responses_received`；
  进程存活有断言，`adapter.dispose()` 后断言 `ESRCH`。
- `scripts/performance-counters/pi-probe.counters.test.ts`：两次读取后 `disposePiCatalog()`，
  再断言 `probe-closed`、`ESRCH` 与关闭时刻不早于最后一个响应。

失败路径（RPC error、启动即退出）仍是「进程不可复用 → 立即关闭」，阶段与退出证据未放宽。

## 验证

- `npx tsc -p tsconfig.node.json --noEmit`：通过。
- `npx vitest run src/main/providers/catalog-performance.test.ts src/main/providers/pi.test.ts`：
  6/6 与 124/124 通过。
- `npx vitest run scripts/performance-counters/pi-probe.counters.test.ts`：通过。
- `npx vitest run scripts/performance-ratchet.test.ts`：10/10 通过（pi-probe 指标尚未进台账）。

## 未验证

- 真实 `pi` CLI 的冷启动 vs 复用毫秒（`SCRY_PI_PROBE_TIMINGS` 只覆盖受控 fixture）。
  需要在低负载下用 `timing-run.mjs` 加锁测。
- 整机全量 unit、renderer UI、真实 App 重放。
- 空闲 TTL 到期关闭只在受控夹具里覆盖，未在长时间运行的 App 里观察。

## 失败读取不常驻（全量测试后补的一句）

第一版实现是「只要进程还能用就停放」，全量 unit 暴露出 `pi-lifecycle.test.ts` 的
「releases a failed flight so a later probe can recover」被破坏：RPC 命令失败后进程本身
健康，于是被停放并复用，下一次读取又撞上同一个失败面。

现在只有**读取成功**才停放；抛出异常（RPC 错误、超时、提前退出）的进程立即关闭，
下一次读取从干净进程开始。相应地：

- `pi-lifecycle.test.ts`：并发读取仍共享一次启动；后续读取复用同一个活进程（不再新起第二个），
  `adapter.dispose()` 后断言子进程 `ESRCH`；忽略 TERM 的顽固进程改为「停放期间仍被持有，
  dispose 时仍走 TERM→SIGKILL」。
- `catalog-performance.test.ts` 的失败用例恢复原断言：失败探测的最后一个阶段是 `closed`，
  进程在探测 settle 前就已退出。

「失败飞行释放」这条原有合同因此没有放宽，只是把「释放」的触发点从「每次读完」精确定义为
「读完成功 → 停放；读完失败 → 立即关闭」。

## L2 尝试（受阻，2026-10-27 5:15）

尝试用真实 CLI 测「冷启动 vs 复用」，受阻：

```
$ pi --version            # /Users/baobingjiang/.local/bin/pi
1.2.0                     # 包装脚本 exec IdeaProjects/vibecoding/pi/.../dist/bundle/cli.js
$ (echo '{"type":"get_state","id":"a"}'; sleep 3) | pi --mode rpc --no-session --offline
Warning: No models match pattern "qoder/ultimate" ...   # 三行警告后没有任何 response 帧
exit=1
```

本机只有这一个 `pi`（无 npm 全局安装），是 dev build。它在 `--mode rpc` 下直接退出 1，
连一个 response 都发不出来，因此无法测真实冷启动毫秒，也无法用真实 CLI 复现 2 秒探测。

这不是本次改动引入的（改动没有碰 CLI 启动参数），但对结论有两点影响：

1. 计划好的 L2 证据仍缺，只能宣称 L1（1 次启动服务 2 次读取）。
2. 如果运行中的 App 用的也是这个 executable，Pi 路径现在会直接失败——需要用户确认
   这是否是当前讨论的 dev build，以及是否需要换回可用的构建再测。
