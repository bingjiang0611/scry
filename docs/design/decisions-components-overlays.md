# Scry 设计决策：组件、浮层与反馈

[返回决策索引](decisions.md)。以下为原始带日期记录；验证结论仅适用于记录中的版本与范围。

## 按钮收敛：Button 与 IconButton（2026-11-15）

范围是渲染进程里所有“执行动作”的文字按钮与纯图标按钮。选择器触发器（`.wdbtn`、`.clibtn`、`.location-button`）表达当前选择而不是执行动作，不在本轮范围；弹窗关闭继续使用 `ModalCloseButton`。

收敛前的状态：`.btn` 在两个文件中各定义一次，后定义的覆写了 hover 与主按钮文字色；另有 `.hosts-button`、`.mp-button`、`.turn-branch-btn` 三套文字按钮和 `.iconbtn`、`.mp-icon-button`、`.icon-button` 局部覆写、完全没有样式的 `.icon-btn` 四套图标按钮。尺寸从 28px 到 40px 不等，圆角有 `--r-sm` 与 `--r-md` 两种，Meta Prompts 的主按钮用反色（`--fg` 底）而非强调色，危险按钮有实心红、红字、`!important` 浅红三种形态。

| 决定 | 理由 | 落地 |
| --- | --- | --- |
| 一个组件、四个 variant、两个尺寸 | 视觉差异来自重复实现，不来自真实的语义差异 | `Button`：primary／secondary／quiet／danger × md 32px／sm 28px；`IconButton`：md 32px／sm 28px |
| 默认 32px，不再是 40px | 40px 按钮配 12px 文字在密集的工具界面里过重；与图标按钮、输入框的高度体系一致 | 弹窗按钮从 40px 降到 32px；对话工具栏、文件编辑栏、后台任务、分支按钮用 sm |
| 填充按钮文字用 `--fill-fg` | 深色主题下白字在强调色上只有 2.75:1、在危险色上 2.94:1；深色字分别为 6.65:1、6.22:1 | 新增语义变量：深色主题 `#151515`，浅色主题白色 |
| 危险操作统一为实心红 | 三种形态让用户无法从外观判断后果 | 删除会话、移除项目、移除主机、删除提示词、放弃编辑都用 `variant="danger"` |
| 默认 `type="button"` | 三个对话框里的按钮未写 type，放进 form 会触发提交 | primitive 默认 button，表单主操作显式 `type="submit"` |
| 图标按钮必须有名字 | 文件面板的 4 个图标按钮只有 `title`、没有 `aria-label` | `label` 为必填参数，同时生成 `aria-label` 与 `title` |

附带修复：终端录制历史弹窗的关闭按钮此前是浏览器默认样式且紧贴标题，底部两个按钮之间没有间距；改用 `ModalCloseButton` 并补上与其他弹窗一致的头尾布局。删除了 TSX 中已无引用的 `.gp-actions .btn`、`.wc-browse .btn` 覆写。

守卫：`Button.test.tsx` 断言 primitive 的输出、`.btn`／`.icon-button` 只在 `styles-buttons.css` 定义、退役类名不再出现、TSX 不再手写 `className="btn…"`；手写一个 `className="btn primary"` 的负对照会使该测试失败。设计债务基线随之下降（字号 272→269、字重 119→117、间距 1329→1311、颜色 145→144）。

验证：在 Playwright Chromium 中用构建后的真实 CSS 静态渲染 10 个真实组件（项目重命名与移除、会话重命名、工作区新建文件、终端录制历史、Meta Prompts、远程主机、对话删除与迁入、文件面板）和 primitive 画廊，深浅主题各拍前后对照。Electron 内的交互、键盘焦点与 UI smoke 未在本地运行（容器以 root 运行，Electron 拒绝在不加 `--no-sandbox` 时启动）；smoke 脚本中引用旧类名的选择器已同步更新，需由 CI 的 UI smoke 验证。已知限制：浅色主题主按钮白字在 `#3f7ee8` 上为 3.92:1，低于 4.5:1，属强调色本身的取值，本轮未改。

