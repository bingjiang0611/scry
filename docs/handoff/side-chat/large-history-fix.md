# 侧聊大历史修复：状态与证据

分支 `scry/88d17fe3`，起点 `d824c609`。Node 一律 `export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"` 后执行。

## 用户可见问题

创建侧聊报 `Error invoking remote method 'conversation:previewSideChat': Error: 迁移归档超过 16 MiB 读取预算`。

链：`bootstrap/conversation.ts:251` → `conversation-side-chat.ts:previewSideChat` → `conversation-side-chat-source.ts:captureNativePrefix` → `transcript-archive.ts:readTraceArchiveForMigration`（主归档 + 各分片字节求和 >16 MiB 抛普通 `Error`，预览的“缩小前缀”只认 `SideChatBudgetRefusal`，所以冒泡成“没有创建侧边会话”）。

真实规模（只读统计）：503 MB/128 轮、195 MB/**9 轮**；单轮文件 195,679,614 / 39,622,695 / 36,543,774 / 26,945,199 B。

## 现在的链路

侧聊预览、创建、首次发送、后续发送、查看器、遗漏检索都不再有“整份历史”或“单条大正文”的隐藏预算。逐段说明（按调用链）：

1. **归档来源读取**：`transcript-archive-capture.ts:iterateTraceArchiveCapture` 用 `stream-json` 逐 token 投影（`trace-archive-projection.ts`），只保留结构与可见正文，正文进 `TextSpool`。195 MiB 单轮工具 payload 结构上跳过，从不成为字符串。
2. **对话来源读取**：`conversation-side-chat-capture-stream.ts:capturedConversationMessages` 用 `streamTraceArchiveTurn` 逐个轮次文件流式投影，并把每条正文对父会话记录的 `items` hash 逐条校验；不再调用 `readTraceArchiveTurnForHistory`（整文件读 + 共享 16 MiB/4 MiB 预算）。工具 payload 不进快照，单条 >4 MiB 可见正文直接流入清单。
3. **无归档原生来源**：Claude transcript 由 `jsonl-record-scanner.ts`（tokenizer 驱动）+ `claude-jsonl-projector.ts` + `conversation-side-chat-native-stream.ts` 逐记录投影：1 MiB 分块 → 流式 `TextDecoder` → **已安装的 `stream-json` tokenizer**（`parser.asStream({jsonStreaming:true, packStrings:false, packNumbers:false})`，与 `trace-archive-projection.ts` 同一套词法层）。本模块不再持有自己的 JSON 词法/结构状态机，只按 key path 投影侧聊要用的字段（`type`/`isMeta`/`isCompactSummary`/Provider turn id/`message.stop_reason`/`message.content` 与 block 的 `type`/`text`/`origin.kind`），其余值逐 token 丢弃、从不成为 JSON 值或字符串，因此单行 195 MiB 的工具结果不再被 `JSON.parse`。未知或任意长的 key 只是匹配不到已知字段而被跳过，不是长度拒绝。
   解析失败的归类比 tokenizer 的措辞更可靠：**记录结尾是写作者写的换行**。文件最后一个字节是换行，说明那一行已写完而是完整坏记录 → fail closed；最后一个字节不是换行，说明那里仍在写入，该行尚不构成证据 → 丢弃未完成贴尾、保留已完成前缀。5 种非法写法（缺逗号、缺冒号、尾逗号、非法数字、未加引号的 key）与重复 key 记录在测试里直接和 `JSON.parse` 的结果对照，读取方不能有和 JSON parser 不同的意见（重复 key 取最后一个，与 `JSON.parse` 一致）。
   可见正文进 `TextSpool`（>256 KiB 落私有临时文件）；tokenizer 的长字符串按 ≤256 字符切分，投影侧按 64 KiB 批量落盘，22 MiB 单一正文从超时降到 1.6 s。贴尾未完成记录不算证据也不阻塞已完成前缀。前缀权威是“解析时对读到的字节累计 sha256，读完对同一区间重读比对”（单遍读取多一次区间读＋哈希，属证据成本）；inode/dev/size 只判“被替换/截断”，追加不影响已读前缀。转录头部自己的 `sessionId`/`cwd` 必须与目录身份一致（有界自证），不再需要 `resolveTranscriptPath` 的整文件 identity 检查。Pi 走同一套 tokenizer 的**两遍**读取（`pi-native-stream.ts`+`pi-jsonl-projector.ts`）：第一遍只读结构，验证 header 身份（`type`/`version`/`id`/`cwd`，与 Claude 逐条 `sessionId` 的差别写在模块里），按最后一条记录的 `parentId` 祖先链选活跃分支；第二遍只给该分支记录落正文，工具输出、图片与 reasoning 在 token 阶段丢弃。两遍都停在第一遍量到的字节数并对该段原始字节累计 sha256，两个 digest 必须相同（同大小改写不动 inode/dev/size，只有内容能证明两遍同源）；追加在已量前缀之后仍合法，被替换或截断则拒绝。已放弃的分支不会被压平进快照。两个 Provider 共用 capture 预算，轮次在记录边界关闭并在消费后释放，驻留按一轮而非整段历史增长。轮次组装、消息 digest、“已终止前缀”规则与 spool 生命周期抽到 `conversation-side-chat-streamed.ts`，Claude 与 Pi 共用。
4. **封存**：`SideChatSnapshotWriter` + `sealSink` 一条消息一次写入；正文 ≤2 KiB 内联、否则 256 KiB 分片进内容寻址清单树（fanout 32，分支只带计数/字节/子引用，写作者只保留每层一个未完成节点）。记录只留格式 4 描述符（`messageCount`/`bodyBytes`/`ManifestRef`）。UTF-16 代理对被 chunk 切开时 `Utf8ChunkNormalizer` 跨块持有，`text-spool.ts` 入口同样携带，hash/字节/分页三者一致。
5. **首次与后续发送的历史选择**：`prepareConversationHandoff` → 格式 4 子会话走 `selectSideChatHistory`：先读清单元数据，正文只在“存储字节 + 最小信封”仍能进交接预算时才读；选择顺序与旧 `selectHistory` 一致（最后 user、最后 assistant、首个 user、由新到旧）。冻结条目全部来自子会话自己的清单。
6. **遗漏台账**：`turn.omittedRanges`（`{snapshotId, from, to}` 闭区间）取代“每条遗漏一个 ref 写回 Conversation JSON”。4200 条冻结消息的 dispatch 记录仍是描述符级 JSON。
7. **遗漏检索**：reader 接收 `HistoryReaderSource`；格式 4 子会话由 `sideChatHistoryReaderSource` 分页清单（元数据页只读覆盖叶子，正文页只读该条消息分片）。Provider 侧由既有 Pi 扩展经 loopback JSON-RPC 调用（`provider-historical-input.test.ts`、`pi.test.ts` 证明真实调用与准入）。
8. **错误文案**：`SIDE_CHAT_COPY.reasonOf` 去掉 `Error invoking remote method '…':` 外壳并集中管理，未知原因如实标明。

旧“缩小前缀”提现已删除：`SideChatBudgetRefusal`、`smallestFreezableOrdinal`、`SideChatPreview.narrowed`、renderer `setNarrowed`/`previewNarrow*` 文案与相关断言都不在了；被拒绝的范围保持拒绝，不会提议把用户历史缩小成别的范围。`smallestThroughOrdinal` 保留，它是用户在预览里主动选择更早边界的那一个入口。

## 历史设计（已被取代）

早期计划用“前向链接的正文块 + 尾向前写清单页 + `<chunk>:<part>:<offset>` 游标”。不可变内容寻址无法事后补 `next`，实现改为 **fanout 清单树**（按计数下降 O(height)）与 **字节寻址分片**。以 `content-manifest.ts` 的契约与 `conversation-side-chat-manifest.test.ts` 的断言为准，上面的前向链接写法只作历史记录。

## 证据（全部 Node 22.22.1）

- `npx tsc --noEmit -p tsconfig.node.json`、`-p tsconfig.web.json`：通过。
- `conversation-side-chat-large-history.test.ts`（生产 `ConversationService` 全链路）：
  - 父会话归档 >16 MiB（36 轮 × 512 KiB 工具 payload + 一条 5 MiB 可见正文），`previewSideChat` → `createSideChat` 成功；快照 `bodyBytes` >5 MiB 且远小于归档；工具 payload 不出现在任何冻结正文里；5 MiB 正文按 256 KiB 分页读回 hash 一致。
  - 查看器按位置翻首个/中间/末个，不需要父归档。
  - 首次发送：Provider 拿到 reader 连接；遗漏台账是区间；记录 JSON <8 KB；经真实 JSON-RPC 调用 reader 分页清单，再分页取回那条 >4 MiB 的遗漏正文，单页 <512 KiB；伪造 id 被拒。
  - 负对照：同一份 >16 MiB 归档跑旧 `readTraceArchiveForMigration` 仍抛 `迁移归档超过 16 MiB 读取预算`，新路径用流式清单读到同样 37 轮。
- `conversation-side-chat-native-evidence.test.ts`：40 MB Claude transcript、40 MB Pi 会话、**2100 轮/4200 条消息**（记录 JSON <20 KB，按位置回读首个/中间/末个）。
- `conversation-side-chat-manifest.test.ts`：跨 chunk 代理对（内联与跨 256 KiB 分片两种阈值）hash/字节/分页一致；内容引用合法但 `count` 撒谎的叶子被拒。
- `conversation-history-side-chat.test.ts`：400 条冻结历史，元数据选择 + 区间台账 + 最早/中间/最新遗漏正文分页回读 + 台账被篡改即报错 + schema 往返；读取次数 < 80。
- `conversation-side-chat-snapshot.test.ts`：4200 条 + 单条 >4 MiB 正文封存后按位置读取，逐字一致。
- `conversation-side-chat-budget.test.ts`：9 MiB 前缀与单条 >4 MiB 正文不再被预算拒绝；显式边界仍精确。

完整门禁结果见本文件末尾“门禁”一节（每次合入前重跑并更新）。

## 完整隔离开发 App 验收（真实 IPC，不是服务单测，也不是打包产物）

`node scripts/electron-security-smoke.mjs --dev-side-chat-large-history-only`：在临时 userData 里用生产 `ConversationStore` + 归档路径写入 **2005 轮 / 4010 条消息 / 22.4 MB 归档 / 单条 4.26 MB 可见正文**的父会话（`scripts/side-chat-large-history-seed.ts`，种子脚本自身断言四个超限），再让**当前代码构建的完整隔离开发 App**（`devApp = true`，`node_modules/electron/dist/Electron.app` 加载本工作区 `out/`）通过真实 IPC 走完整链路。它是真的 main/renderer/preload 与生产 IPC，但**不是打包后的 `.app`**；打包产物的验证是独立 gate，见 [large-history-verification.md](large-history-verification.md)。该模式启动的 smoke Provider 声明 `historyReader: true` 并**真的**经 loopback MCP 读遗漏正文（`smoke-history-reader.ts`）。

实测（`/tmp/lh-final2.log`）：`messageCount=4010`、`archiveBytes=22361185`、`hugeMessageBytes=4259859`、`planItems=400`、`providerReads=3`（早/中/末三条完整正文，逐条与子会话冻结正文等长）、`viewerRows=4010`（翻完所有 `nextCursor`，438 ms）、父会话删除后仍 `readsAfterDelete=4010`。

同一 fixture 在**无 reader** 的 App（`--dev-side-chat-only` 的 `large history refusal` 步骤）里是独立负向用例：预览给出 `历史检索工具` 能力拒绝（文案里没有 `16 MiB|4 MiB|读取预算`），`createSideChat` 失败、`listSideChats` 为空、父会话未被改动。

## 仍然真实存在的上限（审计结论，不是隐藏 bug）

- **共享交接读取仍有预算**：`conversation-history-source.ts:readConversationHistoryMessages` 对“把一份非侧聊父会话直接当历史交接”的 archive 读取仍是 `MAX_CONVERSATION_HISTORY_SOURCE_BYTES = 16 MiB`、`MAX_CONVERSATION_HISTORY_TURNS = 2000`、`MAX_CONVERSATION_HISTORY_TEXT_BYTES = 4 MiB`。这是**所有对话共用**的交接/Adoption 路径，不是侧聊新链路；侧聊的预览、创建、首次发送与后续发送都不再走它。因此本修复不宣称“整个 App 无上限”。
- **计划只带内联窗口，不是全量 ref**：`sideChatPlanRefs` 对格式 4 子会话只返回最新、且单条字节仍可能内联的 ≤400 条（`sideChatInlineCandidates`，预算 `MAX_HANDOFF_BYTES`）；preview/plan/IPC 因此不随冻结消息数增长（App 实测 4010 条冻结消息，`plan.missingItems = 400`）。位置、遗漏区间与累计计数一律由清单描述符推导（`sideChatContextPositions`），旧条数记账只在 v3 记录上保留。
- **封存常驻内存是“单条消息”**：`streamTurns` 把一条正文封进 `TextSpool`（256 KiB 常驻 + 私有临时文件）再写清单，所以一条 195 MB 的**可见**正文峰值仍约为该条消息（不是前缀）。工具 payload 不走这条路径。
- **`normalize`/`transcript-file-cache` 仍是整行解析**：这两处服务于 App 其余读取路径（会话打开、renderer 列表），本次没有改写，调用方不变；侧聊原生来源不再经过它们。
- **`transcript-archive.ts`（97 KB，受 20 KB 提交钩子约束不可改）**：`resolveTranscriptPath`/`inspectTranscriptIdentity` 仍是同步整文件 identity 读取，且对“贴尾残行”的 transcript 判定 invalid。因此 >16 MiB 的**已收敛**原生会话已可冻结，但“正在写且尾部破损”的实时会话仍可能被 identity 判据拒绝。
- **相邻 UI 上限**：`MAX_SIDE_CHAT_TABS = 8`（`right-surface.ts`）、`side-chat-preferences.ts` `MAX_ENTRIES = 64`、`listSideChats` ≤100/页、查看器 40 项/256 KiB 单页、`MAX_CONVERSATION_HISTORY_ARTIFACT_BYTES = 256 KiB`。它们是界面/单页上限，不是历史读取上限。
- **Provider 能力边界**：只有 `historyReader: true` 的 Provider（claude/codex/pi）能在首次发送时按需检索遗漏正文；qoder/opencode 如实拒绝而不是假装支持。Pi 没有 MCP 状态 API，本修复不探测、不推断。

## 父级 review 待办（本分支未完成）

- **`conversation-history-source.ts` 的共享交接读取预算**：仍是 16 MiB / 4 MiB / 2000 轮，只作用于“把非侧聊父会话直接当历史交接”的 archive 路径（adoption 与既有普通对话）。侧聊新链路不经过它。

## 门禁

本轮实测（Node 22.22.1，worktree 内）：

- `npm run typecheck`（node + web）：通过（`TYPECHECK_EXIT=0`）。
- `npm test`：`503 passed | 4 skipped`，`5069 passed | 4 skipped`（`NPM_TEST_EXIT=0`，`/tmp/full-test-new2.log`）。
- `npm run build`：通过。
- `node scripts/electron-security-smoke.mjs --dev-side-chat-large-history-only`：`LH_EXIT=0`（正向大历史，见上）。
- `node scripts/electron-security-smoke.mjs --dev-side-chat-only`：`SC_EXIT=0`（含无 reader 负向用例、既有多 Provider/重启/草稿/adoption 步骤）。用 `stream-json` 替换 tokenizer 之后，`npm run test:renderer:ui` 里同一模式曾停在 `drafts restored` 步骤（`checking the receipt must read its record`），随后单独重跑该模式为 0，同一次重跑的 artifact hash 与失败那次完全相同。**根因未知**，同样只记“失败一次、随后通过”。首轮曾在 `orphan reader` 步骤失败（`the child could not select an agent of its own: {hostAgent:"codex", chipAgent:"codex"}`），同一代码重跑为 0。观察到的事实：该步骤在固定 120 ms 等待后读回 `chipAgent`，最多 3 次尝试，失败时子会话 chip 仍等于宿主 agent。**根因未知**——没有决定性证据能证明是 freshness race，所以这里只记“失败一次、随后通过”，不宣称 fixture 抖动已定位，也没有跳过该步骤。
- `npm run test:renderer:ui`：首轮 `RENDERER_UI_EXIT=1`，失败在 `DesktopRemote UI smoke failed (1): Timed out: late history layout remains at bottom`（与侧聊无关的滚动步骤），同一棵树重跑 `RENDERER_UI_EXIT=0`，大历史冒烟同时通过。**根因未知**，只记“失败一次、随后通过”。
- `npm run performance:measure -- --compare d824c609 --out /tmp/scry-perf-final-Rg8MJQ`（合并后 HEAD `39c29192`，原始侧聊基线 `d824c609`）：`PERF_EXIT=0`，`Ratchet: passed`，`ratchet.worse = []`。135 行对照全部为 `measured`；**没有任何一行 worse**。只有 5 行有差异，且都是字节级：`files.fixed-operations/io.read.payload.bytes` 1398160 → 1398158（−2 B，基线 5 轮 `[1398125,1398160,1398150,1398102,1398150]`，候选 5 轮 `[1398158,1398122,1398156,1398149,1398143]`，两侧自身逐轮抖动 ±30 B）、`trace.r4-cell/*` 三项 +2/+2/+8 B，其余行两侧完全相同。
  `ratchet.md` 另列出 5 个“高于记录基线、不参与门禁”的计数（`git.run.calls` 9→10、`io.readdir` 18→20、`recorder.content-cold/io.stat.calls` 36→44、`persistence.archive/ipc.bytes` 10536→10558、`io.read.payload.bytes` 1397923→1398158）。这不是本次改动造成的：同样这 5 项在 `d824c609` 现场基线与本树候选之间**完全相同**（10/10、20/20、44/44、10558/10558），说明差值来自已合并的 main，`io.read.payload.bytes` 反而比 `d824c609` 低 2 B。已记录的 ratchet 基线本身比 `d824c609` 现场值更严。
  `analytics.stats/cpu.instructions` 在本机两侧都是 unavailable（表中 `missing`），不是 0。这些是 **L1 工作计数**，只能说明工作计数没有回归，**不能证明延迟或流式行为**；大历史的真实证据是 App 冒烟的 22.4 MB 归档、4.26 MB 单条消息、`viewerElapsedMs` 472~504、`planItems` 400、`providerReads` 3、`readsAfterDelete` 4010。


每次合入前重跑同一组命令；毫秒结论需 `timing-run` 锁，本轮没有毫秒结论。

验证范围（哪一层被证明、证据在哪、哪些边界仍然存在）集中在
[large-history-verification.md](large-history-verification.md)：`--dev-*` 模式是当前代码
构建的完整隔离开发 App + 生产 IPC，不是打包产物；仍存在的非侧聊交接上限、无 reader 的
能力拒绝、UI 分页/tab 上限也列在那里。

## 最终证据包（HEAD `a28c6c9f`）

- 分支 `scry/88d17fe3`；基线 `d824c609`（原始侧聊实现）；已合并 main `e5b8ebd2`（`5b123b91` 普通 merge）；本次修复提交 `21945026`（tokenizer）、`39c29192` + `a28c6c9f`（文档）。作者全部为 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。
- 最终树上的 gate（日志在 `/tmp`）：`TYPECHECK_EXIT=0`（`p2-typecheck.log`）、`BUILD_EXIT=0`（`p2-build.log`）、`NPM_TEST_EXIT=0` 508 files / 5111 passed / 4 skipped（`p2-npmtest.log`）、`test:side-chat:ui` `SIDE_CHAT_UI_EXIT=0`（`p2-sidechat-ui.log`，含 `step: large history refusal` 与正向大历史）、`test:renderer:ui` `RENDERER_UI_EXIT=0`（`p4-renderer-ui.log`）、性能对照（`p4-perf.log` + `/tmp/scry-perf-final-Rg8MJQ/{measure,comparison,candidate,baseline}.json`、`ratchet.md`）。
- 开发 App 正向大历史冒烟的机器可读证据（`devApp`，非打包产物）：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-app-driver-MPSjNC/verification.json`（`side-chat execution`，`childId debdf67e-…`，10 条 receipt，providers `codex/claude/qoder/opencode/pi`）与同目录 `side-chat large history`：`parentTurns 2005`、`messageCount 4010`、`archiveBytes 22361185`、`hugeMessageBytes 4259859`、`planItems 400`、`providerReads 3`、`readsAfterDelete 4010`、`readerAvailable true`。`--dev-side-chat-only` 重跑证据 `/var/folders/14/…/scry-app-driver-dMVVSn/verification.json`。
- 构建产物 hash（最后一次 App 冒烟所验证的 `out/`，与 `test:renderer:ui` 失败那次相同）：`out/main/index.js dffa5dabb9f8558be6593c785be4e2fd39a16456452de1f5810c69ec8778778a`、`out/preload/index.cjs 21c2e11bf3b254644e7482c7d245a3cff8ae8bfc394d786765e28b077c0221f5`、`out/renderer/index.html a064c8e1c4c2a9bd1aee616ae50c0b94b70b642fc95103a792236f6c5597bae5`。
- 卫生检查：工作区干净、无暂存文件；本次新增/改动的手写文件最大 19,987 B（`scripts/electron-security-smoke.mjs`，合并带入），本次新文件 `jsonl-record-scanner.ts` 11,435 B、`conversation-side-chat-native-stream.ts` 16,008 B、其测试 9,467 B；本文档 18,131 B。`src/main/transcript-archive.ts`（97,927 B）**早于本次任务**就超过 20 KB 且本次未改动，仍是已知遗留问题。
- 没有残留 `electron-security-smoke`/`Scry.app` 测试进程；冒烟全部使用临时 `userData` 与临时 workspace，未写用户真实 `.scry` 记录、transcript 或 DB；未安装 App、未升版本、未 push、未移动 main。
