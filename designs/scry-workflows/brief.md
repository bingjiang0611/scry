# Scry 工作流 · 方案与交互原型

状态：需求方向确认；本版视觉与生产实现待确认。基线：仓库 HEAD `282c918`，App 0.2.204。仅独立设计产物，不接生产、不调用 Provider、不读用户项目内容。

## 约束与范围

- H1：Scry 自己编排，不调用 Claude 原生 Workflow。用户逐阶段选择 Provider、配置档、模型。
- H2：每次运行自动关联可重新打开的可视化面板；真实实现由运行器事件驱动，不解析自然语言猜进度。
- H3：保留 Provider 能力差异、workspace/trust 校验、renderer 隔离、证据来源与未知结果。
- H4：本次只交付实现方案与可点击原型。已有 iOS/remote/main WIP 不修改、不提交。
- S1：沿用用户给定视频的流程图、可展开任务、底部事件日志；不引入拖拽编辑器、不绑定 JEV。
- A1：第一版固定“请求只读审计”模板，顺序为范围规划 → 并行扫描 → 独立复核 → 汇总；自动修复为后续范围。源码调查发现现有合同不能强制禁止写入，已在原型与实现方案纠正，不把 prompt 当成权限保证。
- 目标视口：桌面 1440×900 与 1280×800，窄窗口降为纵向布局；不是手机端验收。

## 设计依据与复用

| 来源／区域 | 观察 | 本次采用／拒绝 | 检查 |
| --- | --- | --- | --- |
| 用户提供的 mirku 视频截图；https://x.com/mirku21/status/2111200540772221418 | 阶段连线、并发任务与日志能够同时解释运行位置 | 采用可点击阶段与事件详情；不复制固定模型、JEV 路由或 zero burn 宣传 | 所有节点可选，任务状态与证据一致，演示全程标明 |
| `src/renderer/styles.css` 与最后加载的 `codex-alignment.css` | 当前产品为中性深色、蓝色选中态、克制圆角 | 原型复制这两处实际 token 子集，不引入另一套产品皮肤 | 根画布颜色、文字层级和焦点可见 |
| `BackgroundWorkPanel.tsx` | 停止请求和停止确认分离 | 复用交互语义，生产扩展现有证据详情；不直接导入耦合 window.scry 的组件 | 停止请求后显示待确认，不能继续调度 |
| `Pickers.tsx` | Provider/模型选择已有产品组件 | 生产复用选择语义；独立原型用原生 select，避免复制业务接口 | 切换 Provider 清空旧模型，缺少模型不允许开始 |
| 个人库 `UsageReadout` | known/lower-bound/unavailable 有明确区分 | 不导入 React kit：本原型用量不做演示数字，原生 details 即可；生产沿用已有产品用量组件 | 未接 Provider 的费用明确不可用，不显示 0 |
| 个人库 G-02 / C-01；Scry token-speed 历史案例 | 先确认方向；删无用解释，不让指标冒充能力 | 用户已指定结构，跳过多套方向探索；只保留演示边界及必要状态说明 | 不造第二套仪表盘，不重复任务标题 |

已检索 Scry、工作流 page、用量 component。工作流页面未命中；个人库有 5 个既有 stale 路径，不据此替换源文件。

Craft 应用：等宽数字、HTML 根背景、Hover 克制、嵌套圆角。索引外判断：主流程在左、所选任务详情在右，底部日志只显示本次演示的有限事件。

## 运行与交互

在仓库根运行：

```sh
python3 -m http.server 8767 --bind 127.0.0.1 --directory designs/scry-workflows
```

访问 `http://127.0.0.1:8767/`。仅服务此原型目录，不服务仓库或 HOME。

- 默认打开扫描中的样例。点击节点和任务查看来源、提示与结果。
- “下一步演示”手动推进固定样例，不模拟真实后台调度或流式速度。
- “暂停调度”不表示在途任务被冻结；下一步可让在途任务收敛。恢复后再启动后续阶段。
- “停止”先进入停止待确认；继续演示后才呈现样例终态，不自动重试。
- “配置下一次运行”修改默认及各阶段 Provider／模型／配置档、并发，保存本地样例模板。当前运行配置保持冻结。
- “开始演示”使用当前配置创建新的样例，上一条记录可在当前页回看。刷新只保留模板，不保存演示历史。
- 样例 catalog 不表示本机安装、登录或模型可用；生产必须通过实际 adapter/config 校验。

## 验收与交付

原型必须验证：模型切换失效、配置冻结、暂停调度语义、停止待确认、历史只读、独立复核结果保留、费用 unavailable、配置保存、键盘焦点、长标题和窄窗口。自动检查不能证明生产运行器已存在。

本任务不构造可复用组件库：尚未确认的新工作流页面只登记为项目设计记录，不冒充已认可组件。

