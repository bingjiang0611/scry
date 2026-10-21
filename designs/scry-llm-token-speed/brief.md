# Scry LLM 性能 · token 速度 v9（方向已确认，已落地生产）

- 来源：用户看 v5 生产弹窗截图后说“烂透了”，要求“可视化较好的观测 token 速度的页面，清晰直观”。用户已选：补真实采集，并先出 HTML 原型确认。
- 根因：v5 不缺排版，缺数据。本机 usage 历史 150 轮里，Pi/Codex 的实时 token 速度和 API 推导速度都是 0 条可测，所以页面几乎全是 “—”。
- 状态：用户确认 v9 方向（“没问题 落地吧”）。生产采集与弹窗已按 v9 实现，见 `docs/llm-performance.md`。生产成品尚待用户目视验收。

## 指标

输出速度 = 本轮主会话 LLM 调用的 output tokens 之和 ÷ 这些调用的耗时之和。

- 耗时：请求发出 → 响应结束。包含首 token 等待，不包含工具执行。
- output tokens：Provider 上报的每次调用用量，可能包含思考 token。
- 耗时是本机计时，所以这是估算，不是服务端生成速度。
- 出错或中断的调用不计入速度。轮次的最终调用出错或中断时，该轮算失败：计入轮数，不计入中位数。
- 参考：Artificial Analysis 方法论把 Output Speed 定义为“首 token 之后”的 token/s，并单独给出 TTFT。这里不用“首 token 之后”口径：Codex 类推理模型不流式返回隐藏推理，但 output tokens 包含推理 token，按首个可见 token 计时会高估速度。采纳的做法：用 P50 中位数，速度和等待分开显示。
- 首次输出等待暂不显示。现有 `firstOutputWaitMs` 记录的是本轮第一段正文的到达时间；在 Agent 轮次里，这段正文常出现在多次工具调用之后，中位数会到 23–54 s，看起来像 TTFT 但含义不是。逐调用 TTFT 需要另外采集。

## 结构

1. 标题行：运行状态点（“无运行中的会话” / “N 个会话运行中”）+ 1 小时 / 24 小时 / 7 天。
2. 运行中：每个会话一行，显示模型、项目、状态和本轮已测速度。没有运行时整块隐藏。
3. 速度曲线：每个模型一条线。悬停显示该时刻各模型的速度。选中模型后，其他线变暗。
4. 模型对比：按中位速度排序。色带表示 P25–P75，竖线表示 P50。点击一行即可筛选。

## v7 反馈（用户确认）

- 用户要求：用曲线代替散点；去掉“数据口径”；去掉小字解释。
- 已删除：数据口径折叠块、标题旁的说明、模型旁的上游名、失败数小字。保留单位 token/s 和坐标轴数字。
- 曲线算法：在 160 个等间隔时间点上，对附近轮次取高斯加权几何平均（带宽 1h=4min，24h=40min，7d=4h）。几何平均可以压低单个离群轮次的影响。1.5 倍带宽内没有轮次时断线，不跨越空白期画速度。
- 已试过并放弃：(a) 按时间分桶取中位数，会出现很多短线和孤点；(b) 每个模型最近 5 轮的滚动中位数，会出现台阶和竖直尖刺，因为并行会话会在同一时刻产生多轮。
- 已删除的口径仍是产品合同，只是不在界面展示。指标定义见上文。

## v8 反馈（用户给出参考截图）

- 用户提供一张“每日成本”图表截图作为风格参考：深色背景，一条粗白曲线，曲线下有浅灰填充，网格线很淡，横轴只有 3 个刻度，单位写在纵轴刻度上，右上角是胶囊形分段切换。
- 采纳：
  - 单色。选中模型用白色粗线加渐变填充；其他模型用 16% 白的细线。
  - 时间范围改为胶囊切换。
  - 纵轴刻度带单位（70 token/s）；24 小时视图的横轴只有 3 个刻度。
  - 标题改为“输出速度”，19px。
  - 模型列表去掉色点和边框，只用分隔线；选中行为白色，其他行为灰色。
