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
  desktop-mono:
    fontFamily: "\"JetBrains Mono\", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
  scale:
    text-2xs: 10px
    text-xs: 11px
    text-sm: 12px
    text-md: 13px
    text-base: 14px
    text-reading: 15px
    text-lg: 16px
    text-xl: 20px
    text-2xl: 24px
  weight:
    regular: 400
    medium: 500
    semibold: 600
    bold: 700
spacing:
  space-0_5: 2px
  space-1: 4px
  space-2: 8px
  space-3: 12px
  space-4: 16px
  space-5: 20px
  space-6: 24px
  space-8: 32px
  space-10: 40px
  space-12: 48px
rounded:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 20px
  pill: 999px
components:
  button-primary:
    backgroundColor: "{colors.desktop-dark-accent}"
    textColor: "{colors.desktop-dark-accent-fg}"
    rounded: "{rounded.md}"
    minHeight: 40px
  button-secondary:
    backgroundColor: "{colors.desktop-dark-panel}"
    textColor: "{colors.desktop-dark-fg}"
    rounded: "{rounded.md}"
    minHeight: 40px
  search-input:
    rounded: "{rounded.sm}"
    height: 36px
  navigation-item:
    rounded: "{rounded.sm}"
    height: 36px
  badge:
    textColor: "{colors.desktop-dark-dim}"
    rounded: "{rounded.xs}"
  surface-card:
    backgroundColor: "{colors.desktop-dark-panel2}"
    textColor: "{colors.desktop-dark-fg}"
    rounded: "{rounded.md}"
  modal:
    rounded: "{rounded.lg}"
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

本文是桌面 renderer 的设计规范与 iOS 的对应约束。带日期的具体界面决策与当时的验证证据见 [设计决策记录](docs/design/decisions.md)；设计稿、原型和截图放在本地 `designs/`、`artifacts/`，不随仓库分发。

## 系统如何运转

设计系统由三层组成，每一层只引用上一层，不跳层写字面值：

| 层 | 内容 | 位置 |
| --- | --- | --- |
| 尺度 token | 字号、字重、间距、圆角、动效时长与缓动 | `src/renderer/styles-theme-shell.css` 的 `:root`（动效在 `motion.css`）。唯一定义处，其他文件不得重定义 |
| 语义 token | 画布、表面、边界、文字层级、强调、状态、证据类型、Provider、阴影 | `styles-theme-shell.css` 给出基础值，最后加载的 `codex-alignment-shell.css` 覆写深浅主题的最终色值与阴影 |
| 组件 | 按钮、徽章、通知、菜单、弹窗、标签页等 | 组件 CSS 与 `src/renderer/components/primitives/`；只消费前两层 |

入口 `src/renderer/main.tsx` 依次导入 styles、motion、analytics-evidence、inventory-evidence、session-evidence、codex-alignment。最后一层覆盖语义色值，但不得改写尺度 token（`radius-system.test.ts` 与 `design-system.test.ts` 会拒绝）。

### 守卫

| 守卫 | 范围 | 强度 |
| --- | --- | --- |
| `src/renderer/radius-system.test.ts` | 所有 `border-radius` 必须是 `var(--r-*)`、`50%` 或 `0`；圆形必须声明 `corner-shape: round` | 绝对，无存量例外 |
| `src/renderer/motion.test.ts` | 缓动曲线只在 `motion.css` 定义 | 绝对 |
| `src/renderer/design-system.test.ts` | 所有 renderer 样式表：字号与字重只用 token、间距落在 4px 网格、颜色只用主题变量、容器级 `… button` 规则以 `:not(:where(...))` 排除 primitive | 绝对：任何一条发现都使测试失败 |
| `components/primitives/Button.test.tsx`、`Feedback.test.tsx` | 按钮、通知、标签页、分段控件只在各自样式表定义；退役类名不得回归；TSX 不得手写 `className="btn…"` 或 `role="tablist"` | 绝对 |

`npm run design:audit` 列出发现（`-- --verbose` 给出逐行明细），有发现时退出码非零。没有基线和豁免：新增的样式要么用 token，要么先在本文与主题层扩展 token，并在 PR 中说明为何现有档位不够。

删除样式时注意两类陷阱：`:is()`／`:where()` 里只删无效成员，不删整条选择器；文件或规则的章节注释若仍描述剩余规则，要保留。

