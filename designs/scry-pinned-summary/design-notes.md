# Scry 轻量固定摘要 · 设计说明

## 当前方向（v13）

固定摘要始终是约 300 × 520px 的悬浮卡，不占用布局列。未打开右侧详情时，它悬浮在主会话右上角并保留 16px 顶部间距；打开右侧详情时自动收起；详情已打开后再次唤起，则悬浮在详情左侧并贴住顶栏下沿。

## 只展示五类信息

1. **Changes**：文件数量、增加行、删除行；点击进入 Diff / Workspace。
2. **分支名称**：当前 Git branch；点击进入分支与工作区详情。
3. **Skills & MCP · 本会话**：只汇总当前会话已加载记录中的调用证据（Skill 调用/注入、MCP 工具调用），显示种类数与逐项调用次数；点击定位首次对应事件。不展示工作区配置清单或当前连接状态。
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
- 普通摘要状态悬浮在主会话右上角，保留顶栏下方 16px 间距，不压缩主会话宽度。
- 右侧详情已打开时的临时悬浮摘要紧贴顶栏下沿吸顶，不重复叠加顶栏高度。
- 卡片高度固定；折叠项展开后若内容超出，仍可滚动卡片自身，但不展示滚动条轨道或滑块。
- 所有 Skill 使用统一 Skill 图标，所有 MCP 使用统一 MCP 图标。
- Environment 不提供添加按钮，卡片不展示底部证据摘要或“证据详情”入口。
- 某项存在精确证据且数量为 0 时不渲染该行。
- 紧凑摘要只列可用或已发生的项目，unavailable 项不进入此清单；完整 MCP / Diagnostics Surface 仍必须明确展示 unavailable，避免摘要冒充能力全貌。
- Footer 只保留一句证据质量摘要，避免抢占视觉层级。

## 证据约束

- Changes 必须来自真实 Git diff；采集失败时显示 `— / 不可用`，不能显示 `+0 −0`。
- branch 必须来自当前 canonical workspace；无 Git 仓库时显示 `非 Git 工作区`。
- Skills、MCP 必须基于当前会话已加载 TraceEvent 的逻辑调用聚合；不能用配置清单、名称提及或 Skill 文件路径引用冒充调用。Web reading、Subagents 沿用各自真实可观测证据。
- Provider 不提供某项能力时明确显示 unavailable，不为对齐 UI 推断数量。
- started / progress / response 仍按 logical call 去重后计数。

## D-20260908-session-capability-calls

- Scope / status：本摘要的信息口径 / confirmed（规则确认，产物验收待确认）。
- Feedback：用户明确要求“这里应该展示这个会话调用的skill和mcp”。替代此前“配置数量/可用状态”的口径。
- Preserve：卡片布局、图标、展开列表，以及 Changes / Web references / Subagents 保持不变；左侧能力配置入口不受影响。
- Applied：`src/renderer/session-capability-calls.ts`、`src/renderer/components/PinnedSummary.tsx` 与 `App.tsx` 接线。复用 Overview 的逻辑调用去重规则；结果和进度不重复计数，失败调用仍计为调用而非成功。
- Evidence：277 项 focused 测试、typecheck、build 通过。后台浏览器使用生产组件与样例会话验证展示、MCP 点击回调及切换空会话清除旧列表；未执行安装版真实会话重放。
- Boundary：仅陈述已加载证据；空态用“尚未观测到”，不推断完整会话从未调用，也不推断 Provider 的实时 MCP 可用性。
- Follow-up defect：Qoder 将显式 `/rate-native-hsf-invoke` 请求落实为成功的 `Read(.../hsf-invoke/SKILL.md)`，没有原生 Skill 事件。首次改动漏掉了此路径。`skill-load-evidence.ts` 现在要求轮首显式技能命令（含工作区前缀别名）与关联的读取成功结果，才把该 Read 在展示层归类为一次 Skill 加载，并标注“加载推断”。普通扫描、路径提及、失败/结果缺失不计入；已有原生调用/注入时不重复推断。原始 Read 保留为点击定位目标，canonical archive / recorder 不改写。
- Follow-up evidence：292 项 focused 测试、typecheck、build 通过。只读重放该真实轮次：Skill 从 0 变为 `hsf-invoke ×1（加载推断）`，总调用数仍为 108。此项为原始归档的展示投影验证，不等同于安装版真实交互验收。
- Revisit：会话分页、调用证据合同或摘要导航改变时复核。此规则不提升为跨项目视觉偏好。

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
- `Scry Pinned Summary v11.html`：误将普通摘要也吸顶，且临时悬浮摘要重复计算了一次顶栏高度。
- `Scry Pinned Summary v12.html`：顶部间距正确，但普通摘要仍错误占用布局 rail。

以上版本均不作为实现蓝本。
