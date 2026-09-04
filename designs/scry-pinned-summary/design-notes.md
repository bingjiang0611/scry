# Scry 固定摘要 · 设计说明

## 目标

把 Codex 与 Qoder 的上下文摘要能力整合进 Scry 现有右侧 Surface 工作区，让用户无需离开对话即可查看当前运行环境、可用能力、关联活动、外部来源与产物。

## 参考来源

### 继承 Codex

- `Environment` 作为第一层级：Changes、Local、branch、Commit / push。
- Side chats、Subagents、Sources 作为持续累积的上下文。
- 固定摘要开关、短行项目与紧凑信息密度。

### 继承 Qoder

- Skills & MCP 单独成组，不埋在调用列表中。
- Artifact 与 Web reading 明确列出。
- 图标容器帮助快速扫读不同资源类型。

### Scry 自有语义

- 不把 Provider 差异抹平：没有状态 API 时显示“不可用”。
- 数值附带证据来源/质量，不用 `0` 代替缺失。
- Commit、push、分支等操作进入 Scry 现有 trust / confirmation 流程，摘要本身不绕过授权。
- 固定摘要作为现有右侧 Surface 的 `摘要` 页，而不是再叠加一层浮动抽屉。

## 信息架构

1. **当前会话卡**：任务标题、Provider、workspace、branch、运行状态、证据质量。
2. **环境**：工作区变更、运行位置、Git 分支、受控提交与推送入口。
3. **Skills & MCP**：本轮使用的 Skill、MCP 连接和明确的 unavailable 状态。
4. **关联活动**：Side chats 与 Subagents。
5. **来源与产物**：用户提供链接、Web reading、生成文件和完整列表入口。

## 关键交互

- 顶栏图钉切换“固定在当前会话”与“离开会话自动收起”。
- 面板可收起为 52px rail，并可恢复。
- 每组可折叠，保留长会话下的浏览位置。
- Changes 跳转 Diff Surface；Subagents 跳转 Agent Surface；产物跳转 Files Surface。
- Commit / push 仅打开受控流程，不在摘要中直接执行。

## 设计边界

- 本设计稿使用示例数据，不代表 Provider capability parity。
- 不在首版中混入完整 Analytics、Diagnostics 或 trace event 列表。
- Sources 只聚合已被 Scry 观测或用户明确提供的来源；不从文本内容猜测来源。
- Side chats 需要独立的会话关系合同，不能只按标题或 cwd 猜测。

## 待产品确认

- “固定”的持久范围：仅当前会话、当前 workspace，还是全局。
- Commit / push 是否首版进入摘要，或只保留到 Workspace / Diff Surface。
- Sources 是否允许用户手动添加，还是首版仅展示自动观测结果。