## 通知与标签页收敛：Notice、Tabs、Segmented（2026-11-15）

范围是渲染进程里所有行内通知、视图内标签页和分段控件。可关闭、可拖动的工作区标签条（`.surface-tabs`、`.terminal-tabs`）和设置页左侧导航（`.settings-tab`）语义不同，保留独立实现；浮动 toast（`.mp-notice`）与按钮旁的状态字暂不处理。

收敛前的状态：

- 通知 11 套。同样表达“警告”，有琥珀描边框（还写死了 `#b48739`）、琥珀底圆角卡、等宽字体横幅、只有红字、只有灰字五种形态；`side-chat-surface-notice` 引用了不存在的 `--muted`、`--line` 变量，`surface-layout-notice` 完全没有样式；错误提示的关闭按钮是裸 `×`。
- 标签页 7 套。有填充胶囊、蓝下划线、白下划线、整宽居中加粗四种形态。`.overview-data-tabs` 被 4 个文件逐层覆写；`.sc-tabs` 用 `aria-pressed` 按钮冒充标签页；`overview-data-tabs`、`capability-kind-tabs`、`capability-source-tabs` 写了 `role="tab"` 却没有方向键与 roving tabindex。
- 能力弹窗里语义与外观相反：切换整块面板的 Skills／MCP 长得像分段控件，过滤同一列表的“全部／项目／用户”反而长得像标签页。

| 决定 | 理由 | 落地 |
| --- | --- | --- |
| 通知只有三种语气 | 用户需要从外观判断“知道一下／需要注意／失败了”，而不是记住每个面板的配色 | `Notice` tone info／warn／bad，图标、颜色与文字同时表达；`layout="strip"` 用于贴面板边缘的提示 |
| `role` 由调用方给 | status／alert 决定读屏是否打断用户，只有调用方知道 | primitive 不隐式加 role，迁移时逐处保留原值 |
| 标签页与分段控件按语义区分 | 标签页换掉整块面板；分段控件过滤或换算同一份内容 | 能力类型改为 `Tabs`，来源过滤改为 `Segmented`（`role="group"` + `aria-pressed`） |
| 标签页统一键盘行为 | 4 套标签页无法用方向键切换 | `Tabs` 提供自动激活、方向键／Home／End、roving tabindex |
| 选中色不做过渡 | 侧栏 smoke 要求选中色与 `aria-selected` 同一帧切换 | `.tabs` 不声明 color transition；动效指示条沿用 `useTabIndicator` |
| 容器级按钮重置必须排除 primitive | `.usage-page button { font: inherit }`、`.desktop-remote__host button` 等规则的优先级不低于 primitive 且加载更晚，会悄悄改掉 Segmented 和上一轮迁移的 Button | 这类规则追加 `:not(.btn, .icon-button, [role='tab'], .segmented > button)`；设计债务审计新增第 5 项指标 `buttonReset`，存量 87 处只降不升 |

保留的合同：标签按钮的 id、`aria-controls`、`title`、顺序与侧栏动效指示条不变；通知与标签页的原类名保留为定位与测试钩子，smoke 选择器无需改动。删除了 102 个旧选择器（含 `.vtab(s)`、`.panel-tabs` 死样式）。

守卫：`Feedback.test.tsx` 断言 Notice 的语气与 role 合同、Tabs 的 roving tabindex 与键盘目标、Segmented 的 group／pressed 语义、三者只在各自样式表定义、TSX 不再手写 `role="tablist"`（两个可关闭标签条除外）。设计债务基线：字号 269→262、字重 117→114、间距 1311→1268、颜色 144→138，`buttonReset` 首次记录为 87。

