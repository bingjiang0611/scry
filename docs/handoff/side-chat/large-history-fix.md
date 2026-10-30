# 侧聊大历史修复：状态与证据

分支 `scry/88d17fe3`，起点 `d824c609`。Node 一律 `export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"` 后执行。

## 用户可见问题

创建侧聊报 `Error invoking remote method 'conversation:previewSideChat': Error: 迁移归档超过 16 MiB 读取预算`。

链：`bootstrap/conversation.ts:251` → `conversation-side-chat.ts:previewSideChat` → `conversation-side-chat-source.ts:captureNativePrefix` → `transcript-archive.ts:readTraceArchiveForMigration`（主归档 + 各分片字节求和 >16 MiB 抛普通 `Error`，预览的缩小前缀只认 `SideChatBudgetRefusal`，所以冒泡成"没有创建侧边会话"）。

真实规模（只读统计）：503 MB/128 轮、195 MB/**9 轮**；单轮文件 195,679,614 / 39,622,695 / 36,543,774 / 26,945,199 B。

## 已提交

- `6c7dc77e` 归档读取改为流式投影（`trace-archive-projection.ts`、`transcript-archive-capture.ts`），删除侧聊 16 MiB 汇总与 2000 轮闸门。
- `9d444792` 修正上一版的"廉价清单"失真：清单不再调用分页读取（它会解析选中轮次并 hydrate），改为 **元数据 only**（复用索引 / sidecar 扫描 / 投影重建），v1 索引不再走"解析全部正文"的升级路径；单体旧归档逐轮流式读取；打开与读后都校验 dev/ino/size/mtime/ctime，投影同时返回所解析字节的 digest；归档 profile 归属参与来源 fence。
- `6714c18d` 本文件的前一版（内容已被本版取代）。

验证（Node 22.22.1）：

```
npx tsc --noEmit -p tsconfig.node.json                     # 通过
npx vitest run src/main/transcript-archive-projection.test.ts \
  src/main/transcript-archive-capture.test.ts               # 11 passed
npx vitest run src/main/transcript-archive src/main/conversation-adoption \
  src/main/conversation-history src/main/conversation-turn-history \
  src/main/conversation-side-chat src/main/conversation-fork-side-chat \
  src/main/bootstrap/side-chat src/main/session-history       # 198 passed / 22 files
```

新测试覆盖：最新一轮 20 MiB 无关 payload（清单不解析正文、迭代才解析且跳过 payload）、索引与 sidecar 缺失时按 ts 重建顺序、v1 索引不走正文解析、单体归档含 20 MiB 最新轮、2100 个真实轮次（正文 + sidecar 直接落盘，**默认 5 s 超时**，实测约 1.9–3.0 s；上一版 30 s 超时是无效率 fixture 掩盖，已删除）、截断/跨 cwd/跨 run/跨 provider/多轮拒绝、诱饵 payload 不能自选、Unicode 跨 chunk 精确。

## 已提交（续）

- `9b3a4bd4` 有界 fanout 的内容寻址清单树（`content-manifest.ts`）：叶子固定条目数，分支只带计数/字节上界/子引用，写作者只保留每层一个未完成节点，内存 O(fanout·height)；按计数下降读单项/单页是 O(height)。正文按 256 KiB 分片写入，边写边累积整条 hash；每个节点带 `snapshotId+fingerprint` 绑定的 binding，节点自身 hash 有效也无法从别的快照替换。
- `8c493210` 侧聊快照改为格式 4：记录只留描述符（`messageCount`/`bodyBytes`/清单根），封存流式写入清单，读取按计数或字节偏移下降。旧格式 3 记录仍可读且不被重写。`conversationContinuation` 显式接收冻结引用（格式 4 无法自行枚举，返回空列表会静默丢失上下文，缺参数即报错），main 从子对话自己的清单按页读取。

证据：`npx vitest run` 全量 5049 passed / 4 skipped；`npx tsc --noEmit -p tsconfig.node.json` 与 `-p tsconfig.web.json` 均通过。新增 `conversation-side-chat-snapshot.test.ts`：4200 条 + 单条 >4 MiB 正文封存后按位置读首个/中间/末个，正文逐字一致。

## 当前全链路能力（HEAD `fc188d4b`，2026-xx 复核）

已实现并跑过 focused 证据的能力，按调用链列出：

1. **来源读取（归档）**：`transcript-archive-capture.ts:iterateTraceArchiveCapture` 以 `stream-json` 逐 token 迭代，只解析结构、正文落 `TextSpool`；195 MiB 单轮 payload 不被整条物化。侧聊路径已不再调用 `readTraceArchiveForMigration`（16 MiB/2000 轮只约束旧版 Adoption）。
2. **来源读取（无归档原生）**：`bootstrap/side-chat-source.ts` 改为 1 MiB 分块 → `TextDecoder` 流式解码 → 按最后完整换行喂同一个 `appendTranscriptToTurns` reducer；贴尾残行不算证据。>16 MiB 的 Claude transcript 与 Pi 会话现在都能冻结（新测试用 40 MB 双 Provider fixture 证明）。Pi 侧 `maxBytes` 传参已去掉，`nativeLines` 本来就逐行读。
3. **封存**：`SideChatSnapshotWriter` + `sealSink` 一条消息一次写入，正文 ≤2 KiB 内联、否则 256 KiB 分片进内容寻址清单；记录只留格式 4 描述符。UTF-16 代理对被 chunk 切开时由 `Utf8ChunkNormalizer` 跨块持有（`utf8-chunks.ts`），hash/字节/分页三者一致。
4. **首次发送的历史选择**：`prepareConversationHandoff` 对格式 4 子会话走 `selectSideChatHistory`：先读清单元数据，候选正文只在“存储字节 + 最小信封”仍能进交接预算时才读，检索顺序与旧 `selectHistory` 一致（最后 user、最后 assistant、首个 user、由新到旧）。>4 MiB 单条正文与 9 MiB 前缀都实测可冻结、可回读。
5. **遗漏台账**：`turn.omittedRanges`（`{snapshotId, from, to}` 闭区间）取代“每条遗漏一个 ref 写回 Conversation JSON”；400 条遗漏压缩成 1–2 个区间，`omittedItemsHash` 与封存 artifact 用同一份台账，`decodeConversation` 拒绝越界、倒序、跨快照区间。
6. **遗漏检索**：reader 现在接收 `HistoryReaderSource`；格式 4 子会话由 `sideChatHistoryReaderSource` 直接分页清单（元数据页只读覆盖的叶子，正文页只读该条消息的分片），不再把整套正文常驻内存。archive 来源仍用有界内存源。
7. **预错误文案**：`SIDE_CHAT_COPY.reasonOf` 去掉 `Error invoking remote method '…':` 外壳并集中管理，未知原因如实标明。

证据（全部 `export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"`）：

- `npm test`（unit + shell）：`Test Files 501 passed | 4 skipped`，`Tests 5059 passed | 4 skipped`，`EXIT=0`。
- `npx tsc --noEmit -p tsconfig.node.json`、`-p tsconfig.web.json`：通过。
- 新增/改写的 focused 证据：
  - `conversation-side-chat-manifest.test.ts`：跨 chunk 代理对（内联与跨 256 KiB 分片两种阈值）hash/字节/分页一致；内容引用合法但 `count` 撒谎的叶子被拒。
  - `conversation-history-side-chat.test.ts`：400 条冻结历史，元数据选择 + 区间台账 + 最早/中间/最新遗漏正文分页回读 + 台账被篡改即报错 + 记录 schema 往返；同时断言读取次数 < 80（400 条正文全读会是 400+）。
  - `conversation-side-chat-native-evidence.test.ts`：40 MB Claude transcript 与 40 MB Pi 会话（均 >16 MiB）冻结出 80 条消息并可回读末条正文。
  - `conversation-side-chat-budget.test.ts` / `conversation-side-chat.test.ts`：9 MiB 前缀与单条 >4 MiB 正文不再被预算拒绝，`narrowed` 不再触发。

## 仍未完成 / 未验证（合入前必须处理）

1. **未跑的门禁**：`npm run build`、`npm run test:side-chat:ui`、`npm run test:conversation:ipc`、完整 `npm run test:renderer:ui`、`npm run check:cli-release`（本分支未改 CLI 分发面，但 `normalize.ts` 被 CLI 测试覆盖）、`npm run performance:measure --compare d824c609`。改动文件位于 `ipc.conversation:previewSideChat/createSideChat` 性能路径，毫秒级结论未测，不得宣称更快。
2. **真实 App 大历史验收未做**：未在隐藏隔离的完整 App 里用 >16 MiB 归档、>2000 轮、>4000 消息、>4 MiB 单条正文跑 preview→create→first send，也未做旧实现负对照（要求保留原 `迁移归档超过 16 MiB 读取预算` 失败）。
3. **预览 narrowing 已成不可达路径**：4 MiB/16 MiB 来源拒绝被移除后，`SideChatBudgetRefusal` 只剩“归档读取预算”这一条来源，而该来源也不再触发。`smallestFreezableOrdinal`、`SideChatPreview.narrowed`、renderer 的 `setNarrowed`/`previewNarrow*` 文案与 `side-chat-budget` 的 narrowing 断言应按“删除而不是保留死路径”处理，尚未删除。
4. **仍存在的真实上限（审计结论，不是隐藏 bug）**：
   - 归档来源读取仍按 `MAX_CONVERSATION_HISTORY_SOURCE_BYTES = 16 MiB`/`MAX_CONVERSATION_HISTORY_TURNS = 2000` 约束（`conversation-history-source.ts`），只影响“把一份大 **父会话** 直接当历史交接”，不影响冻结侧聊子会话。
   - 交接选择仍把缺失项物化为 ref 数组（`sideChatSnapshotRefs` 读全部清单元数据），这是 O(消息数) 的瞬时内存（4000 条约 0.5 MB），未持久化。
   - 封存时的常驻内存是“单条消息正文”，不是前缀大小；`streamTurns` 仍以 string 交付单条正文，195 MB 级单条消息在投影/封装阶段仍有内存峰值。
   - 相邻 UI 上限：`MAX_SIDE_CHAT_TABS = 8`（`right-surface.ts`，静默淘汰）、`side-chat-preferences.ts` `MAX_ENTRIES = 64`、`listSideChats` ≤100/页、查看器 40 项/256 KiB 单页。它们不是历史读取上限，但整个 App 仍有限制。
4. **`transcript-archive.ts` 97 KB 不可改**（20 KB 提交钩子）：其中的 identity 检查仍是同步整文件读取，`resolveTranscriptPath` 对“贴尾残行”的 transcript 会判定 invalid；因此原生来源的 `>16 MiB` 已可读，但“边写边读且尾部破损”的实时会话仍可能被 identity 判据拒绝。

## Phase 2 契约（已获父级批准，未开工）

**记录只留描述符**：`snapshot = {format:4, id, capturedAt, throughOrdinal, throughRunId, prefixFingerprint, head, tail, pageCount, messageCount, bodyBytes}`，`items`/`chunks` 都不进 `Conversation` JSON。

**前向链接的可行写法**（关键实现决定）：内容寻址块不可变，无法事后补 `next`，因此
- 正文块：流式写入时保留"一块前瞻"（当前块填满后先持有，等下一块密封得到其 ref 再写当前块，内存 ≤2 块 ≈512 KiB）；
- 清单页：项元数据本身就小，先按页切分，**从尾页向前写**，每页的 `next` 已存在；记录只存 head/tail/页数，逐页 `{prev,next,items:[{ref,role,providerId,sourceOrdinal,bytes}]}`。

**分区与游标**：正文块 ≤256 KiB 可见文本；单条超大消息拆 `parts`（UTF-8 安全切分，整条 hash 在密封时对完整正文计算）。查看游标 `<chunkRef 前 16 位十六进制>:<part>:<charOffset>`，每页只读一块；`readItem(ref)` 从 head 顺序走块到目标 item（O(块数)，用户点击路径，如实记录）。

**交接/台账**：`ConversationContinuation`、`turn.omittedItems`、`sideChatPage.items`、`missingDetails` 改为分页快照范围 `{snapshotId, fromIndex, toIndex, count}`；reader 工具按 index 分页取项，不是把 ref 数组放进 turn 记录。v3 记录只读兼容，不就地重写；v4 不被旧版本接受（明确报错，无静默降级）。

需要同步修改（全部当前同步读 `snapshot.items`）：`shared/conversation.ts:conversationContextItems/sideChatSnapshotItems`、`conversation-turns.ts:assertSideChatContextIntact`、`conversation-summary.ts:34/86`、`conversation-service.ts:113`、`conversation-history.ts:155`、`conversation-history-source.ts`、`conversation-schema.ts:124`、`conversation-side-chat.ts:344`、`conversation-side-chat-schema.ts`、`conversation-side-chat-snapshot.ts`。

**单条超大可见消息**：投影阶段不能整条缓冲后再切片。应从正文内容寻址存储分页拉取并逐片密封（`readAppTraceContentPage` 已有分页），块内 `parts` 边读边写，hash 增量累积。

## 限制与风险

- `transcript-archive.ts` 97 KB，受 20 KB 提交钩子约束不可修改；`transcript-archive-capture.ts` 里的受控路径检查是 `trustedOwnedParent` 的镜像，应在拆分该文件时提取为共享 `owned-path.ts`。清单复用公共 `readTraceArchiveMetadataAsync`，未复制索引校验逻辑。
- 归档清单在内存中保留 O(轮数) 的小元数据（与既有 `readTraceArchiveMetadataAsync` 相同量级）；body 逐轮投影。
- 未运行：`npm test` 全量、`npm run test:side-chat:ui`、`npm run test:renderer:ui`、`npm run performance:measure`、`check:cli-release`。改动文件位于 `ipc.conversation:previewSideChat/createSideChat` 性能路径，合入前必须补跑 `performance:measure` 并与 `d824c609` 对比。
- 本机 Node v24.18.0 为默认 PATH；上述验证均在显式 v22.22.1 下完成。
