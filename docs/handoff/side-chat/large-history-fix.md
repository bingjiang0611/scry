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

## 未完成（用户目标未达成）

1. 快照正文仍是 v3 单体：`conversation-side-chat.ts:60/64`、`conversation-side-chat-snapshot.ts:92/103`、`conversation-side-chat-schema.ts:7-8` 的 **4 MiB / 4000 条**上限仍在。
2. 首轮交接仍整段读：`conversation-history-source.ts:46/123/130`、`conversation-history-text.ts:34`（2000 轮 / 16 MiB / 4 MiB），`readConversationHistoryMessages` 先读全部再选。
3. 无 Scry 归档的原生裸 transcript（Claude/Pi）仍整文件读并 16 MiB 拒绝：`bootstrap/side-chat-source.ts:40/65/120`。
4. `Conversation` 仍内联 `sideChat.snapshot.items`；父级已拒绝把 ~8 万条当作最终上限。

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