验证：用构建后的真实 CSS，在 Playwright Chromium 中把迁移前后的标记放进各自的真实祖先容器（`sc-panel`、`sidebar`、`overview-dossier`、`skills-modal`、`capabilities-modal`、`diff-navigation`、`usage-page` 等）渲染，深浅主题各拍前后对照。渲染测试中 3 条写死旧标记的断言按新合同更新（来源过滤改为 group／pressed，计数改为 `.tab-count`）。Electron 内交互与 UI smoke 未在本地运行（容器以 root 运行，Electron 拒绝不带 `--no-sandbox` 启动）。已知限制：Skills 弹窗标签页左侧留白从 22px 变为 24px，与下方工具栏的 22px 相差 2px，待工具栏对齐网格时一并修正。

## 浮层层级 token（2026-11-16）

34 处 z-index 中有 17 处属于浮出组件的元素，取值 20 到 1201，彼此顺序没有规则：侧栏会话菜单（90）低于弹窗遮罩（100），diff 菜单（1200）和工作区选择器（1100）又高于所有弹窗。参照 Primer 的命名档位与 Carbon 的“菜单高于浮层面板”（见[参考案例对比](references.md)），改为 `--layer-overlay` 100／`--layer-dropdown` 200／`--layer-modal` 300，另预留 `--layer-modal-dropdown` 400 与 `--layer-tooltip` 500。

- 菜单高于抽屉：窄窗口下右侧面板是固定定位的抽屉，diff 菜单从抽屉里打开，必须在它之上。这一点与 Primer（dropdown 低于 overlay）不同，与 Carbon 一致。
- 有意的顺序变化：菜单、选择器与右键菜单原先高于弹窗，现在被弹窗盖住；原先低于抽屉的面板内菜单（20）现在高于抽屉。核对过所有渲染到根节点的浮层，没有一个从弹窗内打开，因此弹窗内的菜单行为不变。
- 不变：同层之间按打开顺序叠放；diff 回合菜单仍比 diff 范围菜单高一级（`calc(var(--layer-dropdown) + 1)`）；组件内部的局部叠放（1–16）保持字面值。
- 守卫：`design:audit` 新增 `layer` 规则，拒绝 20 及以上的 z-index 字面值；`design-system.test.ts` 检查五个 token 的取值，并禁止在其他样式表重定义。
- 未验证：真实窗口中的浮层叠放（依赖 CI 的 UI smoke 与人工查看）。

## 菜单 primitive（2026-11-16）

六套命令菜单（Agent 选择、Provider 过滤、侧栏会话菜单、侧栏项目菜单、文件区右键菜单、右侧 Surface 菜单）各自定义容器和条目：条目高度 35／36／40px，圆角三种，内边距 8 或 12px，键盘支持从“完整”到“没有”不等。按[参考案例对比](references.md)的结论收敛为 `Menu` primitive 与单一的 `styles-menus.css`。

- 方案选择：自写，不引入 Radix 等依赖。现有菜单已经共享开关状态（`usePickerOpen`、`useMenuDismiss`）、进出场动效（`usePresence`）和各自的定位方式；依赖库会连同这些一起替换，改动面和行为风险都更大。缺的只是统一的条目合同、按首字母跳转和打开时聚焦。
- 外观：容器内边距 4px、条目 32px（与 `Button` md 同档，Radix 与 Primer 的默认值），文字 13px、前景色，危险操作红色。Chromium 中按真实祖先结构渲染五个菜单，深浅主题下容器与条目的计算样式一致。
- 键盘：方向键循环、Home／End、按首字母跳转，只在启用的 `menuitem*` 之间移动。侧栏项目菜单和文件区右键菜单原先没有方向键，现在有了，并在打开时聚焦第一项；侧栏会话菜单和 Surface 菜单原有的方向键处理改由 primitive 提供，各自只保留 Esc／Tab 关闭。
- 其他：文件区右键菜单补上可读名称，危险项前加分隔线，“重命名”“移入废纸篓”改用对应图标；侧栏会话菜单的“迁入已捕获历史”补上图标（同一菜单图标要么全有要么全无）。
- 不并入：diff 范围菜单（虚拟列表子菜单）、工作区选择器（带搜索的列表）、工作目录与位置选择面板（`role="dialog"`，行内有移除按钮）、slash 命令与模型／权限弹出面板。Agent 菜单里 Pi Profile 行的移除按钮违反“菜单里不放行内按钮”，留待后续把 Profile 管理移出菜单。
- 守卫：`Menu.test.tsx` 检查输出结构与键盘函数，并拒绝在其他样式表定义菜单容器与条目、拒绝手写 `role="menu"`（上面的不并入项除外）。两条守卫都用负对照确认会失败。
- 未验证：真实窗口中的键盘操作与菜单 smoke（依赖 CI）。

