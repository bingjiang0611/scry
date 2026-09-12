# Scry iOS Remote 实施与验收状态

2026-09-12。用户要求：按照技术方案和设计稿实际实现；UI 采用 Codex 对齐 v2。

权威输入：[技术方案](./scry-ios-remote-technical-plan.md)、[产品研究](./scry-ios-remote-research.md)、[v2 设计记录](../../designs/scry-ios-remote/brief.md)。本文件仅追踪实施证据，不缩小产品合同，不把 HTML 模拟或本地 echo 当成远程产品完成。

## 当前状态

**整体未完成，G0 仍未通过，不开放高权限业务。** 首个可执行增量在 `experiments/remote-g0/`，未改动桌面 main/preload/renderer、Recorder、用户数据或真实 Provider。

| 需求 / Gate | 当前证据 | 仍需完成 |
|---|---|---|
| G0 标准双层加密传输 | macOS SwiftNIO SSL ↔ Node TLS 1.3 mTLS，双端主动 WSS 连接；7 个真实本地传输场景通过 | 实际 iOS app / Keychain / 证书配对 / 蜂窝 / 锁屏 |
| G0 单一 schema | 有限 JSON Schema → JS 验证器、TS DTO、Swift Codable；共享 13-case corpus；14 Node tests、2 XCTest methods，通过漂移检查 | 完整业务 operation registry 与跨版本合同 |
| G0 打包 | macOS 可执行文件；iOS Simulator arm64 Mach-O（min iOS 17、SDK 26.5） | 处理/复核链接 sysroot 警告；App bundle、实际启动与 iPhone 签名/安装 |
| G0 配对 / 密钥 | 仅临时预签发测试证书，错误 CA/客户端被拒绝 | 首次 proof/CSR、Mac 人类确认、持久 grant、重放/过期/失败注入、Keychain；不能把 TLS 证书 fixture 称为完成配对 |
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
- iOS Simulator cross-build 生成 Mach-O，`vtool` 确认目标为 IOSSIMULATOR；有 linker sysroot warning，运行/IPA/真机验收缺失。

发现并修复 HTTP upgrade callback 内安装 inner TLS 会使 ClientHello 被 HTTP 升级状态拒绝的问题；改为升级完成后再进入内层握手。所有应用消息等待内层握手完成，没有 0-RTT 写入或失败自动重发。

## 下一步（仍属于完整目标）

1. 完成 G0 的配对/本机确认/Keychain 与可安装 iOS 验证端；复核 iOS 打包和证书库成本。
2. 经用户授权使用测试 iPhone/Personal Team 与外部测试入口，完成蜂窝/锁屏 G0-device。没有该证据不越过技术方案的高权限 gate。
3. G0 通过后按 G1→G3 接入既有应用服务，落地 SwiftUI v2；再完成 G4/G5，不把实验性本地成功当作首发完成。

已有九个无关 WIP 文件保持原样；不复制 runner，不放宽 renderer sandbox/trust，不修改 commitHook auto_grant 策略，不自动购买、部署或推送。
