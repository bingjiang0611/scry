# Scry 轻量固定摘要 · 设计说明

## 当前方向（v11）

固定摘要不是整高 Surface，也不是覆盖消息的浮层。它由对话顶栏按钮打开：主会话主动收窄，右侧出现窄版占位 rail，约 300 × 520px 的轻量摘要卡只放在 rail 顶部。关闭后 rail 完全收起，主会话恢复全宽。

## 只展示五类信息

1. **Changes**：文件数量、增加行、删除行；点击进入 Diff / Workspace。
2. **分支名称**：当前 Git branch；点击进入分支与工作区详情。
3. **Skills & MCP**：汇总数量和可用状态；点击进入 Skills / MCP 详情。
4. **Web reading**：本轮已读取网页数量；点击查看有证据的网页来源。
5. **Subagents**：总量与 done / running 状态；点击进入 Agents Surface。

不在轻量摘要中展示任务卡、Local、Commit / push、Side chats、Sources、Artifact 或完整证据列表。

## 视觉与交互

- 参考用户提供的 Codex 卡片：白色、细描边、约 300px 宽、520px 高、20px 圆角、低对比阴影。
- 卡片所在 rail 参与页面布局，消息、代码、附件和输入框绝不会延伸到 rail 下方。
- 信息使用大行高与单列排列，不用嵌套卡片。
- 顶栏摘要按钮控制 rail 显示/隐藏。
- 打开任意右侧详情 Surface 时，摘要自动收起。
- 详情已打开时再次点击摘要按钮，摘要改为悬浮在详情左侧的临时卡片，不占据第三栏、不触发布局再次收窄。
- 临时摘要支持 click-away 与 Escape：点击主会话、详情或其他空白位置时立即消失。
- Changes 可进入 Diff 详情；当前分支只读展示，不提供展开交互。
- 摘要主行只保留标题、数量与箭头，删除所有灰色辅助小字。
- Skills & MCP、Web reading、Subagents 展开为 Qoder 风格的“图标方块 + 单行名称”列表，不使用分组小标题、树线或状态说明小字。
- 卡片紧贴全局顶栏下方吸顶，主会话滚动不影响其位置。
- 卡片高度固定；折叠项展开后若内容超出，仍可滚动卡片自身，但不展示滚动条轨道或滑块。
- 所有 Skill 使用统一 Skill 图标，所有 MCP 使用统一 MCP 图标。
- Environment 不提供添加按钮，卡片不展示底部证据摘要或“证据详情”入口。
- 某项存在精确证据且数量为 0 时不渲染该行。
- 紧凑摘要只列可用或已发生的项目，unavailable 项不进入此清单；完整 MCP / Diagnostics Surface 仍必须明确展示 unavailable，避免摘要冒充能力全貌。
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
- `Scry Pinned Summary v3.html`：不覆盖主会话，但 384px 卡片仍然偏宽。
- `Scry Pinned Summary v4.html`：宽度合适，但存在无需求的添加、分支展开和证据 footer。
- `Scry Pinned Summary v5.html`：完成静态收敛，但尚未展示 Context 项展开状态。
- `Scry Pinned Summary v6.html`：展开层级和小字过多，不符合参考 UI。
- `Scry Pinned Summary v7.html`：列表样式正确，但整体尺寸和展开高度偏大。
- `Scry Pinned Summary v8.html`：尺寸正确，但未对齐右侧 Surface 的自动收起行为。
- `Scry Pinned Summary v9.html`：误把再次打开摘要实现成持久三栏布局，没有 click-away 语义。
- `Scry Pinned Summary v10.html`：临时悬浮行为正确，但没有吸顶，且滚动条与类型图标未收敛。

以上版本均不作为实现蓝本。
