# Scry 设计决策：证据呈现与工作区

[返回决策索引](decisions.md)。以下为原始带日期记录；验证结论仅适用于记录中的版本与范围。

## 侧栏「动态」的加强（2026-10-21）

范围是 `SidebarActivity` 与 `sidebar-activity.css` 呈现的侧栏动态列表；项目视图、标签栏、行交互、文案模块和证据语义不变。此前的平铺文字仍保留，只把「哪个时刻正在发生」做成整块列表的峰值：

| 决定 | 理由 | 落地 |
| --- | --- | --- |
| 分组标题成为「幕」 | 整屏只有等高灰色文字时，用户无从分段 | 标签 + 通栏细线（`--border3`）；进行中的标签与线更亮（`--fg` / `--border2`），已完成的标签降到 `--dim` |
| 右侧状态列 | 运行状态原先只藏在标题扫光里，右列只有已完成图标 | 进行中的旋转环与「需要回复 / 已完成」图标居中对齐；悬停或聚焦时让位给操作按钮 |
| 修正强调反转 | 运行中的标题原本比已完成更暗，最重要的工作是最淡的文字 | 运行中标题回到 `--fg`，扫光带改为向中间调调制（深色里像阴影、浅色里像高光），已完成标题为 `--dim` |
| 完成段更密 | 归档是检索对象，不是当前工作 | 已完成行 28px、运行中与需要回复行 34px |

保留的既有决定：无卡片、无数量徽章、无项目副标题；动态标题与项目列表保持相同字号与字重；每组 40 行上限、布局动画、指针按住不漂移、`prefers-reduced-motion` 与强制颜色回退均不变。

验证：隔离 Electron fixture `node scripts/session-capability-ui-smoke.mjs --sidebar-activity-only` 通过全部检查，其中新增三项针对本次设计承诺（运行中标记与状态图标同列、完成段行高更小、运行中标题亮度高于完成段）；把行高改回 34px 或把状态环移出该列后，对应断言会失败。深浅主题在 280px 侧栏宽度逐张查看，运行中扫光仍以像素差确认可见。未保留其他临时测量脚本。

## 总览证据块：横向刻度（2026-10-22）

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

## 已回答问答块：台账式记录（2026-10-23）

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

## 侧栏：字号与间距清零（2026-11-15）

范围是所有选择器以 `.sb-`、`.sidebar` 开头的规则，分布在 9 个样式表中。开始前侧栏范围内的债务为：字号 16、字重 3、间距 52、未排除 primitive 的按钮规则 2。

关键发现：侧栏的大部分债务是死代码。同一个元素在 `styles-sidebar.css`、`styles-workbench-geometry.css`、`styles-workbench-layout.css` 和 `codex-alignment-shell.css` 里逐层重新定义（例如 `.sb-new` 的高度、内边距、字号各被写了三到四次），只有最后一层生效。因此本轮分两步：

| 步骤 | 方法 | 结果 |
| --- | --- | --- |
| 删除可证明的死声明 | 同一选择器、同一属性（或覆盖它的简写），被后加载的顶层规则无条件重新声明，且重要性不低于前者。只依赖层叠规则，不依赖截图覆盖了哪些状态 | 删除 174 条声明；真实 Sidebar 组件 197 个元素的计算样式在深浅主题下均为 0 差异 |
| 按固定规则取整其余值 | 见 DESIGN.md「迁移路线」第 4 步的取整规则 | 真实可见的变化只有：会话行图标间距 7→8、行内操作区左内边距 30→32、项目标题右内边距 59→60、“待回答”徽章内边距 7→8、空项目提示与撤销条字号 11.5→12、撤销条内边距统一为四边 8px |

其他决定：未读与待回答会话标题从 550 改为 `--weight-medium`（550 与正文 400、当前会话 500 几乎不可分辨，待回答另有徽章）；撤销归档的手写按钮改为 `Button size="sm"`。删除规则时连带丢失的三处章节注释已恢复。

契约：会话行 36px、项目标题 32px 的行高（`sidebar-activity-ui-checks.mjs`）在比对中未变化；`.sb-undo button`、`.sb-view-tabs [role=tab]` 等 smoke 选择器仍然有效。

