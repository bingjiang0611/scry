# 执行状态（执行 agent 维护）

分支起点：`183415b`。每完成一个任务更新一次。

## 总览

| 任务 | 状态 | 提交 | 备注 |
|---|---|---|---|
| T0 分段测量 | 完成 | `4b72294`、`bea0649` | 传输 / 宿主 dispatch / Provider cold-reused 三段可分别读；`bea0649` 补登记 performance-paths |
| T1 Provider 热池 | 完成 | `6090a21` | `ProviderWarmPool` 泛化 + Pi 接入 + 宿主单飞 + 打开会话预热 |
| T2 Desktop 持久 lane | 完成 | `4915672`、`817778c` | 运行通道四条持久 lane，无 one-shot 回退；撤销即断开宿主连接 |
| T3 长轮询 | 完成 | `70fc0b9`、`8589154` | watch 生命周期模式 + `liveRuns` revision 长轮询；renderer 只在报告变化时读 trace |
| T4 catalog 合批 | 完成 | `d521442` | `catalogSnapshot` 一次带回 info/projects/providers/首页；unchanged 不回 payload |
| T5 协议版本校验 | 完成 | `e2d7426` | `REMOTE_PROTOCOL_VERSION=2`，lane 请求带版本，不符即拒并指出哪一端更旧；Swift 测试未运行 |
| T6 P3/P4 设计文档 | 完成 | `47b543e` | 只写文档：daemon 边界与本机通道、事件日志契约与迁移 |
| 交付前全局验证 | 完成，1 项 not-run | `b08f9f7` | 9 项 gate 通过；`swift test` 缺 XCTest 未运行，见[交付验证](status/delivery.md) |


## 每个任务的证据

每个任务的改动、测试证据与已知限制在 `status/` 下；本文件只保留总览、结论和跨任务的待决事项。

- [T0 分段测量](status/t0.md)
- [T1 Provider 热池](status/t1.md)
- [T2 Desktop 持久 lane](status/t2.md)
- [T3 长轮询](status/t3.md)
- [T4 catalog 合批](status/t4.md)
- [T5 协议版本校验](status/t5.md)
- [T6 P3/P4 设计文档](status/t6.md)
- [交付前全局验证](status/delivery.md)

## 阻塞

- `swift test` 在本机不可用：只有 Command Line Tools，缺 XCTest（`swift test` 报 `no such module 'XCTest'`）。T5 的 Swift 断言因此未被执行，需要装有完整 Xcode 的环境补跑 `swift test --package-path experiments/remote-g0/swift --filter 'WireTests|LaneHandlerTests'`。`swift build` 已通过。

## 需要决定

- 性能对比里唯一的上升项是 `trace.r4-cell/other`（+450 次 stringify、+20.86 MB），已定位为测量夹具的建模成本：假通道把 host 已编码的回包再编码一次产生 wire line，而生产宿主对 keep-alive 回包只编码一次（`inner-mtls-host.ts:149`）。ratchet 已通过（该 cell 是未登记 candidate），本轮未改夹具。是否值得让假通道直接搬运已序列化的字节以消掉这 20.86 MB，需要维护者决定；详见[交付验证](status/delivery.md#性能对比里唯一的上升项)。
- `scripts/performance-paths.json` 距 20,000 B 门禁只剩 47 B。下一次登记 trace（T3 只复用已登记名字，T4 可能需要）前，需要按 path 组拆分文件并同步修改 `scripts/performance-report.mjs`、`scripts/performance-native.mjs` 的文件清单和 `.github/workflows/performance.yml` 的复制步骤。是否接受这次拆分，需要维护者决定；在此之前新增 trace 只复用已登记的名字。
