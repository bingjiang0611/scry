# 参考案例对比：成熟设计系统如何处理 Scry 的待定项

调研日期：2026-11-16。对象是 [DESIGN.md](../../DESIGN.md) 迁移路线中尚未决定的四项（浮动提示、层级、菜单、文案），外加一次密度核对。每一项先列 Scry 现状，再列参考系统的做法和原因，最后给出建议。建议只是提案，涉及新 token、新 primitive 或交互模型变化的部分需要维护者决定后才实施。

## 参考对象与来源

选择标准：文档公开、规则可追溯，且与“高密度桌面开发者工具”相关。

| 系统 | 为什么相关 | 实际读取的来源 |
|---|---|---|
| GitHub Primer | 开发者工具，规则写得最细 | `primer/design` 仓库文档、`@primer/primitives` 11.10 token、`@primer/react` |
| VS Code | 最接近 Scry 的桌面开发工具 | `microsoft/vscode-docs` UX 指南、`microsoft/vscode` 源码 |
| IBM Carbon | 企业级、密度档位完整 | `carbon-design-system/carbon-website` 文档、`@carbon/styles` z-index |
| Atlassian | 层级与浮层方案正在迁移，有参考价值 | `@atlaskit/*` npm 包（文档站点在当前网络不可达，文字规则仅见搜索摘要） |
| Radix Themes／Primitives | React 无样式原语的事实标准 | `radix-ui/website` 文档、`@radix-ui/themes` 3.3 CSS |
| Apple HIG（macOS） | Scry 的主要桌面平台 | HIG 页面的公开 JSON 数据 |
| WAI-ARIA APG | 键盘与读屏行为的规范来源 | `w3c/aria-practices` |

Mobbin、Pinterest 需要登录，未使用；Material 与 Spectrum 未纳入。下文的数值均来自上述包或源码，引文均出自仓库文档原文。

---

## 1. 浮动提示（toast）

**Scry 现状**：一个浮动提示 `.mp-notice`（Meta Prompts 的保存、复制、删除结果；成功 2.4 秒后消失，错误保留）；`useCopyFeedback` 在复制按钮旁显示状态（图标变成勾、读屏播报，成功 2 秒后恢复，失败保留到下次尝试），用于总览 sessionId 和远程邀请码；其余结果用行内 `Notice`。没有统一的 toast 规则。

**参考做法**

| 系统 | 立场 | 关键规则 |
|---|---|---|
| Primer | **不用 toast**。2024 年删除了 Toast 文档，只保留 Banner 与 InlineMessage | “Whenever possible, place messages near the action they are related to.”；复制的示例是“a green checkmark appears to the right of the icon button”；“Use success messaging sparingly and rely more on interaction context.” |
| VS Code | 通知是最后手段，右下角 | 最多同时 3 条；信息／警告／错误分别 10／12／15 秒后收起；鼠标悬停、获得焦点或窗口失焦时不收起；带操作的错误、展开的、有进度的通知常驻；收起后仍可在通知中心找到 |
| Carbon | 允许，用于“与界面某处无关的系统消息” | 最多两行；默认常驻，可选 5 秒自动消失；带操作的 toast 只能有一个操作且不自动消失；行内通知从不自动消失 |
| Atlassian Flag | 允许，左下角 | 8 秒自动消失，悬停或获得焦点时暂停；只显示最前一条 |
| Radix Toast | 区分前台（用户操作结果）和后台（后台任务） | 默认 5 秒；悬停、获得焦点、窗口失焦时暂停；toast 里的操作必须在应用里有永久入口 |
| Apple HIG | macOS 没有应用内 toast | “Consider integrating status feedback into your interface … near the items it describes.”；尽量少用限时消失的元素 |
| WAI-ARIA APG | — | 提示不能抢焦点；避免自动消失（WCAG 2.2.3） |

**为什么这样做**：toast 出现在离触发点很远的位置，读屏用户容易错过，限时消失对阅读慢、操作慢的用户不友好。所有系统一致的部分是：结果优先就近显示；错误和需要操作的消息不自动消失；toast 不抢焦点、通过 live region 播报；收起后的消息要有地方能再找到。

**建议**

1. 不引入通用 toast 组件。用户操作的结果按三档处理：
   - 结果在界面上自然可见（列表多了一行、开关变了）→ 不额外提示，只给读屏播报（`role="status"`）。
   - 需要确认但不影响后续操作（已复制、已保存）→ 按钮旁的状态，统一用 `useCopyFeedback` 的形态（图标变成勾并播报，成功 2 秒后恢复，失败保留）。
   - 失败或需要处理 → 行内 `Notice`，不自动消失，问题解决后移除。
2. `.mp-notice` 迁到上述规则：保存与复制结果放在对应按钮旁，错误改为编辑区内的 `Notice`。
3. 后台事件（运行在后台完成、远端主机断开）是否需要一个角落通知区，**需要维护者决定**。如需要，采用 VS Code 的约束：右下角、最多 3 条、错误常驻、悬停暂停、有历史入口。

