# F · iOS store 观察粒度

状态：**待核验**。实现、原生计数与编译已交付；真机验收受安装配额阻碍，既有 catalog 检查仍有 4 项失败。不能标为全量通过。

## 分支与提交

- 分支：`perf/f-ios-observable`；交接基线：`bf92d04`。
- `fae1993`：独立测量提交，固定负载、原实现基线及负对照。
- `6eb43e8`：补 mixed Combine/Observation 探针、嵌套状态与 readiness 回归。
- `82c5b33ba3f1375fe25862a74688472719e5e2b8`：优化实现。
- 本报告与实验记录/STATUS 更新在后续文档提交。未合并 main，未升级版本，未构建/安装桌面 App。
- 文档原要求并行分支不改 STATUS；本次用户明确要求更新，因此仅修改 F 行为“待核验”，不更新其他批次或宣称审查通过。

## 方案与边界

选方案 1：使用 iOS 17 原生 `@Observable`。

- `RemoteRunStore` 保留 `@MainActor`、全部 `private(set)`、原状态机及输出合并；移除全对象 `@Published` 通知。
- 相关视图同步使用 typed `@Environment`；只读历史 store 的所有权改为 `@State`。未改布局、文案、视图分解、传输、Keychain、配对、持久化、重试、后台策略或协议。
- `ExecutionTargetCoordinator` 一起迁移。否则它仍把 selected/new-task store 的每次流式更新转发给 Home/Drawer/Picker。只有缓存的 `homeSessions` 投影显式监听 catalog：在 will-change 后的下一 MainActor turn 重订阅并合并重建；原 authority revision 与 store identity 阻止旧授权/已移除 store 继续订阅。
- `AppModel` **未改**，保持 `ObservableObject` / `@EnvironmentObject`。实际调用链中它并不转发流式更新；无需扩大迁移到配对/导航/草稿及 UserDefaults 派生状态。SessionActionCenter 也不迁移。
- 不拆第二套流式状态、不增加依赖、不缓存过期证据、不延迟问题或终态。删除的是无关通知，不是必需工作。
- 自审以基线逐文件核对：store 除观察声明外完全一致；视图除观察 wrapper / environment / history ownership 外完全一致；coordinator 仅替换观察与订阅管理。没有 UI 调试日志或临时手机 harness 进入仓库。

## 固定负载与结果（L1）

命令：

```sh
# 原实现采集（fae1993）
python3 apps/ios/Checks/catalog-refresh.py --check observation
# 原实现负对照应退出 1；候选应退出 0
python3 apps/ios/Checks/catalog-refresh.py --check observation --require-isolation
```

原生 runner 编译真实 store / coordinator / AppModel，向同一活动会话的生产 `append` 输入 200 个独立序号的输出片段。临时目录、独立 preferences；mock 隔离 transport，不访问真实凭据，不运行 Provider。没有改负载或缩小片段数。

| 依赖探针 | 原实现 | 候选 |
| --- | ---: | ---: |
| output | 200 | 200 |
| catalog | 200 | 0 |
| projects | 200 | 0 |
| providers / modelOptions | 200 | 0 |
| history | 200 | 0 |
| lifecycle | 200 | 0 |
| pendingQuestions | 200 | 0 |
| coordinator.homeSessions | 200 | 0 |
| AppModel.link | 0 | 0 |

这些是 **Combine / Observation 原生依赖失效次数**，不是实际 SwiftUI body 次数、布局工作量或帧率。不能据此宣称 Home/Drawer 完全不重绘或用户耗时下降。读取 output 的视图仍会更新。

候选 8 项检查通过：输出完整且合并为一行 200 字符；隔离合同；lifecycle/question 更新；catalog 二次更新后仍重订阅；嵌套 pending-work；stop 投影；history 更新；私有 readiness 依赖。原实现负对照明确失败 `observation.invalidationContract`，其他当时的 3 项完整性检查通过。

实验与取舍：[20261022-ios-observation-f.md](../../../performance-experiments/20261022-ios-observation-f.md)。未改性能台账、基线或门限。

## 实际验证

环境：arm64 macOS 27.2，Xcode 26.6 (17F113)，Swift 6.3.3 编译器 / Swift 5 language mode。未做毫秒比较；机器有其他工作负载，不提供 L2 结论。

| 检查 | 结果 | 证据 / 范围 |
| --- | --- | --- |
| `python3 apps/ios/Checks/new-task-readiness.py` | 7/7 通过 | 生产 task identity 表达式；不是 SwiftUI 真机行为 |
| `python3 apps/ios/Checks/catalog-refresh.py --check observation --require-isolation` | 8/8 通过 | 上述固定负载和依赖回归；最终默认 ad-hoc 签名 |
| `python3 apps/ios/Checks/catalog-refresh.py` | 142/146，4 项失败 | 旧实现与最终候选全部 146 项结果逐条相同，未修改既有断言 |
| `swift test --package-path experiments/remote-g0/swift -j 4` | 67/67 通过 | 本地 transport / wire / crypto 包测试；不是线上配对或 Provider 验收 |
| `xcodebuild … build-for-testing CODE_SIGNING_ALLOWED=NO` | App + UI target 编译通过 | generic/platform=iOS；未运行 UI target，不是模拟器 |
| `npm run performance:measure -- --scenario remote.loopback --out /tmp/scry-f-performance` | 无结果，退出 1 | 映射到 remote 的路径没有对应 collector：`No counter collector matches remote.loopback`，不记 0 或 better/worse |
| `git diff --check` / 观察改动范围核对 | 通过 | 仅 F iOS、独立实验与交付文档；未改协议、传输或其他批次 |

