# iOS 重设计规范

依据：Mac 端 `src/renderer/codex-alignment.css`、`styles.css`、`motion.css`（PR #4）、`components/Sidebar.tsx`、`SidebarActivity.tsx`、`ChatTurn.tsx`、`OverviewPanel.tsx`；设计稿源码在 [mockups/](mockups/)。下面的数值是规范，设计稿与本文不一致时以本文为准。

原则：两端共享**结构、语义、token 和动效**；iOS 保留原生交互（NavigationStack 推入、系统 Sheet、长按菜单、44pt 触控、Dynamic Type）。不把 Mac 的 hover 搬到手机上。

## 1. 颜色

新增一套与 Mac 同名的语义 token，深浅两套，跟随系统（去掉 `Info.plist` 里的 `UIUserInterfaceStyle = Dark`）。

| token | 深色 | 浅色 | 用途 |
|---|---|---|---|
| `bg` | `#151515` | `#f7f7f5` | 最外层画布、代码块底 |
| `sidebar` | `#181818` | `#f7f7f5` | 首页（= Mac 侧栏）底色 |
| `main` | `#1c1c1c` | `#ffffff` | 会话页、Sheet 底色 |
| `panel` | `#1c1c1c` | `#ffffff` | Composer 外壳、按钮底 |
| `panel2` | `#232323` | `#f6f6f3` | 用户气泡、工具组展开体、卡片 |
| `panel3` | `#2b2b2b` | `#eeeeeb` | 禁用发送按钮、轨道底 |
| `border` | `#333331` | `#e4e4df` | 外壳、选项边框 |
| `border2` | `#454541` | `#d3d3cd` | 强一级边框、聚焦边框 |
| `border3` | `#292927` | `#eeeeea` | 发丝分隔线、时间线 |
| `fg` | `#f1f1ef` | `#222220` | 主文字、发送按钮 |
| `dim` | `#b5b5af` | `#62625e` | 次文字、已完成会话标题 |
| `dim2` | `#8d8d87` | `#62625e` | 小号辅助文字（浅色用 `dim` 的值，因为 Mac 的 `#85857f` 在白底只有 3.7:1） |
| `accent` | `#5b9cff` | `#3f7ee8` | 强调、选中、运行中 |
| `accentSoft` | accent 12% | accent 9% | 选中底、运行状态条底 |
| `ok` | `#69cc93` | `#18794e` | 成功、已连接、`+` 行数 |
| `warn` | `#efb958` | `#94620b` | 待回答、警告 |
| `bad` | `#f36c67` | `#bf3f3a` | 失败、停止、`−` 行数 |
| `hover` | 白 6% | `#222220` 5% | 按下态 |
| `subtle` | 白 4% | `#222220` 3.8% | chip 底、搜索框底 |
| `providerClaude` | `#d37ec8` | `#a15397` | Provider 图标 |
| `providerCodex` | `#6aa8ff` | `#3f72b7` | |
| `providerQoder` | `#efa84f` | `#9b6206` | |
| `providerOpenCode` | `#70ca93` | `#28744a` | |
| `providerPi` | `#ab9cf2` | `#6a5fae` | |

注意：浅色 `accent` 在白底约 4.0:1，作文字时只用于 ≥15pt semibold，或改用填充 / 下划线表达。

## 2. 字体（全部用语义 text style，响应 Dynamic Type）

| 角色 | Mac | iOS |
|---|---|---|
| 回复正文 | 14.5 / 1.72 | `.callout`（16pt），`lineSpacing` 约 5 |
| 用户气泡 | 14.5 | `.callout` |
| 会话行标题 | 13.5 | `.subheadline`（15pt），单行截断 |
| 页头标题 | — | `.subheadline.weight(.semibold)`，最多 2 行 |
| 分组标签（需要回复 / 置顶 / 项目） | 12 / 600 | `.footnote.weight(.semibold)` |
| who 行、工具行、页脚、时间 | 11.5 | `.footnote` / `.caption` |
| 等宽（路径、代码、ID） | JetBrains Mono | `.system(.footnote, design: .monospaced)`，代码块 `.caption` |
| Sheet 标题 | — | `.headline` |

最小不低于 `.caption2`（11pt）。不再用 `.system(size:)` 固定字号，代码和数值除外。

## 3. 形状与间距

- 圆角（continuous）：用户气泡 18；Composer 外壳 20；卡片 / 状态条 / 选项 12；Sheet 顶部 18；chip 11；行按下底 10；徽标 6。
- 页面水平边距 16；行最小高 44（进行中 / 需要回复 48，已完成 44）。
- 阴影只用在 Composer 外壳和浮层（模型选择），其余靠底色和发丝线分层。