## Colors

frontmatter 中的颜色是 desktop-dark、desktop-light、ios 三域的规范快照，取自最终覆写层；源代码修改后应刷新，不另造一套运行时主题。

| 语义组 | 变量 | 用途 |
| --- | --- | --- |
| 画布与表面 | `--bg`、`--panel`、`--panel2`、`--panel3`、`--panel-hi`、`--sidebar-surface`、`--main-surface`、`--overview-surface` | 外层画布、内容表面、次级与悬浮表面；侧栏与正文有专用 surface，不能一律换成 `--bg` |
| 叠层 | `--surface-faint` … `--surface-strong`、`--surface-inset*` | hover、按下、内嵌区；随主题切换明暗方向，组件不得自写 `rgb(255 255 255 / x%)` |
| 边界 | `--border`、`--border2`、`--border3` | 常规、强调、发丝分隔 |
| 文字 | `--fg`、`--dim`、`--dim2`、`--dim3` | 主文字到三级文字；三级文字仍需 4.5:1，不用更浅的灰冒充层级 |
| 强调与选中 | `--accent`、`--accent-soft`、`--accent-line`、`--selected*` | 主操作、焦点、当前选中；二者色值目前相同，仍保留独立变量 |
| 填充控件文字 | `--fill-fg` | 实心强调色／危险色控件上的文字：深色主题为深色字（白字在 `#5b9cff` 上仅 2.75:1），浅色主题为白字 |
| 状态 | `--ok`、`--warn`、`--bad` 及 `-soft` | 成功、需要注意、失败；状态成立必须有真实证据 |
| 证据类型 | `--read`、`--write`、`--edit`、`--mcp`、`--skill`、`--agent` | 工具调用的读写类别；不与状态色混用 |
| Provider | `--provider-*` | 只用于识别来源，不表达授权、成功或完整性 |
| 阴影 | `--shadow-card`、`--shadow-pop`、`--shadow-xs`、`--shadow-menu`、`--shadow-float`、`--shadow-thumb`、`--shadow-composer(-focus)`、`--shadow-side-panel` | 卡片、弹窗、细微抬升、菜单与浮动提示、浮动控件、滑块、输入框、窄屏浮动右栏；新的阴影先找最近的一档 |
| 填充控件文字 | `--fill-fg` | 见上文 |
| 固定色板 | `--terminal-*`、`--theme-preview-*`、`--qr-surface`、`--bg-deep` | 不随主题变化的颜色：终端始终是深色、主题预览要同时展示两套配色、二维码必须是白底、分析页深色画布 |

状态与证据类型的半透明底色和边框一律由语义变量派生：`color-mix(in srgb, var(--ok) 24%, transparent)`。写死的 `rgba()` 会让浅色主题沿用深色主题调好的色值。

iOS：canvas／surface／message 承载画布、导航背景和消息背景；ink／muted 表达文字层级，blue 是强调色，green／amber／negative 用于相应语义。当前 Palette 是固定色值，没有独立浅色调色板。明暗、色盲和对比度合规未由本文整体证明，具体界面需单独验收。

## Typography

### 字号

| Token | 值 | 用途 |
| --- | --- | --- |
| `--text-2xs` | 10px | 等宽微标、指标标签、徽章计数 |
| `--text-xs` | 11px | 紧凑辅助文字、时间戳、表头（`--text-compact-size` 是其别名） |
| `--text-sm` | 12px | 按钮、辅助说明、表单标签（`--text-supporting-size` 是其别名） |
| `--text-md` | 13px | 次级正文、导航、列表行 |
| `--text-base` | 14px | 界面默认文字：面板正文、表单、列表说明 |
| `--text-reading` | 15px | 只用于对话阅读正文：助手回答与用户消息（Markdown 标题按 em 随之缩放） |
| `--text-lg` | 16px | 面板标题、弹窗标题 |
| `--text-xl` | 20px | 区块标题 |
| `--text-2xl` | 24px | 页面标题、主证据数值 |

- 组件只用上表 token。半像素字号（10.5、11.5、12.5、13.5）不进入 scale：相邻档位只差 1px，再加半档只会制造无法区分的层级。
- 允许的例外只有三类：`inherit`／`0`；Markdown 内部的相对 `em` 比例；欢迎页等展示标题的 `clamp()` 流式字号。
- 大号数字（总览主指标、用量总额等）上限是 `--text-2xl`，不另设展示字号。
- 等宽字体与界面字体共用同一字号 scale。`--font-mono` 声明 JetBrains Mono 及系统回退，不代表字体已随包分发。

