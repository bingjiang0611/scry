# 批次 B 执行报告

执行分支：`perf/handoff`。按用户指示在 A1 修正（`e5b9236`）push 后直接开始，不等 A1 核验。审查方随后已在 `aa61d68` 将 A1 标为已核验。未合入 main、未开 PR、未安装日常 App。结果交审查方核验，不自行标「已核验」。

## 结论与提交

| 条目 | 结果 | 测量提交 | 优化提交 |
|---|---|---|---|
| B1 #4 | 提交时归档读取全部异步；disabled 路径重复读取删除；managed 锁内读取为避免 TOCTOU 保留 | `25fca06`、`91da1cd` | `582c812` |
| B2 #3 | 首屏不再等待归档发现；恢复只扫 Qoder 子树、后台执行、有新会话时通知刷新；索引改异步发布；删除不再同步重建索引 | `629a44e`、`97aaf4d` | `541d076`、`87fc287` |

本报告的哈希是 rebase 到审查方 `aa61d68` 之后的哈希。测试与测量在 rebase 前的同内容提交上执行；`src`、`scripts`、`package.json` 与 rebase 后完全一致（`git diff --quiet` 已确认）。日志和 measure.json 里出现的旧哈希对应关系：`a19e9e9`→`25fca06`、`ad75cb1`→`91da1cd`、`d0a4490`→`582c812`、`0ee82a0`→`629a44e`、`21c7902`→`97aaf4d`、`fc51e3e`→`541d076`、`69cfe54`→`87fc287`。

详细实验：[B1](../../../performance-experiments/20261022-b1-archive-reads.md)、[B2](../../../performance-experiments/20261022-b2-catalog-discovery.md)。

## 前后测量（全部为 L1）

环境：macOS / arm64，Node `v24.18.0`，Electron `42.10.1`，8 个逻辑 CPU，2026-10-23 本地时间；load1 约 2.5–12。没有 L2 毫秒数据，也没有 L3 日常样本。

| 受控工作量 | 基线 | 最终结果 | 减少的工作去了哪里 |
|---|---|---|---|
| B1：500 轮 legacy 归档（167,740 bytes），managed summary 提交 | legacy 读 2 次 / 335,480 bytes；同步 read+lstat 4 | 2 次 / 335,480 bytes；同步 0 | 读取量不变，从主线程同步 I/O 移到异步。锁内读取保留（见红线）。 |
| B1：managed full 提交 / 无 progress / 非 managed 恢复 | 1 / 2 / 1 次；同步 2 / 4 / 2 | 读取次数不变；同步 0 | 同上 |
| B1：recorder disabled 提交 | 2 次 / 335,480 bytes；同步 4 | 1 次 / 167,740 bytes；同步 0 | 锁外的保护步骤与 disabled 分支复用同一次读取 |
| B2：dirty 索引、5 Provider × 10 会话 × 4 轮（200 文件，Qoder 40） | 启动发现读 200 文件 / 91,320 bytes / 200 次 parse；同步发布索引 1 次 | 读 40 / 18,200 bytes / 40 次 parse；异步发布 1 次 | 其他 Provider 的 160 个文件不再读取；Qoder 的 40 个仍读取，但在首屏之后 |
| B2：首次 `listProjects` 返回前 await 的发现工作 | 上一行全部 | 0 | 由代码结构证明（`void recoverTraceCatalogOnce()`），不是计数器读数 |

复现命令：

```bash
npx vitest run src/main/managed-turn-archive-reads.measurement.test.ts
npx vitest run src/main/trace-catalog-discovery.measurement.test.ts
```

## 红线检查与实现边界

