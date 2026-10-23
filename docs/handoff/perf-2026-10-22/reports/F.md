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

## 核验意见（审查方，2026-10-22）

结论：**代码已核验；真机验收未完成，F 不能整体标为通过**。依据是逐行读 `82c5b33` 的 diff 与本报告的命令记录（审查方没有 Xcode/真机，未复跑）。

- `RemoteRunStore` 除观察声明外未改，`private(set)` 与 `@MainActor` 保留；`AppModel` 保持 `ObservableObject` 的判断合理（它不转发流式更新）。
- `ExecutionTargetCoordinator` 用 `withObservationTracking` 只跟踪 `catalog`，在下一个 MainActor turn 重新武装并重建；`authorityRevision` 与 store 身份校验防止旧授权/已移除的 store 继续订阅。原来对 `pendingQuestions/outbox/lifecycle` 的转发改由视图直接读取跟踪，报告中有嵌套 pending-work 回归覆盖。
- `ReadOnlySessionTranscriptView` 从 `@StateObject` 改为 `@State`：`@State` 的初始值表达式在每次视图 init 时都会求值，会构造一个随即丢弃的 `RemoteRunStore`。已确认 `init(historyFor:)` 走 `historyOnly` 分支提前返回，代价很小，可以接受；日后若该 init 增加副作用，需要改回惰性创建。
- L1 口径如实：报告明确这是依赖失效次数，不是 body 次数或帧率。

**仍需完成**（设备可用后，由 F 执行方在本分支继续）：

1. 真机安装隔离包，运行 `-selfTest` 与 XCTest UI target。
2. 经 iCTRL 回放首页、持续流式输出、切换会话、后台→前台。
3. 500+ 行流式输出的 hitch/掉帧串行测量（L2）。

阻碍是免费开发者签名的安装槽位已满。腾出槽位需要删除设备上的 App，这一步由设备所有者决定。

4 项 `catalog-refresh` 失败在基线上同样存在，已记入 `perf/handoff` 的 STATUS「既有问题」，不归入 F。

## 真机补充核验（执行方，本轮 2026-10-22/23）

**结论：审查意见要求的安装、`-selfTest`、XCTest UI target、iCTRL 回放及 600 行 L2 采集均已执行；不是测试全绿，也没有证据支持“真实流式输出已明显更快”。** 本轮未发现这两个测试套件相对 `bf92d04` 新增的失败，未改生产实现。以下更新前文“设备尚不可用”的现场状态；不覆盖审查方原意见，**本轮没有修改 `STATUS.md`**。

### 身份、授权与数据边界

- 首先 `git pull --ff-only` 到 `de8501ab5989114949f04a99decee8484d48d4c4`，读完上述审查意见。候选运行源码仍是已审查的 `82c5b33`；对照源码是 `bf92d049539a375aeafbc4044beedd61fef4244c`。测量工具及归一化数据独立提交 `e26941f2`，没有把测量代码塞入生产 target。
- 始终使用 **iPhone 13 / iOS 26.5.2**，UDID `00008110-000808180E8B801E`，iCTRL 1.97.0；未使用模拟器，也未换成另一台手机。宿主 arm64 macOS 27.2、Xcode 26.6 (17F113)、Swift 6.3.3 / Swift 5 mode、Debug、`-jobs 4`。设备 UI 日志是 23 日，宿主日志是 22 日；统计使用 trace 内的单调时间，不混用两边的墙钟。
- 隔离包仍被免费签名三 App 配额拒绝。之后用户明确授权 **“覆盖日常 scry”**，本轮才改用 `com.scry.remote.local` 原地安装；没有卸载 Scry、清空它的数据或重置配对。用户登录 Xcode 后 runner 可以签名，但安装仍超额；用户随后明确批准卸载 `com.baobingjiang.etch.mobile`，才得以执行 UI target。**Etch 已卸载，未自动重装，可能丢失其本地数据。**
- `device-observation.py` 从不可变 Git revision 生成临时副本；给两边注入同一份 `device-observation.swift`。仅在生成副本隔离 defaults/history/state 目录、注入 body 计数与 trace、增加固定负载按钮和 Documents 结果文件。UI fixture 强制 preview；`-selfTest` 不强制 preview，保留原 admission 语义。没有改 transport、协议、恢复、outbox 或生产 Keychain 实现。
- 构建时 Xcode 自动选择的 **8 个依赖 pin 在基线/候选完全相同**，已对比两份完整 pins 和两份 build log。该实验图保存为 [`20261022-ios-observation-device-f-packages.json`](../../../performance-experiments/20261022-ios-observation-device-f-packages.json)：ASN1 1.7.3、Collections 1.7.4、Atomics 1.3.1、Certificates 1.20.0、Crypto 4.5.2、NIO 2.90.1、NIOSSL 2.36.1、System 1.8.1。因此这是**同一实验依赖图下的源码对照**，不是声称复现原发布二进制。未提交 App 依赖升级；最终日常包另用仓库原锁文件构建，见末节。

