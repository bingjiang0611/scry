# A3：隐藏窗口远程轮询基线

- 路径：`remote`
- 假设：隐藏窗口仍运行四条远程轮询链，导致隐藏 60 秒继续发送 IPC；受控隐藏 Electron fixture 可记录真实 renderer hook/component 到 bridge 的调用。
- 基线提交：见本次 measurement commit（提交后填入哈希）
- 优化提交：`e585f5dbd3f2582a29d471558e24be4a6b1ff567`

## 固定 workload

```bash
node scripts/desktop-remote-ui-smoke.mjs --visibility-polling-baseline
```

fixture 使用隐藏、sandbox、contextIsolation 开启的 Electron 窗口，挂载真实 `RemotePairing`、`RemoteChat` 与 `useConnectedCatalogLoader`，并将 bridge IPC 计数写入结果。运行先稳定 1 秒，再保持隐藏 60 秒；不采集耗时。

## 基线结果（L1）

结果：`hidden: true`；稳定窗口前后计数为 `before={list:1,catalog:1,remoteStatus:1,intents:1,runStatus:0,trace:0}`、`after={list:21,catalog:21,remoteStatus:31,intents:41,runStatus:0,trace:0}`。

| IPC | 隐藏 60 秒 delta |
|---|---:|
| desktopRemote.list | 20 |
| desktopRemote.catalog | 20 |
| remoteStatus | 30 |
| intents / runStatus / trace | 40 / 0 / 0 |

## 优化结果（L1）

同一命令、同一隐藏 60 秒 workload：`hidden: true`；`before` 与基线相同，`after` 与 `before` 相同，`delta={list:0,catalog:0,remoteStatus:0,intents:0,runStatus:0,trace:0}`。工作被移除在隐藏窗口期间，不是移出计数窗口；回到可见时 hook 立即刷新并恢复定时器。

- 基线 measurement commit：`7bf5a7ec54e630bb7b1012ea65bd4ca327467ce6`
- 优化 commit：`e585f5dbd3f2582a29d471558e24be4a6b1ff567`

## 护栏与限制

- 这是工作量计数（L1），不是毫秒或用户体验结论。
- 仅使用离线 fixture，不启动 Provider、不访问网络、不写用户数据。
- 配对状态的服务端过期仍由下一次可见刷新发现；隐藏时暂停不会延长服务端租约，也不会自动授权或发送。
- 本实验提交只增加可复现计数入口；生产轮询行为在后续优化提交改变。