最后的仓库源码编译命令：

```sh
xcodebuild -project apps/ios/ScryRemote.xcodeproj -scheme ScryRemote \
  -configuration Debug -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/scry-f-repo-build -jobs 4 \
  build-for-testing CODE_SIGNING_ALLOWED=NO
```

源码 `82c5b33`，iOS `0.1.15 (24)`，未嵌入完整 Scry build ID（unavailable）。包含运行代码的 `ScryRemote.debug.dylib` SHA-256：

```text
734a1ca208069ed6ec4979738c590d23ffb5d499de05d4c747c01bfcdc910ea5
```

### 既有失败（未顺手修复）

旧源码对照从 `fae1993` 导出，实际生产源码仍为交接版本。只让临时 runner 引用相同、未改动的 Swift package 路径，避免移动目录后的 module-cache 路径冲突。旧实现与候选的 146 项 PASS/FAIL 列表完全相同：

1. `catalog.followUp.routingDoesNotResumeAnotherProfile`
2. `catalog.recovery.explicitModelChoice`
3. `catalog.model.explicitAutoIsRemembered`
4. `catalog.model.catalogRecoveryRestoresReadiness`

这证明它们不是本次观察迁移新增的失败，不证明这些既有合同已满足。保留失败，不改预期、不 skip、不扩大超时。审查方需另行跟进，不能将本批次标为完整验证通过。

### 首轮异常与处理

- 新测量 fixture 初次编译用了错误的属性名/不可直接构造的 wire chunk；随后 cleanup 因临时目录未创建失败。修正 fixture 后才接受基线。
- 旧源码对照最初通过 symlink 搬移 Swift `.build` 导致 module-cache 路径错误；改为引用原 package 路径后完成对照。
- 第一次 Xcode 编译被中断；检查进程已停止后增量继续成功。最终在冻结源码上重新 `build-for-testing` 通过。
- 新隔离 bundle 没有 profile/Xcode account；改用本地已有且设备上未安装的 test bundle profile。初次把 manual profile 参数传到所有 package target 失败；使用自动签名和缓存 profile 后编译、codesign 校验通过。没有绕过签名校验或改系统安全策略。
- 后期 CMS development 签名的 native executable 两次被 signal 9 终止，codesign 验证仍有效；保留 binary/日志，LLDB 无法暂停附加，具体系统终止原因 unknown。同一 binary 改为 runner 原本支持的显式 ad-hoc 签名后 8/8 通过；最终正常 runner 也以默认 ad-hoc 签名通过。没有循环重跑来抹掉首轮失败。
- 已有 concurrency、unnecessary-await、iOS onChange deprecation 编译 warning 保留，未借本次做无关清理。

## 真机验收阻碍（L2 / L3 未验证）

iCTRL 已授权连接 iPhone 13 / iOS 26.5.2；为本次建立的 USB tunnel 已停止。设备没有安装隔离包 `com.scry.remote.test.h7ukeb`。签名 preview fixture 编译成功，但安装明确返回：

```text
MIInstallerErrorDomain 13 / ApplicationVerificationFailed
This device has reached the maximum number of installed apps using a free developer profile
```

配额已被 iCTRL runner、Etch、日常 Scry 占用。没有删除它们、覆盖日常 `com.scry.remote.local`、改动配对/Keychain，亦未使用模拟器。安装失败后 iCTRL launch 同样确认隔离包不存在。临时 fixture 仅为让 iCTRL（不支持 launch arguments）选择现有 DEBUG preview，强制 preview/transport 隔离；该改动只在 `/tmp`，未进入交付源码。

以下均**未执行，不能标通过**：设备 `-selfTest`、XCTest UI target 运行、首页/持续流式输出/切换会话/后台→前台回放、500+ 行 SwiftUI body/hitch/掉帧测量。没有 L2 毫秒或 L3 日常样本证据；候选未安装/未日常生效，无 baseline→candidate 日常 build 映射。

## 现场与后续责任

- 本地保留 `/tmp/scry-f-*.log`、`/tmp/scry-f-repo-build`、`/tmp/scry-f-device-build`、旧源码对照 `/tmp/scry-f-control.EHvfeM`、签名诊断 binary `/tmp/scry-f-observation-binary` 与 preview 源码 `/tmp/scry-f-phone-source.PrKvoy`。这些是临时构建/测试材料，不是日常 App。
- 没有留下本次 App、Provider、HTTP server 或 USB tunnel 进程。未安装任何候选 App。
- **审查方**：review `82c5b33` 与上述 4 项既有失败；确认后按交接流程整合，不将计数冒充真实交互验收。
- **设备所有者**：提供空闲开发签名槽位、另一台已授权 iCTRL 真机或可安装的签名条件。释放现有 App 涉及删除，不在本次自动执行范围内。
- **F 执行方**：设备可用后继续上述真机回放、`-selfTest`、UI target 与串行 body/hitch 测量；如发现回归，再在 F 范围内修复。当前保持“待核验”。