### 字重

| Token | 值 | 用途 |
| --- | --- | --- |
| `--weight-regular` | 400 | 正文 |
| `--weight-medium` | 500 | 导航、按钮、强调的正文片段 |
| `--weight-semibold` | 600 | 标题、判词、主数值 |
| `--weight-bold` | 700 | 等宽微标等极小字号的可读性补偿，正文不用 |

层级首先靠字号与颜色拉开，不靠 550／620／650 这类相邻字重微调；相差 50 的字重在系统字体上几乎不可分辨，只会让同类元素看起来不一致。

iOS 使用 SwiftUI 系统字体与 SF Symbols：RemoteHeader 标题 17pt semibold，副标题 11.5pt；项目分组标题 18pt semibold，列表标题常见 15.5pt。代码同时存在固定字号和语义 text style，不能声称已全面支持 Dynamic Type。

## Spacing & Layout

### 间距 scale

| Token | 值 | 典型用途 |
| --- | --- | --- |
| `--space-0_5` | 2px | 光学对齐补偿（图标与文字基线、细边内缩），不用于组织布局 |
| `--space-1` | 4px | 图标与标签之间、紧密成组的元素 |
| `--space-2` | 8px | 控件内图标间距、同组控件之间、紧凑容器内边距 |
| `--space-3` | 12px | 按钮水平内边距、列表行内边距、卡片内同组元素之间 |
| `--space-4` | 16px | 卡片与面板内边距、段落组之间 |
| `--space-5` | 20px | 弹窗内边距、正文列 gutter 下限 |
| `--space-6` | 24px | 面板分区之间 |
| `--space-8` / `--space-10` / `--space-12` | 32 / 40 / 48px | 页面级留白、空状态 |

间距值必须落在 4px 网格上；1px 只用于发丝线补偿，2px 只用于光学对齐。新代码优先写 token，存量 4 的倍数字面值与 token 等价、可逐步替换。

### 按语义嵌套分配间距

1. **由内到外递增**：同一组内元素的间距 < 组与组之间的间距 < 容器内边距。例如按钮内图标与文字 8px，按钮之间 8px，按钮组与上方内容 16px，所在卡片内边距 16px。
2. **容器内边距四边一致**：卡片、通知、弹窗主体、输入框等容器，在内容是单块时上下左右使用同一个值；只有当一条边需要对齐外部网格（例如与正文列左缘对齐）时才单独调整，并在注释中说明。
3. **同级等距**：同一列表、同一工具栏中的兄弟元素用同一个 gap，不为个别元素单独加 margin。用 `gap` 表达兄弟间距，`padding` 表达容器内缩，避免 `margin` 叠加。
4. **嵌套圆角同心**：外层圆角 = 内层圆角 + 内边距。现有 radius stack 按此设计：20 − 8 = 12，12 − 4 = 8，8 − 4 = 4。

### 布局尺寸

桌面默认侧栏 230px、拖动区 8px、右侧纵览 380px；这些是起始值，不是锁死的宽度。顶部栏 52px，状态栏 26px。主工作区使用 grid 与独立滚动，正文和 composer 共用证据列，最大列宽 960px，gutter 为 clamp(20px, 3cqi, 36px)。

响应式以容器而非窗口宽度判断：main-pane 在 720px 收紧 gutter，在 560px 调整标题；composer-pane 在 560px 换行控件；窗口 900px 以下调整设置弹窗；右侧 surface 在 1180px 以下有独立浮层规则。它们是局部阈值，不组成通用移动 Web 断点体系。

iOS 为原生单列流程。RemoteHeader 最小高度 56pt；列表常用 19pt 水平内边距，底部搜索区 18pt；CircleButton／PlainIcon 普通触控框至少 44pt，填充圆按钮为 46pt。iOS 不套用桌面间距 token。

## Shapes

| Token | 值 | 用途 |
| --- | --- | --- |
| `--r-xs` | 4px | 徽章、行内代码、小标签 |
| `--r-sm` | 8px | 导航项、搜索框、菜单项、紧凑控件 |
| `--r-md` | 12px | 按钮、卡片、菜单与弹出层 |
| `--r-lg` | 20px | 弹窗、composer 等最外层容器 |
| `--r-pill` | 999px | 胶囊与圆形控件 |

