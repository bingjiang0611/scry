# Pi RPC：工具终止与超大快照回归

## 用户场景与证据

- etch：`goal_complete` 后显示红色 `toolUse`。只读检查原生 session 的结构化回执，内容为 completion review unresolved（review tool-call limit reached），不是目标审核通过。
- 对应 Scry 修复已经在 `7fe65f1`：只有当前 assistant 的匹配工具回执明确 `terminate: true`，且工具已收敛，才能归类为工具主动终止。保留原始审核未决说明；工具名、`toolUse` 或历史回执本身都不足以证明完成。本次不改写旧 archive，不修改 Rotom 的审核策略。
- Nib：最后回答之后出现“未完成 JSONL 消息超过 64 MiB”。原生记录约 95 MiB，单个工具结果最大约 20 MiB。Pi RPC 的 `agent_end.messages` 会重复整轮消息，`get_entries` 也会返回完整 entry 内容；旧读取器对这些集合先全量缓存再 JSON.parse，集合可越过 64 MiB，即使单个实时工具结果未超限。
- 原始 stdout 未留存；归因依据为原生记录大小、已安装 Pi RPC 的事件序列化实现，以及同形状子进程回归，不冒充原始 wire 抓包。

## 修复与边界

`src/main/providers/pi-rpc-decoder.ts` 使用 `stream-json` 流式解析，避免自行实现 JSON 词法分析。只在对象组装前移除原本未消费的顶层 `messages`、`toolResults`；`data.entries` 保留所有 entry 的 `id`、`parentId`、`type` 与 `message.role`，满足当前 baseline、增量身份与 fork 调用方。

- 实时 `message_end`、`tool_execution_end`、用量、错误、工具终止回执不截断、不重复计数。
- 被移除的内容仍经过 JSON 语法检查；UTF-8 分块、转义字符和特殊属性名保持正确。
- 每条保留消息仍有 64 MiB 上限；属性名流式检查同一上限，嵌套深度最多 1024 层。更大的实时证据应升级为磁盘承载，不继续扩大主进程内存上限。
- 当前所有 `get_entries` 调用方只用上述 identity 字段；未来若需要正文，应显式增加流式消费路径，不能把该投影误当完整历史。
- 不修改 Provider trust、审批、权限、recorder 或已有会话记录。

## 验证

环境：macOS arm64、Node v24.18.0；包含其他并行 WIP 的开发工作区，验证范围不等于全仓发布验收。

```sh
npm run test:unit -- src/main/providers/pi-rpc-decoder.test.ts src/main/providers/pi.test.ts src/main/providers/pi-lifecycle.test.ts src/main/providers/pi-environment.test.ts --fileParallelism=false
npm run test:unit -- src/renderer/components/termination-notice.test.tsx
npm run typecheck
npm run build
git diff --check
```

- 已完成的串行 Pi 套件 91 项通过；随后增加嵌套深度回归，decoder 全部 16 项再次通过；工具终止展示 4 项通过。合计 96 个不同用例有通过记录，覆盖超大快照后 settlement、增量 entry 身份、实时证据不丢失、正常/错误/中止/恢复/fork 邻接路径与 malformed wire 拒绝。typecheck、build、diff check 通过。
- 新增 96 MiB `agent_end` 回归；临时禁用投影后，集合与 entry 两条回归均因上限失败；恢复实现后通过。故意破坏检查中的 13 项过滤跳过不计为通过。
- 对真实 Nib JSONL 做结构化只读回放（非语义全文审阅、非调用 Provider）：700 个 message，序列化正文 99,165,092 字节，`agent_end` 加 settlement 投影 47 字节；另一次 get_entries 回放 1,214 个 entry，原始 payload 99,555,970 字节，投影 91,086 字节。两条路径均通过，没有写入原生记录或 Scry DB。
- 开发首轮使用库内置 ignore filter，发现其延迟交付根对象闭合 token，造成 RPC 回复超时；已替换为立即交付的字段投影，并添加“不等下一帧/EOF”回归。超时遗留的本任务 fixture 进程已按确切身份清理。
- 后续首轮暴露测试 helper 引用错误、测试销毁流的未处理 AbortError，以及提前 EOF 抢先报语法错误的边界 fixture；均修复。非 JSON/截断输入断言改为流解析器的解码错误，仍验证拒绝、进程退出和重新探测。另一次并行运行有单项 5 秒超时，未以重跑抹除；最终按文件串行运行，未加 sleep/retry、未扩大超时。

最后一次尝试合并重跑全部五个文件时，宿主 1 分钟 load 达 352.92，同时出现登录 shell 环境采集 15 秒超时；命令在 120 秒上限终止，没有最终测试摘要，后续串联的 typecheck/build 未执行。已检查日志和进程，不把这次未知结果写成通过，也未盲目重试；上面的通过结果来自此前已完成的独立检查。

未执行：当前 App 的真实长轮次重放、外部 Provider/付费调用、完整发布 gate、打包安装或推送。自动测试与只读回放不证明现有安装版本已经更新，也不代表 Goal 审核未决已解决。