## 2. 层级（z-index）

**Scry 现状**：34 处 z-index 声明，取值从 1 到 1201，没有命名档位。浮层之间的顺序不一致：侧栏会话菜单是 90，低于弹窗遮罩 100；diff 菜单是 1200，高于所有弹窗；工作区对话框遮罩 300 又高于普通弹窗遮罩 100。

**参考做法**

| 系统 | 档位 |
|---|---|
| Primer（`--zIndex-*`） | sticky 100 < dropdown 200 < overlay 300 < modal 400 < popover 500 < skipLink 600；另有 behind −1、default 0 |
| Carbon | overlay 6000 < header 8000 < modal 9000 < dropdown 9100（“Dropdowns that render outside of a Modal should render above a Modal”） |
| Atlassian | 旧的数字档位 card 100 … tooltip 9999 已标记弃用，改用浏览器原生顶层（`popover` 属性与 `<dialog>`） |
| Radix Themes | 只允许 `auto`、`0`、`-1`；浮层渲染到根节点，按打开顺序叠放 |
| VS Code | 带注释的字面值（2545、2550、2575），注释写明“高于什么、低于什么”。这正是没有命名档位时的维护成本 |

**为什么这样做**：命名档位让“菜单在弹窗之上还是之下”成为一次性的决定，而不是每次写一个更大的数。较新的方案（Atlassian、Radix）干脆不用数字：浏览器顶层天然按打开顺序叠放，菜单从弹窗里打开就在弹窗之上。

**建议**

1. 近期：在 `styles-theme-shell.css` 增加命名层级 token，按 Primer 的顺序，并为 Scry 补一档“弹窗内菜单”：

   | token | 值 | 用于 |
   |---|---|---|
   | `--layer-sticky` | 100 | 吸顶表头、面板顶栏 |
   | `--layer-dropdown` | 200 | 菜单、选择器、悬停卡片 |
   | `--layer-overlay` | 300 | 侧拉面板、窗格切换动效层 |
   | `--layer-modal` | 400 | 弹窗遮罩与弹窗 |
   | `--layer-modal-dropdown` | 450 | 从弹窗里打开的菜单 |
   | `--layer-tooltip` | 500 | tooltip |

   组件内部的局部叠放（1–3）保留字面值；跨组件的浮层一律用 token，并纳入 `design:audit`。迁移时要逐个确认现有浮层是否会在弹窗内打开（diff 菜单、工作区选择器现在高于弹窗，可能正是为了这种情况）。
2. 远期：Electron 的 Chromium 已支持 `popover` 与 `<dialog>`，可以像 Atlassian 一样迁到原生顶层，彻底去掉浮层 z-index。这会改变焦点与关闭逻辑，**需要维护者决定**，建议在菜单收敛时一起评估。

## 3. 菜单

**Scry 现状**：14 套菜单。条目高度 35／36／40px 不等，圆角 `--r-xs`／`--r-sm`／`--r-md` 都有，水平内边距 8 或 12px。键盘方面已有一个共享函数 `moveMenuFocus`（`WorkdirPicker.tsx`：上下方向键循环、Home／End），Provider 过滤和 CLI 选择在用；但侧栏项目菜单和文件区右键菜单声明了 `role="menu"` 却没有方向键导航，侧栏项目菜单的条目也缺 `role="menuitem"`。按 WAI-ARIA，`role="menu"` 承诺了方向键，这两处是现存的无障碍缺陷。现有实现都还没有按字母跳转。

**参考做法：条目结构**（各系统一致）

- 前置图标：同一菜单里要么都有，要么都没有（Primer、Apple）。
- 勾选标记在条目最前；菜单里只要有可选条目，全部条目一起缩进（Primer）。
- 尾部只放快捷键或子菜单箭头（Primer）；快捷键按操作系统显示（⌘B 与 Ctrl+B）。
- 分组用分隔线和组标题；危险操作放最后（Primer、Apple、Carbon）。
- 子菜单最多一层（Carbon、Apple）。
- 菜单里不放输入框、按钮或复选框；需要搜索过滤时换成带输入框的弹出面板（Primer SelectPanel、VS Code Quick Pick）。
- 命令用菜单语义（`menu`／`menuitem`），选值用列表语义（`listbox`／`option`）。

**条目高度**

| 系统 | 条目高度 | 文字 |
|---|---|---|
| VS Code | 24px，菜单最小宽 160px | 13px |
| Radix Themes | 24（size 1）／32（size 2，默认） | 12／14px |
| Primer ActionList | 约 32px（按内边距和行高推算） | 14px |
| Atlassian | 40（默认）／32（紧凑） | 14px |
| Carbon | 24／32／40／48，与触发按钮同档 | 14px |

**键盘**（APG，Primer、Carbon、Radix 都照此实现）：打开后焦点在第一项；上下方向键移动并循环；Home／End 到首尾；按字母跳到对应条目；Esc 关闭并把焦点还给触发按钮；Tab 关闭菜单。

**建议**

