# Scry iOS Remote 实施与验收状态

2026-09-12。用户要求：按照技术方案和设计稿实际实现；UI 采用 Codex 对齐 v2。

权威输入：[技术方案](./scry-ios-remote-technical-plan.md)、[产品研究](./scry-ios-remote-research.md)、[v2 设计记录](../../designs/scry-ios-remote/brief.md)。本文件仅追踪实施证据，不缩小产品合同，不把 HTML 模拟或本地 echo 当成远程产品完成。

## 当前状态

**整体未完成，G0 仍未通过，不开放高权限业务。** 首个可执行增量在 `experiments/remote-g0/`，未改动桌面 main/preload/renderer、Recorder、真实用户数据或真实 Provider。

| 需求 / Gate | 当前证据 | 仍需完成 |
|---|---|---|
| G0 标准双层加密传输 | macOS 7 个真实传输场景；新增真实 iOS Simulator App → Keychain → 共享 NIOSSL → WSS → Node TLS，通过并发单次请求检查 | 真机 / 证书配对 / 蜂窝 / 锁屏 |
| G0 单一 schema | 有限 JSON Schema → JS 验证器、TS DTO、Swift Codable；共享 13-case corpus；14 Node tests、2 XCTest methods，通过漂移检查 | 完整业务 operation registry 与跨版本合同 |
| G0 打包 | macOS 可执行文件；原生 App 的 arm64/x86_64 Simulator bundle 构建、实际启动/测试成功；Xcode 使用正确 SDK，消除早期 CLI cross-link 警告的运行不确定性 | iPhone 签名/安装、真实锁屏与发布打包 |
| G0 配对 / 密钥 | 临时预签发证书，错误 CA/客户端被拒绝；Simulator 实际 Keychain 存取/失败保留与从 Keychain 建立 TLS，通过；私钥只进入 service actor/transport | 首次 proof/CSR、Mac 人类确认、持久 grant、重放/过期/失败注入、真机 Keychain；不能把 fixture 称为完成配对 |
| G1 应用服务 / 账本 / 订阅 | 尚未实现 | 保留桌面焦点/IPC/工作区授权、durable intent fence、崩溃恢复与多端 cursor |
| G2 任务 / Provider / trust | 尚未实现 | Claude/Codex 真实 new/resume/stop、独立 trust、auth 互斥、远程 actor 与双端竞态 |
| G3 文件 / PTY | 尚未实现 | 相对路径与修订冲突、owner-aware cleanup、writer generation、禁止输入重放 |
| SwiftUI Codex 对齐 | v2 HTML 为结构参考，不是原生实现 | 原生首页/新会话/会话及功能入口，连到真实协议与状态，不注入假成功 |
| G4 日常可用 / APNs | 尚未实现 | 锁屏/电源/睡眠/撤销与版本兼容；通知服务/APNs/真机后台提醒 |
| G5 公开发行 | 未创建账号/云服务/签名资产，未部署或发布 | 登录/预算/隐私删除、付费 Apple 开发者账号、签名与上架、独立安全评审、海外实际网络矩阵 |

## 已验证命令与边界

详细命令、依赖锁定与可复现范围见 [G0 README](../../experiments/remote-g0/README.md)。当前测试只使用 OS 临时证书、loopback 网络和 read-only `probe.echo`；不读取或写入真实项目 `.scry`、Provider transcript、DB 或用户凭证。

- `generate-wire.mjs --check`：生成一致。
- `npm --prefix experiments/remote-g0 test`：14 项通过。
- `swift test --package-path experiments/remote-g0/swift -j 4`：2 个 XCTest methods，通过同一 13-case 语料及边界用例。
- `swift build --package-path experiments/remote-g0/swift -j 4`：macOS 编译通过。
- `node experiments/remote-g0/smoke.mjs`：7 个真实传输场景；错误证书/篡改/断线时 0 application requests，非 harness 超时。
- 生成 TS DTO strict typecheck 通过。
- 因独立 `node:test` / SwiftPM 依赖不能被 App Vitest 重复收集，显式排除 designs/experiments；对应实验在独立 runner 和新增 `.github/workflows/remote-g0.yml` 执行。CI workflow 已配置但未推送/未取得远端运行结果。
- 当前工作区 App 回归：140 个 test files / 1908 个 tests 通过，3 个既有真实集成用例跳过；`npm run typecheck`、`npm run build` 通过。包含用户 WIP 的编译/自动测试结果，不代表远程业务或真实交互验收。
- 早期 iOS CLI cross-build 有 sysroot warning；后续原生 Xcode App bundle 使用正确 SDK、Simulator 实际运行通过；IPA/真机验收仍缺失。
- 原生 App：`apps/ios/ScryRemoteG0.xcodeproj`，SwiftUI 诊断页 + `G0Service` actor + Keychain；不是完整 v2 产品 UI，也不开放业务操作。
- `node experiments/remote-g0/ios-smoke.mjs <专用 Simulator UUID>`：当前版本 3 个原生 XCTest 全部通过、0 跳过；覆盖实际 Keychain、格式边界、TLS/model，并发 intent 只形成 1 个主机请求，TLS 1.3、无 session reuse。命令输出的 evidence 目录含完整 `.xcresult`、日志与非秘密报告；本机最近目录为 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-g0-ios-result-0R691m/`。`xcresulttool` 读回确认 3 pass / 0 skip；测试锁已移除。不提交私有测试材料。
- `RemoteProbe` 与 App 共用 `RemoteTransport` library；生成器路径和测试 import 随 Wire.swift 迁移更新。CI 显式选用 runner 已安装的 Xcode 26.3（默认 16.4 不满足锁定的 swift-collections 6.2 工具链要求），原生 build-for-testing 已加入，但远端 CI 仍未运行。

发现并修复 HTTP upgrade callback 内安装 inner TLS 会使 ClientHello 被 HTTP 升级状态拒绝的问题；改为升级完成后再进入内层握手。所有应用消息等待内层握手完成，没有 0-RTT 写入或失败自动重发。

原生 harness 另修复了 Xcode 重装会迁移 App data container 路径的真实问题：进程锁移到稳定 OS 临时目录；清理前重取当前 App container，不用旧路径不存在冒充材料已删除。超时/信号不证明测试后代停止，保留原锁供核查，不自动重试。

## 下一步（仍属于完整目标）

1. 继续完成 G0 的首次配对/本机确认/持久授权。原生验证 App 和 Simulator Keychain 已有证据，但不能替代真机或首次 enrollment。
2. 经用户授权使用测试 iPhone/Personal Team 与外部测试入口，完成蜂窝/锁屏 G0-device。没有该证据不越过技术方案的高权限 gate。
3. G0 通过后按 G1→G3 接入既有应用服务，落地 SwiftUI v2；再完成 G4/G5，不把实验性本地成功当作首发完成。

已有九个无关 WIP 文件未被本任务修改；不复制 runner，不放宽 renderer sandbox/trust，不修改 commitHook auto_grant 策略，不自动购买、部署或推送。

## 用户外部授权增量

用户明确允许在其 iPhone 安装隔离 G0 测试 App，需要其完成连接/信任/开发者模式；系统有开发签名身份但物理设备仍 unavailable。允许评估付费公网资源，**未批准创建或扣费**。Render 候选价格、风险及后续确认边界见 [公网测试评估](./scry-ios-remote-test-deployment.md)。
