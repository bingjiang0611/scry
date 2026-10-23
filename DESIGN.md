---
name: Scry
description: 执行观察室：克制、清晰、工具感
colors:
  desktop-dark-bg: "#151515"
  desktop-dark-panel: "#1c1c1c"
  desktop-dark-panel2: "#232323"
  desktop-dark-border: "#333331"
  desktop-dark-fg: "#f1f1ef"
  desktop-dark-dim: "#b5b5af"
  desktop-dark-accent: "#5b9cff"
  desktop-dark-accent-fg: "#ffffff"
  desktop-dark-selected: "#5b9cff"
  desktop-dark-ok: "#69cc93"
  desktop-dark-warn: "#efb958"
  desktop-dark-bad: "#f36c67"
  desktop-light-bg: "#f7f7f5"
  desktop-light-panel: "#ffffff"
  desktop-light-panel2: "#f6f6f3"
  desktop-light-border: "#e4e4df"
  desktop-light-fg: "#222220"
  desktop-light-dim: "#62625e"
  desktop-light-accent: "#3f7ee8"
  desktop-light-accent-fg: "#ffffff"
  desktop-light-selected: "#3f7ee8"
  desktop-light-ok: "#18794e"
  desktop-light-warn: "#94620b"
  desktop-light-bad: "#bf3f3a"
  ios-ink: "#E8E7E4"
  ios-muted: "#A6A5A0"
  ios-line: "#2B2B29"
  ios-blue: "#86ACF4"
  ios-green: "#75C79A"
  ios-amber: "#D5AA72"
  ios-canvas: "#1C1C1A"
  ios-surface: "#121210"
  ios-message: "#252422"
  ios-negative: "#E68C90"
typography:
  desktop-body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: 14px
    lineHeight: 1.55
    letterSpacing: "-0.004em"
  desktop-button:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: 12.5px
  desktop-nav:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: 13.5px
    fontWeight: 500
  desktop-mono:
    fontFamily: "\"JetBrains Mono\", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
rounded:
  xs: 7px
  sm: 10px
  md: 14px
  lg: 20px
  pill: 999px
  navigation-item: 9px
  badge: 6px
  surface-card: 12px
  modal: 18px
components:
  button-primary:
    backgroundColor: "{colors.desktop-dark-accent}"
    textColor: "{colors.desktop-dark-accent-fg}"
    typography: "{typography.desktop-button}"
    rounded: "{rounded.md}"
    padding: 6px 12px
  button-secondary:
    backgroundColor: "{colors.desktop-dark-panel}"
    textColor: "{colors.desktop-dark-fg}"
    typography: "{typography.desktop-button}"
    rounded: "{rounded.md}"
    padding: 6px 12px
  search-input:
    rounded: "{rounded.sm}"
    height: 36px
    padding: 0 10px
  navigation-item:
    typography: "{typography.desktop-nav}"
    rounded: "{rounded.navigation-item}"
    height: 34px
    padding: 0 10px
  badge:
    textColor: "{colors.desktop-dark-dim}"
    rounded: "{rounded.badge}"
    padding: 3px 9px
  surface-card:
    backgroundColor: "{colors.desktop-dark-panel2}"
    textColor: "{colors.desktop-dark-fg}"
    rounded: "{rounded.surface-card}"
    padding: 15px
---

# Design System: Scry

## Overview

**Creative North Star: "执行观察室"**

以“执行观察室”为比喻：界面帮助用户持续查看 Agent 的执行状态，在需要时检查细节并干预。整体气质是克制、清晰、工具感；内容先于装饰，容器负责组织信息，不代替证据。

桌面采用中性深灰／浅暖灰双主题、多栏工作区与蓝色强调。iOS 使用独立的暖深灰语义色盘、系统字体和 SF Symbols；两端共享产品含义，不强行共享像素值或组件布局。层次以底色和边界为主，阴影辅助；组件以柔和边界表达明确操作。

**Key Characteristics:**
- 中性画布与语义强调色。
- 桌面多栏、对话正文聚焦、细节按需展开。
- 系统字体承载操作与阅读，等宽字体承载代码、路径和数据。
- 平台各自保留交互习惯；未知、禁用和失败不能被美化成成功。

### 范围与依据

