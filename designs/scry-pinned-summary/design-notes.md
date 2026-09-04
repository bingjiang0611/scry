# Scry 轻量固定摘要 · 设计说明

## 当前方向（v3）

固定摘要不是整高 Surface，也不是覆盖消息的浮层。它由对话顶栏按钮打开：主会话主动收窄，右侧出现固定宽度的占位 rail，轻量摘要卡只放在 rail 顶部。关闭后 rail 完全收起，主会话恢复全宽。

## 只展示五类信息

1. **Changes**：文件数量、增加行、删除行；点击进入 Diff / Workspace。
2. **分支名称**：当前 Git branch；点击进入分支与工作区详情。
3. **Skills & MCP**：汇总数量和可用状态；点击进入 Skills / MCP 详情。
4. **Web reading**：本轮已读取网页数量；点击查看有证据的网页来源。
5. **Subagents**：总量与 done / running 状态；点击进入 Agents Surface。

不在轻量摘要中展示任务卡、Local、Commit / push、Side chats、Sources、Artifact 或完整证据列表。

## 视觉与交互

- 参考用户提供的 Codex 卡片：白色、细描边、约 384px 宽、25px 圆角、低对比阴影。
- 卡片所在 rail 参与页面布局，消息、代码、附件和输入框绝不会延伸到 rail 下方。
- 信息使用大行高与单列排列，不用嵌套卡片。
- 顶栏摘要按钮控制 rail 显示/隐藏；点击五个信息行跳转到现有详情 Surface。
- Footer 只保留一句证据质量摘要，避免抢占视觉层级。

## 证据约束

- Changes 必须来自真实 Git diff；采集失败时显示 `— / 不可用`，不能显示 `+0 −0`。
- branch 必须来自当前 canonical workspace；无 Git 仓库时显示 `非 Git 工作区`。
- Skills、MCP、Web reading、Subagents 必须基于各自真实可观测能力聚合。
- Provider 不提供某项能力时明确显示 unavailable，不为对齐 UI 推断数量。
- started / progress / response 仍按 logical call 去重后计数。

## 已归档方向

- `Scry Pinned Summary.html`：整高右侧 Surface，结构过重。
- `Scry Pinned Summary v2.html`：覆盖主会话的悬浮卡，会遮挡消息。

二者均不作为实现蓝本。
