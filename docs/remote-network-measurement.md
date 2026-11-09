# iOS 远程连接：改动、部署顺序与本机测量手册

执行本机验证请直接看任务书 [handoff/ios-remote-verification/TASK.md](handoff/ios-remote-verification/TASK.md)：一键脚本、自动判定与交回格式都在那里。

本文写给在 macOS 宿主上工作的本机 Agent 与维护者：说明分支 `claude/ios-remote-connection-issues-o7oj6x` 改了什么、按什么顺序部署、如何用真机测量并验收。云端开发环境没有 Swift 工具链，Swift/iOS 改动**未编译、未在真机运行**；以下每一步的结果都必须在本机重新取得，不能沿用本文的预期值冒充实测。

## 1. 改了什么（按层）

| 层 | 改动 | 解决的现象 |
|---|---|---|
| Relay（CF Worker/DO） | Mac leg 发文本 ping，运行时自动回 pong 并记录时间（休眠期间也保留）；选证据最新的 leg；无存活 leg 时 600 ms 宽限后关闭 `4001 host_offline`；host 在线但 leg 全忙时最多等 2 s 补位再 `1013`；O(1) 查找；拒绝时也返回等待时长头 | 手机被粘到 Mac 睡眠/断网后残留的死 leg 上，连等 3×8 s 握手超时 |
| Mac host | 每条 WSS leg 10 s ping、30 s 无 pong 判死、检测进程挂起；`powerMonitor` 唤醒/解锁时重建全部 leg；`ping` 操作返回能力集；空闲超时 75 s | 唤醒后长时间不可用、死 leg 不回收 |
| Mac host | 复用协议：带数字 `id` 的请求并发执行、按 id 乱序回复（每连接最多 32 个） | 4 条隧道 = 4 次冷握手 + 4 条 leg；长轮询占住通道 |
| Mac host | `watchStream` 推送：运行事件/输出/状态有变化即推送（至少每 15 s 心跳一次），终态或 10 分钟后收尾；`cancel` | 流式输出每批多付一个往返，显得卡顿 |
| Mac host | 局域网直连监听（默认端口 47820，冲突时改用随机端口），只在已授权的 `ping` 回复里告知私网/100.64/10 地址 | 同一 Wi-Fi 下仍绕 Cloudflare（可能出境） |
| Mac host | 会话目录 `known` 快照短路（`unchanged: true`）；历史 `encoding: deflate` 压缩分页；列会话时同一 cwd 只 `realpath` 一次 | 首页刷新按 100 条一页全量遍历；历史体积大且不压缩 |
| iPhone 传输层 | 首次连接先 ping 探测能力，同一隧道切换为复用模式：control/watch/status 共用 1 条，bulk 1 条；前台每 15 s 静默就 ping 保活（不再 20 s 空闲即关）；网络切换先 3 s 探测再决定是否重建；`4001` 不重试；先试直连路由（0.9 s 连接 / 2 s 握手预算，失败冷却 60 s），走 relay 后在后台尝试升级为直连；TCP 改走 Network.framework（swift-nio-transport-services 1.28.0）；记录每条隧道的分阶段耗时、CF 机房、relay 等待时长 | 冷启动悬崖、切网全断、蜂窝首次连接失败、无法定位慢在哪 |
| iPhone App | 前后台驱动保活；运行观察优先订阅推送，不支持时自动退回长轮询；会话目录快照缓存；历史解压后按原文哈希校验；离线/无空闲 leg 的明确文案；`NSLocalNetworkUsageDescription`；DEBUG `-netBench` | |

能力在 `ping` 回复的 `capabilities` 中声明：`ping`、`mux`、`watchStream`、`sessionsKnown`、`historyDeflate`，开启直连时还有 `lan`。手机只在 host 声明后使用对应功能；执行目标（Mac1→Mac2 转发）路由不使用 `known`、`deflate` 和推送，因为转发层按字段白名单精确校验。

## 2. 兼容矩阵

| 组合 | 行为 |
|---|---|
| 新手机 + 旧 Mac | `ping` 返回 `unknown_op` 后标记为 legacy，沿用 4 条串行通道、20 s 空闲关闭、长轮询；不尝试直连 |
| 旧手机 + 新 Mac | 旧手机不发 `id`，host 保持原串行协议；空闲超时变为 75 s，对旧手机无影响 |
| 新 Mac + **未重新部署的 relay** | host 只在 relay 回过 pong 后才 ping 承载手机的 leg（旧 relay 不回 pong，也就不会把 ping 转发给手机）；手机端忽略文本帧作为第二层保护；没有 `4001`，表现与改动前相同 |
| 新 relay + 旧 Mac | 旧 leg 不 ping，按 legacy 处理（视为存活，按最新排序），仍返回 `1013` |
| 复用状态学到后 Mac 降级 | 回复缺少 `id` 时标记协议不匹配，忘记能力后重新探测 |

## 3. 部署顺序