这是现有实现的记录，不是重设计。用户已确认上述比喻、气质、语义色名，以及“分层为主，阴影辅助”“柔和边界，明确操作”。仅记录稳定的共享样式与代表组件；不把当前未提交功能升级为全局规范。

设计稿、原型和截图放在本地 `designs/`、`artifacts/` 目录，不随仓库分发；文档里指向这两个目录的链接只在维护者本机可打开。

桌面入口 `src/renderer/main.tsx` 依次导入 styles、analytics-evidence、inventory-evidence、session-evidence、codex-alignment 的 CSS。最后一层覆盖基础变量，但仍须遵守选择器优先级和组件局部样式。iOS 依据 `apps/ios/ScryRemote/Theme.swift`、`Components.swift` 和 `HomeView.swift`。原始代码路径与内容指纹见配套 `.impeccable/design.json`。

2026-10-21 补充了真实运行界面的视觉抽查，替代此前截图超时的证据缺口。桌面记录已更新为安装 0.2.214、用户手动重启后的观察：

| 对象 | 实际观察 | 版本与范围 |
| --- | --- | --- |
| 桌面深色 | 重启后的会话导航、正文、代码块与输入区正常显示 | Scry 0.2.214；macOS 窗口 1280 × 880 pt；新进程启动晚于安装 |
| 桌面浅色 | 用户切换后，侧栏、正文、工具状态、运行中输入区未见明显错位或主题混用 | 同一 0.2.214 进程与窗口；保留用户选择的浅色，不自动切回 |
| iOS 固定深色 | 真机主页与设置页；系统文字、列表层级、底部搜索和圆形操作按钮 | iPhone 13、iOS 26.5.2、390 × 844 pt；com.scry.remote.local 0.1.15 (22)，通过 iCTRL 操作 |

初次桌面抽查时，磁盘安装包为 0.2.212、工作区为 0.2.213，旧进程身份未确认；该记录保留在 sidecar 中。后续安装的 0.2.214 已通过构建、打包校验和 Electron 冒烟检查，安装归档与验证产物的 SHA-256 一致。用户手动重启后，已补齐该安装版本的桌面双主题视觉证据；此前完整单测有 Pi 超时，按用户要求直接构建安装，不能据此声称全量测试通过。

所见配色方向、层次与组件形态符合本文记录；未据截图推断精确色值、对比度合规或所有状态可用。未发送或停止 Agent 任务，未改权限或配对；手机回到原设置页。此次不覆盖 iOS 会话详情、键盘、动态字体、横屏及全流程。手机安装包与当前源码的构建对应关系仍未确认；桌面结果只适用于已核验的 0.2.214 安装产物，不自动覆盖后续工作区改动。

仓库 `artifacts/llm-performance-dark.png` 与 `artifacts/llm-performance-light.png` 的 SHA-256 相同，均呈现深色性能页，仍不能用作浅色证据。另在 Chrome 的 1512 × 764 视口核对过六种提取标本的深浅主题默认外观，并确认搜索输入可聚焦；标本检查不等于 App 全状态验收。真实界面含私人会话信息，截图未写入仓库。

## Colors

前置 token 按 desktop-dark、desktop-light、ios 分域，数值是本次提取的规范快照；源代码修改后应刷新，不另造一套运行时主题。CSS 组件示例绑定现有变量，因此跟随所在页面主题；frontmatter 中按钮和卡片的颜色引用描述桌面深色默认态。

- **中性色：** bg 是外层画布，panel／panel2 是内容与次级表面，border 是边界，fg／dim 是主次文字。侧栏与正文还使用专门 surface 变量，不能一律替换成 bg。
- **强调蓝：** accent 用于操作、焦点和重点；selected 用于选中语义。当前二者色值相同，仍保留独立变量。
- **状态色：** ok／warn／bad 分别表达对应的成功、警告和失败状态；状态成立必须有真实证据。Provider、读写类型另有专用色，不与状态色混用。
- **iOS：** canvas／surface／message 分别承载画布、导航背景和消息背景；ink／muted 表达文字层级，blue 是强调色，green／amber／negative 用于相应语义。当前 Palette 是固定色值，没有提取出独立浅色调色板，不宣称两套原生主题齐备。
- 透明背景、柔和强调底、边框和 Provider 色继续引用原 CSS／Swift 定义；本文件不是完整颜色清单。明暗、色盲和对比度合规未由本次记录证明。