守卫：`design-system.test.ts` 新增 cleaned areas，侧栏范围的债务必须为 0。在侧栏追加一条 `padding: 7px` 的负对照会使该断言失败。全局基线随之下降：字号 262→246、字重 114→111、间距 1268→1216、按钮规则 87→85。

验证：在 Playwright Chromium 中，用构建后的真实 CSS 渲染真实 `Sidebar` 组件（3 个项目，含运行中、待回答、置顶、长标题、空项目和撤销条），深浅主题各拍前后对照并逐元素比对计算样式。未覆盖：hover、动态（Activity）视图、远程主机分组、菜单展开等状态。死代码删除对这些状态同样成立（依据是层叠规则，与状态无关）；取整对它们的影响只在 CI 的 UI smoke 中验证。`SessionRename.test.tsx`（真实 Chromium 中的侧栏交互）因容器以 root 运行无法启动 Electron，本地未运行。

## 对话与工具证据：字号、间距与颜色清零（2026-11-15）

范围是首个类名属于 `turn`、`chat`、`hook(s)`、`tool`、`md`、`transcript`、`question`、`thinking`、`user-md`／`user-attachment(s)`、`subagent`、`callrow`／`callserver`、`model-text` 等族的规则，分布在约 20 个样式表中；输入框（`composer`、`runtime-*`、`model-effort-*`）是下一个区域，不在本轮。

| 步骤 | 方法 | 结果 |
| --- | --- | --- |
| 删除可证明的死声明 | 与侧栏相同：同一选择器、同一属性被后加载的顶层规则无条件覆盖 | 删除 125 条；计算样式 0 差异 |
| 按固定规则取整 | 与侧栏相同的间距与字号规则；字重 520–580→500、620–680→600、720→700 | 主要可见变化：等宽小标签 10.5→11px、Markdown 加粗与二级标题 680→600、各处 5／6／7／9／10／14／18px 间距对齐网格 |
| 阅读字号单列 | 机械取整会把助手回答的 15px 降为 14px（影响 4261 个元素），这是阅读体验的产品决定，不应被取整带过 | 新增 `--text-reading: 15px`，只用于对话阅读正文；用户消息从 14.5px 统一到同一档 |
| 颜色改由语义变量派生 | 34 处写死的深色主题状态色（绿／琥珀／红／蓝／紫的半透明值）在浅色主题下也原样使用 | 改为 `color-mix(in srgb, var(--ok|warn|bad|accent|read|agent|edit) N%, transparent)`，透明度不变；蓝色按语义区分时间（`--accent`）与文件读取（`--read`），紫色区分 Hook／插件（`--agent`）与编辑（`--edit`） |

另外：`.turn-tool-error-evidence-head button` 改为排除 primitive；删除规则时连带丢失的“方案 C”章节注释已恢复；一条解释已失效计算方式的 welcome 宽度注释随其规则一并删除。

验证方法升级：不再手写夹具，而是在运行组件渲染测试时截获每一次 `renderToStaticMarkup` 的输出（35 个测试文件、416 个去重后的真实渲染片段），放进与真实 DOM 相同的 `main-pane > chat-body` 容器，用构建后的真实 CSS 在 Chromium 中逐元素比对计算样式（32,834 个元素 × 深浅主题）。另选工具组、Hook、问答结果、用户消息与轮次、工具错误、Markdown 拍前后对照。问答结果块的契约（答案 600 字重、右边缘对齐）在比对中保持成立。

已知遗留：工具卡内问答结果的问题文字紧贴左侧色条，改动前后一致，属于既有布局问题，未在本轮处理。Electron 内的交互与 UI smoke 未在本地运行（容器以 root 运行）。

全局基线：字号 246→184、字重 111→88、间距 1216→1006、颜色 138→101、按钮规则 85→82。

## 工作区可读性与密度：第 1 轮评审修正（2026-11-16）

范围与第一轮分数见 [工作区 UI hill-climb](workspace-ui-hill-climb.md)。两位 Overall 均 8.7、highStandard 均 false；本批不预填后续分数。

