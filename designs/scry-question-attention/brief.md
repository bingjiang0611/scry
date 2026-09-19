# 等待回答提醒与问答减法 · 2026-09-17

## 任务
用户在 Agent 暂停等待选择时，需要在会话列表直接识别“待回答”，进入会话后快速读懂问题并完成选择。成功表现：侧栏不再用运行中转圈表示等待；问题、选项和自定义回答入口都只出现一次。

## 约束
- H1（用户）：需要回答时，在会话列表提醒用户，而不是转圈。
- H2（用户）：优化当前问答区域，去掉重复文案；先出设计稿，不改生产 UI。
- H3（项目）：保留真实运行/等待语义，不把等待伪装为完成或错误。
- S1（现状）：沿用 Scry 深色桌面工作台、蓝色选中态和现有会话分组结构。
- A1：本次先采用单一明确修复方向；属于同模式局部修复，不扩展为三套视觉方案。

## 范围
- 改：会话行的“待回答”状态；AskUserQuestion 等待态的文案层级、选项密度与自定义回答入口。
- 保留：侧栏信息架构、项目分组、当前会话选中态、单选/提交/取消流程、Agent 正在等待这一事实。
- 阶段：先在独立原型确认；用户选择后实施生产 UI 与最小待回答事件接线。
- 不做：已回答结果态、权限确认卡、全局视觉重设计。

## 状态 / 尺寸
- 目标：macOS 桌面宽屏，原型画布 1440×900；内容在 1120px 下仍可滚动查看。
- 展示：1 个待回答问题、未选择、选择后、展开“其他”输入。
- 相邻状态：普通运行中仍可保留 spinner；只有 pending question 切换为琥珀色“待回答”徽标。

## 现状
- 生产组件：`src/renderer/components/Sidebar.tsx`、`AskUserQuestionDialog.tsx`、`ChatTurn.tsx`。
- 样式：`src/renderer/styles.css`；等待回答仍沿用 `.sb-running`。
- 截图问题：标题与正文重复；每个选项重复“选择此项”；`Type something.` 与“其他”形成两个自定义入口；底部再次提示未回答。

## 复用
- 查库结果：0 条命中；发现 `P-PI-MODEL-SELECTOR` 来源路径缺失，属于 stale，未把它当作可复用证据。
- 复用当前 Scry 的 sidebar、tool card、radio option、accent/warn 语义；不引入新组件库。

## 验收
- 视觉：侧栏当前会话右侧清晰显示“待回答”，无 spinner；问答卡只有一份问题正文和一个自定义入口。
- 交互：选项可选；选择后提交按钮启用；“其他”只展开一个输入框；Esc/取消仍可见。
- 安全：不改变实际回答提交、权限或 Provider 语义。

## D-20260917-question-attention
- Scope / status：project:scry / confirmed（需求与设计方向；生产成品待目视验收）。
- Feedback：用户要求“需要用户回答的时候在会话列表提醒用户，而不是转圈”“去掉重复文案，先出设计稿”；随后选择“按此稿实现（推荐）”。
- Rule / reason：pending question 是需要用户行动的注意态，不属于持续运行进度；侧栏用琥珀色“待回答”替代 spinner。问答卡只保留一次问题正文、一次有信息量的选项说明和一个“其他”入口。
- Preserve：普通运行中仍使用 spinner；已完成/未读状态不改；原始问题与回答值、Provider 归属和取消/提交语义不改。
- Applied：选定原型 `index.html`，SHA-256 `c46ee6768097fb6ab8ad395af9d924a42a3aaf075f9860f7e4ef3615a2abc9b3`。生产实现涉及全 run 待回答事件、Sidebar 徽标、AskUserQuestion 展示归一与 focused 回归测试。
- Evidence：`npm run typecheck`、229 个 focused Vitest、`npm run build` 通过；原型在 1512×799 浏览器实际渲染。真实 Provider pending question 未在本轮新启动的 App 中重放。
- Acceptance：原型方向已获用户明确选择；生产 UI 待用户目视验收。
- Revisit：多问题排队、超长自定义答案或后台会话问题关闭后状态残留时复核；不升级为跨项目视觉偏好。
