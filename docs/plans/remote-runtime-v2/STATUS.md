# 执行状态（执行 agent 维护）

分支起点：`183415b`。每完成一个任务更新一次。

## 总览

| 任务 | 状态 | 提交 | 备注 |
|---|---|---|---|
| T0 分段测量 | 完成 | `4b72294`、`bea0649` | 传输 / 宿主 dispatch / Provider cold-reused 三段可分别读；`bea0649` 补登记 performance-paths |
| T1 Provider 热池 | 完成 | `6090a21` | `ProviderWarmPool` 泛化 + Pi 接入 + 宿主单飞 + 打开会话预热 |
| T2 Desktop 持久 lane | 完成 | `4915672`、`817778c` | 运行通道四条持久 lane，无 one-shot 回退；撤销即断开宿主连接 |
| T3 长轮询 | 未开始 | | |
| T4 catalog 合批 | 未开始 | | |
| T5 协议版本校验 | 未开始 | | |
| T6 P3/P4 设计文档 | 未开始 | | |

## 每个任务的证据

### T0 分段测量

改动文件：

- `src/main/remote/remote-request-timing.ts`（新增）：`remoteOperationLabel` / `remoteOperationCounters` / `remoteRequestTrace`。操作名走固定 allowlist，未校验的 `op` 一律折成 `other`，避免把请求体变成自由文本遥测通道。
- `src/main/remote/desktop-transport.ts`：`desktopTlsRequest` 产出 `remote.desktop.request` 采样，checkpoint 为 `connect_started` → `secure_connect` → `request_written` → `first_byte` → 完成，counters 带 `op.<name>` 与 `handshakes: 1`。
- `src/main/remote/inner-mtls-host.ts`：连接级 `remote.host.connection`（`peer_verified`，`connections: 1`）与每请求 `remote.host.request`（`frame_received` → `dispatch_settled` → `response_written`），counters 带 `op.<name>`。同时把帧解析从两次降为一次（keep-alive 判定与 dispatch 共用同一对象）。
- `src/main/providers/pi-catalog.ts`：`pi.catalog.probe` 结束时带 `catalogCold: 1` 或 `catalogReused: 1`，命中率可直接从采样统计。

测试证据：

- `npx vitest run src/main/remote/remote-request-timing.test.ts src/main/providers/catalog-reuse-counters.test.ts src/main/providers/catalog-performance.test.ts` → 10 passed。其中新增：
  - allowlist 边界（未知/超长/非对象 `op` → `other`）；
  - 采样只含 stage 名与 allowlist 计数，不含路径或提示文本；
  - 第一次 probe 为 `catalogCold`，停放进程复用为 `catalogReused`。
- `npx vitest run src/main/remote/inner-mtls-host.test.ts` → 19 passed。新增真实 mTLS keep-alive 用例：一次握手一个 `remote.host.connection`，两次请求各一个 `remote.host.request`，checkpoint 与 counters 精确匹配。

已知限制：

- release 内只有记录开关打开（`SCRY_PERF_LOG=1` 或注入 sink）时才分配采样；日常实例默认不记录，因此关闭时只能证明没有额外开销。
- 分段是「宿主内部」时间，不含 SSH 隧道与手机到 Relay 的网络跳（实测仍需真机/iCTRL，本批次不做）。
- `Provider controls`（`providers.selected`）的冷启动分段仍由 `pi.catalog.probe` 代表；Claude/Codex/OpenCode/Qoder 的 catalog 读取没有独立采样，结论见 T1 的调研小节。

与 EXECUTION.md 命名的差异（`bea0649` 时确认，不改语义）：

| EXECUTION.md | 实际 | 原因 |
|---|---|---|
| 客户端 `remote.client.request`，属性 `op`/`lane`/`reused` | 同名 trace（T2 的 lane 产出），`op.<name>`、`lane.<name>`、`reused: 0/1` 记为 counters | `PerformanceTrace` 的 dimensions 只接受 `provider`/`platform`，任意属性会被丢弃；counters 是唯一能落盘的数值通道。阶段与要求一致：`connect_started`、`secure_connected`（仅新连接）、`request_written`、`first_byte`、`response_parsed` |
| 宿主 `remote.host.dispatch`，阶段 `authorized`、`dispatched` | `remote.host.connection`（`peer_verified`）+ `remote.host.request`（`frame_received`、`dispatch_settled`、`response_written`） | 授权在每个 controller 方法内部逐请求进行，单独打 `authorized` 需要穿透全部 op；`dispatch_settled` 覆盖「授权 + 执行」。握手（每连接一次）单列，正是为了与 dispatch 分开 |
| `pi.catalog.probe` 属性 `reuse: cold\|warm` | counters `catalogCold: 1` / `catalogReused: 1` | 同上，dimensions 不接受；冷/热仍由是否 spawn 决定 |
| — | `remote.desktop.request` 保留 | T2 后只剩配对的 one-shot 交换使用 |

