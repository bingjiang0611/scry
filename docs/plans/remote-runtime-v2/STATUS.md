# 执行状态（执行 agent 维护）

分支起点：`183415b`。每完成一个任务更新一次。

## 总览

| 任务 | 状态 | 提交 | 备注 |
|---|---|---|---|
| T0 分段测量 | 完成 | `4b72294` | 传输 / 宿主 dispatch / Provider cold-reused 三段可分别读 |
| T1 Provider 热池 | 完成 | `T1` | `ProviderWarmPool` 泛化 + Pi 接入 + 宿主单飞 + 打开会话预热 |
| T2 Desktop 持久 lane | 未开始 | | |
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
