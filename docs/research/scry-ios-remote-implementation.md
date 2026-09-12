# Scry iOS Remote 实施与验收状态

2026-09-12。用户要求：按照技术方案和设计稿实际实现；UI 采用 Codex 对齐 v2。

权威输入：[技术方案](./scry-ios-remote-technical-plan.md)、[产品研究](./scry-ios-remote-research.md)、[v2 设计记录](../../designs/scry-ios-remote/brief.md)。本文件仅追踪实施证据，不缩小产品合同，不把 HTML 模拟或本地 echo 当成远程产品完成。

## 当前状态

**整体未完成，G0 仍未通过，不开放高权限业务。** 首个可执行增量在 `experiments/remote-g0/`，未改动桌面 main/preload/renderer、Recorder、真实用户数据或真实 Provider。

| 需求 / Gate | 当前证据 | 仍需完成 |
|---|---|---|
| G0 标准双层加密传输 | macOS 7 个真实传输场景；新增真实 iOS Simulator App → Keychain → 共享 NIOSSL → WSS → Node TLS，通过并发单次请求检查 | 真机 / 证书配对 / 蜂窝 / 锁屏 |
| G0 单一 schema | 有限 JSON Schema → JS 验证器、TS DTO、Swift Codable；共享 23-case corpus（含 7 类配对消息）；30 Node tests、2 XCTest methods，通过漂移检查 | 完整业务 operation registry 与跨版本合同 |
| G0 打包 | macOS 可执行文件；原生 App 的 arm64/x86_64 Simulator bundle 构建、实际启动/测试成功；Xcode 使用正确 SDK，消除早期 CLI cross-link 警告的运行不确定性 | iPhone 签名/安装、真实锁屏与发布打包 |
| G0 配对 / 密钥 | P-256 软件密钥/CSR → Node 验签签发 → NIOSSL 真实互操作；自签 bootstrap 被业务通道拒绝；Simulator Keychain insert-only 生成/保存、公有 proof 读回及既有 fixture TLS 均通过。新增 `PairingAuthority` 状态机：短时秘密（base64url 验证器 + timingSafe + 5 次上限）、CSR 通道密钥绑定、单事务消费秘密+签发、`await`-串行化、写失败/未知回执 fence（不重复签发）、私有 0700/0600 原子文件 + 排它租约 store、崩溃后按观测快照对账；`pair-smoke.mjs` 经真实 host-authenticated bootstrap 通道（Swift CLI → WSS → Node `/pair` 主机 → 真实 `PairingAuthority`）完成 prove→本机确认→签发→用签发证书跑真实 mTLS echo→撤销全链；13 Vitest + 30 Node + 4 Swift + 4 Simulator XCTest 通过 | Mac 上真实人类确认 UI（当前 confirmLocal 由测试直接驱动，非真人）、续期、真机 Keychain/锁屏/蜂窝；不能把状态机与合成确认称为完成配对 |
| G1 应用服务 / 账本 / 订阅 | 新增纯模块 `src/main/remote/session-ledger.ts`（`SessionLedger`）：只追加、服务端单调序号作 cursor；远端任务为一次性持久 intent（intentId 幂等 fence，重提不双建 run）；intent “已记录”与主机执行器 dispatched/settled/failed/cancelled 为不同生命周期，拒绝非法跃迁（未 dispatch 不能 settle、终态不可再变）；先持久 append 后再改内存，append 失败即 fence且不推进序号；崩溃重启按持久日志重放重建状态（未终态 run 存活、不静默完成，重放同 intent 仍为 duplicate）；序号缺口/错误 shape/未知 run 的日志 fail closed；cursor 校验与分页；容量上限。并新增持久文件 store `session-ledger-file.ts`（JSONL 只追加 + 逐条 fsync + 目录 fsync，私有 0700 目录/0600 文件/排它锁租约，O_NOFOLLOW）：挡机重启后真实磁盘重建状态与 fence，未换行的断尾追加丢弃（未回执的写入）而中间行损坏 fail closed。`vitest run src/main/remote/session-ledger.test.ts` 14 项通过（含真实文件重启/断尾/损坏/双租约/关闭后拒用）。新增 `remote-gateway.ts`（`RemoteGateway`）：设备面向应用服务，组合真实 `PairingAuthority`（授权）+ `SessionLedger`（持久 intent/订阅）；每次调用用已验证的 mTLS peer 证书指纹重新授权（撤销后下一调用即拒），runId 主机端分配、intentId 幂等，设备只能读 feed不能驱动生命周期（dispatch/settle 由可信主机执行器驱动后经 poll 反映）。`vitest run src/main/remote/remote-gateway.test.ts` 5 项通过；typecheck(node+web) 通过，remote 套件 33 通过。新增 `g1-smoke.mjs` 端到端：真实内层 mTLS 上，主机从 `socket.getPeerCertificate().raw` 派生指纹授权；已授权设备 submit intent（recorded、intentId 幂等）+ poll 反映主机驱动的 dispatched/settled；另一张同为 inner-CA 信任但未授权的证书完成 TLS 握手但被 gateway 拒绝（device_not_authorized，不改账本）；撤销后下一调用即拒。命令 `npm --prefix experiments/remote-g0 run smoke:g1`（经 `--import ./ts-relative-resolve.mjs` 解析 src 无扩展名相对导入） | 与 RunRegistry/桌面焦点/IPC/工作区授权真实对接；多端实时订阅传输；尚未接入 live IPC/网络 |
| G2 任务 / Provider / trust | 尚未实现 | Claude/Codex 真实 new/resume/stop、独立 trust、auth 互斥、远程 actor 与双端竞态 |
| G3 文件 / PTY | 尚未实现 | 相对路径与修订冲突、owner-aware cleanup、writer generation、禁止输入重放 |
| SwiftUI Codex 对齐 | 已接受 v2；新增产品 App `apps/ios/ScryRemote`（`com.scry.remote`，iOS 17+）忠实实现 SignIn/Home/New/Chat/Pair 五屏。Simulator 与真机（Personal Team 签名）均构建成功；专用 Simulator 实际启动并截图四屏。Sign in with Apple 用官方 `SignInWithAppleButton`；状态真实（无虚构会话、无假 connected 点、未配对就真实展现未连接） | Sign in with Apple entitlement 需付费 Apple Developer 账号（Personal Team 无法供置，真机登录会失败）；会话/文件/终端需 G1+ 真实主机协议才能有真实内容 |
| G4 日常可用 / APNs | 尚未实现 | 锁屏/电源/睡眠/撤销与版本兼容；通知服务/APNs/真机后台提醒 |
| G5 公开发行 | 未创建账号/云服务/签名资产，未部署或发布 | 登录/预算/隐私删除、付费 Apple 开发者账号、签名与上架、独立安全评审、海外实际网络矩阵 |