登记：`scripts/performance-paths.json` 的 `remote` 组加入上述四个 trace，sources 改为整个 `src/main/remote` 目录；`providers` 组加入 `provider-warm-pool.ts`。`npm run performance:inventory` 退出 0，`scripts/performance-feedback.test.ts` 14 passed。该文件现为 19,953 B，距 20,000 B 门禁只剩 47 B，下一次登记前需要按职责拆分（见「需要决定」）。

### T1 Provider 热池

改动文件：

- `src/main/providers/provider-warm-pool.ts`（新增）：`ProviderWarmPool` + `providerWarmKey`。key 由调用方给出的全部身份输入按固定顺序拼装；`take(key, environment)` 在返回值前先关掉「不可复用或环境不同」的停放进程；`park` 重置空闲窗口并按上限淘汰最旧项；`touch(key)` 不启动 Provider 也能续期；`invalidate({ cwd, profileId? })` 只关匹配项；`dispose()` 等全部退栈并汇总关闭失败。
- `src/main/providers/pi-catalog.ts`：停放机制改为使用该池（key = provider + profile + executable + cwd），删除旧的 `warmCatalogProcesses`/`parkWarmCatalogProcess`/`closeWarmCatalogProcess`。`disposePiCatalog`、`invalidatePiCatalog` 语义不变，`invalidatePiCatalog` 现在按 cwd（可选 profileId）定向关闭。
- `src/main/remote/remote-gateway-catalog.ts`：`listProviderControls`、`listCommands` 按 providerId + profileId + cwd 合并**并发中**的请求；用 WeakMap 以依赖对象为归属，两个宿主实例互不影响；请求结束即删除，后续刷新一定重新读 Provider。每个调用方仍各自先 `authorize(peer)`，所以撤销中的设备不会因合并而被放行。
- `src/main/remote/remote-provider-prewarm.ts`（新增）：`createProviderPrewarmer`。同一上下文同时只跑一次预热读；失败只丢弃，不当成会话证据。
- `src/main/remote/host-controller-factory.ts`：`readHistory` 外层加预热。仅在设备授权通过、会话读成功后触发；预热前再用 `workspace.authorize(cwd)` 校验，未授权仓库不会启动 Provider 进程。

测试证据：

- `npx vitest run src/main/remote src/main/providers src/main/provider-operation-gate.test.ts` → 102 files / 1149 passed。
- 新增 `src/main/providers/provider-warm-pool.test.ts`（7 passed）：key 顺序无关、take 独占、不可复用/环境不同先关闭、touch 续期与过期关闭、超限淘汰最旧、定向失效只关匹配项（同 workspace 另一 profile 也关，另一 workspace 不关）、dispose 关闭失败只上报不抛。
- 新增 `src/main/remote/remote-gateway-catalog.test.ts`（3 passed）：并发合并且完成后不复用、不同选择不合并且未授权 Provider 仍拒绝、撤销中的第二个调用方仍被拒绝。
- 新增 `src/main/remote/host-controller-prewarm.test.ts`（3 passed）：授权读后按同一 provider/profile/cwd 预热；未授权 peer / 撤销设备 / 未授权 cwd 都不预热（未授权 cwd 的历史读本身仍按既有语义返回，只是不启动 Provider）；会话读失败不预热；预热失败不影响读结果。
- 既有 Pi 契约测试原样通过：`pi-lifecycle.test.ts`、`catalog-performance.test.ts`、`pi.test.ts`、`scripts/performance-counters/pi-probe.counters.test.ts`（后者随 `src/main/remote src/main/providers` 之外的目录，在 T0/T1 定向运行中未改动，全量门禁在交付前统一跑）。

调研结论（不改代码）：

| Provider | catalog / run-controls 读取 | 是否每次冷启动 | 能否套用热池 |
|---|---|---|---|
| Pi | `pi --mode rpc` 子进程 + 4 条 RPC | 停放命中前是（p50 1672 ms） | 已套用；本次接入 |
| Claude | SDK `query()` 每次读新建，读后 `close()`；按 cwd 有 30 s 缓存与并发单飞 | 每 30 s 窗口一次冷启动 | 理论上可停放 query，但 query 同时承载会话流，复用需单独设计；本次不动 |
| Codex | app-server 客户端常驻（空闲 60 s、最多保留 3 个空闲）+ `model/list` 30 s 缓存 | 否，已有常驻池 | 已是热池，无需重复 |
| OpenCode | `createOpenCodeServerPool` 常驻 server，最多 3 个空闲 | 否 | 已是热池 |
| Qoder | `QoderControlPool` 常驻 control session + 30 s TTL 与 generation 栅栏 | 否 | 已是热池 |

