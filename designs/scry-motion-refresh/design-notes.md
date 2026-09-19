# Scry UI 精修 — 设计说明（motionsites 借鉴）

## 决策记录（2026-09-15）

- 用户**选定方向 A**；并确认**分析页保持现状**（现有分析页「目前这样挺好」，见其提供的截图）。
- 关键发现：已上线的分析页（`src/renderer/AnalyticsView.tsx` + `analytics-evidence.css`）已是更精致的**编辑级语言**——近单色暖中性、hairline 分隔而非重卡片、编辑级大字号 + `tabular-nums`、eyebrow 标签、证据写进排版（虚线=近似/下界、斜纹=未知、`—`=不可用）。这是 App 的真实精致基准，比第一版 A（卡片 + 亮蓝强调）更克制。
- 因此把方向 A **演进为对齐分析页的编辑级语言**，并只应用到尚未跟上的两个界面：**工作台 + 欢迎**。分析页不动。
- 新交付稿：`Scry A Editorial.html`（方向 A 编辑级 · 深浅双主题 · 工作台/欢迎，分析页仅留「保持现状」说明）。第一版对照稿 `Scry Motion Refresh.html` 作为方向探索保留。

## 对齐真实最新 UI（2026-09-15 迭代）

用户要求“打开 Scry app 看目前什么样，基于最新 UI 优化”。已观察真实运行的 Scry.app（light），据此修正原型：

- **删除工作台顶栏的 对话/拓扑/分段 tabs**——真实 app 没有这组 tab（用户截图确认）。顶栏改为：`📁 项目名` + 右侧汇总/环境图标 + 面板切换，与真实 app 一致。
- **欢迎页改为精炼卡片版（Motion Refresh A flavor）**：编辑级 hero（不用渐变，克制）+ 新建/恢复 CTA + 项目卡片网格（provider mark + 绑定 chip + tabular 会话/活跃）+ 本机状态卡片（Provider CLI / MCP 0 / 15 warn / 近 7 天 2.4M exact）。内容均为真实功能。
- **composer 底部对齐真实控件**：完全访问（amber = 权限语义诚实）/ Provider(Qoder) / 模型选择（Ultimate 默认）/ 发送。
- 交付形式：用户选定**先更新设计稿**，本轮仍未改任何 `src/` 生产代码。
- 已浏览器核对：dark 工作台（无 tab、项目名顶栏、footer chips）、dark 欢迎（卡片）均无破版，证据语义正确。

## Provider 图标 + 固定摘要（2026-09-15 迭代）

用户反馈：“看下目前 Qoder 和 Pi/codex 的图标是什么，替换这个黄点，这块好好设计”、“目前的摘要为什么没了”、“这是一次 UI 重构，不要遗漏任何 ui/ux，原型中要体现每一处细节”。

- **真实 Provider 品牌图标集**取代通用彩点（以 CSS mask + SVG data-URI 实现，用 --s-* 系列色上色，与真实 app provider 色一致）：
  - claude = Anthropic 星芒；codex = OpenAI 六瓣花簇；qoder = 环形 Q（取自 Qoder.app 图标的 loop/Q）；opencode = 嵌套门框（取自 OpenCode.app）；pi = π。
  - 新增 `--s-pi` 色 token（dark #ab9cf2 / light #6a5fae）；未探测（.miss）用置灰字形。
  - 真实参考图标提取到 /tmp/prov-icons/{qoder,opencode,chatgpt}.png。
  - 已核对渲染：claude 星芒 / codex 花簇 / qoder Q 在侧栏与项目卡片可见；opencode/pi 同一 mask 机制，已在 DOM 。
- **补回固定摘要（PinnedSummary）**：顶栏第一个图标 = “固定摘要”开关，弹出 Environment（Changes +/− diff、workspace）+ Context（Skills & MCP · 本会话、Web 引用、子 Agent），证据以 —/虚线下划线表达未知。
- **composer 底栏对齐真实**：完全访问（amber = 权限语义）/ Provider(Qoder 带字形) / 模型选择 / 发送。Provider CLI 卡片列出全 5 个 Provider。

> 待办：“不遗漏任何 ui”是一个持续 parity sweep。已知可继续补齐的真实 app 细节：聊天内的工具调用可展开块 / hook 行 / 分支动作；纵览逐轮 T01 的结构化介入 / 子 Agent chip；账单卫士 / MCP 信任 tab 内容；session hover 卡；譊断 nav 页。

---

设计稿：`Scry Motion Refresh.html`（方向对照，历史）；`Scry A Editorial.html`（**当前采用**）。
预览：`cd designs/scry-motion-refresh && python3 -m http.server 8793 --bind 127.0.0.1` 后访问
`http://127.0.0.1:8793/Scry%20Motion%20Refresh.html`；或直接用浏览器打开该 HTML。
顶部可切换 **方向 A/B × 主题 深/浅 × 界面 工作台/欢迎/分析**，同框对照。

## 从 motionsites.ai 真正借鉴了什么

motionsites 是**营销落地页**画廊（电影感暗色 hero、3D 渲染、玻璃拟态、大编辑体标题、重动效）。Scry 是信息密集的**专业观测/治理工具**，直接照搬会伤害扫读效率与「证据不说谎」。因此只提炼可迁移的「精致」手法：

