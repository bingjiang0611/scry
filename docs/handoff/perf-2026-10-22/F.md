# 批次 F：iOS RemoteRunStore 观察粒度（#7）

分支：`perf/f-ios-observable`（从 `perf/handoff` 的交接提交切出，只改 `apps/ios/`）。先读 [README.md](README.md)、[review.md](review.md) #7 与 `apps/ios/README.md`（尤其 Honesty invariants 与验证方式）。

**前置条件**：需要完整 Xcode 与一台通过 iCTRL 授权的真机（`ictrl-phone-control` skill）。按 CLAUDE.md，**不使用模拟器**；缺少真机时只交付编译与离线检查结果，交互验收标“未验证”，不得标为通过。

## 现状

`apps/ios/ScryRemote/RemoteRunStore.swift:23` 是一个 `ObservableObject`，有 67 个 `@Published`（`:192-523`），约 19 个视图文件观察它。流式输出 `output.append`（`:2910`）每次都触发 `objectWillChange`，使所有观察者（Home、Drawer、SessionRow、Pickers……）重算 body。部署目标 iOS 17.0。

## 先测（单独提交）

真机上一轮持续输出 500+ 行时：主线程 hitch / 掉帧（Instruments 的 SwiftUI 与 Hitches 模板，或 os_signpost 计数）、每秒 body 重算次数（可用 `Self._printChanges()` 计数的 DEBUG 开关，提交时不保留噪声日志）。没有真机时记录为“L2 未验证”，只做计数。

## 改法方向（择一，写明取舍）

1. **迁移到 `@Observable`**（Observation 框架）：视图只在读取过的属性变化时更新。注意 `@EnvironmentObject` / `@ObservedObject` / `@StateObject` 用法要全部同步改为 `@Environment` / `@Bindable` / `@State`，`private(set)` 语义保留。
2. **拆出流式状态**：把 `output`、`lifecycle` 等高频字段拆进独立的小 `ObservableObject`，只有会话视图观察它。改动小，但收益只覆盖流式路径。

建议先评估 1 的改动面（19 个文件）；若过大，先做 2 并在报告中说明。

## 红线

- `apps/ios/README.md` 的 Honesty invariants 全部保持：未观测不等于完成、“已连接”只在真实交换后显示、outbox 持久化与重试语义不变。
- 不改传输协议与 Keychain/配对逻辑。
- 行为保持：`-selfTest` 中的回归全部通过。

## 测试

```sh
python3 apps/ios/Checks/new-task-readiness.py
python3 apps/ios/Checks/catalog-refresh.py
swift test --package-path experiments/remote-g0/swift -j 4
```

外加 `xcodebuild` 编译、`-selfTest`、XCTest UI target；真机经 iCTRL 重放：首页、会话流式输出、切换会话、后台再回前台。编译、离线检查、真机交互分别报告。

## 完成后

写 `reports/F.md`，push `perf/f-ios-observable`。不改 STATUS.md。