已知限制：

- 本机侧没有接入「会话被选中即预热」：`HostController` 与会话选择路径所在的 main 装配文件超过仓库 20,000 B 提交门禁（既有大文件不豁免），本批次不为此重构会话选择链路。远程侧已覆盖（打开会话 + `providers` 的 `detail: selected`，后者本身就是那次热读）。
- 活跃 run 期间的周期续期未实现：读取本身会重置空闲窗口，长时间不再读会话时仍会在 60 s 后回收（与改动前一致）。
- 未做 cwd 的 `realpath` 归一化：key 使用已通过工作区授权的 cwd 原值，若同一目录以不同写法到达会各占一个槽位（上限 8 已兜底）。
- Claude 的 30 s 控制缓存仍是 Provider 内部行为，没有并入统一池；它的冷启动耗时未单独采样。
- 命中率目标（≥ 90%）需在真实活跃会话的 `performance` 日常记录上统计 `catalogReused / (catalogCold + catalogReused)`；本批次只保证指标可读，**未**宣称达到该目标。

### T2 Desktop 持久 lane

改动文件：

- `src/main/remote/desktop-lane.ts`（新增）：`DesktopLanes`、`connectDesktopLane`、`laneForRequest`、`replayableRequest`。每个 connection 一组 lane，请求在 lane 上串行（一问一答）；`closeConnection` 让该连接的 lane 退役（在途请求在原通道上结束，其余不重连、不重放），`closeAll` 用于 dispose。
  - 每个请求带 `keepAlive: true`；回包必须以 `{"keepAlive":true` 后接 `,` 或 `}` 开头，否则 `desktop_protocol_mismatch`，不退回 one-shot。`keepAlive` 字段在交给调用方前删除。
  - notSent（通道没打开或字节没写出）在新通道重发，最多 2 次；lost（已写出）只对 replayable 的读重放 1 次；写操作 lost 原样抛出，由现有逻辑记 unknown。被取消的调用不重试。
  - 空闲 20 s 关闭（只在两次请求之间计时，长轮询不算空闲）；响应超时 control/bulk 30 s、watch/status 40 s；取消：control 不拆通道，其余关闭承载该请求的通道，同 lane 排在后面的请求换新通道继续。
  - 关闭原因随 `onClose(reason)` 传出：超时、对端重置、超大回包各自保留诊断，不统一成 `desktop_lane_closed`。
- `src/main/remote/desktop-client-base.ts`：`requestForConnection` → `laneRequest`，按 op 路由；`request()` 只剩配对通道使用。`desktop-client-connections.ts`：连接时的 `desktop info` 也走 control lane，所以随后的 catalog 复用这次握手，旧宿主在连接时就报 `desktop_protocol_mismatch`；连接失败与断开都会关闭该连接的 lane。
- `src/main/remote/desktop-client-validation.ts`：依赖注入新增 `openLane`（测试注入假通道；生产缺省为 `connectDesktopLane`）。
- `src/main/remote/inner-mtls-host.ts`：按已验证的证书指纹索引 socket，新增 `closePeer(certificateSHA256)`。`remote-host-service.ts`：`revokeDevice` 撤销后关闭该设备全部连接（含在途长轮询）。为留在 20,000 B 门禁内，`RemoteHostServiceDependencies` 拆到 `remote-host-service-deps.ts`（原导出路径保留 re-export）。
- 测试支撑：`desktop-lane-fixtures.ts`（新增）提供 `fakeLaneConnector`（把 lane 帧交给 one-shot 风格的处理函数）与 `faultyLaneConnector`（包住真实 lane，注入「未送达」或「回包丢失」）。
- 测量 harness（单独提交 `817778c`）：`scripts/fixtures/concurrency-trace-host.ts`、`remote-trace-host.ts` 用假 lane，`concurrency-trace-live-client.ts` 用真实 TLS lane；请求计数仍按请求而不是连接。被拒的宿主读取改为回 `{ error }`（与 `inner-mtls-dispatch` 一致），否则会被当作回包丢失而重放。

op → lane 映射（代码常量在 `desktop-lane.ts`）：