### 真机功能结果

| 项目 | 结果 | 证据与范围 |
| --- | --- | --- |
| 真机 `-selfTest` | 基线、候选均 **114 PASS / 3 FAIL**，全部 117 条 SELFTEST 结果相同 | `/tmp/scry-f-device-selftest-{baseline,candidate}-v3.log`；使用隔离 defaults 与测试专用 Keychain service，不写生产 service |
| XCTest UI target | 基线、候选均 **26/31 PASS，5 FAIL，0 skip**；失败名及错误文本完全相同 | `/tmp/scry-f-followup-ui-{v3,baseline}.xcresult`；两边 UI 测试源码无 diff；没有删断言、跳过测试或扩大其超时 |
| iCTRL 首页、切换会话 | 可从首页打开“完成 iOS 工作目录选择器和附件发送”，返回后打开“修复手机续聊在 Mac 端不可见的问题” | `/tmp/scry-f-replay-*.json`；预置 DEBUG 会话，未冒充真实 Provider 请求或刷新成功 |
| iCTRL 后台→前台 | 经 Settings 切后台，再回到 Scry，第二条会话标题仍在 | 同上；没有重新配对、清缓存或手动恢复会话 |
| iCTRL 持续输出及流中切后台 | 固定流实际完成 600 行，1 个输出 row，前后台回放后的完整输出 hash 与基线相同 | `/tmp/scry-f-replay-stream-{start,progress,background,foreground,resumed,final}.json`；AX 样本上限 50 条，不将该样本说成 600 行全量 UI 遍历 |
| 数据保留 | 日常 `Library/Preferences/com.scry.remote.local.plist` 安装前、测试后、最终安装后**字节完全一致**；其中连接描述符仍在 | `/tmp/scry-f-daily-preferences-{before,after-tests,final-locked}.plist`；未导出私钥，没有调用生产 Keychain 写入/删除路径。不将此等同于真实宿主已重新联通 |

`-selfTest` 的三个基线同样失败项：

- `run.recovery.explicitModelChoice`
- `run.model.explicitAutoIsRemembered`
- `run.model.catalogRecoveryRestoresReadiness`

XCTest 的五个基线同样失败项（两边实际都执行了完整 31 个测试）：

- `ConversationUITests.testFailedTurnKeepsItsOutcomeInTheTurn`
- `ConversationUITests.testHomeRefreshFailureKeepsCacheActionableAndTechnicalDetailsCollapsed`
- `ConversationUITests.testOpeningAndSendingFromOlderMessagesGoToLatest`
- `ConversationUITests.testSessionStatusAndReadOnlyWorkspaceBrowser`
- `ConversationUITests.testTurnDetailsDoNotInventMissingUsage`