## Typography

桌面正文采用平台 UI 字体栈；中文包括 PingFang SC 回退。`--font-mono` 声明 JetBrains Mono 及系统等宽回退，不代表字体已随包分发。基本字级见 frontmatter，不新增营销用展示字体。

欢迎页标题使用 clamp(27px, 3.2cqi, 34px)、650 字重；这属于欢迎页，不是全 App 标题标准。导航、按钮和辅助标签保持紧凑；支持文字与紧凑文字变量分别为 12px 和 11px。

iOS 使用 SwiftUI 系统字体与 SF Symbols：RemoteHeader 标题 17pt semibold，副标题 11.5pt；项目分组标题 18pt semibold，列表标题常见 15.5pt。代码同时存在固定字号和语义 text style，不能声称已全面支持 Dynamic Type。使用系统图标，而非把桌面 SVG 强行搬成同尺寸触控按钮。

## Layout

桌面默认侧栏 230px、拖动区 8px、右侧纵览 380px；这些是起始值，不是锁死的宽度。顶部栏变量为 52px，状态栏为 26px。主工作区使用 grid 与独立滚动，正文和 composer 共用证据列，最大列宽 960px，gutter 为 clamp(20px, 3cqi, 36px)。

响应式以实际容器而非仅窗口宽度判断：main-pane 在 720px 收紧 gutter，在 560px 调整标题；composer-pane 在 560px 换行控件。窗口 900px 以下调整设置弹窗；右侧 surface 在 1180px 以下有独立浮层规则。它们是局部阈值，不组成通用移动 Web 断点体系。

iOS 为原生单列流程。RemoteHeader 最小高度 56pt；列表常用 19pt 水平内边距，底部搜索区 18pt；不要将这些局部数值扩成虚构 spacing scale。CircleButton／PlainIcon 普通触控框至少 44pt，填充圆按钮为 46pt。不同屏幕、键盘、safe area 和大字体适配仍须按实际界面验证。

## Elevation & Depth

**分层为主，阴影辅助。** 桌面有真实的 card 与 popover 阴影，不是完全扁平。弹窗使用 panel、细边框、较强浮层阴影与带 blur 的遮罩；composer、消息和指标各自有局部阴影／悬浮反馈，不能把它们压成一种通用卡片。

精确 shadow 与 motion 值放在 sidecar。基础控件常见 140ms 状态过渡，后置皮肤常见 150ms；部分 hover 会位移。已有 prefers-reduced-motion 规则覆盖一组具体控件，不代表所有动效已验收。焦点环是可操作性提示，不作为装饰光晕扩散。

iOS 的 GlassBackground 实际是 96% 不透明度的固定颜色、continuous 圆角和 1pt 描边，没有使用 Material 或背景模糊。文档保留其实现含义，不从名称推断玻璃效果。

## Shapes

全局桌面圆角见 frontmatter 的 xs／sm／md／lg／pill，它们由最后加载的皮肤覆盖。navigation-item／badge／surface-card／modal 记录实际局部例外，不是新增 CSS 变量；搜索采用 sm 对应尺寸。不要仅凭最近的 token 将局部例外统一化。

iOS 使用 Circle、Capsule 与 continuous RoundedRectangle。Notice 为 12pt 圆角；底部搜索区为 24pt 圆角、48pt 高。两端圆角语言相近，但没有共用尺寸合同。

## Components

配套 sidecar 收录六个桌面代表实例。它们是提取的样式标本，不是可执行产品流程；不发起请求，也不代替 React 或 SwiftUI 组件。文案仅在标本数据中集中保存。

| 组件 | 来源与默认形态 | 状态与边界 |
| --- | --- | --- |
| 主按钮 | .btn.primary；强调色填充、最小高度 40px | hover 混入白色；禁用 opacity 0.45；保留 focus-visible 与按下反馈 |
| 次按钮 | .btn；panel 底、border2 边框 | hover 使用 panel3／accent-line；不自动变为主按钮 |
| 搜索输入 | .sb-search；36px 高容器、无边框内输入 | focus-within 的边界与外环来自后置皮肤；不是所有输入框的默认样式 |
| 导航项 | .sb-navitem；34px 高、左对齐 | active 保留 surface-hover 底和继承的选中 inset 线；会话行另有自己的选中样式 |
| 状态标签 | .badge；紧凑文字与边框 | 默认非交互；ok／bad 按证据着色，不添加虚构 hover 动作 |
| Surface 入口卡片 | .surface-card；最小高度 124px | 这是可操作入口，含 hover、focus 与按下反馈；不是所有内容容器的模板 |

