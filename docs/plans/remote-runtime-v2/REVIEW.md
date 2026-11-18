# 代码证据核对（2026-11-03，基于 main `357fbdf`）

执行时以此为事实基础；行为若与此不符，以代码为准并在 STATUS.md 记录差异。

## 当前传输

- Desktop 每次 RPC 新建连接：`src/main/remote/desktop-transport.ts` 的 `desktopTlsRequest` 每次 `tlsConnect`，读到一行即 `destroy`，从不发 `keepAlive`。连接走 SSH `-L` 转发的 unix socket（`openDesktopSshTunnel`，`ServerAliveInterval=15`、`CountMax=2`）。Desktop 只有 SSH 路线，`tlsRequest` 只接受 path。
- 宿主 `src/main/remote/inner-mtls-host.ts`：TLS 1.3、`SSL_OP_NO_TICKET`、拒绝 `isSessionReused`（每次都是完整握手）；keep-alive 按连接 opt-in，回包以 `{"keepAlive":true,` 开头；每个请求经 `HostController` 按对端证书指纹鉴权，每次收数据检查证书过期；30 s 空闲断开；一问一答，pipelining 或忙时收数据直接断连。撤销设备（`remote-host-service.ts:323`）不会关闭已保持的 socket。
- 宿主已有长轮询：`HostController.watchRun`（≤ 20 s，每次唤醒重读授权读取器）与 `liveRuns`（≤ 20 s，每轮 `authorizeDevice`）。
- iOS 已有持久 lane：`experiments/remote-g0/swift/Sources/RemoteTransport/Lane.swift` 的 `RelaySession`（control/watch/status/bulk、notSent/lost 重发规则、20 s 空闲先关、`abortOnCancel`），`apps/ios/ScryRemote/RemoteRunClient.swift` 的 `RemoteSessionRegistry` 在网络变化/后台时 reset。

## Desktop 请求放大

- `intents` 是本地读，不发 RPC（`desktop-client-session.ts`）。
- `runStatus` = `runState` + `poll`（≥ 2 次）；`liveRun` 用 `liveRuns waitMs:0`；`catalog()` = `info` + `projects` + `providers` + `sessionsPage`×N（≥ 4 次）；`providerControls` 先发一次 `info`。
- Renderer：`RemoteChatControls.tsx` 1.5 s 轮询（安静时退避到 5 s，`QUIET_POLL_MAX_MS`），`useRemoteCatalogs.ts` 每 3 s 刷新 catalog，均为可见性轮询。峰值约 160–200 次完整握手/分钟。
- `docs/desktop-remote.md` 记录 Desktop 不用 `watch` 的原因：它带 shadow output，输出缓存故障不能阻塞生命周期。

## 慢路径归因

- 快照（0.2.237，`d9d74e…`，不在公开历史）：Pi catalog read p50 1888 ms、Provider controls 1304 ms、history 795 ms、trace 166 ms、catalog 124 ms、run status 59 ms。run status 含 2 次完整握手仍只有 59 ms，说明 SSH 上单次「握手+请求」约 20–30 ms；秒级路径耗在宿主/Provider。
- Pi 常驻进程已合入 main：`21c5eab`（停放复用）及后续定向失效、8 槽工作集、60 s 空闲（`src/main/providers/pi-catalog.ts`）。10-28 记录 34 次 probe 中 26 次冷启动（p50 1672 ms），复用 p95 13.5 ms。问题是命中率。
- `listProviderControls`（`remote-gateway-catalog.ts`）每次调用 `providers.selected`，无宿主端单飞。
- 现有指标只有 IPC 端到端耗时，缺握手/宿主/Provider 分段。