支持 `corner-shape: superellipse()` 的环境自动使用连续圆角（`styles-theme-shell.css` 中的渐进增强），不支持时回退为普通圆角，没有额外运行时成本；`50%` 与 `--r-pill` 的元素必须显式声明 `corner-shape: round`，保持真圆。

iOS 使用 Circle、Capsule 与 continuous RoundedRectangle。Notice 为 12pt 圆角；底部搜索区为 24pt 圆角、48pt 高。两端圆角语言相近，但没有共用尺寸合同。

## Elevation & Motion

**分层为主，阴影辅助。** 弹窗使用 panel、细边框、`--shadow-pop` 与带 blur 的遮罩；卡片使用 `--shadow-card`。composer、消息和指标有各自的局部反馈，不要把它们压成一种通用卡片，也不要把 `--shadow-pop` 用在非浮层元素上，否则会读成弹窗。

动效 token 在 `motion.css`：hover 用 `--duration-hover`（120ms），进入／退出按 sm／md／lg 档位，缓动只引用 `--ease-*`。所有位移和缩放动效必须有 `prefers-reduced-motion` 回退。焦点环是可操作性提示，不作为装饰光晕扩散。

iOS 的 GlassBackground 实际是 96% 不透明度的固定颜色、continuous 圆角和 1pt 描边，没有使用 Material 或背景模糊；不要从名称推断玻璃效果。

## Components

### 语义目录：按意图选组件

先确定这块界面要做什么，再选组件；不要因为外观相近就借用另一个组件。

| 意图 | 用 | 不用 |
| --- | --- | --- |
| 触发一个动作（提交、保存、运行） | `<Button>`；一组里最多一个 `variant="primary"`；不可逆确认用 `variant="danger"`；返回、取消这类低强调动作可用 `variant="quiet"` | 链接样式的按钮；同一视图里两个主按钮；手写 `className="btn"` |
| 工具栏里只有图标的动作 | `<IconButton label=…>`（`label` 必填，同时作为 tooltip） | 无标签的图标；为图标按钮另写一套 hover |
| 打开一个选择菜单（Provider、模型、工作目录） | 选择器触发器（`.wdbtn`、`.clibtn`、`.location-button`），显示当前值 | `<Button>`：它表达“执行”，不表达“当前选择是什么” |
| 关闭弹窗 | `ModalCloseButton` | 手写 `<button>×</button>` |
| 在同一视图内切换平级内容（换掉整块面板） | `<Tabs>`：`--selected` 下划线，方向键／Home／End 切换 | 用按钮组或 `aria-pressed` 模拟标签页；用标签页做页面导航 |
| 在 2–4 个互斥选项中过滤或换算同一份内容，立即生效 | `<Segmented>`：`role="group"` + `aria-pressed` | 用标签页做过滤；下拉菜单（选项少时多一次点击） |
| 从较多选项中选择，或选项需要说明 | 菜单／选择器（`.menu` 结构，键盘可达） | 平铺一排按钮 |
| 描述对象的状态或属性 | 徽章 `.badge`（非交互，文字 + 颜色） | 可点击的徽章；只靠颜色的徽章 |
| 实时连接或运行状态 | 状态点 + 文字标签 | 只有颜色的圆点 |
| 需要用户注意、但不阻断操作的结果 | `<Notice tone>`：info／warn／bad；`layout="strip"` 贴面板边缘，默认 box 放在相关内容旁；最多一个小按钮 | 全局弹窗；只有颜色、没有图标与文字的提示；自己写底色与边框 |
| 一次性操作反馈（已复制、已保存） | 短暂的 toast 或按钮旁的状态字 | 常驻的 Notice |
| 必须用户决定才能继续 | 弹窗 `ModalFrame` | 把可选细节塞进弹窗 |
| 低频的解释、定义、来源说明 | tooltip 或可展开的 `Disclosure` | 常驻的说明段落 |
| 大块可选细节（原始输入输出、日志） | `Disclosure` 折叠 | 默认展开 |
| 空列表、无数据 | 空状态：一句事实 + 可选的一个下一步 | 插画加营销语；显示成 `0` |

### 收敛清单

