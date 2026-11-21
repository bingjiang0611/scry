# P6 · §E 证据与用量（草案）

属于 [P6 草案](P6-multi-agent-draft.md)。状态：草案，未批准。2026-11-19 评审后从 [security](P6-multi-agent-security.md) 拆出并修订（评审 E1–E3、S7）。行号说明见草案开头。

## E1. 任务结局与摘要

- **结局**：取子 run 的结局，原样映射；不从最终回复推断「任务成功」（GLOSSARY「运行结果」）。`unavailable(host_restarted)` → 任务 `unavailable`，不是 `failed`（P4 决定 12）。Scry 确认被拒为 `declined`，等用户超时为 `unavailable(interaction_timeout)`。
- **摘要**：`Evidence<string>`，取 trace 归档里的最后一条助手消息，≤ 2 KiB 预览。
  - **继承归档的两个标记**：归档消息的 `status`（如 `partial`）与 `quality`（如 `inferred`）原样带上，不升为 `available`/`exact`（P4 data §3.2「两个标记，原样携带」）。首稿一律写 `exact`，作废。
  - 截断：`status: 'partial'`，质量不变。
  - 最后一条消息为空或不存在：`unavailable`，`omissionReason: 'empty_final_message'`；归档读不到：`unavailable` + 原因。
  - 最终回复存在不证明任务完成。
- **结果引用**：`task-result:<taskId>` 解析为子 run 的 `run.finalized` 事件（R10）。事件 30 天后裁剪（P4 data §4.8）；裁剪后解析返回 `unavailable`，`omissionReason: 'evidence_trimmed'`，任务行与摘要仍在（tools §6.5）。`scry_task_result_read` 从归档分页读，归档已清理时同样 `unavailable` 并写原因（L6）。

## E2. 子会话首轮不是用户轮次（D17）

- 子会话的首轮由 Agent 写成（R3 的 `author: 'agent'`）。Provider 看到的却是一个普通的主会话首轮，recorder 会照常记为主 Agent 轮次。
- 维护者 2026-11-19 决定：**不改 recorder 合同，Recorder Core 不动**。凡统计「用户轮次」的地方（人工介入次数、主轮次分母），按 run id 关联编排 projection 的 `orch_p_turn.author`，`agent` 的排除。
- 关联不上（编排库不可用、记录早于 P6、外部会话）：作者按 `unavailable` 处理，不当作用户轮次补齐；统计照实标 `partial` 并写「N 个轮次的作者不可用」。

## E3. 用量

用量不进事件（P4 data §3.3）。父会话的「含子任务」在读取时按谱系汇总各子 run 的轮次记录：

- **单位分开**：Token、美元、Credits 不合计（GLOSSARY「用量」）。Credits 只到已知请求，不宣称整轮总额。
- **质量并列，不合成**：`exact`、`estimated`、`inferred` 三者之间没有约定的强弱序（GLOSSARY「证据质量」只给定义），所以每个单位按质量分栏小计并列显示，例如「Token：精确 12,400 · 估算 3,100」，不合成一个带单一质量的总数。首稿的「质量取最弱」没有定义 `estimated` 与 `inferred` 谁更弱，作废。
- **缺失**：任一子 run 的用量 `unavailable`，合计 `status: 'partial'`，写「N 个子任务的用量不可用」；从不按 0 计。
- 父 run 自己的用量不含子任务，两者分开显示，避免重复计数。

## E4. 同一工作区并行写（评审 S7）

- 子任务与父 run、兄弟子任务共用一个工作区并同时运行时，文件改动无法可靠归给单个 run。此时每个相关 run 的文件足迹与提交归属标 `partial` 或 `inferred`，并写「同一工作区有并行运行」；不归给单个 run，也不显示为 `exact`。
- 判定依据是编排 projection 中运行区间的重叠（同一 canonical cwd、未终态时间段相交），不靠猜测改动内容。
- 文件足迹本就不是完整审计日志（AGENTS 开头）；工作树隔离（第二切片）是让归属回到 `exact` 的途径。
