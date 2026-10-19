# Scry 工作流 · 方案 v4 / 原型 v3

状态：用户已确认“任务驱动编排，模板作为捷径”。本轮完整核对 Claude Workflows 文章，更新技术方案和三张 Mermaid 流程图；HTML 仍为 v3 固定模板原型，不接生产、不调用 Provider、不修改真实工作区文件。

## v4 技术方案修订

- [技术方案与流程图](implementation-plan.md)：自动规划和三种 Scry 模板共用结构化计划、依赖调度和运行面板；不执行任意生成 JS，不再把每个目标强制套同一四阶段模板。
- [官方原文核对](reference-notes.md)：完整读取官方 Markdown 506 行。当前只明确内置 `/deep-research`；审计、迁移、循环修复等属于六类示例提示词，不能混称内置命令。
- 吸收 phase/agent/pipeline 的分层、外置中间结果、结构化输出和可复用模板；不照搬固定并发/总量上限、null 过滤、自动重启、顺序重放、模型静默替换或仅特定订阅支持的配额等待。
- Jev 首批用于分类、分组和复核优先级，不能替代事实验证，也不宣称一定省钱；开启关闭、模型与阈值仍由用户配置。
- 计划确认、动态集合展开、派发前持久化、所需证据收口、未知结果不重发和受影响依赖失效均写入验收门槛。
- 本轮只改文档，没有将方案更新宣称为生产实现。下一步是协调 main 的并行 WIP 所有权后从 M1 开始，不重复询问用户已经确认的编排方向。

### v4 验证与交付记录

- `git diff --check` 通过；三个 Markdown 文件的本地链接及代码围栏检查通过。三张 Mermaid 为方案源图，未运行 Mermaid 渲染器。
- 另提供 [SVG 总览图](workflow-overview.svg)：XML、可访问标题/描述、无 script/foreignObject 检查通过；Chrome Relay 1512×764 实际截图检查文字、分支/回流箭头和证据投影，整图可见。它是架构说明，不是运行截图。
- 默认 `npm run install:mac:dev`：当前工作区 Scry 0.2.205 / Vitest 3.2.7；node/web typecheck 通过。全量 unit 270 文件通过、11 失败、4 跳过；3421 测试通过、24 失败、4 跳过；900.50s，退出 1。
- 失败摘要实际含子进程 timedOut/SIGKILL、5000ms 超时及断言差异。失败涉及 Provider、remote、Git 与性能 fixture，未逐项定位原因，不能推断全是资源争用或声称已修复。失败文件不在本次文档/SVG 改动范围，Vitest 排除 designs；当前还有并行 WIP，不能把总数变化当同源码对照。
- shell/build/package/install 未进入，未替换 `/Applications/Scry.app`、未重启 Scry。未重跑掩盖首轮失败或放宽测试。进程组 99133 已收敛为空；日志 `/tmp/scry-workflow-plan-v4-install.log`，退出码 `/tmp/scry-workflow-plan-v4-install.exit`。
- 后续实施按方案 M1 起步；全量失败需由相应代码所有者另行排查，未混入本轮方案任务。预览服务保持可用。

## v3：Jev 与左侧 Workflow 的真实含义

用户要求加入可配置 Jev，并询问左侧是否按任务自动编排。

- 当前左侧是固定鉴权审计模板的流程示意，不是模型生成的 Workflow，也没有执行 `workflow.js`。现已直接标记“鉴权审计模板 · 流程示意”。
- Jev 单独作为可选 classifier 节点，不混入 coding Agent 模型列表。支持启用、`jev-latest` 与复核阈值（默认 0.70）。开启后同时更新左侧、四节点图和回放阶段；关闭则是原有三节点图。
- 3 条分类样例使用 P(true)=0.96 / 0.09 / 0.55，置信度为 max(p,1-p)。低于用户阈值标记 Agent 复核；所有候选保留。示例概率明确标注非 API 返回，不宣称真实分类或文件修改。
- Agent 数与分类请求数分开；配置随运行冻结，保存只影响下一次演示。增加“下一阶段”回放快捷键，通过同一状态机推进事件，不跳过依赖或编造额外任务。
- 用户随后已确认按任务生成结构化计划，模板作为捷径。原型尚未实现此能力；当前合同与实施顺序以 v4 技术方案为准。
- 复用已收录的 `D-SCRY-WORKFLOWS` 画布和原生配置表单；本轮共享组件检索无现成分类配置组件。TypeSafe 官网仅用于核对 typed decisions / calibrated confidence，不采用营销的速度与成本数字；本机 Pi Classify 文档用于区分 bool 概率与 choice/score confidence，不当作 Scry 已集成 API。

