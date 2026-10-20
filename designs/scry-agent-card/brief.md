# Scry · Pi Agent 卡片设计稿 v2

## D-20261019-scry-agent-card

- Scope / status：project:/Users/baobingjiang/IdeaProjects/vibecoding/scry；需求与 A 方向 confirmed，v2 成品待审。仅独立设计稿，不改产品实现。
- Feedback：2026-10-19 用户提供 Pi worker 卡片截图，要求“这个 agent 的卡片优化下 ui，先出设计稿”；看 v1 后选择“A 但是不要这么多文字，只保留关键信息即可”。
- 现状：重复 worker 描述；完整任务 UUID、启动回执、计时和停止说明占据同一视觉层级；状态不突出。
- Preserve：仅展示已观测任务，清单可能不完整；计时从启动回执起而非进程时长；Pi 不支持单个子 Agent 停止，结束主轮观测不能证明后台子 Agent 停止。不增加进度、Token、子 Agent 工具统计或停止按钮。
- Applied：`index.html` + `preview.js` + `style.css`，原生 HTML/CSS/JS，无依赖、外部字体或网络服务。所有原型文案集中在 `preview.js` 的 copy 对象（文档标题除外）。静态 fixture，示例状态不是运行数据。
- Preview：`python3 -m http.server 8473 --bind 127.0.0.1 --directory designs/scry-agent-card`，访问 http://127.0.0.1:8473。
- Acceptance：用户已确认 A 的结构方向，并要求减字；不等于认可 v2 或授权产品实现。
- Next use：Pi 后台任务卡片的信息噪声 → 默认只留名称/Provider/状态/观测时长、短能力限制和详情入口；技术证据与完整解释折叠 → 检查无伪造进度、无假停止能力、未知终态不变成完成。
- Revisit：方向确认后，在现有 BackgroundWorkPanel 中实现；不得改动 Provider 状态合同来迎合样式。

## v2 · A 精简版

- 默认第一行：`worker · Pi` / `等待结果` / `已观测 14m`。
- 第二行仅保留：`不可单独停止` / `详情`。
- UUID、回执、计时依据、状态依据、完整停止限制、观测范围均放入详情；未知状态不重复铺一段说明，但详情保留未收到终态的依据。不删除依据或改变权限语义。
- 删除 B 切换、Agent 冗余标签、卡片内两段说明及预览下方的设计解释。
- 本次是项目级明确反馈，不推为跨项目全局审美偏好。
- 验证：`node --check designs/scry-agent-card/preview.js`、作用域内 `git diff --check` 通过；Chrome Relay 实际 DOM 读回 v2 默认字段，折叠状态不再显示 UUID 和长说明。
- 限制：v2 截图操作超时；recover 同一标签（relayAttached=true）后仅重试一次，仍超时。详情点击返回 unknown，随后一次 snapshot_visible 仍为 expanded=false，未重发该操作。因此本次不宣称 v2 截图视觉或详情展开交互已通过；需要用户在预览中确认。不启动隔离浏览器或通过 OS 工具绕过 Relay。
- 历史研究沿用下方来源；本轮只调整信息密度，无新的视觉来源或个人组件导入。

## v1 · 两个方向（历史）

| 方向 | 结构 | 适用与代价 |
| --- | --- | --- |
| A · 紧凑卡片（推荐） | 轻边框、名称在左、状态与时长在右；证据折叠 | 独立边界更清楚，适合含限制提示的后台任务 |
| B · 内联任务行 | 名称、状态、时长连续排列，短左轨连接正文 | 更轻，但任务边界弱于 A |

重复的 worker 描述不再展示；真实 description 若与名称不同，落地时仍需保留。整轮文件证据在卡片之外，不能当成此子 Agent 的 9 次读取。

独立只读评审指出：仅有启动回执，不足以支持明确“执行中”。稿件主状态改为“等待结果”；原型保留 unknown/completed/failed 示例用于比对，不改变生产状态映射。实现时需基于已有来源明确区分“获知运行”与“尚未收到结果”。

## 研究与复用凭据

| 来源 / 区域 | 观察 | 采用 / 拒绝 | 动作与检查 |
| --- | --- | --- | --- |
| 用户截图 / worker 展开块 | 身份、证据与限制挤在一起 | 采用现有事实；拒绝 UUID 作为主信息 | 移除重复名称；证据按需展开，限制不隐藏 |
| `src/renderer/components/BackgroundWorkPanel.tsx`、`background-work.css`、`src/shared/background-work.ts` | 现有任务列表是本次卡片真实来源；description、tool、observedAt、taskId 已存在 | 复用事实与 details 原生交互；不改产品 | 比较真实字段和 Provider 停止限制 |
| `src/renderer/styles.css` / dark/light tokens | Scry 使用中性深色表面、蓝色 accent、11/12px 支持文字 | 沿用实际 text/line/accent 色；只在独立稿做布局 | 浏览器查看深浅色，不导入个人库主题 |
| https://www.anthropic.com/engineering/multi-agent-research-system / “Teach the orchestrator how to delegate” 与 production tracing 段落 | 原文强调任务边界、轻量引用和可追溯性，而非把每个任务的所有输出平铺 | 采用身份/结果/证据分层；拒绝从研究架构推导 Scry 控制能力 | 2026-10-19 curl 获取原始全文，针对相关段落抽取阅读；属于信息结构依据，不是视觉验收 |
| 库检索 `Scry` / `Agent --kind component` / `后台 --kind page` | 命中 D-20260910-qoder-background-work，保留“静默不等于失败”；UsageReadout/UsageSummary 是用量指标，不适合任务卡 | 复用项目合同，不导入无关组件；旧失效路径保持 stale | 未创建或宣称可移植组件；只登记此项目稿 |

## v1 验证记录（不作为 v2 交互证据）

- `node --check designs/scry-agent-card/preview.js`：通过。
- HTTP 预览返回的 preview.js 与磁盘文件 `cmp` 一致。
- Chrome Relay 实际渲染桌面 1512 CSS px：A/B 深色截图；改为“等待结果”后 A 浅色截图。细分层级、停止限制、文件证据分离均可见。
- Relay 鼠标展开任务证据后，snapshot_visible 确认 expanded=true，UUID、回执、计时与状态依据可读。Enter 折叠后正文不再包含 UUID。
- A/B 切换显示不同结构；未知状态选择后读回“状态未知”及“未收到子 Agent 终态，不能确认它已结束”。
- 独立 reviewer 只读文件评审，未具备浏览器工具；其评论不作为视觉验证。已修正其指出的启动回执/执行中歧义。
- 不宣称移动端、完整键盘焦点流、真实 App 或真实 Provider 已验收。此稿不调用 IPC，也不连接真实任务。
- 此阶段不构建、安装、启动或重启 Scry。现有工作区有大量无关改动，本次只交付设计目录。

## 库状态

本记录是项目权威来源；共享库只注册指针。已 register；build 成功生成 54 个条目，search 精确 ID 命中本文件。全库 check 失败于 5 个已存在的 stale 来源：P-PI-MODEL-SELECTOR、D-20260912-scry-ios-remote、D-20261008-scry-ios-continuity、P-SCRY-SESSION-HISTORY、D-20261010-scry-llm-sidebar。它们不在本次修复范围。本次记录已保存且可检索，不新增跨项目审美偏好。