这些结果证明的是**相对此基线没有新增套件失败**，不是上述行为已通过验收，也未进一步把五项 UI 失败归因为产品 bug 或 fixture bug。本轮不扩大到修复非 F 回归。

### 串行 L2：真实 body、Hitches 与 FPS estimate

固定输入为 `stream600-paragraphs-30hz-tail500-v2`：600 段相同长度文本，按 33 ms 调度，走真实 `RemoteRunStore.append` / 合并与 SwiftUI 渲染，末尾留 500 ms。33 ms 是调度目标，**不是实现达成的吞吐率**。没有真实 Provider、付费请求、自动发送或网络流量造数。所有六轮均输出 600 行 / 1 row，完整 UTF-8 SHA-256：

`2fe847c12d3295747ee52bff44914d2230f71a471f4237e2de5fbf2820e30ae4`

每轮通过 `timing-run.mjs` 独占锁串行执行；顺序 A1→B1→B2→A2→A3→B3。以数字 PID attach，Activity Monitor + Hitches + Core Animation FPS + os_signpost，等固定负载完成后停止并保存 trace，而不是录固定秒数截断输出。只统计 `com.scry.batch-f / Stream600` interval；Hitches 再按目标 App PID 筛选，并裁剪到该 interval。已独立核对六份完整 Hitches 表：swap ID 均唯一、时间区间不重叠，没有重复相加。

| 样本 | Stream interval ms | App hitches | Hitch ms/s | Display FPS estimate | 手机 thermal | 宿主 load before→after / 10 cores |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| A1 `baseline-v2-1` | 51981.6 | 326 | 365.9 | 26.62 | nominal→nominal | 90.22→63.58 |
| B1 `candidate-v2-1` | 53446.6 | 304 | 313.7 | 26.57 | nominal→nominal | 41.46→39.02 |
| B2 `candidate-v2-2` | 52851.1 | 307 | 356.4 | 26.58 | nominal→nominal | 36.59→26.03 |
| A2 `baseline-v2-2` | 56434.3 | 324 | 339.7 | 26.03 | nominal→fair | 22.05→15.32 |
| A3 `baseline-v2-3` | 52936.0 | 303 | 357.0 | 26.08 | nominal→nominal | 6.04→7.23 |
| B3 `candidate-v2-3` | 54540.7 | 302 | 319.0 | 25.70 | nominal→nominal | 11.23→7.28 |

FPS 按每个采样桶与 interval 的交集加权，覆盖率另存 JSON；它是 Instruments 的 **display FPS estimate**，不是 App 每帧呈现证明。`hitches-frame-lifetimes` 的 A3/B3 导出也已解析（1487/1474 行），其 schema 没有权威 dropped-frame-count 字段。CADisplayLink 的 missed callbacks 仅是主线程漏回调：基线 2710/2965/2764，候选 2786/2751/2855；**不能说成实际 GPU 呈现丢帧数**，本轮精确呈现丢帧计数为 unavailable。

纯流式区间的真实 `body` 入口计数，六轮一致：

| View | 基线 / 每轮 | 候选 / 每轮 | 解释 |
| --- | ---: | ---: | --- |
| `RootView` | 601 | 0 | 原来读 coordinator 的父层失效被切断；缺失的 dictionary counter 表示未进入该已注入的 body，基线是正对照 |
| `ChatView` | 601 | 601 | 它自身依赖流式状态，仍正常更新 |
| `FocusedTurnView` | 601 | 601 | 输出未被隐藏、节流或减少 |

**可证实：本固定场景消除了无关父层 body 重算，且输出完整。不可证实：App 已整体更快或卡顿已解决。** 样本中位数 interval 为 52936.0→53446.6 ms（候选约 +0.96%）；hitches 324→304，hitch ms/s 357.0→319.0，FPS estimate 26.08→26.57。这只是描述，不是显著性结论。5/6 轮被现有 timing guard 标为 `highLoad:true`，A2 结束时 thermal 为 fair；保留全部样本，未挑掉慢值。不能将该小幅耗时增加归因为 F，也不能据此承诺无性能回归。若要作稳定 L2 提速/门禁结论，必须再做双方低宿主负载且 thermal nominal 的成对测量；本轮没有放宽 ratchet、替换 workload 或把 L1 当 L2/L3。当前持续输出依然有明显卡顿；未做 CPU call tree 归因，不擅自把它归咎于 Markdown 或扩大重构。