### v3 实际验证

- `node --test designs/scry-workflows/demo-state.test.mjs`：13/13 通过。新增覆盖可选节点、按配置插入依赖、模型类型隔离、配置冻结、阈值改变路由、缺失概率、Jev 暂停/停止。原有 257 个就绪任务全派发回归仍通过。
- 负对照：临时副本误把 bool confidence 写成 probability，同一测试正确失败（0.09 ≠ 0.91，路由错误）。未改正式源码；临时副本已清理。
- `node --check designs/scry-workflows/app.mjs`、`git diff --check` 通过。
- Chrome Relay：开启 Jev、保存，当前三节点运行不变；重新演示出现 Jev 节点与左侧 classify 行。“下一阶段”后 Agent=0、classifier requests=3；下一次推进产生 3 条分类结果，之后才进入 edit。
- 点击 Jev / 签名检查，实际显示 P=55%、置信度 55%、阈值 70%、Agent 复核。将配置改为 0.97 保存，当前结果不变；重新演示后 3 条都标为低置信度，验证配置确实影响回放而不只是改标签。
- 1497×764 截图检查四节点、粉色 Jev 连线、左侧高亮、分类计数与配置输入。没有扩大到本轮未操作的窄窗口、屏幕阅读器、系统 reduced-motion 或真实 API 验收。
- 一次打开配置的 click 超时，原 tab recover（relayAttached=true）并只读确认弹窗已打开，未重发未知写操作。后续使用新 refs 正常完成。

### v3 默认安装

`npm run install:mac:dev` 退出 2，在 `typecheck:node` 被 `src/preload/index.test.ts:135` 的 TS1360 阻断：remote 映射缺少 `forkSession`、`deleteSession`。该文件/合同不在本次原型改动中，工作区仍有并行 remote/iOS WIP；未顺手修改它们或重跑掩盖首轮结果。

Web typecheck、全量 unit/shell、build/package/install 未进入；未替换 `/Applications/Scry.app`，未重启 Scry。日志 `/tmp/scry-workflow-jev-install.log`，退出码 `/tmp/scry-workflow-jev-install.exit`。由 remote WIP 所有者补齐合同与检查，再运行安装；这不妨碍预览本地原型。

以下保留 v2 的设计依据与历史检查，不作为 v3 新增能力的验收证据。

## v2 反馈：替代 v1

用户：“我要做的是这种可视化效果，不要设置并发上限。”参考为同一 mirku 视频截图，并给出 v1 配置弹窗反例。

- v1（`3cd5704`）的常规任务面板与并发控件被否定，不再作为视觉基线；旧源码和检查记录保留在该提交。
- v2 必须呈现左侧编排脚本／等待状态、中间主会话与运行器、scan/edit/verify 节点连线、运行中的 Agent 点阵、底部事件流。
- 删除并发输入、固定派发上限、槽位分母及实施方案中的单活动 workflow／固定任务数限制。不得将它们移到隐藏配置。
- 保留用户逐阶段选择 Provider／模型、不使用 Claude 原生 Workflow、证据诚实、renderer 隔离与 trust gate。
- 此约束仅属于 Scry 工作流，不升级为全局视觉主题或所有项目的并发政策。

## 参考与复用