**对话与 composer：** 延续共享正文列；正文、工具证据与输入控制分层。runtime-composer 的 send 使用独立的圆形按钮样式，不能用 .btn.primary 的矩形标本替代。

**弹窗：** .modal 使用 18px 圆角、panel 表面和 popover 阴影；头部最小高度 60px。承载受保护的设置或决策，不将任意细节都塞进弹窗。

**原生组件：** 复用 CircleButton、PlainIcon、Notice、EmptyState、StatusDot 和 RemoteHeader。连接点的 green 仅对应 connected；pairing 为 amber；offline／notPaired 为 faint。标签、空状态和错误说明保留具体语义，不能只靠颜色传达。

### 可复用实现（2026-10-21 提取）

本轮不新增颜色、尺寸或圆角 token；继续使用现有 CSS 与 `Palette`。提取只集中同用途的重复结构，不重设计外观。

| 实现 | 已迁移范围 | 使用合同 |
| --- | --- | --- |
| `src/renderer/components/primitives/ModalCloseButton.tsx` | 9 个文件中的 14 处弹窗关闭按钮 | 必填 `aria-label`，引用集中文案；固定 `type="button"`，保留 `disabled`、点击回调、DOM ref 和附加 class。默认使用现有 X 图标；两处字符外观通过 children 保留。继续使用 `.modal-x`，不承担弹窗焦点陷阱或确认关闭逻辑。 |
| `apps/ios/ScryRemote/Components.swift` 的 `MoreMenu` | `HomeView`、`ChatView`、`SessionTranscriptView` | 原生 `Menu`、17pt medium 省略号、44 × 44pt 区域；默认名称来自 `ConnectionCopy.more`。历史页通过 `moreWithStatus` 保留当前历史状态；菜单操作与可用条件仍由页面提供。 |

桌面示例：

```tsx
<ModalCloseButton ref={closeRef} aria-label={MODAL_COPY.closeMcp} onClick={onClose} />
```

iOS 示例：

```swift
MoreMenu(label: ConnectionCopy.moreWithStatus(historyStatus)) {
  Button(ConnectionCopy.settings) { model.route = .settings }
}
```

验证：桌面静态渲染对照保留原 DOM，隔离 Electron 以原生坐标和键盘验证关闭、禁用、ref、非提交行为，并查看深浅主题。iPhone 13 已安装本轮真机构建，核对主页与历史页菜单的展开、44pt 区域、状态文案和进入设置；没有发送或停止 Agent。`ChatView` 的真机入口需要手机发起的任务，本轮未发起该任务，因此该调用方只有编译验证。

2026-10-21 用户重启后，已核对进程启动时间和安装归档哈希，并在真实桌面 App 的 1512 × 885 pt 深色窗口检查设置弹窗：关闭按钮实际点击后，重新读取界面确认弹窗消失、工作区恢复。该结果仅覆盖设置这一代表调用方；键盘、禁用、ref 和非提交行为仍以隔离 Electron 检查为依据，不声称全部弹窗逐一验收。保留本次观察时的深色主题，未编辑草稿或附件，未发送或停止 Agent。

### 侧栏「动态」的加强（2026-10-21）

范围是 `SidebarActivity` 与 `sidebar-activity.css` 呈现的侧栏动态列表；项目视图、标签栏、行交互、文案模块和证据语义不变。此前的平铺文字仍保留，只把「哪个时刻正在发生」做成整块列表的峰值：

| 决定 | 理由 | 落地 |
| --- | --- | --- |
| 分组标题成为「幕」 | 整屏只有等高灰色文字时，用户无从分段 | 标签 + 通栏细线（`--border3`）；进行中的标签与线更亮（`--fg` / `--border2`），已完成的标签降到 `--dim` |
| 右侧状态列 | 运行状态原先只藏在标题扫光里，右列只有已完成图标 | 进行中的旋转环与「需要回复 / 已完成」图标居中对齐；悬停或聚焦时让位给操作按钮 |
| 修正强调反转 | 运行中的标题原本比已完成更暗，最重要的工作是最淡的文字 | 运行中标题回到 `--fg`，扫光带改为向中间调调制（深色里像阴影、浅色里像高光），已完成标题为 `--dim` |
| 完成段更密 | 归档是检索对象，不是当前工作 | 已完成行 28px、运行中与需要回复行 34px |