1. 新增 `Menu` primitive（`Menu`、`MenuItem`、`MenuGroup`、`MenuSeparator`），只负责结构、样式和键盘；定位与触发仍由调用方负责。是否引入 `@radix-ui/react-dropdown-menu` 之类的依赖代替自写，**需要维护者决定**；自写的话从现有 `moveMenuFocus` 扩展，补上按字母跳转、打开时聚焦第一项和 Esc 归还焦点。
2. 条目高度定为 32px（与 `Button` md 同档，也是 Radix、Primer 的默认），文字 `--text-md`，圆角 `--r-sm`，容器内边距 4px。现有 40px 条目在桌面参考里偏高。
3. 带搜索的选择器（工作区选择器、slash 命令）不并入 `Menu`，归为“带输入框的弹出面板”，用 `listbox` 语义。
4. 先修现存缺陷：给侧栏项目菜单和文件区右键菜单接上 `moveMenuFocus`，侧栏项目菜单的条目补 `role="menuitem"`；这一步不依赖上面的决定。

## 4. UX 文案

**Scry 现状**：DESIGN.md 的文案规则（动词开头写清对象、不用营销语、缺失写“不可用”、错误写清发生了什么／影响／下一步）与参考系统的共识一致。

**参考系统里 Scry 还没有的规则**

| 规则 | 来源 | 对 Scry 的意义 |
|---|---|---|
| 区分删除、移除、清除：删除是销毁对象，移除是从集合中拿掉但对象还在，清除是清空字段或选择 | Carbon 用词表 | Scry 现有文案已经这样用（删除 Scry 副本、录制、提示词；移除项目、主机、排队消息；清除候选文件选择），但没有写成规则，写进用词表防止以后混用 |
| 按钮用具体动词，只有找不到具体动词时才用“确定”；英文里“Run”优先于“Execute” | Carbon、Apple | Scry 的“执行”多用于技术语境（Hook 执行、执行确认），可以保留；用词表只约束按钮文字 |
| 结果反馈沿用触发控件的动词（点“转移”就提示“正在转移”，不说“正在移动”） | Primer | 补进规则 |
| 错误标题说明什么停止了或做不了，正文必须给出用户可做的操作；正文不复述标题 | Carbon、Apple | 把“下一步”从建议改为必需 |
| 不责备、不过度道歉、失败时不幽默（不写“哎呀”） | Primer、Apple | 已隐含在规则里，可写明 |
| 已知用户创建过的东西暂时读不到时，说明“不可用”，不显示通用空状态 | Primer | 与 Scry 的“缺失不写成 0”一致，可补进空状态规则 |
| 空状态只给一个主要操作；错误状态不放插图 | Primer、Apple | 与现有规则一致，可写明 |

大小写规则（Primer、Carbon 用句首大写，Apple 菜单用标题大写）对中文界面不适用。

**建议**：在 DESIGN.md 的“UX 文案”补一个用词表（删除／移除／清除；按钮不用“确定”）和上面几条规则；属于文档改动，不改变界面。逐面板审查文案仍按迁移路线第 6 步进行。

## 5. 密度核对

| | 正文 | 小字 | 默认控件 | 紧凑控件 | 列表／菜单行 |
|---|---|---|---|---|---|
| macOS HIG | 13pt／16pt 行高 | 10–12pt | 28pt | 20pt | — |
| VS Code | 13px | 12px | 约 24px | — | 22／24px |
| Primer | 14px／20px | 12px | 32px | 28px | 约 32px |
| Carbon、Atlassian、Radix | 14px／20px | 12px／16px | 32px | 24px | 32–40px |
| **Scry** | 14px／1.55；控件多为 13px | 11–12px | 32px | 28px | 导航与会话行 36px；菜单 35–40px |

结论：Scry 的字号档位和按钮高度与参考一致（按钮 32／28 等于 Primer 的 medium／small，也接近 macOS 默认的 28pt）。明显偏离的只有菜单条目（35–40px），在第 3 项里一起处理；不建议调整整体字号或按钮档位。

---

## 决定与落地（2026-11-16）

维护者的决定和实际落地方式如下，细节见[设计决策记录](decisions.md)。

1. 后台事件需要通知区：落地为侧栏底部的后台通知。最初按建议放在右下角浮层，但常驻的通知会挡住输入框的发送按钮，因此改为侧栏内随文档流排列；规则沿用 VS Code（最多三条、需要处理的常驻、其余 10 秒后消失且悬停与窗口在后台时暂停、有历史入口）。
2. 层级先上命名 token：`--layer-overlay`／`--layer-dropdown`／`--layer-modal`，另预留两档。菜单高于抽屉，采用 Carbon 的顺序而不是 Primer 的，因为 diff 菜单从抽屉里打开。
3. 菜单自写 `Menu` primitive，条目 32px，不引入依赖。理由：现有菜单已共享开关、关闭与动效逻辑，依赖库会一并替换这些。

无需决定的三项也已完成：两个菜单补上方向键导航；Meta Prompts 的浮动提示改为就近反馈；文案用词表写入 DESIGN.md。