| 参考区域 | 观察与采用 | 不采用／检查 |
| --- | --- | --- |
| 用户本轮视频截图；https://x.com/mirku21/status/2111200540772221418 | 终端框架、紫色主编排、蓝色扫描、橙色修复、绿色验证；节点间的分派与回流线 | 不复制零 token 消耗、未经证实的速度、JEV 延迟或模型版本宣传 |
| 左侧脚本栏 | 当前 phase 高亮，主会话等待执行结果 | 这是可视化示例脚本，不宣称已经执行任意 JS |
| 中间 JEV 面板 | 采用窄而高密度的分派层 | 改成 Scry runtime，三行表示配置来源、依赖就绪、证据确认，不伪装成已集成 JEV 或概率指标 |
| scan/edit/verify 并列节点 | 扇出连线、阶段进度、每任务点阵、返回主会话 | 用依赖状态区分可运行与等待，不让排队等于 Provider 限流 |
| 底部日志 | 回放时间、来源、任务事件形成连续轨迹 | 明确是演示事件；不编造真实费用、速度或源码审计结果 |
| v1 反例 | 横排普通卡片＋任务列表，配置比运行图更突出 | 移除常驻列表和侧边导航，任务详情按节点展开；模型配置变为次要入口 |
| 现有产品 | Provider/profile/model 身份、停止待确认、unknown 语义 | 生产复用 Pickers 与事件合同；本版视觉只作用于原型，不覆盖生产 tokens |

已复用上一轮技能调研，并再次检索 Scry 自有工作流及流程组件。工作流项目记录命中，未命中可直接导入的流程组件。用户提供的原始截图就是本轮外部视觉来源，不以索引摘要替代。

Craft：等宽数字、根背景、焦点即时反馈、reduced-motion。连线和状态颜色的设计属于本参考的局部视觉选择，不是通用 UI 规则。

## 实际原型行为

- 页面默认播放有限样例：9 个扫描任务 → 4 个隔离修复样例 → 3 个验证任务 → 主会话汇总。一次派发该阶段全部就绪任务，没有并发槽位数。
- 这是包含未来修复阶段的视觉回放，没有真实 worktree、文件写入或 Provider 调用；点击 edit 可见说明。真实执行第一期仍按方案先完成审计闭环，不能拿回放冒充实现。
- 连线粒子标示当前阶段，脚本 phase 高亮与节点点阵使用同一演示状态。修复与验证尚未就绪时保持暗态。
- “暂停回放”只冻结演示时间；“暂停调度”允许在途样例结束，但不启动后续阶段。两者不是同一能力。
- 停止先进入 STOP REQUESTED，下一帧才模拟确认；未开始的任务取消，不自动重发。
- 点击阶段查看完整请求模型与任务结果；最后一项验证缺少证据，保留 unverified。
- 模型配置按阶段冻结；Provider 切换清空旧模型。只有 Pi 有额外样例配置档。保存只作用于重新演示；目录不代表本机登录／可用模型。
- v3 模板存于浏览器 `scry-workflow-prototype-v3`；旧演示 localStorage 不迁移、不删除。只保存样例配置，不包含 API key 或生产数据。
- 显示日志保留最近 120 条、画布显示最近 6 条。这个显示界限不限制可派发任务数量。
- 页面隐藏时暂停演示计时，离开页面清理 timer；系统 reduced-motion 关闭连线动效。生产后台执行不会因面板隐藏而暂停。

## 预览与自动检查

```sh
python3 -m http.server 8767 --bind 127.0.0.1 --directory designs/scry-workflows
node --test designs/scry-workflows/demo-state.test.mjs
node --check designs/scry-workflows/app.mjs
```

入口：`http://127.0.0.1:8767/`。只服务此目录；不服务仓库根或 HOME。现有本地预览服务可复用。

### v2 历史验证