## 已验证命令与边界

详细命令、依赖锁定与可复现范围见 [G0 README](../../experiments/remote-g0/README.md)。当前测试只使用 OS 临时证书、loopback 网络和 read-only `probe.echo`；不读取或写入真实项目 `.scry`、Provider transcript、DB 或用户凭证。

- `generate-wire.mjs --check`：生成一致。
- `npm --prefix experiments/remote-g0 test`：30 项通过（23-case wire corpus + 5 CSR/签发 + 2 边界）。
- `node_modules/.bin/vitest run src/main/remote/pairing.test.ts`：13 项通过，覆盖仅存 verifier、密钥/CSR 通道绑定、5 次上限、候选不可替换、单次消费+签发、时钟回拨与重启不复活、写失败/未知回执 fence、签名中取消、撤销即时+持久、私有原子文件 + 排它租约 + 符号链接/损坏/陌生锁拒绝。
- `swift test --package-path experiments/remote-g0/swift -j 4`：4 个 XCTest methods，通过 wire 语料/边界和设备密钥/CSR 测试。
- `swift build --package-path experiments/remote-g0/swift -j 4`：macOS 编译通过。
- `node experiments/remote-g0/smoke.mjs`：7 个真实传输场景；错误证书/篡改/断线时 0 application requests，非 harness 超时。
- `node experiments/remote-g0/enrollment-smoke.mjs`：2 个真实场景通过，Swift CSR / Node 签发 / NIOSSL 密钥互操作及自签 bootstrap 拒绝；不是完整配对或人工确认。详见 [互操作证据与缺口](./scry-ios-remote-enrollment-interop.md)。
- `node --test experiments/remote-g0/relay-admission.test.mjs`：11 项通过。纯 `RelayAdmission` 覆盖单次票据、host/device 角色绑定、重放拒绝、时钟（墙钟或单调任一）过期、会话容量、滑窗限速、共享票据/格式校验与日志脱敏；网络集成用鉴权 relay 证明「持正确 device 票据的对端完成真实内层 TLS1.3 mTLS echo；错误票据 401 且 0 内层请求、不建桥；已消费票据重放 401；日志不泄露明文票据」。这是 loopback 鉴权 relay 证据，尚未部署公网/局域网可达 relay。
- `npm --prefix experiments/remote-g0 run smoke:g1`：1 个端到端场景通过。真实内层 mTLS 上 `RemoteGateway` 按验证 peer 证书指纹授权：已授权设备 submit（幂等）/poll/runState 正常；未授权但 CA 信任的证书与撤销后均被拒（`events=3` 不变）。本机证据，无真机/人。
- `node experiments/remote-g0/pair-smoke.mjs`：1 个全链场景通过，经真实 host-authenticated bootstrap 通道（Swift `pair prove` CLI → 外层 WSS → Node `/pair` 主机 → 真实 `PairingAuthority`），完成「错误秘密拒绝→pending→合成本机确认→granted→用签发证书跑真实 mTLS echo→撤销后拒绝」；`proves=4`、`issued=1`（只签发一次）。本机确认由 harness 直接调用，非真人。
- 生成 TS DTO strict typecheck 通过。
- 因独立 `node:test` / SwiftPM 依赖不能被 App Vitest 重复收集，显式排除 designs/experiments；对应实验在独立 runner 和新增 `.github/workflows/remote-g0.yml` 执行。CI workflow 已配置但未推送/未取得远端运行结果。
- 当前工作区 App 回归：140 个 test files / 1908 个 tests 通过，3 个既有真实集成用例跳过；`npm run typecheck`、`npm run build` 通过。包含用户 WIP 的编译/自动测试结果，不代表远程业务或真实交互验收。
- 早期 iOS CLI cross-build 有 sysroot warning；后续原生 Xcode App bundle 使用正确 SDK、Simulator 实际运行通过；IPA/真机验收仍缺失。
- 原生 App：`apps/ios/ScryRemoteG0.xcodeproj`，SwiftUI 诊断页 + `G0Service` actor + Keychain；不是完整 v2 产品 UI，也不开放业务操作。
- `node experiments/remote-g0/ios-smoke.mjs <专用 Simulator UUID>`：当前版本 4 个原生 XCTest 全部通过、0 跳过；覆盖实际 Keychain、生成设备密钥的跨 actor insert-only、格式边界、TLS/model；并发 intent 只形成 1 个主机请求，TLS 1.3、无 session reuse。当前 `.xcresult`/日志/报告目录为 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-g0-ios-result-P22q8O/`；`xcresulttool` 读回确认 4 pass / 0 skip。不提交私有测试材料。
- `RemoteProbe` 与 App 共用 `RemoteTransport` library；生成器路径和测试 import 随 Wire.swift 迁移更新。CI 显式选用 runner 已安装的 Xcode 26.3（默认 16.4 不满足锁定的 swift-collections 6.2 工具链要求），原生 build-for-testing 已加入，但远端 CI 仍未运行。
- 真机（2026-09-12，用户连接后）：以 Personal Team `7USHN8Q8JL` 自动签名、`-allowProvisioningUpdates` 自动创建 `com.scry.remote.g0` profile，`iphoneos` 构建成功；`devicectl device install` 安装到 `鲍炋江的iPhone`（UDID 00008150-001A29A926D8401C，开发者模式 enabled）；`xcodebuild test -destination platform=iOS,id=...` 在真机上执行 3 个 XCTest 全部通过（fixture 边界、生成设备密钥 insert-only 持久、Keychain round-trip + 失败导入保留），真实验证 `AfterFirstUnlockThisDeviceOnly` 非同步 Keychain 策略在设备上生效。`testSimulatorTLSFromKeychain` 在真机上正确跳过：它需要一个从设备可达的 Mac 侧活跃 relay（host/device 绑定），而已鉴权的 LAN/公网 relay 尚未实现——这是真实缺口，不当作已通过。结果 bundle `/tmp/scry-g0-device-tests.xcresult`；签名/安装产物未入库。

发现并修复 HTTP upgrade callback 内安装 inner TLS 会使 ClientHello 被 HTTP 升级状态拒绝的问题；改为升级完成后再进入内层握手。所有应用消息等待内层握手完成，没有 0-RTT 写入或失败自动重发。

原生 harness 另修复了 Xcode 重装会迁移 App data container 路径的真实问题：进程锁移到稳定 OS 临时目录；清理前重取当前 App container，不用旧路径不存在冒充材料已删除。超时/信号不证明测试后代停止，保留原锁供核查，不自动重试。

## 下一步（仍属于完整目标）

1. 真机安装与设备 Keychain 已有真实证据（见上）。已鉴权 relay 的 admission 层（ticket + host/device 绑定 + 重放/过期/限速/缓冲 + 日志脱敏）已在 `relay-admission.mjs`/`authenticated-relay.mjs` 实现并通过 loopback 真实 mTLS 集成测试。仍需：把该 admission 接到从设备可达的 LAN/公网 relay（票据签发与 host 控制通道自身鉴权），再在真机完成 TLS-from-Keychain 与锁屏/蜂窝 G0-device；持久 grant 的真机回放与续期。
2. 登录/身份已定为 Sign in with Apple，最低 iOS 17+；把设备身份绑定到 `PairingAuthority` 的 grant（设备证书 + Apple 身份）。
3. 已接受设计 v2：按其实现原生 SwiftUI home/new/chat，绑真实协议/状态，真实展现未登录/未配对/未连接/空态，不注入假成功；再按 G1→G5 接入应用服务。

已有九个无关 WIP 文件未被本任务修改；不复制 runner，不放宽 renderer sandbox/trust，不修改 commitHook auto_grant 策略，不自动购买、部署或推送。

## 用户外部授权增量

用户已连接并信任其 iPhone（开发者模式 enabled），隔离 G0 测试 App 已以 Personal Team `7USHN8Q8JL` 签名安装并在真机跑通设备 Keychain XCTest（见上）。允许评估付费公网资源，**未批准创建或扣费**；仍未部署任何公网 relay。Render 候选价格、风险及后续确认边界见 [公网测试评估](./scry-ios-remote-test-deployment.md)。
