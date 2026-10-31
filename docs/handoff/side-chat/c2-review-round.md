# 侧边会话 C2 复核轮记录

本文件保存 C2 复核轮的过程证据，从 `implementation-report.md` 拆出，避免主报告超过 20 KB 门禁。结论以主报告为准。

## C2 复核轮（修复与真实 App 验收）

父级复核提出的十项问题按「先修因，再取证」处理，全部改动仍是本分支 WIP，未提交。

- **副作用环与重复创建**：`useSideChatWorkspace` 改为语义键驱动（`scopeKey`、`sideChatSourceKey(source)`、`openIds`），易变输入放进 `latest` ref；`validateTabs` 按 `scope/source/ids` 合并并发读取，metadata 不变不新建 Map；创建用 `busy` ref 与固定 scope/source/target/commandId，账本满时派发前拒绝而不淘汰未知命令。
- **选择 ID 上限**：已打开页签的校验与分页历史彻底分开——`historyPages` 永不进入 `validateTabs`，校验只看 ≤8 个已打开 ID；历史保留上限 `MAX_HISTORY_ROWS=160`，`canLoadMore`/`truncated` 明确提示。
- **作用域正确性**：创建时固定 scope；回包时若当前 scope 已变，只经 `dispatchForScope(scopeKey)` 写回原子会话布局并提示「仍属于原来的主会话」，不改写当前主区。
- **滚动与焦点**：子对话位置改由 `initialViewPosition` 在真实历史页提交后应用一次（`restoredConversation` 去重），滚动位置由活的 `scroll` 监听持续持久化，不再在被动清理里读已清空的 DOM ref；只有新建子对话聚焦输入框，页签切换保留页签焦点。
- **注意力与可发现性**：`attentionSummary` 让 live 事件携带 `permissionCount`/`inputCount`，启动响应被 live 覆盖栅栏保护；侧栏活动把子对话标为背景子项而不是抹掉；父条目消失的子对话进入有界（12 组 × 20 行）`SideChatOrphanGroup`，措辞是「父会话不在目录中」而不是断言已删除。
- **一次读取目录**：`ConversationService.listCatalog` 用一次 `store.list` 同时产出条目与被拥有的 native 别名，`list`/`nativeSessionAliases` 都委托它；回归「answers rows and the owned-native filter from one store read」验证读取次数。
- **预算拒绝 UI**：`previewSideChat` 捕获预算拒绝后以 `smallestFreezableOrdinal()` 重新预览并返回 `narrowed`，面板显示 `data-side-chat-narrow` 的显式小边界按钮；未选择前不创建，冻结前缀不被静默改写。
- **测试文件门禁**：三个 >20 KB 测试文件按职责拆分（`useAgentSession-trace.test.ts`、`composer-pending-preparation.test.ts`、`run-trace-stream-session.fixtures|teardown`），用例数保持 37 / 18 / 21。
- **归档布局**：真实 fixture 证明旧整份归档（v3 monolith）与 `providerTurnId` 分段归档都能被批量投影，未请求的分段不被读取；此前的「归档布局」风险不成立。
- **真实 App 验收**：`scripts/structure-side-chat-checks.mjs` 在隔离生产构建里用真实点击完成——卡片创建（一个页签、一次 `createSideChat`、子输入框获焦）→ 主/子草稿各自保留 → 关闭页签回到 chooser 且主区宽度不变 → 历史重开同一子会话并恢复草稿 → 页签切换不夺焦点、不重复读取 → 空闲 1.2 s 无侧聊 IPC → 双击只产生一个子会话 → 新父会话不显示旧子页签 → 注入「回包丢失」后只读回查找回 → 账本满在派发前拒绝 → 「提交前丢失」进入未知且下次点击只回查不重发。计数器来自 App 自身 `ipcMain.handle`。

本轮检查：`tsc` web/node 通过；`npx vitest run` 440 files / 4611 tests 通过、4 skipped；`npm run build` 通过；`node scripts/electron-security-smoke.mjs --dev-structure-only` 通过（light+dark，含上述侧聊断言）；`git diff --check` 通过、`git diff --cached` 为空。

仍未验证：子对话滚动位置在**可滚动**历史下的真实恢复、>40 条历史的 App 内分页翻页、创建瞬间切换父会话的 `elsewhere` 分支、五 Provider 覆盖、重启后布局恢复、以及 `npm run performance:measure`。

后续待填：双实例并行、归档/删除预览、五 Provider 真实输入与审批、重启后布局恢复、性能测量与交付门禁、安装结果和最终限制。所有未完成项由主 agent 继续推进。