- Agent Profile 优先保留宽度：flex 不收缩、最终上限 192px，移除 96px 窄栏上限；模型控件承担收缩。保留长名 ellipsis，补完整名称 tooltip；相关动作说明复用集中 copy，不改变选择行为。
- 运行元信息与统计改为 12px／dim2，footer 标签 11px／dim，who 行高 1.4；正文保持 text-reading 15px，不采纳降至 14px 的建议。
- turn 底边距 12px、相邻顶边距 16px、flow gap 8px；仅文件证据条上边距 8px、r-sm、最小高度 36px、横内边距 12px。Hook／警告与助手卡片 16px 内边距不变。
- 侧栏分区顶边距 12px，行高不变；分析改用现有 overview 图标，性能保留 chart。浅色助手卡片用 surface-muted、悬停／焦点用 surface-hover，不增加嵌套边框；不全局改图标按钮尺寸。
- 验证：设计审计无发现；10 文件 50 项 focused 测试、typecheck:web、脚本语法与 diff 检查通过。长 Profile tooltip 新测试用旧组件负对照确认失败。现有统一对话截图循环新增宽窄／深浅 computed-style 与布局断言及 JSON 证据，初版 168px 经主控真实 smoke 失败（标签可用 106px、内容 121px），修正总宽预算至 192px 后，本线程实际 build＋完整统一对话 smoke 通过；8 份布局 JSON 中标签均 121px 完整可见，未放宽断言。截图目录 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-unified-rendering-nObxcF`。实际查看四张 timeline 图；当轮交接时尚未复评；最终结论见下面第 3 轮。Linux 与长 Markdown／工具展开／运行中等相邻状态未专项验证。
- 自查：改动限定为已批准的显示与回归，无 token／primitive／证据／权限语义变更。优化子任务未 commit／push，主控统一交付；未安装。

本轮评审精确模型：第一位 `openai-codex/gpt-6.1-sol`，第二位 `openai-codex/gpt-5.6-luna`；Kimi／DeepSeek 因 Radius 403 条款、Opus 因 429 不可用而替代。


## 统计脚注减重：第 2 轮评审修正（2026-11-16）

本轮只改最终 footer 两个选择器：标签字重 semibold→regular（400）、字距 0.08em→0；数值字重 semibold→medium（500）。保留标签 11px／值 12px、现有颜色、字段与单位；标签统一大写，不改文案。此前 base 的 uppercase 被 session-evidence-chat.css 更高 specificity 的 lowercase 覆盖，最终选择器明确为 uppercase。避免连续粗体等宽统计串压过回答和文件证据。

核实真实样式链后不采纳额外压缩：textarea 的 64px 是编辑能力与既有 smoke 合同；真实 transcript 的 `.turn` 底 margin 已被更具体规则覆写为 0，并没有额外 24px 完成态间距。顶部图标已有 32px 框／16px 图标／1.6 stroke，行内分支沿用 sm 文字按钮；浅色卡片沿用前批 surface-muted，不重复增加嵌套边框或更改 primitive。

第 2 轮 sol Overall 8.5、highStandard false；luna Overall 8.2、highStandard true，后者只表示可交付意见，不符合用户门槛，仍判未通过。平均 Overall 8.35；完整各维度与取舍见 [工作区记录](workspace-ui-hill-climb.md)，不声称评分单调提升。第 1 轮评审图源已更正为 ue52x1；ELaDgR 仅是执行线程另看过的未改代码基线，不混作同一次取证。

验证：新增 computed 权重断言在修改前真实 App 上以 600≠500 按预期失败（`/tmp/scry-ui-round2-footer-negative.log`）。修改后 build 与完整统一对话 App smoke 通过（`/tmp/scry-ui-round2-build.log`、`/tmp/scry-ui-round2-app.log`）；8 份宽窄／深浅布局均为标签 400、值 500、字距 normal，并保留全部旧断言。第 3 轮截图目录：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-unified-rendering-XpOtf8/`。本线程设计审计、10 文件 50 项 focused 测试、脚本语法与 diff 检查通过；实际查看四张新 timeline 图，不打分。

主控此前的 136 文件／1335 项 renderer 测试、chat-preview-ui-smoke、sidebar-activity-only 通过结果已读取日志，作为前批相邻链路证据，不冒充本轮全量重跑。Linux 未验证；当轮记录时第三轮独立评审尚未完成，最终结论见[工作区记录](workspace-ui-hill-climb.md)。第 3 轮完成后，sol／luna 两位评审所有项均 ≥9.5，Overall 均为 9.5；第三轮后无 UI 改动。主控最终 renderer 136 文件／1335 项、node + web typecheck 与 design audit 均通过。