审计发现同一意图存在多套平行实现。它们各自的尺寸、hover 和焦点规则不同，是“看起来不统一”的主要来源。后续按下表收敛到一个实现，迁移时保持各调用方的行为与无障碍属性：

| 意图 | 现存实现 | 收敛目标 |
| --- | --- | --- |
| 文字按钮 | ~~`.btn` 双重定义、`.hosts-button`、`.mp-button`、`.turn-branch-btn`、`.project-remove-confirm`~~ | **已完成（2026-11-15）**：`Button` + `styles-buttons.css` |
| 图标按钮 | ~~`.iconbtn`、`.icon-button` 局部覆写、`.mp-icon-button`、无样式的 `.icon-btn`~~ | **已完成（2026-11-15）**：`IconButton` |
| 行内通知 | ~~`.sc-notice`、`.sc-inline-notice`、`.composer-notice`、`.conversation-history-notice`、`.diff-review-notice`、`.side-chat-surface-notice`、`.surface-layout-notice`、`.termination-notice`、`.hosts-alert`、`.llm-perf-alert`、`.mcp-auth-banner`~~ | **已完成（2026-11-15）**：`Notice`；类名保留为定位与测试钩子 |
| 标签页 | ~~`.sc-tabs`、`.sb-view-tabs`、`.overview-data-tabs`、`.skill-scope-tabs`、`.capability-kind-tabs`、`.diff-navigation-tabs`；无引用的 `.panel-tabs`、`.vtabs`~~ | **已完成（2026-11-15）**：`Tabs` |
| 分段控件 | ~~`.usage-segmented`、`.capability-source-tabs`~~ | **已完成（2026-11-15）**：`Segmented`。`.seg-chip` 是指标徽章，不属于分段控件 |
| 不并入 | `.surface-tabs`、`.terminal-tabs`（可关闭、可拖动）；`.settings-tab`（设置页左侧导航，`aria-current`） | 保留独立实现，但选中色、下划线与字号对齐 `Tabs` |
| 待定 | `.mp-notice`（浮动 toast）；`.overview-session-notice`、`.surface-chooser-notice`（按钮旁的状态字） | 等 toast 模式确定后统一 |
| 菜单 | `.menu`、`.wdmenu`、`.climenu`、`.ctxmenu`、`.slash-menu`、`.surface-menu`、`.sb-project-menu`、`.sb-session-menu`、`.diff-scope-menu`、`.diff-turn-menu`、`.arch-provider-menu` | 共享 `.menu` 结构与菜单项样式；定位与触发逻辑仍由调用方负责 |

### 已有 primitive

| 实现 | 合同 |
| --- | --- |
| `src/renderer/components/primitives/Button.tsx` | variant：primary / secondary（默认）/ quiet / danger；size：md（32px，弹窗与面板）/ sm（28px，工具栏与行内）。默认 `type="button"`，表单主操作显式传 `type="submit"`；`className` 只用于测试钩子与定位，不改尺寸、颜色和圆角 |
| `src/renderer/components/primitives/IconButton.tsx` | `label` 必填，同时生成 `aria-label` 与 `title`；size：md（32px，图标 16px）/ sm（28px，图标 14px）；`active` 只控制视觉，`aria-pressed`／`aria-expanded` 仍由调用方给出 |
| `src/renderer/components/primitives/Notice.tsx` | tone：info（默认）／warn／bad；layout：box／strip；size：md／sm；`action` 放一两个 sm 按钮。图标随 tone 自动给出；`role`（status／alert）由调用方决定，primitive 不隐式添加。正文里的 `<b>` 是标题样式 |
| `src/renderer/components/primitives/Tabs.tsx` | `items` 的 `id`／`controls`／`title`／`count` 保持原 DOM 合同；自动激活，只有选中项在 Tab 顺序中；`tabRef`／`listRef`／`children` 支持动效指示条。颜色在 `aria-selected` 同一帧切换，不做颜色过渡 |
| `src/renderer/components/primitives/Segmented.tsx` | `role="group"` + `aria-pressed`；`value` 可为字符串或数字 |
| `src/renderer/components/primitives/ModalCloseButton.tsx` | 必填 `aria-label`，引用集中文案；固定 `type="button"`，保留 `disabled`、点击回调、DOM ref 和附加 class。不承担焦点陷阱或确认关闭逻辑 |
| `src/renderer/components/ModalFrame.tsx` | 弹窗栈、焦点进入与恢复、Esc／遮罩关闭路由、进出场动效 |
| `src/renderer/components/Disclosure.tsx` | 折叠内容的挂载、`inert` 与进出场动效；长内容自动切换为长动效 |
| `apps/ios/ScryRemote/Components.swift` 的 `MoreMenu` | 原生 `Menu`、17pt medium 省略号、44 × 44pt 区域；菜单操作与可用条件由页面提供 |

