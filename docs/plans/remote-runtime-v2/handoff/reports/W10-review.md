结论：通过（无阻塞；应修 1 须在合入 main 前完成）

# W10 核验（核验方，2026-11-20，提交 `20211a33`、`c8706755`、`c44c929d`、`c30a291f`）

## 确认成立

- **反向通道的身份门**：领取调用和回传结果都先检查是否为 App 主实例的本地 grant（`app-execution-target-bridge.ts:194`、`:218`，`pairing.ts:256-270`）。
  - 真正的边界是 `enrollLocal` 只保留一个本地 grant，重新登记会撤销旧的。scry CLI 不在 `local.sock` 登记。
  - 网络端点上这两个操作返回 `unsupported_op`。
- **不扩大手机权限**：路由前后的 `authorizePeer` 复核都还在，桥接层自己也再复核一次。App 返回的 `executionTarget` 会被剥掉后重新盖章；发现结果经过清洗，最多 32 项。
- **上限与清理**：
  - 单帧上限在入队和回传时都检查；最多 64 个调用；App 不在时直接拒绝，不排队。
  - 超时 35 s，大于 `waitMs` 的上限 20 s。
  - App 断开时，进行中和排队中的调用立即以 `execution_target_gateway_offline` 结束。
  - 计时器都调用了 `unref`，没有泄漏。
- **App 未连接**：发现只返回网关、`targets: []`；target 请求返回 `execution_target_gateway_offline`。
- **兼容性**：进程内模式不变。与 C 的编排代码同时接入 `host-process.ts`，`off`、`shadow`、`on` 和 trust gate 的测试都通过。
- **iOS**：文案按要求修改，协议版本保持 2。只做了代码审查，Swift 测试与真机三态以 A 的报告为准。
- **中继**：
  - 只有在已经有 leg ping 过的房间里，才会淘汰超过 30 s 没有活性的 leg。新开的 leg 会立即 ping，所以不会被误淘汰；从不 ping 的旧版主机不受影响。
  - `node --test` 4/4 通过，三处修复的变异都会被测试拦下。
  - 「鉴权与首次 ping 的竞态」在生产中有自动应答，影响比报告说的小。
- **变异测试**：去掉主实例身份检查、去掉断开时立即结束，都会被测试拦下。
- **Linux 复跑**：
  - `typecheck` 通过。
  - daemon 与 remote 共 862 个用例，855 个通过。6 个是满载时的 5 s 超时，单独跑全过；1 个是以 root 运行导致的已知失败。

## 应修

1. **（合入 main 前必须完成）App 正好退出或卡住时，发现请求仍会返回错误。**
   - App 在发现过程中退出，返回 `gateway_offline`；App 卡住，35 s 后返回 `timeout`（`:108-111`、`:182`、`:264-274`）。
   - 已发布的旧版 iOS 会把这个错误显示成「主机暂不支持读取会话，请更新 Scry」，正是本任务要消除的告警。
   - 修法：`client.executionTargets` 遇到 `gateway_offline`、`timeout`、`bridge_busy` 时返回 `[]`。
2. **35 s 超时贴近 App 一侧的超时**：`watch` 通道为 40 s（`desktop-lane.ts:86`）；`mobileSubmit` 在每个目标上串行执行、单次 30 s。不会产生安全问题，但「结果不确定」的提交会比进程内模式多。建议改为约 45 s，或给 `mobileSubmit` 单独放宽。
3. **陈旧的 poll 可能抢走新调用**：poll 按身份绑定，而不是按连接绑定。如果只有 `targetWork` 这条连接断了，旧的挂起 poll 不会被唤醒，可能把新调用领走，直到 35 s 超时。应改为按连接绑定，或在新 poll 到来时作废旧的。
4. **文件大小**：三个 Swift 文件原本就超过 20,000 字节，这次又变大了（ConnectionCopy 增加 174 B，ExecutionTargetCoordinator 增加 1,030 B）。至少要做到净增为零，例如把新文案移到新文件。TS 一侧有三个文件已接近上限：`index.ts`、`desktop-lane.ts`、`remote-host-service.ts`。
5. **小项**：
   - `ownerPeer` 绑定没有测试覆盖（变异存活）。
   - 超出单帧上限的结果被拒后，该调用要等到超时才结束，应立即结束。
   - `daemon-run-transport.ts:86` 把所有 `unknown_op` 都映射成 `daemon_run_control_unavailable`，会改变旧 daemon 下 `DaemonEventPump` 的行为。应只对新操作生效，或在报告里写明。

## 关于「本来就失败」的两个测试

- `scripts/performance-native.test.ts` 的 1 个失败，在 `8532408f` 上同样失败，确实是先前就有的。
- `scripts/performance-abab.test.ts` 的 2 个失败是本批次新引入的。二分定位到 **`a74fe125`**（执行方 C，新增 `orchestration.pre-first-token` 预算），已转给 W9 修复。

## 待维护者决定

中继修复是否部署到线上 `scry-relay-pages`。核验方推荐：先在本地用 workerd 跑一次冒烟测试，再由维护者部署。部署属于对外操作，执行方不得自行部署。
