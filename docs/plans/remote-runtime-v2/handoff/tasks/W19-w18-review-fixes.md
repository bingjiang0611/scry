# W19 · W18 核验返修 + iPhone 真机验收

执行方：维护者本机的单个执行方。起点 `claude/scry-performance-optimization-46ngcf` 的 W18 最终提交 `9f874ca1` 及其后续提交。规则同 [README](../README.md) 与 [W18](W18-finish-s3-p4-p5.md) §0–§1：
- 阶段门、独立评审、可续跑、不放宽门限、只用临时数据；
- 不开 PR，不合并 main。

报告写 `reports/W19.md`，第一行写状态。

核验方在 Linux 上复跑了 W18：
- 类型检查、`--strict` 导入检查、`check:cli-runtime` 通过；
- 全量 vitest 只有既有的环境性失败和负载下的偶发失败。

两路独立评审**没有阻塞项**，下面是要返修的问题。每一项都先写失败测试再修，每项一个提交。

## A. 应修（合并 main 前必须完成）

**A1 · 大量历史首次升级时，侧栏变空**
- 位置：`src/daemon/orchestration-authority-startup.ts:66`、`src/host-runtime/orchestration/legacy-import.ts:321-329`、`:481`、`src/daemon/orchestration-catalog-access.ts:65,133`、`src/main/bootstrap/history-catalog.ts:24`。
- 现象：未导入的 run 超过 2,000 条时走延迟回填。`openOnly` 分支在 `importCatalogEntries` 之前就返回了，回填期间 projection 返回 `[]` 或部分列表，于是：
  - 旧会话从侧栏消失，打开时报「会话不属于当前 Scry catalog」；
  - 这期间删除的旧会话，没有行也没有墓碑，回填时会被 `ensureSessionForRun` 重新建出来。
- 修复：
  1. `openOnly` 路径在打开 `local.sock` 之前，先做只含元数据的 `importCatalogEntries`（这一步很便宜）。
  2. 或者在 `legacy_catalog_sha256` 与文件哈希一致之前，让 `read()`/`readDetail` 返回 `undefined`，回到读文件。
  3. 无论选哪种，延迟回填导入 run 时都要检查 `session.deleted` 墓碑。
- 测试：2,001 条以上未导入的 run 时，回填期间侧栏完整、旧会话能打开；回填期间删除的会话，回填后不会复活。

**A2 · 删除统一会话时 `scry.db` 不可用，返回的是 `partial_failure`**
- 位置：`src/main/bootstrap/conversation-delete.ts:104-108,127`。按设计应返回 `unavailable`（plan §10「删除会话」）。
- 修复：保留每个目标 receipt 的 `reason`；任何一个目标是 `unavailable` 时，整体返回 `unavailable`。

**A3 · `session.withdrawn` 进不了 `sessions` 视图，远程端的临时行一直不消失**
- 位置：`src/host-runtime/orchestration/subscribe-engine.ts:29-47`（`SESSION_VIEW_EVENTS` 漏了它）、`:69-71`、`:387`。
- 已复现：发现临时会话 → 取快照 → `session.withdraw` → `subscribe({views:['sessions','activeRuns'], known})` 返回 `{"mode":"idle","seq":2}`，事件被跳过。
- 修复：把 `session.withdrawn` 加进 `SESSION_VIEW_EVENTS`。
- 测试：remote scope 下，引擎返回 `events`，其中带 `sessionRow: null`；Desktop、iOS、本机 App pump 都能删掉这一行。

**A4 · iOS 收不到离线期间的 `hostNotice`（命令行批准或撤销设备）**
- 位置：`subscribe-engine.ts:321`（`fresh = !request.known` 时跳过缓存的提示）；iOS 冷启动不带 `known`（`TransportSubscriptionState.swift:131`）；`reportNotices` 和 `HostNoticeBanner` 只处理实时提示；iOS 不读 `catalogSnapshot.hostAdminNoticeItems`（Desktop 会读）。
- 违反的设计：P5-host-security §4.3「设备在下次读状态或长轮询时显示」。
- 修复（推荐前者）：
  - iOS 连接时读 `hostAdminNoticeItems`，按 id 去重，并持久化已看过的 id；
  - 或者宿主在 remote 状态快照里总是带上近期通知。
- 测试：Swift 单测；宿主侧也加测试。

**A5 · 已安装的旧版 iPhone 连 v3 宿主，看到的是原始错误码**
- 原因：升级提示文案在 `3d705db8` 才加（`apps/ios/ScryRemote/ExecutionTargetErrorPolicy.swift:10-13`）。旧版 iPhone 会直接显示 `protocol_upgrade_client` 或 `protocol_mismatch`。不卡死，但不符合 protocol §6 的「请更新 Scry」。
- 处理：
  1. 在 P4-plan 和发布说明里写明**发布顺序**：先给手机装含 `3d705db8` 的版本，再升级宿主到 v3。
  2. 真机上看一次旧版手机的实际画面，截图记录（见 C）。