- **B1**：`existingTurnDisposition` 的判定与输入未改；`mergeArchives` 未改，精确文件无效时仍忽略、不回退旧副本；锁顺序未改，未新增锁。B.md 要求“读一次并传给三处”，但 `archiveJournal` 在锁内、`protectManagedInput` 在锁外，复用会产生 TOCTOU，所以 managed 路径在锁内仍单独读一次（B.md 明确允许正确性优先）。同步 `readArchiveFile` 删除，`findTraceArchiveTurnMatches` 只保留异步实现。
- **B2 方案**：选方案 2（缩小范围 + 移出首屏），未做增量索引。理由：catalog 唯一生产用途是 Qoder 补缺，方案 2 不新增持久化格式就能消除首屏等待。限制：任何 Provider 写轮次都会把索引标 dirty，活跃用户的下次启动仍会在后台重扫 Qoder 子树。触发升级的条件：Qoder 归档变大，后台重扫造成可观察的负载。升级路径：方案 1。
- **B2 dirty 语义**：保留。限定 Provider 的索引带 `providers` 字段，只回答同一范围的请求；全 Provider 请求不信任它，会重扫。删除会话时先标 dirty（原有），不再同步重建，由下次发现重建。
- **B2 并发写**：`traceArchiveCatalogWriteGeneration` 保留。扫描后复核一次（原有）。异步发布后，在同一同步步骤内再复核一次，然后才 `unlinkSync` dirty 标记。若发布期间有新写入，保留 dirty 并删除刚发布的索引。这里不用异步 unlink，因为它可能删掉一个新写入依赖的标记。
- **B2 异步写**：启动发现改用 `writeOwnedFileAtomicallyAsync`。同步 `writeTraceArchiveCatalogIndex`、同步 scan/parse/rebuild 与只剩测试调用的 `discoverTraceArchiveSessions` 已删除，生产代码中不再有同步写索引。
- **B2 不复活归档**：恢复仍只记录 catalog 已知 cwd 的 Qoder 会话（`trace-catalog-recovery.ts`），有回归覆盖。
- **B2 刷新时机**：恢复记录了新会话时发送 `agent:dataUpdated { kind: 'catalog_recovered' }`，renderer 的 `shouldReloadProjectsForDataUpdate` 对此返回 true。恢复失败只记 warn，下次启动按 dirty 索引重试。

## 修改的既有测试断言及依据

- `transcript-archive.test.ts`：`原子增量索引损坏或 segment 身份变化时从 canonical 文件重建` 从同步 `discoverTraceArchiveSessions` 改用生产异步 API。期望值不变。依据：同步 API 已无生产调用方并被删除（与 B.md 对 B1 的“不留 sync/async 双实现”一致）。
- `render.test.tsx`：catalog 刷新策略用例新增 `catalog_recovered → true`。原有断言未改。

其余均为新增测试，见实验文档「回归」节。

## 验证

| 检查 | 结果 | 证据 / 命令 |
|---|---|---|
| 类型、全量测试、构建、CLI 发布检查 | 通过 | 最终源码 `87fc287`：`npm run typecheck && npm test && npm run build && npm run check:cli-release`，日志 `/tmp/scry-b-final-gate.log`。unit 306 files / 3749 tests 通过，4 files / 4 tests skipped（默认关闭的 performance-correlation、billing-admin-real、P0、P1）；`test:shell` PASS；CLI 32 files / 624 tests 通过，`smoke:cli-package` 正常 |
| diff 检查 | 通过 | `git diff --check facca08 HEAD` exit 0 |
| `pack:artifact` | 通过（第二次） | `87fc287`，`/tmp/scry-b-pack-final2.log`，含 packaged Electron security / files / remote host smoke。第一次失败见下节 |
| conversation IPC | 通过（第二次） | `87fc287`，`npm run test:conversation:ipc`，`/tmp/scry-b-convipc-final2.log`。第一次失败见下节 |
| 持续性能门禁 | 43/43 measured，ratchet 通过，无 `worse` | `npm run performance:measure -- --compare facca08 --out /tmp/scry-batch-b-performance-final`（candidate `87fc287-dirty`，dirty 仅为实验文档）。唯一变化 `files.fixed-operations/io.read.bytes` −19。`97aaf4d` 时曾为 +12；同源 `97aaf4d` 对比为 −5，说明是 fixture 噪声，不计为收益或回归 |
| 完整 renderer UI 入口 | **未全绿**：仍是既有 chat-preview workspace dirty 失败 | `97aaf4d`，timing lock 下运行 `npm run test:renderer:ui`，`/tmp/scry-b-renderer.log`，load 4→3.3。失败信息与批次 A 在 `bf92d04` 上的基线一致。该 fixture 修复在 `fix/chat-preview-workspace-dirty`（`052ea92`，审查方已核验），尚未合入本分支 |
| 被截断的余下 UI / IPC | 完整命令链 exit 0 | `97aaf4d`，timing lock 下原样执行 A 报告列出的同一命令链，`/tmp/scry-b-renderer-remaining.log`（结束时 load 12.16，`highLoad: true`，只用作通过/失败证据，不用作毫秒） |

`87fc287` 只改主进程的删除路径与删除测试。在它上面重跑了与删除相关的 conversation IPC 和 packaged smoke，没有重跑完整 renderer UI 入口。

### 已验证的反例

