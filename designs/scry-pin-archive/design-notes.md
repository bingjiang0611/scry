# Scry 侧边栏置顶与存档 · 设计说明

原型：`Pin & Archive.html`（HTTP 打开，`http://localhost:4311/scry-pin-archive/Pin%20&%20Archive.html`）。
顶栏两个旋钮：主题 深色/浅色、场景 侧边栏 / 设置·外观 / 设置·已存档。会话的置顶、存档、取消存档、删除都是真实状态变更，可以连着点。

## 设计上下文

没有用外部 design system。`tokens.css` 是从 `src/renderer/styles.css` 的 `:root` / `:root[data-theme='light']` 抄出来的生产 token；`pin-archive.css` 前三节抄的是生产侧边栏（`styles.css:6076-6302`）和设置弹窗（`6878-6990`）规则，所以密度、圆角、provider 标签的大小写和 mono 字体都跟真实 App 一致，新增部分只能在这套词汇里加东西。

## 三个决定

**1. 置顶是顶层独立分组，跨项目平铺。**
`置顶 N` 排在 `最近 N` 上面，置顶的会话从原项目分组里移出去（不双份显示）。因为跨了项目，行的 meta 里必须补一个项目名（`· rate-native`），否则会丢掉「这条会话属于哪个工作目录」这个 Scry 最核心的上下文——Codex 的置顶区没有这个问题是因为它本来就不按项目分组。置顶为 0 时整个分组连标题一起隐藏。

**2. 操作入口是行内 hover 图标，右键菜单整体去掉。**
鼠标移到会话行（或键盘 focus 进去），右侧浮出 `置顶` + `存档` 两个 24px 图标按钮，左边带一段渐变遮罩把标题渐隐掉。已置顶的行 pin 图标是 accent 色、`aria-pressed=true`，图形不换——13px 下的「斜杠 pinOff」看不清。

存档会让行从列表消失，所以列表底部给一条 `已存档「xxx」· 撤销` 的一次性撤销条，否则误点只能进设置里翻回来。这条不是需求里写的，觉得多余可以砍。

**3. 设置弹窗加宽 + 左侧 tab 栏。**
`.settings-modal` 从 `min(480px, 92vw)` 改成 `min(920px, 94vw)` 固定 620px 高，左侧 188px 竖排 tab（外观 / 已存档会话 N），右侧内容区。外观那一节的两张主题卡片原样保留，只是不再撑满整个宽度（限 460px）。

已存档会话页照 ChatGPT 的信息结构，但用 Scry 的说法：搜索框 + Provider 筛选 + 项目筛选 → 按项目分组的卡片列表 → 每行「垃圾桶图标（永久删除）+ 取消存档」，右上角 `全部删除`。`全部删除` 不弹系统对话框，而是就地展开一条红色确认条并写清数量（`永久删除全部 9 个已存档会话？`）；它删的是全部已存档会话，不受当前筛选影响，所以数量必须写出来。

空态两种分开写：一种是真的没有存档（引导去侧边栏存档），一种是筛选没命中（引导改条件）。

## 落地时要注意的

- **`.sb-sess` 现在是 `<button>`，行内塞按钮会嵌套 button（非法 HTML）。** 原型里的做法是拆成 `div.sb-sess-row` 包裹层 + 内部 `button.sb-sess` + 绝对定位的 `.sb-sess-acts`，hover 态从 `.sb-sess:hover` 挪到 `.sb-sess-row:hover .sb-sess`。这一步必须做，不能只加图标。
- **数据模型要加两个可选字段**：`SessionMeta`（`src/preload/index.ts:47-65`）和 `AppSession`（`src/main/app-store.ts:20-30`）各加 `pinnedAt?: number | null` / `archivedAt?: number | null`，同时改 `isAppSessionArray`（`app-store.ts:164-179`）的校验，老数据缺字段要当未置顶未存档处理，不能判成非法把索引整个降级。
- **删除 `Sidebar.tsx` 的 ctx 菜单**：状态 `ctx`（72-89）、`onContextMenu` / `ContextMenu` 键盘分支（217-245）、菜单 DOM（277-312）、CSS `.ctx-overlay/.ctxmenu/.ctxitem`（`styles.css:497-531`）。`onDelete` prop 和它背后的 `agent:deleteSession` IPC 不要删，改由已存档页调用。
- **hover 操作会盖住运行中转圈**：`.sb-running` 在行右侧，被操作区遮住。正在运行的会话要不要禁掉存档（或者存档时先停 run）需要单独定一下——原型里没管。
- 存档不动 SQLite 里的 turn/span 数据，文案已经写明「历史记录、用量与 trace 都保留」；真删除才走 `deleteSessionData`。这条口径别在实现时改掉。