## 4. 动效（与 PR #4 同一套）

| token | 时长 | SwiftUI |
|---|---|---|
| micro | 100ms | `.linear(duration: 0.10)`：按下反馈、颜色 |
| fast | 160ms | 选中态；收起用 exit 曲线 |
| base | 220ms | 标签下划线、列表入场 |
| slow | 300ms | Sheet 自定义入场、占用刻度填充 |
| ease-out | | `.timingCurve(0.23, 1, 0.32, 1, duration:)` |
| ease-struct | | `.timingCurve(0.32, 0.72, 0, 1, duration:)` |
| ease-exit | | `.timingCurve(0.4, 0, 1, 1, duration:)` |

用法：
- 标签下划线滑动：220ms struct，`matchedGeometryEffect`。
- 折叠展开（思考、工具组、项目分组）：展开 240ms struct，收起 160ms exit；箭头同步旋转 90°。
- 列表入场：opacity 0→1 + 上移 4pt，220ms ease-out，每行延迟 16ms，最多错开 10 行；只在首次出现时播，刷新不重播。
- 流式输出新块：180ms ease-out 淡入上移 4pt。
- 会话在「动态」各段之间移动：位置动画 220ms struct；手指按住时不移动。
- 运行环：900ms 线性旋转。
- **减少动态效果**：所有位移 / 缩放 / 展开改为 120ms 淡入淡出；运行环保留旋转（它是状态，不是装饰），流式光标不闪。

## 5. 页面

### 5.1 首页（取代现在的 HomeView + HomeDrawer）

首页就是 Mac 侧栏，`sidebar` 底色。自上而下：
1. 头部 48pt：左边主机 chip（胶囊、`panel2` 底、7pt 状态点：已连接 `ok` / 配对中 `warn` / 离线 `dim2`，后接主机名和上下箭头，点开是现在的主机筛选菜单）；右边设置按钮 44pt。
2. 搜索框：38pt 高、圆角 10、`subtle` 底、`border3` 发丝边，占位「搜索会话 / 项目…」。
3. 标签「项目 | 动态」：`.subheadline` medium，选中 `fg`、未选 `dim2`，下面 2pt `fg` 下划线滑动；整行下方一条 `border3` 线。默认停在「动态」，记住上次选择。
4. 列表（可滚动，下拉刷新保留）。
5. 底部 Composer 外壳（见 5.4，带项目 / Provider chip），保留现有 HomeComposer 的发送逻辑。

**动态**（对应 Mac `SidebarActivity`）：三段「需要回复 / 进行中 / 已完成」，每段一个标签加通栏发丝线（进行中和需要回复的标签 `fg`、线 `border2`；已完成标签 `dim2`、线 `border3`）。行：Provider 图标 16pt + 标题（单行）+ 右侧状态列：
- 需要回复：`warn` 12% 底的「待回答」徽标；
- 进行中：运行环；
- 已完成：相对时间，标题用 `dim`，行高 44。
不显示项目副标题、不显示数量徽标。每段最多 40 行，多出显示「另有 N 条，请搜索定位」。分组规则必须和 Mac `sidebar-activity.ts` 一致：等待回答 → 需要回复；有运行中的 run → 进行中；`lastRunOutcome == completed` → 已完成；其他都不进动态。iOS 拿不到 Mac 判定所需字段的，报告里写明，不要猜。

**项目**：
- 「置顶」段：行尾补项目名（`dim2`，最长约 70pt）。
- 「项目」段：项目行 44pt（箭头 + 文件夹图标 + 名称 semibold + 会话数 `dim2`，右侧「+」在该项目新建会话）；展开后会话行缩进 18pt，行尾依次是未读点（`accent` 7pt）/「待回答」/运行环 / 相对时间。
- 「工具」段：两列网格，分析、LLM 性能、技能、MCP 等，对应现在 drawer 的工具页。
- 会话行的长按菜单保留现在的置顶、重命名、归档。

现在首页上的「回到任务」卡片、后台发送队列、刷新失败横幅、未核验缓存提示都保留，放在标签行上方，样式改成 12 圆角 `panel2` 卡片。

### 5.2 会话页（ChatView / SessionTranscriptView）