实现依据与阶段验收见 `implementation-plan.md`。

## 实际检查与剩余边界

- `node --test designs/scry-workflows/demo-state.test.mjs`：7/7 通过；覆盖配置冻结、Provider/profile/model 组合、并发上限、暂停只停调度、停止待确认、未验证发现、复核任务计数。
- 负对照：只在临时副本移除配置深拷贝，同一测试得到 6 通过／1 失败（opus 不等于 haiku），证明冻结配置检查能抓到回归；没有修改正式产物，临时副本已清理。
- `node --check` 检查 app.mjs、copy.mjs；`git diff --check` 通过。
- Chrome Relay 实际点击：暂停 → 收敛在途扫描至 7/8、0 槽位；切换 Pi 后旧模型清空，未选择模型时保存被拒绝；选择样例模型和 Pi 配置档后保存；当前 run 仍保留 Claude；停止请求 → 单独推进确认；下一次 run 使用 Pi；历史 run 显示只读且保留 Claude。Esc 关闭配置弹窗并返回主视图。
- 最新渲染版实际点击：扫描 → 独立复核 → 汇总 → 完成；独立复核保留“含未验证”，选择 Webhook 任务显示中断依据，未变成全部绿色。刷新到新标签后样例模板仍保存。
- 视觉自查：实际 viewport 1497×764 与 1497×708；主面板及配置弹窗已截图查看。长模型 ID 没有覆盖相邻字段。初版任务列表过长，已限制滚动高度；重复费用说明已删；复核结果的 completed 与 verified 误读风险已改为“收口／含未验证”。使用等宽数字和当前产品根背景，不加装饰性动效。
- 工具异常：一次 stale ref、一次 viewport unavailable 均刷新观察后重试一次成功；一次弹窗截图内容不完整，经 switch 同一标签后重新截图可完整看到表单。没有绕过 Relay 或通过 OS 驱动浏览器。
- 未独立视觉评审：已委派只读 reviewer，但子会话缺少浏览器／截图工具，Relay 加密截图也无可读本地文件可交接；没有伪造评审通过。
- 未验证：1280/窄窗口的实际渲染、完整键盘遍历、屏幕阅读器、生产 Electron、真实模型目录与 Provider 执行。响应式 CSS 与语义控件是实现，不等于这些验收已完成。用户确认方向后，在 M3 的 Electron fixture 补齐目标窗口与辅助交互检查。
- 原型不会发模型请求，没有真实审计结果。浏览器只保存本原型的样例模板，不保存真实凭据；演示历史只保留当前页上一条。

## 项目反馈与复用回执

- Scope/status：project:scry / 需求确认，成品待审。
- 用户明确要求：“不要用claude原生 Workflow，让用户自己配置用什么模型”。本原型与实现方案均遵守，不上升为跨项目偏好。
- 下一次遇到工作流可视化：先读本方案中的 owner／事件／收口接缝，复用当前产品 picker 与证据合同；检查缺失能力、实际模型与请求模型，以及“停止待确认”是否仍独立。
- 共享库已登记且 search 命中：`D-SCRY-WORKFLOWS` → 本文件，状态仍为待用户验收；不是已认可的通用组件。library build 成功（50 条），check 因 5 个既有 stale 来源失败：P-PI-MODEL-SELECTOR、D-20260912-scry-ios-remote、D-20261008-scry-ios-continuity、P-SCRY-SESSION-HISTORY、D-20261010-scry-llm-sidebar。没有删除这些来源或宣称全库健康。

## 默认构建／安装结果

按仓库约定运行 `npm run install:mac:dev`，在当前含既有 WIP 的工作区执行，退出码 1。Node v24.18.0，Vitest 3.2.7，macOS。typecheck:node 和 typecheck:web 通过；随后全量 unit 为 272 文件通过／6 失败／4 跳过，3399 测试通过／12 失败／4 跳过，耗时 570.03s。

失败分布：Codex app-server 初始化 2 项、CLI locate 慢 wrapper 1 项、Pi integration 1 项、runtime-evidence counters 1 项、Pi lifecycle 6 项、Pi RPC 1 项。主要证据为 5000ms 超时、initialize response_unconfirmed、预期 ready 实得 unavailable。完整日志：`/tmp/scry-workflow-install.log`；退出码：`/tmp/scry-workflow-install.exit`。

这些失败均在本次改动之外；`vitest.config.ts` 显式排除 designs，原型不进入 App 构建或这些测试。未判定它们是既有代码缺陷、WIP 影响还是环境负载，未重跑、未扩大超时或修改无关源码。命令在 unit gate 中止，因此 shell/build/package/install 均未进入，`/Applications/Scry.app` 未由本次流程替换，也没有启动或重启 Scry。

下一步由维护者决定是否另开任务排查这 12 项失败；本原型的验证和方向确认不依赖将全量测试改绿。
