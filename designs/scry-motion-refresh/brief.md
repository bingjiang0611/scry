# Scry UI 精修（motionsites 借鉴）· 2026

## 任务
交互流程已稳定，用户要在**不改交互链路**的前提下，让 Scry 的 UI 更精致，借鉴 https://motionsites.ai/ 的优秀设计；先出设计稿供确认。

## 约束
- H1（产品身份）：Scry 是 local-first 的 AI coding agent 观测与治理**专业工具**，信息密集、需快速扫读；不是营销落地页。来源：CLAUDE.md「证据不能说谎 / 不是营销仪表板」。
- H2（证据诚实）：`exact/estimated/inferred/partial/disabled/unavailable/unknown` 是产品语义，缺失不能伪装成 0/绿色/无风险。视觉精修不得削弱这一点。
- H3（不改交互流程）：三栏工作台、tab、composer 的信息结构与操作路径保持；这次是表现层精修。
- S1：借鉴 motionsites 的「精致感」= 分层玻璃表面、柔和景深/阴影、编辑级排版、克制的渐变点缀、平滑 hover/focus 微交互；**不上**全屏视频/3D 背景/重动效。
- S2（用户已选）：**两版对照**——A 精炼专业工具、B 电影感暗色；**深浅都做**；覆盖主工作台、欢迎/仪表盘、分析/账单/诊断。
- A1（假设）：沿用现有真实语义 token（dark/light 均来自 src/renderer/styles.css），只调层级/景深/排版/点缀，不发明业务状态。

## 现状
- 源码：`src/renderer/`，样式 `styles.css`（已有完整 dark/light token）。已有一版 approved「Workbench」方向（designs/scry-ui-refresh，2026-08）。
- 当前渲染：三栏（侧栏会话列表 / 对话流 + 顶栏 tab / 右侧纵览 + 账单 + MCP），暗色默认。截图见 designs/scry-ui-refresh/reference-current-light.png。

## 复用
- 直接复用 styles.css 的语义色板（provider/read/write/ok/warn/bad、surface-* 分层）作为两版共同底座，避免另造第二套配色。

## 两版方向差异
| 方向 | 信息结构 | 精修手法 | 放弃 | 适用 |
| --- | --- | --- | --- | --- |
| A 精炼专业工具 | 与现状同（三栏密度不变） | 分层中性表面+hairline、柔和阴影、编辑级标签排版、渐变环形图、hover 抬升/focus 微光、克制点缀 | 视觉冲击 | 长时间观测、扫读优先 |
| B 电影感暗色 | 结构同，纵览/欢迎标题更大 | 景深径向辉光、卡片发光边（渐变描边）、玻璃面板、渐变强调字、active 会话微光泽 | 部分密度 | 需要更强质感/展示 |

## 验收
- 视觉/交互：dark+light 两主题 × A/B 两方向 × 三类界面在原型内可切换对照；关键状态（active 会话、unknown/unavailable 证据、风险为 0 vs 未知）表达正确。
- 用户验收：选定方向后再谈接生产；本次仅设计稿待确认。
</content>