1. **Relay**（需要 Cloudflare 账号与维护者授权，属于外部写操作）：`cd experiments/remote-g0/cf-relay && npx --prefix .. wrangler deploy`。Pages 入口 `cf-relay-pages` 只做转发，无需重新部署。可选：在 `wrangler.toml` 设 `RELAY_LOCATION_HINT = "apac"`，只影响**新建**的房间。
2. **Mac**：按 CLAUDE.md 在 macOS 宿主上 `npm run install:mac:dev`，然后**完全退出并重新打开 Scry**（覆盖安装不会更新正在运行的进程）。首次监听 47820 时 macOS 防火墙可能弹窗；拒绝只会让直连不可用，relay 不受影响。`SCRY_REMOTE_LAN=0` 关闭直连，`SCRY_REMOTE_LAN_PORT=<n>` 固定端口。
3. **iPhone**：签名构建到真机（命令见 §4.4）。首次直连局域网地址时 iOS 会弹出"本地网络"权限，需要允许。

## 4. 本机验证（先自动测试，再真机）

在仓库根目录执行，记录 revision、命令、退出码和日志路径。

### 4.1 Node/host

```bash
npm run test:unit -- src/main/remote src/main/bootstrap
```

本分支新增的测试在 `inner-mtls-lanes`、`inner-mtls-stream`、`remote-gateway-transfer`、`remote-lan-listener`、`relay-connect-ws`、`relay-client` 中；原有的大测试文件未改动。

```bash
npm run typecheck:node
```

云端基线：`src/main/remote` 中唯一失败的是 `desktop-directory-picker` 的"不可读目录"用例，原因是容器以 root 运行，`chmod 0` 拦不住 root，与本分支无关；macOS 普通用户下应当通过。

### 4.2 Relay

```bash
cd experiments/remote-g0 && npm ci
```

```bash
cd experiments/remote-g0 && node cf-relay-smoke.mjs && node cf-relay-lifecycle-smoke.mjs && node --test ws-relay-server.test.mjs
```

若有 HTTP(S) 代理，先对这些本地 workerd 命令取消代理环境变量。lifecycle smoke 共 8 个用例，覆盖：ping 回 pong 且不转发、选最近 ping 的 leg、静默 leg 被关闭并报离线、忙时等待补位、无补位时 `1013`、无 leg 时快速 `4001`。

### 4.3 Swift 包（未在云端编译过，预计需要修编译问题）

```bash
swift test --package-path experiments/remote-g0/swift
```

新增或改动的文件：`Sources/RemoteTransport/{RelaySession,RelayLane,LaneConnection,Lane,Mux,HostTransport,ConnectTiming,Bootstrap,TransportConnection,Transport,TransportHistory,TransportRunWire,TransportRunTypes}.swift`（原 `Lane.swift` 已按职责拆分，只保留串行 `LaneHandler`）、`Package.swift`（新增 NIOTransportServices）、`Tests/RemoteProbeTests/MuxTransportTests.swift`。修编译错误时保持语义：复用超时只结束单个请求，探测超时才结束整条隧道；取消只影响自己的 id；`4001` 不重试。macOS 上的测试同样经过 Network.framework 路径。

### 4.4 iOS 真机构建

```bash
xcodebuild -project apps/ios/ScryRemote.xcodeproj -scheme ScryRemote -configuration Debug -sdk iphoneos -destination "id=$SCRY_IOS_DEVICE_ID" -derivedDataPath /tmp/scry-remote-device-build DEVELOPMENT_TEAM="$SCRY_IOS_DEVELOPMENT_TEAM" CODE_SIGN_STYLE=Automatic build
```

App 侧改动的文件：`RemoteRunClient.swift`、新文件 `RemoteSessionRegistry.swift` 与 `RemoteNetBench.swift`（已登记到 `project.pbxproj`）、`RemoteHistoryCache.swift`（历史下载与校验移到这里）、`RemoteRunStore.swift`、`ScryRemoteApp.swift`、`Info.plist`、`Checks/catalog-refresh.py`。离线检查同样需要在本机重新运行：`python3 apps/ios/Checks/catalog-refresh.py` 与 `python3 apps/ios/Checks/catalog-refresh.py --check observation --require-isolation`。

## 5. 测量

### 5.1 Relay 路径（无凭据，可在任意机器运行）

```bash
node experiments/remote-g0/relay-path-probe.mjs wss://scry-relay-pages.pages.dev --samples=10
```

输出为 `RELAYPROBE <json>` 行，逐段给出 DNS、TCP、TLS、WS 升级（`upgradeExcludingWait` 扣除 relay 的离线宽限）、关闭帧的耗时，以及 CF 机房和 relay 版本（`heartbeat-aware` 表示已部署新版，`pre-heartbeat` 表示旧版）。在 Mac 的网络上跑一次，再让 Mac 连接手机热点跑一次，近似比较手机蜂窝路径；机房如果是 `LAX`/`SJC` 这类海外节点，说明流量出境。该探针直接连接，不走代理。

### 5.2 真机 `-netBench`（只读，使用手机上已有的配对）