```tsx
<Button onClick={() => requestModalClose()}>{copy.cancel}</Button>
<Button variant="primary" type="submit" disabled={!name.trim()}>{copy.save}</Button>
<IconButton label={copy.refreshFiles} onClick={refresh}><Icon name="refresh" /></IconButton>
<ModalCloseButton ref={closeRef} aria-label={MODAL_COPY.closeMcp} onClick={onClose} />
```

按钮的样式只在 `src/renderer/styles-buttons.css` 定义；`Button.test.tsx` 拒绝在其他文件重新定义 `.btn`／`.icon-button`、拒绝已退役的类名，也拒绝在 TSX 里手写 `className="btn…"`。

### 代表组件的当前形态

| 组件 | 来源与默认形态 | 状态与边界 |
| --- | --- | --- |
| 主按钮 | `Button variant="primary"`；强调色填充、`--fill-fg` 文字、32px、`--r-md` | hover 混入白色；禁用 opacity 0.45；焦点环来自全局 focus-visible |
| 次按钮 | `Button`；panel 底、`--border2` 边框 | hover 使用 panel3／accent-line；不自动变为主按钮 |
| 危险按钮 | `Button variant="danger"`；`--bad` 填充 | 只用于不可逆确认；触发确认流程的入口用次按钮 |
| 发送按钮 | runtime-composer 的 send；独立圆形按钮 | 不能用 `.btn.primary` 的矩形样式替代 |
| 搜索输入 | `.sb-search`；36px 高、`--r-sm` | focus-within 的边界与外环来自后置皮肤；不是所有输入框的默认样式 |
| 导航项 | `.sb-navitem`；36px 高、左对齐、`--r-sm` | active 使用 surface-hover 底；会话行另有自己的选中样式 |
| 状态标签 | `.badge`；紧凑文字与边框、`--r-xs` | 默认非交互；ok／bad 按证据着色，不添加虚构 hover 动作 |
| Surface 入口卡片 | `.surface-card`；最小高度 124px、`--r-md` | 可操作入口，含 hover、focus 与按下反馈；不是所有内容容器的模板 |
| 弹窗 | `.modal`；`--r-lg`、panel 表面、`--shadow-pop`；头部最小高度 60px | 承载受保护的设置或决策 |

原生组件复用 CircleButton、PlainIcon、Notice、EmptyState、StatusDot 和 RemoteHeader。连接点的 green 仅对应 connected；pairing 为 amber；offline／notPaired 为 faint。

## UX 文案

文案集中在 `src/renderer/constants/*-copy.ts`（如 `copy.ts`、`conversation-copy.ts`），组件不内联可见文字。

1. **先定位，再写字**：动笔前说清这个页面或面板是做什么的。只保留一个核心标题和完成任务所需的键值对；标题已经说明的内容，不在副标题和说明里重复。
2. **书面、准确、简短**：用陈述句和名词短语，不用营销语（“强大”“轻松”“一键搞定”）、口语（“哦”“啦”“搞定了”）和感叹号。动作按钮用动词开头，写清对象：“删除会话”，不写“确定”。
3. **按使用频率决定形态**：
   - 每次都需要看的 → 常驻标签或键值对；
   - 偶尔需要的解释、定义、来源 → tooltip 或 `Disclosure`；
   - 需要注意的结果 → 行内 Notice，问题解决后消失；
   - 必须决定才能继续 → 弹窗。
   说明性段落不常驻显示。
4. **诚实表达缺失**：缺证据写“不可用”“未提供”并说明原因，不写成 `0`、“无”或“一切正常”；与证据语义（`exact`／`estimated`／`partial`／`unavailable`）保持一致。
5. **错误信息**：说明发生了什么、影响什么、下一步能做什么；不暴露堆栈，也不责备用户。

## Do's and Don'ts

