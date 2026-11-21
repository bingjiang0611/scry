# W17 · 默认 daemon 下恢复远程桌面的会话操作与工作区操作

执行方 B（在 W15 返修之后做）。缺陷见 [reports/W15-review.md](../reports/W15-review.md) 最后一节。这是已经在 `main` 上的回归：远程桌面连接到默认走 daemon 的主机时，用不了会话的重命名、置顶、归档、恢复、删除、分叉，也用不了「在系统应用中打开」和「移入废纸篓」，横幅还提示「请更新并重启 Scry」。

## 要做的

1. **会话操作**：
   - daemon 的 `createHostRuntime`（`src/daemon/host-process.ts:270-297`，或者拆出去的装配文件）要提供 `sessionRefFromRequest`、`changeLegacySessionMetadata`、`deleteOneSession`，以及面向远程对端的 `forkSessionWithAuthority`。
   - 复用 daemon 里本机 App 已经在用的会话生命周期实现（`local-ops/session-lifecycle.ts` 等），不要另写一套。
   - 远程对端的授权与进程内模式一致：grant、工作区授权、操作门禁都要做；远程删除必须与进程内模式有同样的确认和限制。
2. **工作区操作**：`openPath` 与 `trashItem` 需要 Electron 的 `shell`，daemon 里没有。参照 W10 的 App 桥接方式实现：
   - 经 App 转发，只接受 App 主实例。
   - App 不在时，`workbenchOps` 如实报告不可用，并给出准确的文案（例如「需要在这台 Mac 上打开 Scry」），不能写「请更新」。
   - 不要自己在 daemon 里实现 trash（不同系统的语义不同）。
3. **文案**：远程桌面的横幅只在主机确实是旧版本时才提示「请更新」；能力因为 App 不在而缺失时，改为说明真实原因。
4. **测试**：
   - daemon 模式下，`desktop info` 宣告 `sessionAction`、`sessionFork`、`sessionDelete`，远程对端能逐项执行并被正确授权；未授权的对端被拒绝。
   - App 在时，`openPath` 与 `trashItem` 可以经桥接执行；App 不在时，如实报告不可用。
   - 进程内模式不变。
   - 先写失败测试，再实现。
   - 把 `scripts/desktop-remote-host-smoke.mjs` 改回默认 daemon 模式，并跑通。

## 约束

- 不改协议版本，只按现有能力字段宣告。
- 不碰 orchestration（C 在做 W16）、W13 的 trust 文件和 host-admin 的安全逻辑。复用 W10 的桥接代码时，不改变它已经核验过的安全语义。
- 单文件小于 20,000 字节，`host-process.ts` 接近上限时先拆分。
- 真机验证（远程桌面连到这台 Mac）写成步骤，交给 A。
- 报告写 `reports/W17.md`，第一行写状态。