| lane | op | replayable |
|---|---|---|
| control | 写：`submit`、`stop`、`answerQuestion`、`resolveIntent`、`attachmentStart`、`attachmentChunk`、`attachmentCommit`、`sessionAction`、`sessionDelete`、`sessionFork` | 否 |
| control | `desktop` 且 `query.kind` 不是下面 bulk 的几种（`info`、`workbench` 等）；没有 `op` 的请求 | 是 |
| watch | `watch` | 是 |
| status | `liveRuns` | 是 |
| bulk | `desktop` 且 `query.kind` ∈ `history`、`trace`、`trace_delta`、`image_chunk`；其余所有读（`poll`、`runState`、`intentStatus`、`providers`、`projects`、`sessions*`、`history*`、`commands`、`directories*`、`fileDownload`、`toolPanel` 等） | 是 |

测试证据：

- `npx vitest run src/main/remote src/main/providers scripts/performance-counters scripts/concurrency-trace-host.test.ts scripts/concurrency-trace-trial.test.ts scripts/concurrency-trace-live-client.test.ts scripts/concurrency-trace-live-build.test.ts scripts/concurrency-trace-live-pairing.test.ts scripts/performance-feedback.test.ts` → 128 files / 1316 passed。`npx vitest run src/main` → 287 files / 2820 passed（3 skipped 为既有）。`npm run typecheck` 退出 0。
- 新增 `desktop-lane-real-host.test.ts`（真实 `RemoteHostService` + `InnerMtlsHost`，不 mock TLS，6 passed）：
  - 3 个连续请求只有 1 个 `remote.host.connection`，客户端 `reused` 为 0/1/1；
  - 宿主断开空闲连接（`closePeer`，与 30 s 空闲超时同一 destroy）后下一请求自动重连，共 2 次握手；
  - 通道第一次打不开时，非 replayable 请求也在新通道重发成功，宿主只收到 1 次；
  - bulk 上挂着真实的 20 s `liveRuns` 长轮询时 control 请求照常完成，取消 bulk 后 control 仍可用；
  - 撤销设备后在途长轮询在 5 s 内失败（远小于 20 s 窗口），后续请求得到 `device_not_authorized`；
  - 撤销后已保持的空闲连接被宿主关闭。对照：注释掉 `revokeDevice` 里的 `closePeer` 后此用例失败（3 s 超时）。
- 新增 `desktop-lane.test.ts`（9 passed）：op 路由表；复用与 trace 阶段序列（新连接含 `secure_connected`，复用不含）；watch 不阻塞 control；无 keepAlive 前缀报 mismatch 且失败 trace 以 `error` 结束；打不开的通道最多重试 2 次；lost 读重放 1 次、lost 写不重放且保留原诊断；取消不连累同 lane 后续请求；连接关闭后排队的写在写出前被拒；20 s 空闲关闭与 40 s watch 超时。
- 写请求 lost 只执行一次：`desktop-client-real-host.test.ts` 现在跑真实 lane，提交回包丢失后为 `unknown`，`resolveIntent` 得到 `recorded`，`providerStarts` 为 1；「未送达」的提交被 fence 为 `cancelled`，迟到的原请求得到 `intent_payload_conflict`。

自审中发现并修正的问题（均有测试覆盖）：idle 计时从发送开始会在 20 s 关掉 40 s 的 watch；超时与 close 竞争时丢失 `desktop_lane_timeout`；已关闭通道上 `onClose` 同步回调导致 TDZ 错误；`keepAlive` 标记泄漏进返回给手机的 intent 结果。

已知限制：

- 撤销只关闭本进程 `InnerMtlsHost` 上的 socket；经 relay 转发的连接同样由该 host 服务，但未单独做 relay 路径的撤销测试。
- 旧宿主（不回 keepAlive）现在连接即失败为 `desktop_protocol_mismatch`，UI 的「请升级」文案在 T5 做；在此之前用户看到的是通用错误。
- `request_timeout` 等 one-shot 的错误码在运行通道上换成 `desktop_lane_*`；仓库内没有按这些字符串分支的调用方（已 grep 确认）。
- 毫秒收益未测：本任务只有 L1 证据（握手次数由每请求 1 次降为每 lane 1 次）。`npm run performance:measure` 放在交付前全局验证统一运行。

## 需要决定

- `scripts/performance-paths.json` 距 20,000 B 门禁只剩 47 B。下一次登记 trace（T3/T4 可能需要）前，需要按 path 组拆分文件并同步修改 `scripts/performance-report.mjs`、`scripts/performance-native.mjs` 的文件清单和 `.github/workflows/performance.yml` 的复制步骤。是否接受这次拆分，需要维护者决定；在此之前新增 trace 只复用已登记的名字。
