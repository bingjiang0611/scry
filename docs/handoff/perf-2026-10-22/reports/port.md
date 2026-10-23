# 移植验证报告：perf/port-2026-10-23

## 结论

移植结果 `fdfb0eb` 第一次跑 7 个桌面 gate 时，只有 `npm test` 失败：1 个 unit 断言失败。原因是移植时合并了 IPC method 列表，但测试里的数量断言没有同步。

修复在独立提交 `815c0e8` 中，只改了这一个测试断言。修复后 `npm test` 全部通过。其余 6 个 gate 都是首次通过。远程会话的手工合并路径通过了全部 UI 冒烟测试，其中包括 `--unknown-receipt-only` 和它的负向对照。

iOS 只完成了一部分：

- `new-task-readiness.py` 通过。
- `xcodebuild build-for-testing` 无法运行：本机没有安装完整 Xcode。
- `markdown-blocks.py` 和 `catalog-refresh.py` 编译成功，但编译出的可执行文件被本机执行策略用 SIGKILL 终止。一个最小的 Swift hello world 同样被终止，所以这是环境问题，不能归因到移植。

本分支未合入 main，未安装 App。

## 身份与基线

| 项 | 结果 |
|---|---|
| fetch 后的引用 | `origin/perf/port-2026-10-23` = `fdfb0eb`，`origin/main` = `b358dcb` |
| `origin/main` 是 HEAD 的祖先 | 是 |
| worktree `git config user.email` | `307659028+bingjiang0611@users.noreply.github.com` |
| `origin/main..HEAD` 所有 author / committer | 只有 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`；没有出现旧地址 |
| 新提交 `815c0e8` | author 和 committer 与上一行相同 |
| 依赖 | 与旧 integration 的 `package-lock.json` 相比，忽略 `resolved` URL 后，只有根包 `version` 不同（0.2.219 → 0.2.221），没有依赖版本差异，所以复用了同一锁版本的 `node_modules` |
| 环境 | macOS 26.3.2 arm64，Node 24.18.0，App 0.2.221；只有 Command Line Tools（Swift 6.3.3），没有 Xcode.app |

工作目录：`/Users/test/vibecoding/scry-perf-port-2026-10-23`。这个 worktree 基于 `origin/perf/port-2026-10-23` 新建，没有从任何旧分支派生。

## 桌面 gate

| 检查 | 版本 | 首次结果 | 证据 |
|---|---|---|---|
| `npm run typecheck` | `fdfb0eb` | 通过，14 s。在 `815c0e8` 上再次运行也通过 | `/tmp/scry-port/typecheck-first.log` |
| `npm test` | `fdfb0eb` | **失败**，276 s：1 failed / 3800 passed / 4 skipped（4 个是 opt-in 探针） | `/tmp/scry-port/test-first.log` |
| `npm test`（修复后） | `815c0e8` | 通过：308 个文件，**3801 pass / 4 skipped**；shell `PASS setup-scry-workspace` | `/tmp/scry-port/test-after-fix.log` |
| `npm run build` | `fdfb0eb` | 通过 | `/tmp/scry-port/build-first.log` |
| `npm run check:cli-release` | `fdfb0eb` | 通过，92 s：CLI 合同 32 个文件 / 627 pass；CLI 包冒烟 `scry-turn-recorder` 0.2.51 正常 | `/tmp/scry-port/check:cli-release-first.log` |
| `npm run test:renderer:ui` | `815c0e8` | **整条首次通过**，232 s，开始时 load 4.93 | `/tmp/scry-port/test:renderer:ui-first.log` |
| `npm run test:desktop-remote` | `815c0e8` | 首次通过，120 s | `/tmp/scry-port/test:desktop-remote-first.log` |
| `npm run performance:measure -- --compare origin/main` | `815c0e8` 对比 `b358dcb` | 通过，`Ratchet: passed`；通过 timing lock 运行，`highLoad: false` | `/tmp/scry-port/performance-measure-first.log`、`/tmp/scry-port/performance/measure.json` |

`815c0e8` 相对 `fdfb0eb` 只改了一个测试文件。因此 typecheck、build 和 `check:cli-release` 在 `fdfb0eb` 上的结果同样适用于运行代码。

UI gate 使用 Electron ABI 的 `better-sqlite3`，与 CI 中 `electron-builder install-app-deps` 的做法一致。gate 结束后已恢复 Node ABI，并重新加载验证通过。

### 首次失败与修复

```
FAIL src/main/remote/desktop-client-ipc.test.ts
  > rejects foreign sender/frame/origin before resolving the privileged client
