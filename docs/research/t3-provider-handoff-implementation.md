# T3 跨 Provider 接续：源码核查

## 范围与结论

- 对应推进顺序 **2 → 4 → 6 → 7** 的第 4 项；本文是研究，不是 Scry 功能完成声明。
- T3 固定在 [`7ac952c630ef8a60d14ca8f6a0c7adce33db4bae`](https://github.com/pingdotgg/t3code/tree/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae)。沿用上一项的 main 快照，不把它当作稳定版 `0.0.45` 或当前最新版本。
- Scry 核查基线：`1f932e0`，App `0.2.190`。本轮只读相关调用链，没有启动 Provider、运行 T3 测试或进行账号切换。
- **跨 Provider 转交的是可观察的历史资料，不是原生 session、隐藏推理、工具执行状态或审批。**
- 初始评估曾建议“保留源会话，交接到目标 Provider 的新会话”；**用户随后明确选择统一会话内切换**，当前技术方案已按该选择更新。统一 app thread 必须有真实身份和覆盖模型，不能仅解锁现有 Provider 下拉框。

## 1. T3 有哪些独立身份

```text
App Thread：统一历史
  ├─ Run 1..N：每轮执行
  ├─ ProviderThread A：A 的原生对话引用
  ├─ ProviderThread B：B 的原生对话引用
  ├─ ProviderSession：可释放/重建的运行连接
  └─ ContextHandoff：历史覆盖范围、正文与投递证据
```

连接关闭不等于原生历史消失。反过来，app thread 能显示旧内容，也不等于当前 Provider 原生上下文包含这些内容。

`ProviderSwitchServiceV2.plan()` 根据实例元数据、continuation identity、运行设置与能力决定 transition；不能仅比较 UI 上的 Provider 名称。它筛选目标 ProviderThread，并分别处理可释放的 live session 与已停止/失败的历史记录。transition policy 区分复用、原生恢复、创建后交接和拒绝。

“切回旧 Provider 就直接 resume”不成立。必须知道旧线程已覆盖哪些运行、缺哪些运行，以及当前原生身份是否仍可安全恢复。架构文档提出 delta/full 等策略；这些策略名称不能单独证明最终投递成功。

## 2. 文档与实际源码存在差异

同一固定快照中：

- `docs/internals/context-handoffs.md` 仍描述把文字折叠空白并截为 240 字符。
- `ContextHandoffService.ts::prepareProviderHandoff()` 实际调用 `historicalMessage()`、`selectHistory()`，保存完整被选中条目、覆盖范围、omitted IDs，再渲染历史。
- 240 字符的 `compactText()` 仍用于该文件里的 fork delta 展示摘要；不能把它套到当前跨 Provider 历史交接路径。
- legacy import 又有独立的 32,000 字符摘要逻辑；不能与当前 handoff 的预算混用。

所以本方案以实际 provider-handoff 路径为依据，不复制过期内部文档的算法。

## 3. 选择历史，不等于生成 AI 总结

`handoffBudget.ts` 的实际规则：

1. 转换用户/助手消息，以及命令、错误、中断、文件名、计划等受支持条目。
2. 保留用户/助手消息的角色；其他活动以 assistant 角色加原 kind 标签表示。另保留顺序、item/run/provider-thread 引用与状态，不把失败轮次当成成功。
3. 优先尝试最后一个 user、最后一个 assistant、首个 user，再从最近条目向前填充。
4. 单个条目放不下就整条省略，不截断入选正文。记录省略数量和 ID。
5. 包装文字明确历史不是新的请求或更高优先级指令；不重放原生工具调用、推理与附件。
6. 使用 `t3_thread_read` 的 thread/item/分页引用找回省略资料。

这不是“自动理解并提炼全部约束”。很长的关键指令仍可能整条被省略。T3 的检索工具是补偿机制；Scry 没有对应的跨 Provider 历史工具合同，不能复制提示词后就声称目标 Agent 能找回全文。

### 预算的真实含义

- 初始 token cap 默认 16,000，配置夹在 1,024–64,000；导入历史另有 64,000-byte 上限。
- `historyCost()` 比较 native/message 与 inline 两种序列化后的字节开销，并计入包装。
- 可用预算扣除已有上下文、当前请求、附件估算，以及至少 16,000 或窗口四分之一的预留。
- 无容量信息时假定 128,000；图片每个预留 8,192，其他附件 4,096。

这些是源码中的估算与 fallback，不是精确 tokenizer，也不是任意自定义模型都能接收的保证。当前请求不会为了容纳历史被截短。

## 4. 投递也有状态，不能只拼一个字符串

`ContextHandoffDelivery.ts` 的重要边界：

- 按 native thread 与已投递 item IDs 过滤、去重，并在发送时再次做预算选择。
- 存储 `pending` 后再调用注入；原生注入成功记录 `injected`，文本随轮发送确认后记录 `inline`。
- 已存在不明确的 pending 注入时抛出 `ContextHandoffDeliveryUncertainError`，不是盲目重复注入。
- `unsent` 仅适用于能证明 Provider 在读入请求前拒绝的情况；不能将普通超时当作未发送。
- compaction 不能接收 inline 历史时可以暂存到普通轮次，而不是假装已经补齐。

因此值得借鉴的是“覆盖范围 + 正文快照 + 投递归属 + unknown”，不是整套 Effect/orchestration/event-store 架构。

## 5. Scry 的实际起点

| 入口 | 核查结果 | 对本项的影响 |
| --- | --- | --- |
| `src/renderer/App.tsx` → `ChatView` | 有 active session、busy 或 loading 时 `agentLocked` | 当前不支持直接在既有会话里改 Provider |
| `AgentForkSessionRequest`、`agent:forkSession` | 单一 providerId；读取该 Provider 的 archive，验证原生 turn 边界，再调用同 Provider facet | 不应把它扩成跨 Provider 的“假原生 fork” |
| `ProviderRunRequest` | prompt、resume、attachments 等；没有通用历史注入 facet | 第一版只能诚实采用文本上下文交接，不能宣称 native message injection parity |
| `TraceArchive` / `TraceArchiveTurn` | Provider/session/run 身份、用户文字、事件、终态及证据 | 可作为 main-owned 来源；不能复制旧事件到目标后把它们计为目标执行 |
| `session-history.ts` | 默认只展示最近 40 轮，`partial` 不代表此前不存在 | 禁止只拿 renderer 当前页生成“完整会话摘要” |
| `startAppRun()` | `expectedExternalSessionId: null` 显式要求新 session；已有 displayPrompt / 私有 providerPrompt 分离 | 可复用真实新建和运行入口，不增加第二套 Provider runner |
| `ContextAdmission` | 当前只有单 key 串行 admission | 同时校验源边界与目标启动，需要明确跨 key 的准入，不能反序嵌套造成死锁 |
| `CommandReceipts` | 内存去重，失败撤销，最多 256 项；不持久化 | 不能作为重启后或未知投递结果的 exactly-once 保证 |

还必须复用 workspace authorization、provider operation gate、target run controls、trust/fingerprint、run registry 与正常停止/归档路径。Pi 没有 MCP 状态 API，不能为了交接去虚构探测或临时注入一个通用 MCP 能力。

## 6. 近期反馈：仅作为风险证据

公开搜索只取最近 5 条结果，针对其中两条直接相关 PR 阅读正文；不是社区反馈的全量统计。以下均为读取时未合并 PR，验证数字是作者自述，本轮未复现，也不能归入上面的固定源码快照。

| 反馈 | 对 Scry 的启示 |
| --- | --- |
| [#19557](https://github.com/pingdotgg/t3code/pull/19557)：Codex 共用原生历史的账号切换涉及 writer owner、确认关闭、后代与共享进程 | 账号/Profile 兼容不能靠相同 providerId 推断；不把 unsubscribe acknowledgment 当作释放原生 writer 的证据 |
| [#19803](https://github.com/pingdotgg/t3code/pull/19803)：自定义 Claude 模型缺少目录容量，fallback 128K 导致 handoff 被错误拒绝 | 已知/未知容量必须分开；不要把固定猜测包装成目标模型的真实上下文窗口 |

## 7. 可复核源码

以下链接都固定到研究 commit。阅读范围包括完整 switch planner、delivery、用户说明，及 handoff builder/budget/集成测试中与本项有关的小节；没有声称读完大型集成测试或执行过这些测试。

- [ProviderSwitchService.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/apps/server/src/orchestration-v2/ProviderSwitchService.ts)
- [ProviderSessionTransitionPolicy.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts)
- [ContextHandoffService.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/apps/server/src/orchestration-v2/ContextHandoffService.ts#L414-L496)
- [handoffBudget.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/packages/provider-core/src/server/handoffBudget.ts#L94-L285)
- [ContextHandoffDelivery.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/apps/server/src/orchestration-v2/ContextHandoffDelivery.ts)
- [ProviderSwitch.integration.test.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/apps/server/src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts#L500-L714)
- [用户说明](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/docs/user/portable-handoffs.md) / [有差异的内部说明](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/docs/internals/context-handoffs.md)

建议实施合同见 [Scry 跨 Provider 接续技术方案](provider-handoff-technical-plan.md)。
