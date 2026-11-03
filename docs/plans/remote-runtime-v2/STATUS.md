# 执行状态（执行 agent 维护）

分支起点：`183415b`。每完成一个任务更新一次。

## 总览

| 任务 | 状态 | 提交 | 备注 |
|---|---|---|---|
| T0 分段测量 | 完成 | `T0` | 传输 / 宿主 dispatch / Provider cold-reused 三段可分别读 |
| T1 Provider 热池 | 未开始 | | |
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
