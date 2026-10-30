# 侧聊大历史修复：状态与证据

分支 `scry/88d17fe3`，起点 `d824c609`。本文件记录实际完成的部分和未完成的部分，不把计划说成结果。

## 用户可见问题

创建侧聊时报 `Error invoking remote method 'conversation:previewSideChat': Error: 迁移归档超过 16 MiB 读取预算`。

调用链：`bootstrap/conversation.ts:251` → `conversation-side-chat.ts:previewSideChat` → `conversation-side-chat-source.ts:captureNativePrefix` → `transcript-archive.ts:readTraceArchiveForMigration`（把主归档 + 每个轮次分片字节求和，>16 MiB 抛普通 `Error`）。预览的"缩小前缀"兜底只认 `SideChatBudgetRefusal`，所以直接冒泡成 `没有创建侧边会话：…`。

真实规模（只读统计 `~/Library/Application Support/scry/trace-archive-turns-v1`）：503 MB/128 轮、195 MB/**9 轮**；单个轮次文件 195,679,614 B、39,622,695 B、36,543,774 B、26,945,199 B。也就是说 16 MiB 不是极端历史，而且"只删总闸门"会立刻撞上每轮 16 MiB 限制。

## 已完成（commit `6c7dc77e`）

- `src/main/trace-archive-projection.ts`（新）：用已安装的 `stream-json` 3.7（BSD-3，仓库既有依赖，`providers/pi-rpc-decoder.ts` 已用同一模式）对单个轮次归档做**流式结构投影**：只解码 capture 需要的字段（`kind/stage/runId/messageId/agentId/parentToolUseId/ts/text/modelContent/steer/runtimeMetadata/providerId/runtimeProvider`），`items[]` 中其它键的整棵子树按结构键跳过，不物化 195 MB 的工具 payload。选择依据是结构路径，不是文本匹配，因此工具文本里出现 `"stage":"text"` 无法把自己选成正文。截断/损坏/身份不符（cwd/session/provider/runId/多轮）一律 fail closed。
- `src/main/transcript-archive-capture.ts`（新）：先 `readTraceArchivePageAsync({limit:1})` 取 `readMode/sourceComplete/totalTurns`，不完整分片直接拒绝（不冻结残缺前缀）；分片归档按索引有序、每批 20 轮逐个打开 + 投影；每轮读后重验 inode/dev/size。打开路径用 canonical 目录包含 + `O_NOFOLLOW`（`trustedOwnedParent` 私有且所在文件过大，见"限制"）。
- `src/main/conversation-side-chat-source.ts`：原生归档分支改用上述流式读取，删除 16 MiB 汇总与 2000 轮闸门；无归档时仍走既有原生读取器。
- 测试：`trace-archive-projection.test.ts`（6 例，含 Unicode 跨 chunk、恶意 payload 诱骗、截断/身份）、`transcript-archive-capture.test.ts`（4 例，含 >16 MiB 单轮、2100 轮、缺分片拒绝、单体旧归档）。

验证命令与结果：

```
npx tsc --noEmit -p tsconfig.node.json            # 通过
npx vitest run src/main/trace-archive-projection.test.ts src/main/transcript-archive-capture.test.ts   # 10 passed
npx vitest run src/main/transcript-archive src/main/conversation-adoption src/main/conversation-history \
  src/main/conversation-turn-history src/main/conversation-side-chat src/main/conversation-fork-side-chat \
  src/main/bootstrap/side-chat     # 158/159，唯一失败是 2100 轮用例超时，改为 30s 后通过
```

## 未完成（必须做完才算达到用户要求）

1. **快照本体仍是 v3 单体 + 4 MiB/4000 条上限**（`conversation-side-chat.ts:measure`、`conversation-side-chat-snapshot.ts`、`conversation-side-chat-schema.ts`）。现在创建不会再被 16 MiB 挡住，但可见正文 >4 MiB 或消息 >4000 条时仍会被 `SideChatBudgetRefusal` 拒绝。这是用户明确要求去掉的下一个闸门。
2. **交接/首轮仍整段读**：`conversation-history-source.ts` 的 `MAX_CONVERSATION_HISTORY_TURNS=2000`、`conversation-history-text.ts` 的 4 MiB 全文预算、`readConversationHistoryMessages` 先读全部再选。
3. **原生裸 transcript（Claude/Pi，无 Scry 归档时）仍按整文件读取并 16 MiB 拒绝**（`bootstrap/side-chat-source.ts`）。
4. **16 MiB 的 Conversation 记录上限**是元数据内联的最终结构限制，父级已拒绝接受；v4 必须外置。

## 父级已批准的 Phase 2 契约（未开工）

v4 快照：`Conversation.sideChat.snapshot` 只留描述符 `{format:4, head, tail, messageCount, bodyBytes, throughOrdinal, throughRunId, prefixFingerprint, id, capturedAt}`；正文与元数据放在内容寻址的链接块里（每块 ≤256 KiB 可见文本，单条超大消息拆片段，块内 `prev/next`，块内含 `{itemIndex, role, providerId, sourceOrdinal, ref, parts}`）；渲染用分页游标 `<chunk>:<item>:<charOffset>`。

需要同步改的消费者（全部同步读取 `snapshot.items`）：`shared/conversation.ts:conversationContextItems/sideChatSnapshotItems`、`conversation-turns.ts:assertSideChatContextIntact`、`conversation-summary.ts`（messageCount/missingDetails）、`conversation-service.ts:readItem`、`conversation-history.ts:loadConversationHistory`、`conversation-history-source.ts`、`conversation-schema.ts:124`、`conversation-side-chat.ts:sideChatPage`。首轮交接与 thread-read 台账改为**分页快照范围描述符** `{snapshotId, fromIndex, toIndex, count}`，不是展开的 ref 数组（否则 16 MiB 只是换位置）。v3 只读兼容，不就地重写。

## 限制与风险

- `transcript-archive.ts`（97 KB）受 20 KB 提交钩子约束无法修改，因此 `openSegment` 内的路径加固是 `trustedOwnedParent` 的镜像而非复用；应在拆分该文件时提取为共享 `owned-path.ts`。
- 单体旧归档仍是一次整文件解析（诚实标注 `readMode: 'monolithic'`；本机无 >1 MB 样本）。
- 单个可见消息在投影阶段会完整物化一次（其体积即用户自己的正文）；>256 KiB 消息的分片读写在 Phase 2。
- 未运行：`npm test` 全量、`npm run test:side-chat:ui`、`npm run test:renderer:ui`、`npm run performance:measure`、`check:cli-release`。改动文件属于 `ipc.conversation:previewSideChat/createSideChat` 性能路径，合入前必须补跑 `npm run performance:measure`。
- 本机 Node 为 v24.18.0（任务书写 22.22.1）。