```bash
xcrun devicectl device process launch --console --terminate-existing --device "$SCRY_IOS_DEVICE_ID" com.scry.remote -- -netBench -netBenchRounds=5
```

如果 `devicectl` 不支持 `--console`，按仓库惯例用 iCTRL 启动并收集控制台输出。输出为 `NETBENCH <json>` 行：

- `environment`：路由模式、手机当前是否在本地网络。
- `cold-open`：断开全部隧道后打开 control+bulk 的耗时。
- `warm-request`：已开隧道上一个小请求的耗时（只在失败时逐条打印，汇总在 `summary`）。
- `catalog`：`full`（全量遍历）与 `refresh`（host 确认未变化）两次耗时。
- `history`：一次完整历史下载、解压与校验的耗时。
- `tunnels`：每条隧道的 `route`（`relay`/`direct`）、`tcpMs`/`outerTLSMs`/`upgradeMs`/`innerTLSMs`/`pingMs`/`totalMs`、`colo`、`relayWaitMs`、`multiplexed`，以及能力集与已学到的直连路由。
- `summary`、`done`。

### 5.3 测量矩阵（每格至少 5 轮；串行执行；注明网络与机器负载）

| 编号 | 场景 | 命令参数 | 重点看 |
|---|---|---|---|
| M1 | 同一 Wi-Fi，强制走 relay | `-netBenchRoute=relay` | 冷开中位数/P90、各阶段耗时、colo |
| M2 | 同一 Wi-Fi，自动（应走直连） | 默认 | `tunnels` 中 `route=direct`；冷开、热请求与 M1 对比 |
| M3 | 关闭 Wi-Fi，只用蜂窝 | 默认 | 冷开、colo；有 Tailscale 时应走 100.x 直连 |
| M4 | Mac 合盖 1 分钟后 | `-netBenchRounds=1` | `cold-open.error` 应为"Mac 当前不在线…"，且远低于改动前的约 24 s |
| M5 | 首页刷新 | 默认 | `catalog.refresh` 应接近一个往返 |
| M6 | 大会话历史 | `-netBenchSession=<id>` | `history.ms`；与旧版本同一会话对比 |
| M7 | 手动：发送一条提示、看流式输出、中途切换 Wi-Fi/蜂窝 | App 正常使用 | 输出是否连续；切网后是否没有出现"结果未知" |

如需对比改动前的表现，用旧 revision 的 App 与 Mac 在同一时段、同一网络、同一会话上重复 M1/M4/M5/M6。按 CLAUDE.md 的"如实宣称"规则写结论：这些数字属于 L2 级（受控真机毫秒数），注明样本数和网络条件；不能当作 L3 的日常记录。

## 6. Relay 就近部署选项

- **Cloudflare**：`RELAY_LOCATION_HINT` 只影响新房间。已存在的房间位置固定在它第一次被访问的地方；如果 Mac 当初经代理出境访问，房间可能在海外。要迁移，需要换一个新的 `hostId`（重新生成 host 身份并重新配对），本文不自动执行这一步。
- **自托管**（例如与用户同区域的 VPS）：

```bash
RELAY_TOKEN='<随机长串>' node experiments/remote-g0/ws-relay-server.mjs --port=8080 --host=127.0.0.1 --store=/var/lib/scry-relay/rooms.json
```

前置 Caddy/nginx 终止 TLS（证书必须被 iOS 系统信任）。然后在 Mac 上设置环境变量 `SCRY_REMOTE_RELAY_WS='{"url":"wss://relay.example","token":"<RELAY_TOKEN>"}'`，重启 Scry 后让手机重新扫码配对。协议与 Worker 完全一致；relay 只做字节转发，仍然拿不到内层密钥。

## 7. 已知限制与未验证项

- Swift 与 iOS 代码未编译、未上真机；Network.framework 路径、复用切换、推送、直连、保活均待本机验证。
- 未检查 Cloudflare 免费额度（每天 10 万请求）是否是失败原因；请查看 Cloudflare 后台按日的请求数和报错时段。新的心跳会让每条 leg 每 10 s 多一条消息，但自动应答不唤醒 DO；leg 的 55 s 回收频率未改。
- 推送只覆盖当前聚焦的运行；"动态"列表等其他长轮询仍是原方式。
- 直连只使用 IPv4 私网和 100.64/10 地址；企业网络的客户端隔离、防火墙拒绝都会退回 relay，并对该路由冷却 60 s。
- `desktop-directory-picker` 的 root 用例失败为云端环境原因，与本分支无关。
- 20KB 暂存文件门禁（`.githooks/pre-commit`）：本分支其余文件都已按职责拆分到预算以内；`RemoteRunStore.swift` 改动前就有 281KB，推送循环与离线文案必须改它，因此单独提交（`feat(ios): observe the focused run by push…`），这个提交无法通过门禁。是否拆分这个文件、何时拆分，由维护者决定。云端克隆没有启用 `core.hooksPath`，门禁是手动运行 `node scripts/check-staged-file-size.mjs` 检查的。