## 不做通用 toast，Meta Prompts 改为就近反馈（2026-11-16）

[参考案例对比](references.md)的结论：Primer 已删除 toast，其余系统也要求反馈就近、错误不自动消失、toast 不抢焦点。Scry 不引入通用 toast，用户操作的结果分三档：界面上已经可见的只做读屏播报；需要确认的放在触发按钮旁；失败用行内提示并保留到问题解决。

唯一的浮动提示 `.mp-notice` 按此迁移：

- 复制（详情页按钮与列表行的快捷按钮）用 `useCopyFeedback`：图标变成勾、播报“已复制「标题」”，成功 2 秒后恢复；失败在按钮旁（列表行在行下方）显示原因，保留到下次尝试。反馈按提示词区分，切换提示词不会带走上一条的结果。
- 保存与删除：编辑框关闭、列表变化已经说明结果，只保留读屏播报。保存或删除失败仍显示在各自的弹窗里，与之前相同。
- 列表行的播报区只在有内容时存在，空闲的列表不产生空的 `role="status"`；Meta Prompts smoke 依赖“第一个 status 区域显示已复制”，详情页的复制状态在 DOM 中位于原浮动提示之前。

## 后台通知（2026-11-16）

维护者决定需要一个角落通知区，用于用户没在看的会话。做法参照 VS Code 的通知规则与 Radix 的前台／后台区分（见[参考案例对比](references.md)）：

- 来源：main 的待查看标记（与侧栏蓝点、Dock 角标同一来源）。某个会话新变为待查看时，按侧栏动态的分组生成一条通知：需要回复、运行失败、运行中断、运行已取消、已完成；没有记录运行结果的写“有新结果”，不写“已完成”。窗口打开时已经待查看的会话只作基线，不补发通知。目录还没跟上（运行仍标为进行中）的会话最多等 30 秒再判断，不猜。
- 位置与数量：侧栏底部、设置上方，随文档流排列（与“已存档，撤销”条同一位置），最多三条，新的在上。最初放在窗口右下角浮层，但需要回复与失败的通知会常驻，右侧面板隐藏时正好盖住输入框的发送按钮；右上角又会盖住右侧面板的“+”菜单。放进侧栏后不遮挡任何控件，只压缩会话列表的滚动区域，也挨着保存历史的“动态”视图。侧栏折叠时看不到通知，待查看蓝点与 Dock 角标仍然有效。
- 停留：需要回复、失败、中断的保留到用户打开、关闭或查看该会话；其余 10 秒后消失，悬停、键盘焦点在通知区内或窗口在后台时暂停计时。通知不抢焦点；保留类用 `role="alert"`，其余用 `role="status"`；没有通知时不渲染，不留空的播报区。
- 操作：点通知正文切到对应会话，右侧按钮关闭通知；查看该会话后通知自动移除。Sidebar 是 memo 组件，通知以数据和稳定回调传入，不额外触发侧栏重渲染。历史不另做通知中心，侧栏“动态”已经按需要回复、待查看、已完成列出所有结果。
- 不覆盖：远端会话、侧边会话与已存档会话（它们不在本机侧栏中作为可打开的行）。
- 验证：`background-notices.test.ts` 覆盖分组、解析、去重与上限、基线与重试窗口；`BackgroundNotices.test.tsx` 覆盖空状态、播报角色与操作；Chromium 中按构建后的 CSS、230px 侧栏宽度检查了排列、深浅主题与长标题截断。未验证：真实运行结束时的通知时序（依赖 CI 与人工）。
