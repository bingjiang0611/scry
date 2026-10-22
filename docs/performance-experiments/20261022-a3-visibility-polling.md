# A3：隐藏窗口远程轮询基线

- 路径：`remote`
- 假设：隐藏窗口仍运行四条远程轮询链，导致隐藏 60 秒继续发送 IPC；受控隐藏 Electron fixture 可记录真实 renderer hook/component 到 bridge 的调用。
- 基线提交：`784a9d1`（推送分支上的 measurement commit）。
- 初次暂停提交：`58e57fc`；最终新鲜度修正提交见批次报告。

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

- 基线 measurement commit：`784a9d1`。
- 在最终 controller/新鲜度修正后再次执行同一 60 秒命令：`before={list:1,catalog:1,remoteStatus:1,intents:1,runStatus:0,trace:0}`，`after` 相同，六项 delta 全为 0。

## 恢复与请求收敛验收

`node scripts/desktop-remote-ui-smoke.mjs --visibility-polling-check`：真实挂载四条生产路径及远程侧边栏，使用隔离 Electron/userData 和 bridge fixture。已验证：

- 挂起连接/catalog/手机状态响应，隐藏再显示后，在线标识与活动徽标立即撤回，历史和草稿保留，Send 禁用。
- 同时直接请求相同资源，不增加正在进行的 IPC。
- 显示前已发出的旧请求先完成，不恢复在线确认；每条链在它结束后只追加一个新请求。
- 新请求成功才恢复在线、活动和 Send；新请求失败保留错误与历史，不发送任何提示词。
- 单次 fixture 三条状态链各 4 次读取；此项是生命周期验证，不是隐藏一分钟测量。

负对照：加 `--negative-visibility-control` 故意取消 invalidation，测试明确失败于 `Resume must withdraw stale online/activity confirmation`。原有 `--negative-activity-control` 的 mutation 目标随新调度方式更新，仍保留初始刷新但暂停后续周期刷新，不削弱验收。

初次子任务实现的共享 key 注册表会保留闭包、丢失 pending 状态下的立即恢复读取，且没有撤回旧在线确认；未将它作为最终结果。最终使用每个挂载所有者一个 controller，连接 store 在首/末订阅边界共享一个 controller，无永久 session-key 注册表。visibility 变化使旧 revision 失效；single-flight 保存到旧请求结束，随后执行一次可见刷新。

## 护栏与限制

- 这是工作量计数（L1），不是毫秒或用户体验结论。
- 仅使用离线 fixture，不启动 Provider、不访问网络、不写用户数据。
- 已跟踪 `preload.remoteStatus → handleTrusted('remote:status') → RemoteHostService.status() → PairingAuthority.inspectLocal()`：status 只读取 pairing 与 relay diagnostics 快照，不是服务端心跳；`active()` 在授权操作时按 wall/monotonic deadline 检查过期。暂停 renderer 不延长租约，也不会自动授权或发送。UI 在下一次可见刷新重新读取状态；服务端过期本身不依赖该读取。
- `refreshing/stale` 仅撤回实时确认，不把保留的连接伪造成 disconnected，也不因窗口隐藏永久暂停提示词队列。确实断开连接仍保持原有 pause 语义。
- 首次 parent focused 验证超时，原因是旧测试要求并发发出两份 list 请求，并在释放第一份前等待第二份；已按新 single-flight 合同改成验证合并读取和成功回读，未扩大超时。随后 focused 35 项通过，typecheck/build 通过。完整门禁记录见批次报告。
- 本实验提交只增加可复现计数入口；生产轮询行为在后续优化提交改变。