归一化完整数据及 XML SHA-256：[`20261022-ios-observation-device-f.json`](../../../performance-experiments/20261022-ios-observation-device-f.json)。原始六份 trace、三张导出表、process metadata、iCTRL replies、结果和 timing log 均在 `/tmp/scry-f-l2-20261022/<样本名>/`。未上传 trace、xcresult、偏好文件或设备诊断。

### 工具、负对照与首轮失败

- 新增 `apps/ios/Checks/device-observation.{py,swift}`：只生成隔离副本，不自动安装、签名或运行。新增 `device-observation-record.py`：必须由现有 timing lock 包装，对明确授权的 bundle/device 录一轮，拒绝覆盖已有输出目录；最后两轮已实际用提交版入口执行。新增 `device-observation-report.py`：完整解析三张 XML 表及 ref，校验 phase PID、600 行、1 row 和独立计算的完整输出 hash；六轮重新归一化后与提交数据逐字节相同。
- Python 编译检查通过。报告器负对照：把独立副本改成 599 行、把 process PID 改成错误值，**两者均退出 1**；没有把缺失证据显示成 0 或成功。没有新增依赖或 App target 源文件。
- 初次 self-test harness 错误地强制 preview，造成额外 readiness 失败；只修正临时入口选择后才采纳 v3 的 117 项完整对照。初次 XCTest 是缺 runner profile / Xcode No Accounts；登录后仍被槽位拒绝；经用户批准卸载 Etch 后才真正运行，没有把安装失败算作 skip 或 PASS。
- 初次 Instruments 按进程名 attach 失败；改数字 PID。另一次 Animation Hitches 模板固定约 28 s，早于约 56 s 的实际 workload 结束，保存被中断，trace 无法导出。这些首次失败仍保留在本地，**不纳入可比较的 v2 数据**；之后使用更轻模板并按 completion 停止，没有缩小 600 行负载。完整 v2 的慢值和高负载值全部保留。

同机复现示例（需要设备所有者事先授权相应安装/覆盖；不要清 Keychain 或重新配对）：

```sh
# 对 bf92d04 / de8501a 各生成一份新目录；实际设备构建、签名、安装另行执行。
python3 apps/ios/Checks/device-observation.py --revision bf92d04 --output /tmp/f-device-A
# 两边构建前使用同一份已归档实验依赖图，防止重新解析到未来的版本。
cp docs/performance-experiments/20261022-ios-observation-device-f-packages.json \
  /tmp/f-device-A/apps/ios/ScryRemote.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
# xcodebuild 使用 -onlyUsePackageVersionsFromResolvedFile；不要自动升级依赖。
# 安装并确认对应 fixture 后，一次只录一轮，output 必须是新目录。
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs F-ios-A \
  -- python3 apps/ios/Checks/device-observation-record.py \
  --device 00008110-000808180E8B801E --bundle com.scry.remote.local --output /tmp/f-l2-A \
  > /tmp/f-l2-A.log 2>&1
cp /tmp/f-l2-A.log /tmp/f-l2-A/timing.log
python3 apps/ios/Checks/device-observation-report.py /tmp/f-l2-A
```

### 收尾与未验证项