保留的既有决定：无卡片、无数量徽章、无项目副标题；动态标题与项目列表保持相同字号与字重；每组 40 行上限、布局动画、指针按住不漂移、`prefers-reduced-motion` 与强制颜色回退均不变。

验证：隔离 Electron fixture `node scripts/session-capability-ui-smoke.mjs --sidebar-activity-only` 通过全部检查，其中新增三项针对本次设计承诺（运行中标记与状态图标同列、完成段行高更小、运行中标题亮度高于完成段）；把行高改回 34px 或把状态环移出该列后，对应断言会失败。深浅主题在 280px 侧栏宽度逐张查看，运行中扫光仍以像素差确认可见。未保留其他临时测量脚本。

### 总览证据块：横向刻度（2026-10-22）

范围是 `OverviewPanel` 面板头到数据标签页之间的证据块：上下文占用、判词行、Token 总量与派生指标、会话摘要。轮次列表、证据语义与控件行为不变。设计稿先出四稿（`designs/scry-overview-bolder`，A 环 + 通栏卡片 / B 台账 / C 横向刻度 / D 单峰），用户选定 C。

| 决定 | 理由 | 落地 |
| --- | --- | --- |
| 占用改用横向刻度 | 58px 环与 16px 数值同级，占用率读不出主次；环还占 66px 高度 | 一行「上下文占用 … 26%」，8px 轨道按 26% 填充，下面一行「已用 / 窗口」13px（已用 `--fg`，窗口 `--dim2`）；显示文本仍是「已用 / 窗口」 |
| 阈值跟随判词 | 占用接近窗口上限是要人介入的状态，不该只在环上换色 | 轨道填充沿用既有阈值：≥50% 用 `--warn`，≥80% 用 `--bad`，其余 `--accent` |
| 指标去卡片 | 三格等高卡片读作同级，380px 下还空出一格 | 一条发丝线起头：主证据行左右分置（标签 10px、数值 26px `--accent`），下面并排两格由一条竖线分隔，不再有卡片底色和圆角 |
| 让出一个峰值 | 会话压缩计数 20px、标签页填充胶囊都比证据本身响 | 计数 14px；标签页去掉填充与内描边，只留 `--selected` 下划线；面板头说明降到 `--dim2` |
| 判词行保留状态点 | 状态要能一眼读出，不能只是灰字 | 判词 13px/620，7px 状态点配 2px 同态软光环（复用面板标题写法） |

保留的既有决定：未新增颜色、字体或组件原语；缺证据仍显示 `—`；隐藏 tooltip、aria 文案、会话摘要的 ID 展开/复制与失焦回退、标签页的 tab 语义与键盘往返都不变。文案「上下文占用」「暂无上下文数据」移入 `OVERVIEW_SESSION_COPY`。

验证：`npx vitest run src/renderer` 849 项通过；`npm run typecheck:web` 通过；`node scripts/session-capability-ui-smoke.mjs --overview-only` 深浅两主题 × 380/340/535 通过，`firstTurnTop` 430.34（契约 ≤460，比上一版矮约 19px）、`headerHeight` 44、间距 14/10/8、双列、三格指标、无横向溢出；`--summary-only` 通过（`.ctx-copy` 文本仍为「100.0k / 272.0k」这类原样比值，改用 `.ctx-track` 后 aria 校验同步更新）。另用临时 fixture 渲染真实数值（26%、70.5k / 272.0k、1.7M、$31.81）逐张比对深浅主题与三种宽度，并确认空态（— + 空轨道 + 暂无上下文数据）。对比度：轨道填充与底色 5.72:1（深）/ 3.72:1（浅），单看填充与面板底色的 3:1 图形下限通过；主证据数值 5.72:1 / 3.72:1（26px）。已知限制：指标标签仍是全应用约定的 10px `--dim2`，浅色主题 3.52:1，属既有标签色决定，本次未改。

### 已回答问答块：台账式记录（2026-10-23）

