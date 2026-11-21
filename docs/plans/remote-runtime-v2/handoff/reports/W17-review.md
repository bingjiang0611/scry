结论：通过（3 项应修，不阻塞，随下一轮做）

# W17 核验（核验方，2026-11-21，提交 `343b0cd3`、`25c3bc28`）

## 确认成立

- **授权与进程内一致**：
  - daemon 的 runtime 从 local-ops 已经构建的同一个会话生命周期实例提供 `sessionRefFromRequest`、`changeLegacySessionMetadata`、`deleteOneSession`。
  - 分叉走共享的 run-fork，带操作门禁。
  - 远程检查使用进程内同样的 `host-controller-session.ts` 与 `host-runtime.ts`：每次调用前后都复核设备 grant；工作区先规范化再检查，变化时返回 `workspace_context_mismatch`；删除需要 `confirmed: true`，远程 grant 只能删除已归档的会话，删除时再复核一次；分叉按 Provider 的实际能力。
  - 只被授权了 A 工作区的设备，操作不了 B 工作区；已撤销的设备在进入 controller 之前就被拒绝。
- **openPath 与 trashItem**：
  - daemon 在转发前用现有的 `workspace-files` 检查路径：`link/secret`、指向外部的文件链接、绝对路径、`..`、`sub/..`、根目录（`""` 与 `"."`）都被拒绝。
  - 只有 App 主实例能处理；W10 的 `isPrimaryAppPeer` 没有改。
  - App 离线时报告 `{false, false}`，调用返回 `desktop_workbench_operation_unavailable:*`。
  - App 一侧只接受非空、不含 `\0` 的路径，未知方法一律返回 `invalid_target_request`。
  - W10 的安全规则没有变化，只新增了两个由 daemon 发起的方法。
- **实时探针**：只是内存检查加一次 grant 查询；App 连上或断开时，info 立即变化。
- **范围**：没改协议版本；没碰 orchestration、host-admin、W13 trust、`src/cli`；进程内模式不变；所有文件小于 20,000 字节。
- **Linux 复跑**：
  - `typecheck` 通过。
  - daemon、remote、bootstrap 共 1,264 个用例，1,263 个通过，唯一失败的是以 root 运行导致的已知用例。
  - renderer 相关 290/290 通过；`check:cli-runtime` 通过。
  - `desktop-remote-host-smoke.mjs --dev` 在默认 daemon 模式下通过（核验方在 xvfb 下本地调整了 Electron 路径）。

## 应修（不阻塞）

1. **越界路径的测试太弱**：去掉 workbench 里 trash 的工作区检查（openPath 同理）之后，测试照样通过，而越界路径确实会被转发给桥接，最后靠超时才失败。测试只断言 `error` 为真，`trashed` 数组还是手工填的。要改为断言具体错误「工作区路径不能越过根目录」，并断言 App 的 poll 没有收到任何调用；openPath 和符号链接逃逸也各补一个测试。
2. **「打开 Scry」横幅对旧主机也会出现**：W17 之前的主机即使 App 开着，也报告 `{false, false}`，这时正确的提示应该是更新。修法（不改协议）：只有 `catalog.sessionActions === true` 时，才显示「需要在 <host> 上打开 Scry 桌面端…」，否则保留原来的提示。
3. **几个变异只被其他层兜住**：
   - 去掉 daemon `deleteOneSession` 里内层的 `authorize`。
   - 去掉 `runSessionDelete` 里的 `authorizeDevice`（已撤销的设备会被更早的检查拦住，只有「调用进行中被撤销」这种情况没有保护）。
   - 未知的 pump 方法被路由到 openPath。

   要补「删除进行中被撤销」和「未知 pump 方法」两个测试。

真机验收清单见 W17.md §3，交给执行方 A。