AssertionError: expected 29 to be 28
```

- **原因**：两边各自加了一个 method，移植时 `METHODS` 取了两边的并集。
  - main 加了 `resolveIntent`，main 自己的断言是 28。
  - E 加了 `traceDelta`，E 分支上的断言也是 28。
  - 并集后实际有 29 个不重复的 method，但断言仍是 28。这是移植合并造成的，不是产品回归。
- **修复**：`815c0e8 test: count merged desktop remote IPC methods`，把 `28` 改为 `29`。
  - 没有删除或放宽其他断言。
  - 同一个测试仍断言 `traceDelta` 存在，仍断言 foreign sender 被拒绝前不会解析特权 client，并断言 `resolveIntent` 正常调用。
  - `src/preload/index.test.ts` 的 channel 表也同时包含这两个 method，与实现一致。
- **验证**：
  - focused 测试：`npm run test:unit -- src/main/remote/desktop-client-ipc.test.ts src/preload/index.test.ts` 通过，2 个文件 / 10 个测试。
  - 完整 `npm test` 通过。
  - 未修复的 `fdfb0eb` 首轮就是失败对照。

### 远程会话（手工合并部分）

`RemoteChat.tsx`、`desktop-client-ipc.ts` 和 `desktop-remote-ui-smoke.mjs` 中的手工合并，都由真实 Electron UI 冒烟测试覆盖：

| 路径 | 结果 |
|---|---|
| `--unknown-receipt-only`（received-active） | `crossProjectNotice`、`draftAndImagePreserved`、`explicitOriginalIdRecovery`、`noReplayOrStop`、`failedRecoveryActionable` 都为 true |
| `--unknown-receipt-only --negative-unknown-receipt-control`（old-host-unavailable） | 上述字段都为 true，outcome 为 `old-host-unavailable`，阶段退出 0 |
| `test:remote-queue-ui` | `unknownBarrier`、`manualStopKeepsUncertain`、`queueEditing` 都为 true |
| 主 `desktop-remote-ui-smoke.mjs` | `dispatchNoticeLifecycle.unknown`、`pollErrorRecovery`、`canonicalScryRunTrace`、`staleReadNotLive` 等都为 true；calls：history 12、traces 6、submits 3、stops 1、answers 1 |
| parity / composer-history / remote-settings / session-lifecycle / host smoke | 都通过 |

代码审读（只是阅读，不是额外测试）：

- `sendBlockedReason` 的顺序是：unknown receipt 最优先，然后是 catalog 或 poll 错误，然后是刷新中或证据不新鲜，最后才是其他原因。
- `unknownIntent` 沿用 main 的写法：`intents.find(status === 'unknown')`，不做 context 过滤。
- 这两点与 STATUS 记录的合并决策一致。

### 性能

与 `origin/main` 相比：

- 43/43 个指标都测到了。
- 只有 `files.fixed-operations/io.read.bytes` 有变化：1227182 → 1227199（+17）。
- 在同一 candidate 上单独重跑这个场景两次，分别得到 1227201 和 1227191。同一版本的运行间波动约 ±10 bytes，所以 +17 属于噪声量级，不归因到移植。

Ratchet：

- 2 个 gating 指标都通过：`source-control.diff/subprocess.git` 8 ≤ 8，`source-control.service.status-diff/subprocess.git` 11 ≤ 11。
- candidate 指标：4 better、4 worse、3 missing（`cpu.instructions` 不可用）。
- 与旧 integration 的结果逐行比较，只有 `io.read.bytes` 的值不同，各行的分类完全一致。所以 worse 和 missing 来自现有 ratchet 基线，不是本次移植引入的。
- 本次没有修改 `scripts/performance-ratchet.json`。

## iOS

| 检查 | 首次结果 | 判断 |
|---|---|---|
| `xcodebuild … -destination 'generic/platform=iOS' build-for-testing CODE_SIGNING_ALLOWED=NO` | exit 1：`tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance` | **受阻**：本机没有 Xcode.app，iOS 编译未验证 |
| `python3 apps/ios/Checks/new-task-readiness.py` | 7/7 通过，与 F 报告的基线一致 | 通过 |
| `python3 apps/ios/Checks/markdown-blocks.py` | `swiftc` 编译成功；运行时可执行文件收到 SIGKILL，exit 1 | **环境受阻**，见下 |
| `python3 apps/ios/Checks/catalog-refresh.py` | `swift build` 和 `swiftc` 编译、ad-hoc 签名、`codesign --verify --strict` 都成功；运行时 SIGKILL，exit 247 | **环境受阻**；无法与已知基线（142/146，4 项既有失败）比较 |

日志：`/tmp/scry-port/ios-*.log`、`/tmp/scry-port/ios.status`。

**SIGKILL 的证据**：

- 一个与仓库无关的 Swift `print("hello")`，用 `xcrun swiftc` 编译后运行，同样 exit 137。
- 在 `$HOME` 下编译、重新做 ad-hoc 签名后，仍然 exit 137。
- 内核日志显示 `AMFI: … has no CMS blob? … Unrecoverable CT signature issue`。
- 同一环境下，clang 编译的 C 程序可以正常运行。
- 本机没有可用的 codesigning identity（`0 valid identities found`），所以无法使用 runner 支持的 `SCRY_IOS_CHECK_SIGN_IDENTITY`。
- 没有修改任何系统安全策略。
- `docs/ios-execution-targets.md` 和 F 报告都记录过同类的本机执行策略终止。

**补充证据（不替代原 runner）**：

- 按 `markdown-blocks.py` 的方式拼出同一个生产源码程序（从 `Components.swift` 提取，加上 `markdown-blocks.swift`）。
- 用解释器 `xcrun swift -Xfrontend -parse-as-library` 执行：17/17 通过，与 F2 报告的 17/17 一致。日志：`/tmp/scry-port/ios-markdown-blocks-interpreter.log`。
- `catalog-refresh` 需要链接 SwiftPM 产出的目标文件，不能这样执行，所以没有补充证据。

**移植风险**：

- 移植后，`ToolPanels.swift`、`RemoteRunStore.swift`、`ArchivedSessionsView.swift`、`HomeDrawer.swift` 是 main 的 iOS 修改与 F/F2 的自动合并结果，没有文本冲突。
- `catalog-refresh.py` 用 macOS SDK 编译了 `RemoteRunStore`、`AppModel` 等非 UI 源码，编译通过。
- SwiftUI/UIKit 视图文件（如 `ToolPanels.swift`、`HomeDrawer.swift`、`ArchivedSessionsView.swift`）在本机没有任何编译证据。

## 未验证

- iOS `build-for-testing`：需要在装有 Xcode 的机器上运行本报告中的命令。
- `catalog-refresh.py` 的逐项结果：需要一台允许运行本地 ad-hoc 签名 Swift 可执行文件的机器，或者一个可用的本地开发签名 identity。然后与 142/146 的基线逐项比较。
- 真机、L2/L3 毫秒、A1/B2 重放：本次没有在移植版本上重做。A1 和 B2 只在旧 integration 上通过；在移植版本上仍未验证。

## 核验意见（审查方，2026-10-23）

**桌面端已核验；iOS 编译仍待完成。**

- `815c0e8` 只把 `desktop-client-ipc.test.ts` 的方法数断言从 28 改为 29：main 加了 `resolveIntent`，E 加了 `traceDelta`，移植时 `METHODS` 取了并集，29 是正确的数。同一测试里对 `traceDelta`、`resolveIntent` 和外来 sender 拒绝的断言都保留，依据写得清楚，修复正确。
- 7 个桌面 gate 通过；手工合并的远程会话路径由真实 Electron 冒烟覆盖，包括 `--unknown-receipt-only` 及其负对照。`sendBlockedReason` 的优先级和 `unknownIntent` 的写法与移植记录一致。
- 性能计数与旧整合结果逐行一致，`io.read.bytes` +17 在同版本重跑的波动范围内。
- 身份：`origin/main..HEAD` 的 74 个提交，作者和提交者全部是 noreply 地址。

**合入 main 前还差一步**：在有 Xcode 的机器上运行 `xcodebuild build-for-testing`，并跑完 `catalog-refresh.py`。main 的 iOS 改动与 F/F2 在 `ToolPanels.swift`、`HomeDrawer.swift`、`ArchivedSessionsView.swift`、`RemoteRunStore.swift` 上是自动合并的，其中 SwiftUI 视图文件目前没有任何编译证据。A1/B2 的重放没在移植版本上重做：相关源码除 `index.ts` 外都没和 main 冲突，`index.ts` 是自动合并且桌面 gate 通过，所以不强制要求。

## iOS 补充验证（Xcode 机器，2026-10-23）

本节补齐上次核验意见要求的 iOS 编译与逐项运行证据，保留前面不同机器上的首次失败/受阻记录。验证源码为 `perf/port-2026-10-23` 的 `75c5183d1a905f45d1339f7196d98665c941f3ed`；工作区起始干净，`git config user.email` 已确认是 `307659028+bingjiang0611@users.noreply.github.com`。未检出或推送停用的旧分支。

环境：arm64 macOS 27.2（26B5112a）、Xcode 26.6（17F113）、Swift 6.3.3；App 当前按 Swift 5 language mode 编译。按要求串行执行原命令，没有修改 runner、断言、超时或签名策略：

```sh
xcodebuild -project apps/ios/ScryRemote.xcodeproj -scheme ScryRemote -configuration Debug -destination 'generic/platform=iOS' build-for-testing CODE_SIGNING_ALLOWED=NO
python3 apps/ios/Checks/catalog-refresh.py
python3 apps/ios/Checks/markdown-blocks.py
```

| 检查 | 本机首次执行结果 | 判断 / 证据 |
|---|---|---|
| iOS `build-for-testing` | exit 0，`TEST BUILD SUCCEEDED` | App 与 XCTest UI target 均编译通过；日志 `/tmp/scry-port-ios-build-first.log` |
| Catalog | exit 1，146 项中 142 PASS、4 FAIL | 与 F 的已知基线逐项完全一致，没有新增失败；日志 `/tmp/scry-port-ios-catalog-first.log` |
| Markdown | exit 0，17/17 | 原 runner 编译并执行成功，不是解释器替代；日志 `/tmp/scry-port-ios-markdown-first.log` |

### Catalog 逐项比较

读取 `/tmp/scry-f-catalog-control.log`（F 旧实现基线）与 `/tmp/scry-f-catalog.log`（F 候选）保存的原始结果，按**完整行**提取名称与状态，保留 `catalog.catalog.discoveryDiagnostic.1006 fixture-close` 名称中的空格。当前结果与两份记录的全部 **146 项名称、顺序和 PASS/FAIL 都相同，差异为 0**，不是仅比较总数或失败数量。对比记录 `/tmp/scry-port-ios-catalog-comparison.json`。

四项仍失败，未改成通过，也没有删除或跳过断言：

1. `catalog.followUp.routingDoesNotResumeAnotherProfile`
2. `catalog.recovery.explicitModelChoice`
3. `catalog.model.explicitAutoIsRemembered`
4. `catalog.model.catalogRecoveryRestoresReadiness`

146 项有序 `{name,result}` 列表用 `json.dumps(checks, sort_keys=True, separators=(',', ':'))` 序列化后的 SHA-256：`847583bdb96288c4ccc621201b69aaf39ec44257c46ca1e976fdb7fc307196ef`。因此本轮结论是**维持已知基线**，不是 Catalog 全绿。

### 四个自动合并文件复核

核对 main 合并基点 `b358dcb7336c990866a245a8b3a2d3075df61379` 到被测版本的完整文件差异；再机械归一化预期 Observation 迁移，与当前文件全文比较，四个文件均完全一致：

| 文件 | 合并后相对 main 的差异 | 本轮证据 |
|---|---|---|
| `ToolPanels.swift` | run/targets 改为 typed `@Environment`；AppModel 仍为 `@EnvironmentObject` | 无额外业务差异；编译日志第 12276 行有本文件 `SwiftCompile normal arm64` |
| `HomeDrawer.swift` | 同上 | 无额外业务差异；编译日志第 12405 行 |
| `ArchivedSessionsView.swift` | run 改为 typed `@Environment`；SessionActionCenter 保留 `@StateObject` | 无额外业务差异；编译日志第 12413 行 |
| `RemoteRunStore.swift` | `Combine`/`ObservableObject`/`@Published` 改为 `Observation`/`@Observable`/普通属性，保留 `@MainActor` | 去除这些预期注解差异后与 main 全文相同，未丢失 main 的字段或业务方法；编译日志第 12310 行及 Catalog 运行 |

编译日志有 20 条 warning、0 条 error，其中 `RemoteRunStore.swift:1147` 有捕获 `self` 的 Swift 6 并发兼容提示；当前 Swift 5 模式构建成功。本轮未做无关的警告清理，也未声称验证了 Swift 6 language mode。上述归一化是静态合并证据，不替代真实 UI 交互验收。

### 范围与交付

- 未发现编译失败或新增测试失败，因此**没有生产源码修复，也无需单独的修复提交**；本轮仅补充报告。
- 按要求未使用真机或模拟器，未执行 XCTest UI 交互、未安装 App；`build-for-testing` 只证明编译。未补做 L2/L3、真实 Provider 或 A1/B2 重放，不复述为本轮通过。
- 本次命令未改变依赖锁文件，未修改 `STATUS.md`、源码或测试。只提交本节并推送到 `perf/port-2026-10-23`，不合并 main、不向停用的旧 `perf/*` / `fix/*` 分支推送。