| 改法 | 失败的测试 |
|---|---|
| disabled 分支“只复用、不回退读取” | `disabled direct commit still reads the archive when progress pins the policy` |
| 发布后的 generation 复核改为恒真 | `does not trust an index published while a new turn was written` |
| 未限定的请求接受限定索引（最终源码上把 `!providers ||` 改为 `providers &&`） | `scopes startup discovery to requested Providers ...` |
| 删除仍同步重建（`541d076` 源码） | `session deletion leaves the catalog dirty ...` |

### 首次失败与处理（不以重跑抹掉）

- **`pack:artifact` 与 `test:conversation:ipc` 第一次失败**（`/tmp/scry-b-pack-final.log`、`/tmp/scry-b-convipc-final.log`）。断言是 SQLite stats `unavailable`，预期 `ready`；日志显示 `better_sqlite3.node` 为 NODE_MODULE_VERSION 137，而 Electron 需要 146。
  - 原因在测试环境。我第一次 pack 时，@electron/rebuild 写入 `.forge-meta`（`arm64--146`）。之后我为 Node 单测换回 Node 版二进制，`.forge-meta` 没跟着删。第二次 pack 读到这个 meta，以为已为 Electron 编译，跳过了 rebuild。
  - 处理：删除自己产生的 `.forge-meta`，让 pack 正常 rebuild 后两项都通过。没有改代码、测试或门槛。
- 交付前已把 Node 版二进制换回（sha256 `c6fac315…` 与备份 `/tmp/scry-batch-a-node-sqlite.node` 一致），并删除本次 pack 产生的 `.forge-meta`，这样下次 pack 会重新 rebuild。

## 未验证项与交付状态

- 没有 L2 冷启动毫秒数据，也没有真实大 userData 的启动对比；不宣称用户可感知的启动或提交提速。
- `catalog_recovered` 的端到端刷新（后台恢复后侧栏出现新会话）只有纯函数和主进程单测覆盖，没有在 Electron fixture 中重放。要验证，需要构造“catalog 缺 Qoder 会话 + dirty 索引”的 userData，启动后观察侧栏。
- 本分支的完整 renderer UI 入口仍会在 chat-preview workspace dirty 处失败，因为 fixture 修复 `052ea92` 在 `fix/chat-preview-workspace-dirty`，尚未合入。合入后可重跑 `npm run test:renderer:ui` 一次确认完整入口通过；是否合入由维护者决定。
- 未驱动真实 Provider；未安装到 `/Applications/Scry.app`；日常 App 未被停止或替换。
- `dist/` 中留有 packaged 测试产物（已 gitignore）。日志与 raw performance JSON 保留在上列 `/tmp/scry-*` 路径。没有后台进程。
- B1/B2 状态为「待核验」。负责人：审查方，按 README 检查本报告与反例后标记。

## 核验意见（审查方，2026-10-23）

结论：**B1、B2 已核验**。审查方未在本会话重跑测试（网络策略拒绝 npm registry），依据是逐行读 `582c812`、`541d076`、`87fc287` 的 diff 和本报告的命令记录。rebase 后 `aa61d68` 是本分支祖先，A1 修正未被改动。

**B1**
- `protectManagedInput` 的策略取值顺序仍是 journal → progress → archive → open → input，只有前两者都没有时才读归档，与原 `??` 链的惰性求值一致。
- disabled 分支复用锁外那次读取：原实现两次读取也都在锁外，复用不改变一致性；managed 路径在锁内单独再读一次，避免 TOCTOU，取舍正确。
- `findTraceArchiveTurnMatches` 并行读 legacy 与精确文件，`mergeArchives` 及“精确文件无效不回退”的语义不变；同步孪生已删除。

**B2**
- 选方案 2（缩小到 Qoder 子树、移出首屏）合理，限制和升级条件写清楚了。
- 限定 Provider 的索引只回答范围内的请求，全量请求不会误用它；反例测试覆盖了这一点。
- 异步发布后，在同一同步步骤里复核写入代数，再决定删 dirty 标记还是删刚发布的索引；在发布期间发生并发写入时，下次会重扫，不会信任过期索引。
- 后台恢复不会复活刚删除的会话：恢复开始时先取一份目录快照，已在目录里的会话会被跳过；只有目录里本来缺失的 Qoder 会话才会被补录。

**非阻塞**
- `parseTraceArchiveCatalogIndexAsync` 开头仍有一处 `existsSync`（原有代码），开销极小，可在以后顺手改掉。
- `catalog_recovered` 的端到端刷新只有单测覆盖，整合时可在 Electron fixture 中补一次重放。