- 不采纳：参考图在没有数据时画成 0。成本没有数据时确实是 0，速度没有数据时不是 0，所以空白时段仍然断线。
- 默认选中范围内轮数最多的模型；点击行可以切换，不能全部取消。多模型混合平均没有统一含义，所以不画。

## 生产采集计划（确认后实施）

- Pi：`message_end` 的 assistant message 带 `usage.output` 和 `timestamp`（pi-ai 在发请求前设置）。Scry 用接收 `message_end` 的本机时间减去 `timestamp`，得到调用耗时。
- Codex：`thread/tokenUsage/updated.last` 提供逐调用 output tokens。计时边界需在实现时核对。
- Claude：继续使用 `durationApiMs`。

## 检查

- 原型数据：`node extract.mjs` 读取本机 Pi 会话文件，生成 `data.js`（不提交）。这不是 Scry 运行记录。“运行中”三行是样例。
- 已在 Chrome 1512×742 下查看默认、运行中、选中模型、无数据四种状态。未检查窄窗和浅色主题。

## v9 反馈（用户纠正）

- 用户原话：“恢复前一版。我说的是线不要断，没数据的时候可以用 0 轴。”
- 对 v8 的纠正：用户发参考图，只是为了说明“线要连续”，不是要换成单色风格。v8 的单色方案已撤销，恢复到 v7 的多色多模型曲线。
- 变化：每个模型一条连续曲线。附近没有轮次时，曲线平滑下降到 0 轴；有数据时再升回来。这是用户明确的选择，取代 v7、v8 的断线规则。
- 0 轴只是绘图基线，不是测量值：
  - 悬停提示里，空闲时段显示“空闲”，不显示“0 token/s”。
  - 中位数、色带和轮数都不计入空闲时段。
- 下降到 0 的过渡段按附近轮次的权重缩放。所以这一段的高度只是视觉过渡，不代表真实速度；悬停时这段显示的是附近轮次的真实速度。

## D-20261011-scry-llm-token-speed

- Scope / status：project:/Users/baobingjiang/IdeaProjects/vibecoding/scry / confirmed（方向：v9 原型已认可；生产成品待审）
- Feedback：
  - v7：“曲线代替散点”，去掉数据口径块和小字，只留 token/s 单位与坐标数字。
  - v9：“回复前一版 我说的是线不要断 没数据的时候可以用0轴”。
  - 落地：“没问题 落地吧”。
- Rule / reason：每个模型一条连续彩色曲线，空闲时段落到 0 轴。0 轴只是基线：悬停显示“空闲”，统计不计入空闲。速度只用 token/s，不从字符换算，不造数据。
- Lesson（参考图误读）：用户给的“每日成本”截图只用来说明“线不断”。v8 据此改成单色是过度解读，已回退。
  - 触发情境：用户给参考图并附一句具体意图。
  - 设计动作：只借用户点名的那一个属性，其余保持当前已认可版本。
  - 可检查条件：差异只落在用户点名的属性上；如需改其他维度，先问。
- Preserve：多模型配色、模型对比行（P25–P75 + P50 + 轮数）、范围切换、运行中会话列表。
- Applied：`src/renderer/components/LlmPerformancePanel.tsx`、`llm-performance.css`；采集在 `src/main/providers/{pi,codex}.ts`、`src/main/llm-performance.ts`。
- Evidence：`scripts/session-capability-ui-smoke.mjs --performance-only` 用真实指针验证悬停/空闲/选中/范围，并截取深浅两种主题；`electron-security-smoke --dev-performance-only` 通过。还没有用真实 Pi/Codex 轮次在真实 App 里验收。
- Revisit：用户看完真实数据下的生产弹窗后；或要加逐调用 TTFT、超出上限的值贴顶标记时。

## D-20261011-scry-llm-first-token

- Scope / status：project:/Users/baobingjiang/IdeaProjects/vibecoding/scry / confirmed（需求与展示方式；成品待审）
- Feedback：用户确认要采集首 token（“需要”），展示方式选“图表切换 + 对比表加列”。
- Rule / reason：把网络/排队/prefill 与生成速度分开看。首 token = 请求开始 → 第一个内容块（含思考块开始），单位秒；输出速度口径不变。
- Applied：图表标题处「输出速度 / 首 token」切换，单位随之变为 token/s 或 秒；模型对比加「首 token」列（P50，无证据显示 —）；运行中会话行显示本轮平均首 token。
- Preserve：v9 连续彩色曲线与 0 轴空闲规则同样用于首 token 图。
- Evidence：fixture 截图（深色，首 token 模式与运行中会话）；还没有真实 Pi/Codex 轮次验收。
- Revisit：首 token 图里 0 轴容易被读成“0 秒很快”；若用户觉得误导，再改空闲画法。