**A6 · 转发的 `subscribe` 长轮询不随手机断线取消**
- 位置：`inner-mtls-dispatch.ts:105` 没有传 `connectionSignal`；`execution-targets.ts:146,164`、`desktop-client-session.ts:29-40` 也不接收 signal。每个订阅者一条 lane（`desktop-lane.ts:242`），一次只跑一个请求。
- 后果：手机断线重连后，新的 `waitMs:0` 快照要排在孤儿长轮询后面，最长等 20–25 s；被撤销的手机的孤儿轮询也会一直占着 Mac2 的 lane。
- 修复：把 `connAbort.signal` 一路传到 `dispatch` → `mobileRequest` → `requestForConnection`。
- 测试：断线后孤儿请求立刻取消，重连后的快照不用排队。

## B. 小问题（这次一并处理；不处理的写明理由）

1. **`subscriptionId` 挤掉别人的游标**：`subscribe-hub.ts:9,222-233` 全局最多 512 个游标、LRU 淘汰，已配对设备可以任意传 `subscriptionId`，连发约 513 次就能挤掉本机 App 的游标，导致重放旧提示。改为：
   - 按设备指纹分别设上限；
   - 本机 scope 的键永不淘汰；
   - 只有 desktop scope 的转发对端可以自带 `subscriptionId`。
   加测试。
2. **不可达的 v2 读取器**：`HostController.poll/runState/pendingQuestions`（`host-controller-surface.ts:123-136`）从网络已经调不到，但还有测试通过它们断言：`host-process-orchestration-r4-consistency.test.ts:207`、`host-controller-factory.test.ts:134,222,266-268`、`host-controller-intent.test.ts:17-37`、`relay-client.test.ts:238`。删掉这些读取器，把断言改到 `subscribe` 或 SQLite projection 上，断言强度不能降低。
3. **开关残留**：
   - `src/shared/background-service.ts:102,127`、`authority-engine.ts:55` 的旧注释；
   - 29 个测试文件里设置或恢复 `SCRY_ORCHESTRATION` 的死代码；
   - `sidebar-activity.mjs` 中「No explicit refresh」注释已经不对。
4. **轮询静态检查只查 5 个文件**：`protocol-v3-retirement.test.ts` 改成全仓检查：`LIVE_RUNS_TICK_MS` 不出现，renderer 远程读不用 `setInterval`；需要保留的已知例外列白名单。
5. **扫描发现的会话编号**：已经有 transcript 字节的 `session.discovered` 行，之后的 run 用 `ordinal_origin: since_import`（`projection.ts`、`orchestrator-handlers.ts:268-274`）。
6. **性质测试覆盖**：`projection-properties.test.ts` 的随机序列加入：
   - `session.import`
   - `session.delete`
   - 带 `attachNative`/`appRunId` 的 `run.session_bound`
   - `session.withdraw`
7. **原生门比较口径**：`scripts/native-composer-probe.mjs:119-127` 的 `sendToOutputReceiptMs` 在候选版取 renderer 标记和 trace 回调中较早的那个，基线版只有 trace，比较偏向候选版。改为门禁用 `sendToTraceOutputReceiptMs`，或要求两边来源一致。**不改门限数值。**
8. **边缘情况**：
   - `orchestration-run-transcript.ts`：文件系统报 birthtime 为 0 时，不应一律 `transcript_frontier_unavailable`。用其他身份字段判断，仍然保持 fail closed 的语义。
   - `git-capture.ts` 与 `git-compute.ts targetedPathspec`：嵌套的 `sub/.scry/` 在定向 diff 和全量 diff 里排除得不一致，统一起来。
9. **iOS 预览夹具里的模型名**：`apps/ios/ScryRemote/RunStore/RemoteRunStorePreview.swift:34-40` 改成中性占位名。
10. **Linux 可移植性**：`scripts/concurrent-performance-provider.test.ts` 在没有 `/usr/bin/time` 的 Linux 上报 `spawn /usr/bin/time ENOENT`。被测脚本要对缺少 `/usr/bin/time` 给出明确处理（降级或清楚的错误），测试按平台条件断言，不要静默跳过。

## C. iPhone 与 mac2/mac3 真机验收（合并 main 前必须完成，需要维护者配合）

W18 跳过了这一部分。做到这里时，停下来告诉维护者具体要做什么、看什么，每一项都截图或录屏，存进证据目录。

1. **旧版手机**：用当前已安装的旧版 iPhone 连 v3 宿主，记录实际画面（对应 A5）。
2. **新版手机**：装本分支构建的 iPhone 版，逐项验证：
   - 实时更新（运行开始、输出、结束）；
   - 会话列表分页；
   - 断网后重连（含 A6：重连后快照没有被卡住）；
   - 临时会话撤回后从列表消失（A3）；
   - 手机 App 杀掉期间，Mac 上执行 `scry-host approve` 或撤销设备，重开 App 后能看到通知（A4）。
3. **转发**：如果 维护者的 mac2 和 mac3已经按维护者之前的配置就绪，先把它们升级到本分支，再从手机经本机转发访问它们，验证订阅与实时更新；没有就绪就记为未验证，并写明原因。
4. 回归：手机上发一轮对话、回答一个权限提问、停止一次运行。

## 阶段门

- `npm run typecheck`
- `--strict` 导入检查
- 全量 vitest
- `check:cli-runtime`
- iOS 单测与构建
- 冒烟全套：开发和打包两种布局，含 CI 的三个 UI 分片
- 原生性能门一轮（B7 改口径之后）
- 以上门限一律不变

报告按 README §3 写；全部完成后，第一行改为 `状态：待核验` 并推送，然后告诉维护者：
- 最终 SHA
- 真机结果
- 未验证项