- 分层玻璃表面 + 发光边（渐变描边）代替单纯描边
- 柔和景深径向辉光、克制阴影建立层级
- 编辑级排版层级（eyebrow / 大标题 / 舒展正文 / mono 遥测）
- 单一强调色收敛为**渐变线/环**而非大面积色块
- 平滑 hover 抬升 / focus 微光 / active 会话微光泽（180ms ease）
- **不上**全屏视频、3D 背景、重入场动效

## 两个方向

| 方向 | 结构 | 精修手法 | 代价 | 适用 |
| --- | --- | --- | --- | --- |
| **A · 精炼专业** | 与现状同，三栏密度不变 | 三档中性表面 + hairline、柔和阴影、编辑级标签、渐变环形图、hover/focus 微交互 | 视觉冲击弱 | 长时间观测、扫读优先（对话流 / 纵览） |
| **B · 电影感暗色** | 结构同，纵览/欢迎标题放大 | 景深径向辉光、卡片渐变发光边、玻璃面板、渐变强调字与 logo、active 会话微光泽 | 密度略降、深色更沉 | 强质感 / 展示（欢迎页、空态、hero 时刻） |

两版共用 `src/renderer/styles.css` 的真实语义色板（provider/ok/warn/bad、surface 分层），深浅主题分别校准；证据语义（exact / estimated / unavailable / 未知 / 真实 0）在两版里都保持产品含义，精修不改变它。

## 覆盖界面

1. **主工作台三栏**：侧栏会话列表 + 对话流（顶栏 tab、turn 页脚遥测、composer） + 右侧纵览（上下文环、会话判决、KPI 网格、每轮调用证据条含「风险 未知」）。
2. **欢迎 / 仪表盘**：渐变 hero、新建/恢复 CTA、项目绑定卡、本机状态（Provider CLI 探测 / MCP 0/15 / 近 7 天用量 exact）。
3. **分析 / 账单 / 诊断**：KPI（总 Token exact、成本 estimated、会话数、风险事件 **— unavailable**）、每日用量柱状、Provider 分布、诊断行（Recorder / MCP 授权 / Hook 指纹 auto_grant）。

## 我的推荐（供参考，不代替你的选择）

**A 为日常密集面（对话流 / 纵览 / 分析表格）的基线，B 的电影感只用在欢迎页 / 空态 / hero 这类不需要密度的时刻**——即「A 打底 + B 点缀」的混合，最贴合专业工具身份，又拿到 motionsites 的精致质感。纯 B 用于全工作台会牺牲扫读效率。

深浅：两套都已校准；建议保留深色为默认（与当前一致、也是 motionsites 的主基调）。

## 已验证 / 待确认

- 视觉：dark/light × A/B × 三界面已在浏览器内逐一渲染核对（截图见本轮记录），布局无破版、证据语义表达正确。
- 待确认：方向选择（A / B / A+B 混合）与是否接入生产。**本次仅设计稿，未改任何 `src/` 生产代码。**

## 全量对齐 sweep（第 N 轮 · 与真实最新 App 校准）

以真实运行的 Scry.app + 生产源码为准，把原型逐处修正：

- **固定摘要（PinnedSummary）位置修正**：从（错误的）左上改为**主区右上、顶栏下方的浮层**（对齐 `.pinned-summary-layer { position:absolute; top:topbar-h; right:0; width:min(326px) }` + 20px 圆角卡片），不再遮挡顶栏切换按钮。
- **对话流补齐每处 UI**：用户消息气泡（右对齐）、`● claude run · run-id`（含 tok/tools）运行头、`本轮 Hook · N 个周期 · N 个处理器实例` Hook 行、工具调用卡（Read/Bash/Glob，含状态圆点 ✓、op 标签、arg、耗时、chevron）、`在新会话中分支` 动作；数值内部自洽（tools 3 = tfoot Tools 3 = 纵览调用 3）。
- **每轮调用证据条补齐并对齐顺序**（OverviewPanel）：耗时 / **结构化介入** / MCP / Skill / **子Agent** / Hooks / 文件（补上此前缺失的结构化介入、子Agent；移除真实每轮并不存在的「风险」chip）。
- **右侧面板 tab 模型修正（重要）**：真实 App 的右侧是 **Surface 工作区**——可开关的 tab（纵览 / 文件 / Diff / 终端 / Agents），每个 tab 带关闭 ✕，`+` 打开添加菜单，右上角为最大化 / 隐藏面板。**`账单卫士` 与 `MCP 信任` 已在真实 App 中移除**（render.test：「总览只保留纵览内容，不再提供账单卫士和 MCP 信任入口」），原型原先的固定三段 tab 是过时的，已替换。
- Provider 会话身份自洽：该会话统一为 Claude（sidebar hello / 运行头 claude / 上下文 claude-opus-4-8 / composer 页脚 Claude + claude-opus-4-8）。

### 本轮仍未落地（下一批）
- 侧栏「诊断」导航页内容；会话行 hover 卡。
- 右侧其余 Surface 内容：文件浏览、Diff 审阅、终端、Agents（子 Agent 状态/活动/工具调用）。
- 纵览「总览 / 会话证据」二级视图（当前只呈现总览视图）。

**本轮仍为设计稿，未改任何 `src/` 生产代码。**
