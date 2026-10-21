# Mac UI 流畅性：侧栏渲染隔离与存档格式化（2026-10-21）

## 范围与身份

用户反馈页面切换、弹窗和列表卡顿，选择先优化 Mac，再考虑 iPhone。本轮保留现有视觉与交互，不增加全局过渡来遮盖加载等待。

- 基线：`5ea0e60`，App 0.2.214；独立分支 `perf/ui-fluidity-scry-ui-fluidity.gGgnZm`。
- 工作区：`/tmp/scry-ui-fluidity.gGgnZm/source`。原工作区的远程、iOS、性能面板 WIP 与暂存状态未修改。
- 测量先提交：`66d0522`（行执行次数）、`2db39f5`（日期格式化）、`9a99368`（悬浮生命周期与减少动态效果）。生产优化另行提交。
- 环境：macOS arm64、M2 Pro 10 核、Node 24.18.0、Electron 42.10.1。串行 UI 检查使用现有 timing-run 锁；多次 highLoad=true，负载从约 25 上升至 68，5 分钟负载最高观察到 84。**仅报告 L1 工作量，不作 L2 毫秒或 L3 日常提速结论。**

## 已实现

1. `Sidebar.tsx`：稳定菜单回调，memo 隔离会话行。父级刷新仍按相对时间字符串失效；行自己的 hover/focus 渲染仍重新计算年龄，不让标签冻结。
2. `SessionHoverCard.tsx`：悬浮卡片所有权改为稳定 ref 协调；只关闭前一个 owner，而不是用 context 状态通知整张列表。转移所有权也取消旧卡片待执行的 timer/frame，卸载释放 owner。
3. `Modals.tsx`：存档日期复用同一个 Intl.DateTimeFormat，日期和缺失信息文案不变。
4. `styles.css`：减少动态效果时禁用 CSS transition，而不是为所有元素声明 0.01ms 的默认 all 过渡。保留原动画结束事件策略；正常动态效果模式不变。

## 固定负载与负对照

未缩小既有 277 会话、120 轮聊天的原生 Electron fixture。Vite 测试插件在真正的生产 SessionRow 函数入口计数，不用 DOM mutation 数代替 React 执行数，也没有生产计数代码。

| 检查 | 旧实现 | 新实现 |
|---|---:|---:|
| 原生指针切换一条会话，SessionRow 执行 | 555 | 2 |
| 原生指针移入另一行，SessionRow 执行 | 280 | 5 |
| 20 次流式更新，Sidebar 执行 | 0 | 0 |
| 277 条存档两次渲染，渲染期间新建日期格式化器 | 554 | 0（复用模块实例） |
| 减少动态效果，运行中标题 computed transition-property | all，负对照失败 | none，通过 |

减少的工作没有移到后台：未变化行不执行；hover 仅通知原 owner；格式化器只在模块初始化时创建。列表数据、选择、置顶/存档回调、运行状态和证据不变。

新增行为检查：已有键盘焦点卡片转移给另一个 hovered 行；待打开卡片被新 owner 取消；owner 卸载/重挂载；Escape；模拟经过时间后行与 tooltip 年龄一致。原有分页、原生文本选择、焦点释放、展开工具和图片预览检查全部保留。

## 实际验证与失败记录

- focused unit：`render.test.tsx`、`ChatTranscriptTurns.test.tsx`、`ArchivedChatsPanel.performance.test.tsx`，253 项通过。SSR 只用于内容与格式化计数，不证明流畅性。
- 完整 `typecheck` 通过；`npm run build` 通过。
- `node scripts/session-performance-ui-smoke.mjs` 通过；`node scripts/session-capability-ui-smoke.mjs --sidebar-activity-only` 修复后通过。
- 完整 `npm run test:renderer:ui` 通过（包含 Credits、远程、源代码管理、统一对话及真实隔离 App 的历史恢复路径）。独立 `node scripts/electron-security-smoke.mjs --dev` 也通过。均使用临时 workspace/userData、离线 Provider fixture，不是用户现有进程或真实付费 Provider 验收。
- 检视了当前生产组件的 1100×750 深色与 1512×885 浅色 fixture 截图；它们不是全 App 的逐页视觉验收。
- `performance:measure --scenario navigation.catalog` 失败：现有映射没有对应 counter collector。没有新增或放宽门禁；本轮 L1 以原生 UI 行执行计数为证据。
- 第一次 `install:mac:dev`：3458 unit 通过、1 个 source-control push-endpoint 用例 15 秒超时、4 个 opt-in 跳过。该用例单独执行通过（其他 35 项被名称过滤），不抹去全量失败。
- 第二次 `install:mac:dev`：3446 unit 通过、13 失败、4 个 opt-in 跳过，涉及 7 个文件。主要为 recorder、source-control、terminal、runtime-evidence、Qoder 用例/钩子超时及清理 ENOTEMPTY，另有 Codex fixture 子进程 SIGABRT。这些后端文件未被本轮修改；高负载是混杂因素，**不能据此断言全部失败根因已确定**。不再循环重跑、不改 timeout、不跳过门禁。
- 初期夹具错误保留：timing-run 参数形式、nativeUiPointer 缺少必填 timeout、同批 mouseMove 被合并、表达式包装中的分号均在测试侧修正。首次类型检查发现 activity 路径漏传年龄失效键，已补齐。activity 首轮读到瞬时 scrollbar-color 过渡；原基线单次控制通过，但增强 computed-style 断言确定性失败，随后修复减少动态效果规则，而非删除断言。

安装两次都停在 unit gate，未进入打包/安装，`/Applications/Scry.app` 未由本任务替换；用户运行实例未重启。交付检查时现有安装版本已变为 0.2.215，这不是本任务的安装结果，也不能证明它包含本次优化；后续必须集成到最新代码再验收，不能用本分支 0.2.214 覆盖较新版本。源码保留在独立分支，未推送、未合并到有并行暂存/WIP 的主工作区。

## 尚未解决与下一步

只读日常日志先快照再分析。build `59f234869922131601d6ecf860bcedc94cb35f56173e093f884101e60b68b1fe`、0.2.214、3697 条、一个尚未关闭会话，仅为 provisional 线索：历史加载 IPC 34 样本 p50 401.5ms / p95 2341.3ms；Pi 能力探测存在约 12–25 秒等待。这不能用本次减少行渲染的计数宣称已解决。

- 交付 owner：后续集成 agent。在并行工作冻结、机器负载正常后，将本分支相关提交合入最新代码，保留 Modals 的远程 WIP；重新运行安装门禁，通过才安装。不要求用户停止现有 Scry。
- 性能 owner：后续 Mac 性能轮次。先测历史打开的点击→选择反馈→首屏证据和 Provider 能力加载依赖，确认阻塞点再改；不得把缓存数据伪装为当前证据。
- 本轮没有虚拟化侧栏初次挂载，仍是 O(n) DOM。若固定大列表首次打开/滚动仍产生长任务，再按焦点、搜索和悬浮合同引入窗口化；不为预留需求增加框架。
- 动效 owner：后续 UX 验收。实际延迟下降后，再决定哪些切换需要短过渡，不加全局等待或滚动劫持。
- iPhone 未修改、未验收；后续需 iCTRL 真机验证，不用模拟器。

本地证据保留在 `/tmp/scry-ui-fluidity.gGgnZm/`：只读 journal 快照、baseline.json、sidebar-before/after/lifecycle.log、archive-before.log、reduced-motion-before/after.log、renderer-ui.log、current-app.log、install.log、install-final.log，以及两张 fixture 截图。未把日常日志原文或会话内容提交进仓库。