## D-20261021-scry-llm-reading

- Scope / status：Scry 桌面性能弹窗；用户已确认四项统一方案（「没问题 继续吧」），实现后成品待用户目视验收。
- Rule / reason：先分清当前运行会话的平均值与所选历史范围的中位数；各状态数量直接可见，不用「多种状态」占位；图例靠近曲线；必要统计解释按需展开，不增加常驻说明段。
- Preserve：暗色身份、深浅主题、多模型配色、连续曲线、零轴空闲，以及既有采集／平均／中位数／轮次替换合同。不是更换视觉世界。
- Applied：`LlmPerformancePanel.tsx` 明确运行中／历史分区，模型行可展开实际成员和独立指标分母，图例与表格共享选择状态，测速轮次显示已完成与暂计星号；`llm-performance.css` 提高辅助文字可读性，弱化空闲与非测量过渡段，不修改样本。文案集中到既有 `constants/copy.ts`。
- Reference / reuse：复用 D-20261011-scry-llm-token-speed 与 D-20261011-scry-llm-first-token。定向核对 Artificial Analysis 方法论的 Output Speed／TTFT 定义，采纳速度与等待分开呈现，不套用其不同的计时口径。保留项目已确认的连续曲线，不再次误读参考而改成断线／单色。
- Evidence：相关采集／历史／分组单元测试 24 项通过。隐藏隔离 Electron fixture 用原生指针和键盘验证分区、图例／表格同步、详情和帮助、指标切换、临时样本、空闲／测量分层、结束／停止、错误与关闭清理；深浅主题和 700px 窗口截图已查看。检查到的辅助标签最低对比度：深色 7.63:1、浅色 4.99:1。故意只保留第一种状态时，回归检查以 `Grouped row hides session states` 失败，恢复实现后通过。新增用例还复现了「首 token 视图选中无该指标的模型」时缺少明确反馈的问题；现已保留可取消的选择并显示缺失，回归通过，不把缺失显示为空闲。当前构建的生产 main／preload IPC 隔离 smoke 通过，使用测试 adapter 而非真实 Provider。
- Limits：未使用真实付费 Provider 验收，未验证 VoiceOver；未获前台窗口授权，原生隐藏／恢复刷新用例仍标 not-run。性能计数门禁通过，但测量时机器高负载，不作毫秒或提速结论。
- Next use：出现同模型多个统计值 → 先标清统计对象，再显示数字；用户要求删小字 → 将必要证据解释放到键盘可访问的按需说明，不删除缺失／暂计语义。
- Delivery：App 0.2.215 已通过 `install:mac:dev` 构建、开发签名、产物与打包 smoke 并安装到 `/Applications/Scry.app`；安装目录与受测产物的 app.asar SHA-256 一致。最终安装流程的 unit 为 3519 passed／4 显式 skipped，shell 通过；完整 `test:renderer:ui`（含 Credits）及打包产物的 `--performance-only` smoke 通过。安装来自当前工作区，包含原有远程功能 WIP；本任务提交只包含性能面板相关改动及 App 版本。未重启用户日常实例。
- Validation history：首个安装候选在 3516 项 unit 及完整 renderer UI 检查通过后安装。补充缺失数据修复后的默认并发全量检查出现 12 项失败（6 个非面板 suite；等待超时和后续目录清理错误），现场为 10 核、load 138.75；失败场景单 worker 定向复核 13 项通过。最后以 `VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 npm run install:mac:dev` 完整复跑通过并重新安装，未删测试、未改断言或超时。完整 renderer UI 与打包性能面板 smoke 随后通过。失败历史保留，不以复跑抹去。
- Acceptance：需求与方案确认；自动测试和隔离渲染证据不等于用户已认可最终视觉。