### Do
- 用 `var(--text-*)`、`var(--weight-*)`、`var(--space-*)` 或 4 的倍数、`var(--r-*)` 和主题颜色变量；先检查最终覆写层。
- 先按语义目录选组件，再写样式；同一意图复用同一个实现。按钮用 `<Button>`／`<IconButton>`。
- 用文字、图标和状态共同说明证据；保留来源和缺失状态。
- 复用现有文案模块；保留键盘焦点、禁用态与原生触控标签。
- 新增模式前检查桌面双主题和 iOS 原生约束；具体界面再验收。

### Don't
- 不要写半像素字号、550／620 这类中间字重、5／7／9／10／14px 这类网格外间距。
- 不要在组件里写 `#hex`、`rgb()`、`oklch()` 等裸颜色；需要新颜色时先在主题层定义语义变量。
- 不要为一个新功能另起一套按钮、通知或标签页样式；扩展收敛目标而不是复制。
- 不要写 `.panel button { … }` 这种覆盖容器内所有按钮的规则；确需重置原生按钮时写成 `.panel button:not(:where(.btn, .icon-button, [role='tab'], .segmented > button))`。必须用 `:where()`：直接写 `:not(.btn, …)` 会把规则的优先级抬高到参数里最高的那一项，反过来压过组件自己的样式。
- 不要把 Provider 品牌色、选中态或连接点当作成功、授权或完整性证明。
- 不要把基础 `styles-theme-shell.css` 的颜色旧值或 `designs/` 原型直接当作当前产品规范；颜色以最终覆写层为准。
- 不要把 iOS 的 glass helper 描述成已实现的系统材质或背景模糊。
- 不要把文档示例、历史截图或代码扫描当作当前 App 的视觉与无障碍验收。

## 迁移路线

存量债务按区域分批偿还，每批都会改变可见外观，因此单独提交、单独验证（隔离 Electron fixture 深浅主题截图 + 受影响的 UI smoke），并在 [设计决策记录](docs/design/decisions.md) 记一条。

1. **地基（已完成）**：尺度 token、守卫与基线；在 scale 上的字号与字重已等价替换为 token，外观不变。
2. **核心控件（已完成）**：`Button`／`IconButton` primitive 与单一 `styles-buttons.css`，迁移全部文字与图标按钮调用点。
3. **通知与标签页（已完成）**：`Notice`、`Tabs`、`Segmented` 与 `styles-notices.css`、`styles-tabs.css`；容器级 `button` 规则改为排除 primitive，并纳入债务棘轮。
4. **按区域偿还字号与间距（已完成）**：侧栏 → 对话与工具证据 → 输入框 → 总览 → 设置与清单 → 分析视图 → 其余工作区界面，全部清零后守卫改为绝对规则。每个区域用的方法：
   - **先删死代码**：同一选择器、同一属性被后加载的顶层规则无条件重新声明的，先加载的那条一定不生效，直接删除；删除后用真实组件的计算样式比对确认零变化。
   - **再按固定规则取整**：间距取最近的 4 的倍数，恰在中间（6、10、14、18、22、30）时取 8 的倍数；字号 ≥12 的半像素向下取（12.5→12、13.5→13），<12 的向上取（9、9.5→10，10.5→11，11.5→12）；中间字重按角色取 500 或 600。
   - **守住契约**：区域内 smoke 断言的行高、宽度与对齐值不变；用计算样式比对列出每一处真实变化并逐条确认。
   - **阅读字号不随取整变化**：会改变正文阅读字号的取整先停下，确认是否需要语义 token（对话正文因此新增 `--text-reading`）。
   - **颜色由语义变量派生**：状态与证据类型的半透明底色、边框写成 `color-mix(in srgb, var(--ok) 24%, transparent)`，不写死 `rgba()`，否则浅色主题会沿用深色主题调好的色值。
5. **颜色与层级**：颜色与阴影已收敛为语义变量和固定色板（已完成）；z-index 尚未收敛为分层 token（现有约 20 个散落值）。
6. **文案**：按 UX 文案规则逐面板审查常驻说明，改为 tooltip、Notice 或 Disclosure（尚未开始）。
7. **其余组件**：菜单（14 套）尚未收敛；浮动 toast 的模式待定；可关闭的标签条与设置导航保留独立实现，但选中色与字号应对齐 `Tabs`。