- 已卸载**本轮新装的** `com.scry.remote.local.xctrunner`，释放 runner 槽位。iCTRL runner 仍在；没有停止原本已运行的 USB tunnel（PID 82924）。本轮 xctrace / xcodebuild 已结束；未留下运行中的 Provider 或测试驱动。
- 已从当前仓库正常 target **重新构建并原地安装无注入的 Scry `0.1.15 (24)`**。命令是相同 physical-device Debug build 加 `-onlyUsePackageVersionsFromResolvedFile`；codesign strict/deep 校验、构建、安装均成功。Xcode 曾自动改动 App `Package.resolved`，已仅撤回该次生成的更新；最终锁文件与 Git 完全一致（ASN1 1.7.2 / Collections 1.6.0），未顺带提交依赖升级。
- 最终正常包 `ScryRemote.debug.dylib` SHA-256：`361dd6d75f4492c73596edb8838ceef5044c52825a947a0d3c26434604b1b012`。symbol 检查不存在 `BatchFDevice`；不会再默认进入 fixture。最终版本没有完整嵌入 Git build ID，以上 revision / version / hash 用于限定证据。日志 `/tmp/scry-f-followup-final-locked-build.log`，安装结果 `/tmp/scry-f-followup-final-locked-install.json`。
- 最终正常包**未自动启动或发送**。功能/帧率验收针对上述隔离状态、相同实验依赖图的 DEBUG fixture；不冒充最终正常包的真实已配对宿主/Provider 联通验收。没有执行 L3 日常样本或精确 GPU 呈现丢帧验收。默认 preferences 再次逐字节比较未变，真实 Keychain 不导出、不重置。
- 本地保留上述 `/tmp/scry-f-*` 证据、临时 fixture、构建产物及失败现场。App Documents 中保留本轮 `batch-f-preview.json`、`batch-f-stream.json`、`batch-f-selftest.log` 三个测试文件；无注入正常包不读取它们。Etch 未自动恢复；如需使用，由设备所有者按其原安装流程恢复。
- **审查方 / 原 iOS 契约维护者下一步**：处理或明确接受上列 3 项 self-test 与 5 项 UI 基线同样失败，再决定整体验收口径；不要把本轮“已运行且未新增失败”改写成“全绿”。如要宣称 L2 更快，由 F 执行方另做低负载、nominal 的成对复测。本轮只补证据，不更改 `STATUS.md`，不合并 main。

## 核验意见 · 真机补充（审查方，2026-10-22）

结论：**F 已核验**。目标是消除与流式输出无关的父层失效，这一点已在真机上证实；L2 提速没有证实，也不再要求。

- `82c5b33..1a7f152` 只新增 `apps/ios/Checks/` 的测量工具与文档，生产源码与上次核验一致。
- 真机 L1：`RootView` body 每轮 601→0；`ChatView`/`FocusedTurnView` 仍为 601，输出完整（600 行、hash 一致）。说明只删掉了无关重算，没有节流或丢输出。
- 功能：`-selfTest` 114/117、XCTest UI 26/31，基线与候选的失败项和错误文本完全相同，没有新增失败。8 项原有失败已记入 `perf/handoff` 的 STATUS「既有问题」，不归 F。
- L2：中位数 hitch 324→304、hitch ms/s 357→319，区间 +0.96%。只能算描述，不足以下结论。报告没有夸大。不再为 F 补低负载复测，理由见下一条：真正的瓶颈不在 F 的范围内。

**新发现，单独立项（F2，不在本分支做）。** 固定负载按 33 ms 调度 600 段，理论约 19.8 s，实测每轮 52–56 s；FPS 约 26，约 35% 的时间在 hitch。两边都一样，说明主线程处理每段追加约需 88 ms，跟不上输入。`ChatView` 和 `FocusedTurnView` 每段都重算 body，而输出合并成一个不断变长的 row，推测每次追加都要对全文重新排版，整体是 O(n²)。这是推测，需要 Time Profiler 的调用树来确认。

设备侧记录：经用户授权覆盖安装日常 `com.scry.remote.local`，并卸载了 Etch（可能丢失其本地数据）。最终已装回无注入的正常包，偏好文件逐字节不变。