范围只有 `AskUserQuestionResult` 渲染的 `.question-result` 内层块：状态行、问题与答案、`查看原始输入与输出` 折叠。外层工具组行、工具卡行与待回答的内联表单都不动。设计稿先出四稿（`designs/scry-question-result-bolder`，A 裸渲染现状 / B 倒置 / C 台账 / D 单行），用户选定 C。

前置事实：这块从 `ab5601b` 起就没有任何样式——`.question-result*` 规则在该提交里从 `styles.css` 整段删除且没有补回，真实界面渲染的是浏览器默认的 `<dl>`（上边距 1em）、`<dd>`（缩进 40px）与 `<summary>`。所以这一轮是重建而不是再加一层装饰。

| 决定 | 理由 | 落地 |
| --- | --- | --- |
| 状态与等待压成一行等宽小字 | 「已回答」是判词，问题数与等待是附注，三者不该占同等视觉重量 | `--ok` 10px/650 等宽配 11px 对勾图标（未完成类判词改 `--bad` 与预警图标），问题数与等待 10.5px `--dim2`，等待靠右 |
| 问答成行、答案落在右轨 | 问题与答案同行才读得出对应关系；短答案需要锚点 | 两列 grid（`1fr` / `minmax(84px, 38%)`），问题 12.5px `--dim`、答案 13px/600 `--fg` 右对齐；等待时长与答案共用同一条右边缘 |
| 只用发丝线分隔 | 旧版（已删除）给每条问答套了 `--panel2` 卡片，与工具卡形成嵌套容器 | 块顶、列表顶、行间、折叠前各一条 `--border3` 发丝线，无新容器、无新圆角 |
| 窄栏退化为上下两行 | 右栏打开时两列会被挤到读不出对应关系 | `@container main-pane (max-width: 640px)` 转单列，答案改左对齐 |
| 缺答案单独标记 | 「没拿到答案」不能与「用户选了某项」同形 | `dd.missing` 用 `--dim2` 与 500 字重；没有 duration 时不渲染等待 |

保留的既有决定：判词文案（已回答 / 用户取消 / Provider 取消 / 未完成）、`<dl>/<dt>/<dd>` 语义、`question-result-fallback` 与 `<details>` 折叠、`aria-label` 都不变，未新增文案与颜色。原始输入输出区沿用 `--surface-inset` 底、11.5px 等宽与 280px 上限，与 `.tool-detail` 同一写法。

验证：`npx vitest run src/renderer/components/AskUserQuestionDialog.test.tsx` 14 项、`src/renderer/components/render.test.tsx` 244 项通过；`npm run typecheck:web` 与 `npm run build` 通过。新增 `node scripts/session-capability-ui-smoke.mjs --question-result-only`：在隔离 Electron fixture 里用真实 React + 真实 CSS 断言 `dl` 不再带浏览器边距、行是两列 grid、答案 600 字重右对齐、等待与答案右边缘相差 ≤1px、判词取 `--ok` 变量而非字面色、取消态渲染 `dd.missing` 且不编造等待、`summary` 可键盘聚焦且展开后箭头旋转、560px 容器下退化为单列左对齐；把本轮 CSS 注释掉重跑该检查会失败（已作为对照执行一次）。深色与浅色截图（`SCRY_QUESTION_RESULT_SCREENSHOT`）各看一次。已知限制：右对齐的长答案（如 4 行）左侧参差，这是台账方向的已知代价；桌面打包版内未用真实会话重放（需要一次真实 Provider 的回答），本轮只做到隔离 Electron fixture 与真实 CSS。

## Do's and Don'ts

### Do
- 复用当前主题变量及平台原生组件；先检查最终覆盖层。
- 用文字、图标和状态共同说明证据；保留来源和缺失状态。
- 复用现有文案模块；保留键盘焦点、禁用态与原生触控标签。
- 新增模式前检查桌面双主题和 iOS 原生约束；具体界面再验收。

### Don't
- 不要把基础 styles.css 的旧色值或 designs/ 原型直接当作当前产品规范。
- 不要把 Provider 品牌色、选中态或连接点当作成功、授权或完整性证明。
- 不要把 iOS 的 glass helper 描述成已实现的系统材质或背景模糊。
- 不要把文档示例、历史截图或代码扫描当作当前 App 的视觉与无障碍验收。
