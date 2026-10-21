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

桌面入口 `src/renderer/main.tsx` 依次导入 styles、analytics-evidence、inventory-evidence、session-evidence、codex-alignment 的 CSS。最后一层覆盖基础变量，但仍须遵守选择器优先级和组件局部样式。iOS 依据 `apps/ios/ScryRemote/Theme.swift`、`Components.swift` 和 `HomeView.swift`。原始代码路径与内容指纹见配套 `.impeccable/design.json`。

当前 App 的可访问性树证明存在会话导航和主工作区；截图请求超时，未取得当前完整视觉证据。仓库 `artifacts/llm-performance-dark.png` 与 `artifacts/llm-performance-light.png` 的 SHA-256 相同，均呈现深色性能页；仅可作局部深色参考，不证明浅色主题。本文未进行 iOS 真机验收。另在 Chrome 的 1512 × 764 视口核对了六种提取标本的深浅主题默认外观，并确认搜索输入可聚焦；这不是当前 App 的双主题或全状态验收。

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
