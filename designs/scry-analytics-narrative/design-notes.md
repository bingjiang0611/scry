# Scry Analytics Narrative — 设计说明

## 范围与假设

- 这是 `AnalyticsView` 的高保真交互原型，不修改 Scry 应用源码，也不连接 Provider / SQLite。
- 页面数值是结构仿真样本，只用于验证信息层级、缺失态、响应式和交互；不是本机真实统计。
- 保留 Scry 的工作台外壳、深浅主题、Provider 类别色、danger / warn 语义色和「未知不按 0」红线。
- 首轮不动 Chat、`OverviewPanel`、MCP modal；这些区域与当前尚未提交的 OAuth / Provider 改动重叠。

## 参考证据

- 线上参考：<https://leeknowlton.github.io/run-streak/>
- 固定源码：<https://github.com/leeknowlton/run-streak/tree/ce0cff3e226456601a6e61701066742043f7ee23>
- 视觉 token：<https://github.com/leeknowlton/run-streak/blob/ce0cff3e226456601a6e61701066742043f7ee23/src/tokens.css>
- 页面骨架：<https://github.com/leeknowlton/run-streak/blob/ce0cff3e226456601a6e61701066742043f7ee23/src/app.css>
- 个体 ledger：<https://github.com/leeknowlton/run-streak/blob/ce0cff3e226456601a6e61701066742043f7ee23/src/acts/you.css>

迁移的是「少卡片、强层级、结论标题、统一选中态、口径贴图、问题专属图形」，不是 36 屏 pinned scroll、guided tour、地图或径向图。

## 设计审查

| Before | After | Why |
| --- | --- | --- |
| 5 个等宽 KPI 后接两列卡片墙 | 4 个按时间与问题分章的证据区 | 先建立阅读顺序，再展示精确数值 |
| 图表标题只说数据类型 | 标题直接给可计算结论 | 用户先知道「发生了什么」，再检查证据 |
| KPI、图表、表格都被圆角卡片包围 | 主要靠留白、hairline、轴与 ledger 分区 | 减少容器噪音，提高数据本身的权重 |
| Token partial 可能呈现实心精确柱 | partial 用斜纹、`≥` 与覆盖比表达 | 已知下界不能伪装成完整总量 |
| Provider、状态与强度色竞争 | Provider 色只编码类别；红黄只编码风险；青色只编码当前高亮 | 一个视觉变量只承担一个稳定语义 |
| donut 展示模型长尾 | 原型暂不展示模型分布 | 当前 SQL 先按 cost 截断，不能诚实声明 Token 全量构成 |
| 仅靠原生 `title` 找细节 | 日期可点击并打开点线 ledger；Provider 高亮贯穿页面 | 精确证据可见、可键盘操作，也保留快速扫读 |
| 高频页面切换加入大段 reveal | 导航即时；仅 hover / press / 高亮用 120–140ms 反馈 | Analytics 是日常工具，不是营销 scrollytelling |

## 四章信息架构

1. `00 · 近 30 天`：Token 密度场、完整轮次覆盖、日期钻取。
2. `01 · Provider 覆盖`：已知 Token、known / turns、cache 口径、danger capability。
3. `02 · 工具与延迟`：按 calls 排名、avg duration / error 旁注、MCP P50 / P95。
4. `03 · 风险与盲区`：90 日 classified events、unsupported Provider 的独立解释。

## 实现前的查询前置修复

1. `TOOL_STATS_SQL` 当前先按 `avgMs` 取 8，再由 UI 按 calls 排序；必须改为 calls Top N。
2. `BY_CWD_SQL` 当前按 cost 取 5，却在 UI 里按 turns 命名；必须统一口径。
3. `BY_MODEL_SQL` 当前按 cost 取 8，不能直接画成 Token 全量分布。
4. 日 Token 的 partial 判定必须比较 `inputKnownTurns / outputKnownTurns` 与 `turns`，不能只看合计是否 `null`。

## 动效与响应式

- 高频章节导航即时切换，不做入场动画。
- 点击反馈只缩放至 `0.97`，120–140ms `ease-out`；仅动画 `transform / opacity / color`。
- `prefers-reduced-motion` 下所有位移动效降为近零时长。
- 宽屏保留侧栏 + 两栏叙事；主区小于 1000px 改为上下结构；viewport 小于 1120px 时侧栏收为 72px 图标栏。
- 图形通过主区 container query 重排，不依赖整个窗口宽度。

## 原型验证记录

- 默认桌面 viewport（1280px）与窄桌面 viewport（1024px）均无横向溢出。
- 已验证四章渲染、章节导航、日期下钻、Provider 贯穿高亮、风险能力行联动、口径抽屉和深浅主题切换。
- `08-07` 的缺失样本显示为 `≥ 92k · 0/1 轮完整`；Codex 风险视图显示 `— · 分类能力未支持`，没有把未知或未支持画成 0。
- 浏览器控制台无 runtime error；仅保留单文件原型使用 in-browser Babel 的开发期 warning，产品实现时由现有 Vite 构建链预编译。
- 本轮只交付设计资产，因此未执行 Scry 源码的 typecheck、test、build、pack 或安装；应用实现需在隔离的干净 worktree 中进行。