- 状态测试 7/7 通过：模型冻结、Provider/profile/model 失效、无隐藏并发限制、暂停与在途收敛、停止请求与确认、scan/edit/verify 保留未验证、日志窗口不限制任务派发。
- 无上限检查不是只删输入框：提供 257 个就绪任务，断言 257 个全部进入 running；默认配置只含 stages，没有并发字段。
- `node --check app.mjs` 与 `git diff --check` 已通过。
- 负对照：临时副本在 dispatch 中加回 `.slice(0, 4)`，同一测试失败，实际 4、不等于预期 257。正式源码未修改；临时副本已删除。
- Chrome Relay 实际观察：1497×764、1497×708；最终版 1512×708 截图包含完整画布、日志和回放控件。主会话／运行器／分支节点／回流线／脚本栏与日志均已截图对照用户原图；小高度桌面压缩纵向空隙并显示最近 3 条事件（常规高度 6 条），不影响 120 条内存日志窗口或派发。没有用浏览器缩放掩盖布局。
- 实际点击下一帧：扫描由 0/9 到 1/9，活动 Agent 从 9 到 8，事件流追加 auth.ts 回执。点击 edit 展开任务及“仅演示、未改文件”说明。
- 实际配置交互：切换 Pi 清空旧模型，缺模型保存被拒绝；选择样例模型后保存，当前运行仍是 Claude/haiku；重新演示才切换为 Pi。Esc 关闭弹窗，焦点返回模型入口。
- 配置弹窗截图及 AX 检查：仅模型字段，没有并发数量输入，spinbutton 匹配 0；没有扫描槽位分母。源代码与方案同步删除派发上限，而非仅隐藏控件。
- 实际停止交互：STOP REQUESTED 仍保留 9 个在途样例；下一帧确认后才变 STOPPED / 0，节点变取消，没有把请求当作完成。
- 连线运动、reduced-motion 和自动回放为实现；本次截图是抽样帧，未测动画帧率、未做系统 reduced-motion 实机切换，也未用手动推进冒充连续自动回放验收。完整 scan/edit/verify 生命周期由状态测试覆盖，真实 Provider 尚未执行。
- 为定时更新中的节点保留稳定 id 与焦点；阶段按钮的可访问名称包含状态和完成数。完整屏幕阅读器与窄窗口仍未验收。

## 验收边界与后续

- 原型仍待用户确认视觉，不把本轮“修改吧”当作成品认可。
- 真实 Provider、生产 Electron、真实限流与资源不足仍未验证；它们需要在实施阶段通过真实或隔离 fixture 检查。
- 没有产品层并发上限不代表 Provider 或主机资源无限；遇到实际拒绝如实显示，不绕过认证、同 session fencing 或仓库 trust，也不偷偷加回固定槽位。
- 独立视觉评审工具缺口：本会话可用 reviewer/delegate 子 Agent 不带浏览器或截图工具，Relay 截图为加密附件；不复用上轮受阻结论冒充本轮独立通过。由主会话直接截图对照，用户保留成品验收权。
- 方案：`implementation-plan.md`。用户确认当前原型与编排范围后才接生产运行器；本轮不改已有 remote/iOS/main WIP。

## 设计记忆

继续更新同一共享记录 `D-SCRY-WORKFLOWS`，不创建第二份认可状态。下次工作流可视化必须先看本轮纠正：是节点与执行流，不是把普通任务看板换个色；不存在并发配置或隐藏固定限制。v1 的错误方向保留为具体反例，不推断用户全局反感卡片或表单。

library build 已成功（50 项）；check 仍因 5 个先前已记录的 stale 来源失败：P-PI-MODEL-SELECTOR、D-20260912-scry-ios-remote、D-20261008-scry-ios-continuity、P-SCRY-SESSION-HISTORY、D-20261010-scry-llm-sidebar。没有删除旧记录来让检查通过，本条权威文件已更新。

## v2 历史安装流程

按项目约定运行 `npm run install:mac:dev`，退出 1。当前 macOS / Node 24.18.0 / Vitest 3.2.7；工作区包含既有且并行变化的 remote/iOS WIP，不把本轮总数与上轮当成同源码性能或质量对照。

- typecheck:node、typecheck:web 通过。
- 全量 unit：276 文件通过、2 失败、4 跳过；3416 测试通过、3 失败、4 跳过；耗时 558.01s。
- 失败：pi-lifecycle 的 unfinished frame 探针超时；pi.test 的 no-terminate 收口超时，以及 custom command 消息等待 terminal 断言失败。它们不在本次改动内；Vitest 明确排除 designs。本次没有重跑抹掉首轮失败，没有扩大超时或改动无关源码。
- shell/build/package/install 未进入；没有替换 `/Applications/Scry.app`，没有启动或重启 Scry。
- 日志 `/tmp/scry-workflow-v2-install.log`，退出码 `/tmp/scry-workflow-v2-install.exit`。是否另开任务排查这些 Provider 测试由维护者决定；不阻塞用户检查本地原型。