底色 `main`。
- 头部 56pt，下方 `border3` 线：返回 44 / 标题（最多 2 行）+ 副标题（Provider 图标 + 「项目 · Provider」，`dim2`）/ 总览按钮 44（打开 5.3 的 Sheet）/ 更多菜单 44。现在的「文件」按钮移进更多菜单。
- 一轮：
  - 用户气泡右对齐，左侧留 15% 空白，`panel2` 底、圆角 18、内边距 10/14、极淡阴影。长按菜单保留（复制、本轮详情）。
  - who 行：6pt 圆点（运行中换成 `accent` 运行环）+ Provider 名 + 模型 · 强度（只有主机提供了本轮实际模型才显示；Composer 里选的偏好不等于本轮实际模型，不能拿来填）。
  - 内容流：左侧 20pt 缩进，3pt 处一条 1pt `border3` 竖线。块之间 12pt。
  - 思考：折叠行「思考」+ 箭头，`dim2`；有时长证据才显示「· N 秒」。展开为 `dim` 色正文。
  - 工具组：连续的工具调用合成一行「已运行 N 个工具」+ 按类别的小徽标（如「读取 3」「编辑 2」）+ 右侧时长（有才显示）。展开是 `panel2` 底、圆角 10、`border3` 边的列表，每行「类别 + 等宽路径 + 行数增减」。N 按收到的条目数计；输出被截断时写「至少 N 个」。
  - 回复正文 `.callout`，行内代码 `subtle` 底圆角 5，代码块 `bg` 底圆角 10。
  - 页脚：`border3` 上分隔线，左「N 个文件 +a −b」（点开文件与 Diff），右「用量 · 时长」。主机没给就不显示该项；全都没有就整行不显示（正常完成保持安静）。
  - 失败 / 停止 / 截断的 `TurnOutcomeNote` 保留。
- 状态条（保留现有 `SessionStatusLine` 逻辑，只改样式）：44pt、圆角 12；运行中用 `accentSoft` 底 + `accent` 字 + 运行环，右侧「停止」用 `bad`；警告用 `warn` 12% 底；需要你决定用 `warn`，按钮「回答」。
- Composer：见 5.4，无上方 chip 行。

### 5.3 Sheet

- **需要你决定**（RemoteQuestionSheet）：`panel2` 底，顶部抓手；头部 60pt「需要你决定」+ 会话名 · Provider + 关闭；类型徽标（「Provider 请求授权 / 需要输入」，`warn`）；问题 `.callout` medium；选项为 12 圆角卡片，选中 1.5pt `accent` 边 + `accentSoft` 底 + 实心圆点（160ms）；底部两个 48pt 按钮「取消请求」（次按钮）/「提交」（`accent` 填充，圆角 14）。多选、文本输入的逻辑不变。
- **会话总览**（新增，对应 Mac OverviewPanel）：上下文占用横向刻度（8pt 轨道，≥50% `warn`、≥80% `bad`，其余 `accent`）+「已用 / 窗口」；判词行（7pt 状态点 + 文字）；Token 总量（大号 `accent`）+ 费用 | 时长两格；会话信息（ID 可复制、Provider、模型、工作目录）；「轮次 / 文件 / 时间线」标签。**每一项都只显示主机真实提供的数据**，iOS 目前很可能拿不到上下文占用和累计 Token：拿不到的整块显示「Mac 未提供」，不要隐藏到让人以为是 0，也不要估算。
- **模型 · 推理强度**：从 Composer 的模型按钮弹出的浮层（`panel2` 底、圆角 16、`border` 边、浮层阴影，220ms ease-out 从右下缩放 0.96→1）。上半是模型列表（名称 + 一句说明，选中打勾），下半是推理强度分段控件（滑块 220ms struct）。选项来自现有 `modelOptions` / `effortOptions`，选择逻辑和缺失时阻止发送的规则不变。

### 5.4 Composer 外壳（首页、新建会话、会话页共用）

外壳：`panel` 底、1pt `border`、圆角 20、Composer 阴影（深色 `0 10 30 黑28%`，浅色 `0 10 30 黑8%`）；聚焦时边框 `border2` + 1pt `accentSoft` 外环。
- 首页 / 新建会话：顶部 chip 行（项目 chip、Provider chip，36pt、圆角 11、`subtle` 底），下有 `border3` 线。
- 输入区：`.callout`，1–6 行。
- 底部一行：「+」附件 38pt / 权限按钮（`dim`，`.caption` medium）/ 弹性空白 / 模型 · 强度按钮（模型 `fg`，强度 `dim`）/ 发送 34pt 圆形：可发送 `fg` 底 `main` 箭头，不可发送 `panel3` 底 `dim2` 箭头。
- 斜杠命令菜单、附件 chip、错误提示保持现有逻辑，换成新 token。
