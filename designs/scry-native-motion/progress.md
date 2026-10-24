# 进度与核验

执行方每完成一步，在「记录」末尾按模板追加一节；设计方核验后在同一步下追加「核验」。不要删除或改写已有记录。

## 当前状态

| 步骤 | 状态 | 最近提交 |
| --- | --- | --- |
| 01 基础 | 通过 | `22b0358`（实现修正）、`3abbfeb`（验收修正）、`7fbbf106`（经用户批准隔离验收前置主题过渡） |
| 02 结构过渡 | 通过 | `42f3f9dc`、`3305911d`（修正）；`3145cd79`、`06defe55`（回归）；按「02 · 核验」授权，修正验收后进入 03 |
| 03 弹窗与浮层 | 通过 | `b6f42801`（实现）、`5e3e14ee`（验收）；范围取舍见本轮用户确认；一项小修正并入 04 开头，见「03 · 核验」 |
| 04 列表 | 通过 | `5f3484c1`（实现）；`b8537f5e` / `5aa66684`（04-fix）；完整安装通过，见「04-fix · 核验」 |
| 05 加载防闪 | 通过 | `7861d4be` / `b74c6726`（实现）；`e935f2e8`（05-fix）；完整安装通过，见「05-fix · 核验」 |
| 06 侧栏材质（可选） | 已评估，暂不采用（已回退，待核验） | `978e128e` / `41612756` 已回退；完整安装通过，保留原 06 记录 |

状态取值：待开始 / 进行中 / 待核验 / 需修改 / 通过。

## 问题

（执行方发现规格有误、做不到或需要用户决定的事项写在这里，并停下等待回复。）

- 01 安装受阻：`npm run install:mac:dev` 已执行。完整测试、shell、构建及打包完成后，`check:packaged-app` 执行产物的 `Contents/Resources/bin/scry --version` 收到 `SIGKILL`；单独读版本再次复现（退出 137）。`codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Scry.app` 通过，但不能据此认定产物可运行。未绕过校验，未安装到 `/Applications/Scry.app`，未停止用户实例。签名/系统终止的根因未确定；由维护者决定是否另开打包排查，恢复后需重新走完整安装流程。本步实现与下列验收已提交待设计方核验；不进入 02。

### 2026-10-22 · main 打包对照与 02 合同问题

- main 对照：按「01 · 核验」指定的 `main` 基线 `531e88c`，在独立 detached worktree `/private/tmp/scry-motion-main-repro.tS07ww/source` 执行完整 `npm run pack`；沿用 Node 22.22.1、Electron 42.10.1、同一签名身份和单 worker 环境变量。**未复现**：typecheck、3699 个 unit（4 个原有跳过）、shell、build、packaged check、全部 packaged smoke 均通过；私有 CLI 返回 `0.2.51`。日志 `/tmp/scry-motion-main-repro-pack.log`。没有切换或写入用户现有 main worktree，没有安装 main 产物、没有向 main 提交或推送。
- 对照后的排查：同一时点重新运行设计分支原来失败路径的 `dist/mac-arm64/Scry.app/Contents/Resources/bin/scry --version`，现在也返回 `0.2.51`（exit 0），未改动该 bundle 来使其通过。因此当前无法稳定复现历史 SIGKILL，不能将其标成已复现的 main 既有缺陷，也不能断言根因是动效代码或签名缓存。原始失败记录保留；没有绕过 `check:packaged-app`。新修正版本的安装尚未执行，不能将 main 打包通过当成修正版本已安装。
- **02 暂停：`steps/02-structure.md` A 与 H2 的同步合同无法同时由原生 View Transitions API 满足。** A 要求 `runViewTransition(kind, commit): void` 在 API 的回调中 `flushSync(commit)`，同时要求 commit 的异常同步冒泡到调用方；H2 要求调用后的状态同帧提交。Electron 42 的 `startViewTransition` 会先返回，再异步调用 update callback。`flushSync` 只能保证回调执行时同步刷新 React，不能让尚未调用的回调回到调用者栈里执行。原生 API 将回调异常放入 `updateCallbackDone` / `finished` 的 rejected Promise，不会同步 throw 给外层调用方。
- 平台实测：独立 sandbox/contextIsolation 的隐藏 Electron 测试窗口、独立临时 userData，未显示或抢焦点。Electron `42.10.1` / Chromium `148.0.7778.280`，`document.visibilityState === 'visible'`，非隐藏文档退路。正常调用事件顺序为 `["returned", "commit"]`，函数返回时 state 仍是 `old`，finished 后才是 `new`；回调抛出 `probe-sentinel` 时外层同步 catch 未触发，错误通过两个 Promise 拒绝。原始可运行探针 `/tmp/scry-native-vt-contract-probe.cjs`，日志 `/tmp/scry-native-vt-contract-probe.log`，临时 userData 已清理。
- 最小复现：`let state = 'old'; const vt = document.startViewTransition(() => { state = 'new' }); console.log(state); await vt.finished; console.log(state)` 在真实 Electron 输出 `old`、`new`。把赋值改为 `throw new Error('sentinel')`，错误进入 `vt.updateCallbackDone`，不进入围绕 `startViewTransition(...)` 的同步 catch。不能用同步执行回调的单测 mock 证明相反合同。
- 需设计方决定：保留真实 View Transitions，则需明确允许快照更新回调的异步调度，并将错误通过 Promise 交付（侧栏选中仍单独同步提交）；或坚持同步 commit / 同步异常，则需批准改为 WAAPI 等同步提交后的新内容入场，并放弃旧页快照交叉淡化。执行方未自行改 brief、步骤说明或降低验收。按执行协议在此暂停 02；尚未做面板 V/F 实验、接入或宣称第 02 步完成。

### 2026-10-22 · 02 继续执行与原生转场的输入阻碍

- 用户已明确批准上一项前置取舍：保留真实 View Transitions，采用异步更新回调与 Promise 错误合同；侧栏选中及 authority 不得延后。历史打包 SIGKILL 按未确定原因继续跟踪，不据此绕过任何后续打包检查。原始记录保留，brief 与步骤文件未改。
- 本地 WIP 已接入 page/session/theme，分离会话 authority 与异步展示提交，增加过期回调检查；补充真实 App 和隔离 renderer 检查。实现与测试均未提交，也未宣称 02 完成。局部验证：`npm run typecheck:web`、297 个 focused unit（5 文件）、`npm run build` 通过。`node scripts/session-capability-ui-smoke.mjs --structure-only` 通过 page 240ms、session 180ms、主内容在 chrome 下且包含 composer、侧栏首帧选中、跳过后的旧回调不能覆盖新会话、减弱动效仅 120ms opacity 且不捕获 root。这里的点击检查仅证明**侧栏**在主内容动画期间可用，不证明被捕获主内容可点击。日志 `/tmp/scry-motion-02-focused.log`、`/tmp/scry-motion-02-structure-final.log`。
- 面板实验选择 F：300 轮真实 Markdown 转录，1280×800，每方案 10 次开合；最后一轮另校验可见转录高度 778px、scrollHeight 75705px，避免空白/不可见 workload。V 每次超过 25ms 的帧数为 `[3,7,2,5,2,4,2,5,2,5]`，不达线；生产 F 为 `[1,1,1,1,1,1,1,1,1,1]`，正文一次改宽，仅面板 transform/opacity。原始逐帧数据 `/tmp/scry-motion-02-pane-visible.log`。10 核机器 load 11.60→11.48，锁报告 `highLoad: true`：**高负载，L2 毫秒结论不可信**，不宣称更快或日常不卡；仅据观察到的帧数保守选 F。前两轮未校验转录可见布局，已排除，不当作最终达标证据；本轮共做三次实验，不通过循环重跑挑绿色结果。
- **新阻碍：真实 App 在 session 转场活动期间无法点击 composer。** `node scripts/electron-security-smoke.mjs --dev-structure-only` 的真实临时 App 测试失败，未移除命中检查或改成等待动画结束。textarea 的 rect 在视口内、`pointer-events: auto`、`visibility: visible`、无 inert；但 `elementFromPoint` 返回主内容父节点。同期存在 `::view-transition-{group,new,old}(page)`，`data-vt=session`。未暂停的 App 失败日志 `/tmp/scry-motion-02-app-hit-test.log`；诊断截图仅留本机临时目录，不提交用户数据或截图。
- 独立可重复对照 `/tmp/scry-native-vt-input-probe.cjs` / `.log`：Electron 42.10.1 / Chromium 148.0.7778.280，sandbox/contextIsolation、独立 userData、隐藏窗口但文档 `visible`。让真实原生转场到 ready 后暂停动画，仅固定观测阶段，不 mock API 或业务输入。原生命中与输入结果：捕获区 input 的命中落到 BODY，鼠标首击及文本 `X` 未进入 input；未捕获的外侧 input 可原生点击并收到 `Y`。这区分了“整个窗口/输入服务失效”和“原生快照排除捕获区命中”。
- 两个控制均未解决首击：① document 捕获阶段的 `pointerdown` 调用原生 `skipTransition()`，转场虽结束，但本次已定位到父节点的点击不会自动重新命中 input，文本仍为空；② ready 后清除元素的 `view-transition-name`，活动捕获区仍不能命中。没有重放点击、合成按钮事件、手动代替用户执行动作，也没有放宽 renderer/IPC 边界。探针完成后私有窗口、进程和临时 userData 已清理。
- 按协议在此暂停。需要用户/设计方明确选择：改用实时 DOM 的新内容入场（不再保留旧快照 110ms 淡出；主题即时切换，不做全窗截图交叉淡化），以保持首击/输入；或明确放宽 H2，接受原生截图动画窗口内捕获区可能丢首击；或由设计方修改规格后再继续。**当前未完成真实 App 的深浅色、全部形状变化与远程取消路径验收，未跑本 WIP 的完整 UI/performance gate，未对本 WIP 执行完整打包与安装。** 上面的局部通过不替代这些要求，状态不改为待核验。

### 2026-10-23 · 实时 DOM 例外已获批准；本轮安装门禁受阻

- 用户选择「改用实时 DOM 动效（推荐）」：页面 / 会话只让新内容入场；主题即时切换；放弃旧快照退场与整窗主题交叉淡化。此前原生快照输入冲突不再通过延迟输入或伪造点击规避，生产已移除原生 capture。
- 本轮 `npm run install:mac:dev` 在完整 unit 阶段失败，未进入打包、产物校验和安装。未绕过门禁；历史 SIGKILL 没有得到新的复现或修复证据。
- 同环境未改动 HEAD `35bd6a8d` 的隔离源码对照也复现文件计数与真实本地 TLS 测试的 5s 超时，详见 02 记录。这是保留的门禁阻碍，不宣称整套验证通过。执行方待机器低负载时重新执行完整安装；本轮停止在 02，等待设计方核验，不进入 03。

### 2026-10-23 · 03 执行中已获用户确认的两项取舍

- 完整 UI 遇到 01 的既有前置条件竞态：`#motion-micro` 的主题 border/color 过渡尚未完成，断言将其计入后续单次 background-color 变化。不含 03 的 02 诊断归档也出现相同失败。已暂停询问，用户选择「修正前置条件并继续」：仅等待已有动画的 `finished`，不改生产样式、不加 sleep、不删断言、不放宽时间。`7fbbf106` 单独提交；临时恢复全局 120ms 规则仍被原断言拒绝。
- 规格称弹窗全部共用共享壳，但实际 `WorkspacePanel` 有独立文件操作确认框，Picker 也有自己的弹出层。已暂停确认，用户选择「按点名范围交付」：03 覆盖共享 `ModalFrame` 消费者、4 类 `role="menu"` 和会话悬停卡；独立工作区确认框不迁移，保留其既有尺寸、焦点与 Esc 合同。未修改 brief 或步骤文件，也未把这些独立框宣称为已加入动效。

### 2026-10-23 · 04 开始：立即安装结果与待确认规格

- 用户已明确要求不等空闲，立即在刚拉取的 `db53ca71` 执行一次 `npm run install:mac:dev`。Node 22.22.1，未设置额外 worker 上限或绕过门禁。typecheck 通过；unit **3719 通过、1 失败、4 跳过**（301 文件通过、1 文件失败、4 文件跳过）。唯一失败为 `src/renderer/components/SessionRename.test.tsx` 的 `shows bounded session hover cards and renames via the real sidebar DOM with cancel, retry and pinned profiles`，内部断言 `context menu dismisses tooltip`；未进入 shell、打包与安装。日志 `/tmp/scry-motion-04-install-initial.log`，`INSTALL_EXIT=1`。起始 07:08 load 12.47 / 13.37 / 14.46，结束 07:13 load 18.92 / 19.21 / 17.21（10 核）；这是断言失败，不能据此认定原因是负载。
- 该失败的源代码证据：公开的 `hover.dismiss()` 目前保留 100ms 出场，而原菜单接管断言要求立即退休 tooltip；普通离开与 owner 换人的实现已分开。执行方会保留原断言，按原有显式 dismiss 合同排查修正，不扩大 timeout、不改小 fixture workload。未把这次失败改写成安装通过。
- **04 规格确认 1**：brief H2 将装饰退出限制为 ≤160ms，但 `04-lists.md` C 指定收起 180ms。执行方已完成第 0 项后暂停其余实现，提请用户选择按 H2 的 160ms 上限，或明确批准短折叠的 180ms 例外。
- **04 规格确认 2**：现有活动列表是每组最多 40 行，三组加标题最多 123 个 keyed 节点；项目会话、提示队列、后台任务没有 renderer 本地 ≤40 上限。不能为动效截断业务数据。提请选择：总节点超过 40 的列表不播 FLIP（最小、有界），或另做视口内最多 40 节点的定位追踪。原数据、排序、分页与可访问交互均不改变。

### 2026-10-23 · 04 交付：安装仍受终端录制门禁阻挡

- 最后一次完整 `npm run install:mac:dev` 已立即执行，不等机器空闲。typecheck、3725 个 unit、shell、构建、签名打包及 packaged resource 检查通过；随后 packaged security smoke 的终端录制回放检查失败：`terminal recording UI condition timed out`（测试表达式第 61 行，仍显示「没有打开的终端」）。安装脚本未执行，`/Applications/Scry.app` 未更新；用户正在使用的实例未停止。
- 在独立 detached worktree 的未改生产基线 `db53ca71`，使用相同测试脚本（含等待面板动画结束的前置条件）构建后执行 `node scripts/electron-security-smoke.mjs --dev`，复现相同第 61 行超时。当前 packaged 失败与基线 dev 对照的分发形式不同；它们共同证明旧源码也会失败，不证明全部根因已经确定。原始日志 `/tmp/scry-motion-04-install-head.log`、`/tmp/scry-motion-04-baseline-security.log`。未删断言、跳过安全门禁或扩展本步去修终端业务。
- 本步实现和下列专项验证交付核验；不进入 05。由维护者决定是否另开终端录制 gate 排查，修复后重新执行完整安装。高负载下的计算耗时不能作为可靠 L2 性能结论；若需要此级别结论，由维护者安排低负载复测。

### 2026-10-24 · 04-fix：修正终端历史查询；安装阻挡解除

- 撤回上一轮「安装受既有终端问题阻挡」的归因：`db53ca71` 已包含 03 的 ModalFrame portal，所以该基线复现不能证明问题早已存在。根因是安全测试仍在当前 session surface 内查询已 portal 到 body 的录制历史弹窗，不是终端业务故障。
- 修正查询后，`--dev` 在 portal / 临时不 portal / 恢复 portal 三种状态均通过；完整 `npm run install:mac:dev` 也已通过并安装。旧失败记录保留为历史，本条与下方 04-fix 记录覆盖旧的待处理结论。未修改终端业务、surface 内控制查询、原断言或 timeout。

## 记录

### 01 · 基础：token 与清理（2026-10-22）

- 提交：`f38dd6b` motion(01): 补充动效 token 与隔离 App 回归验收（测试 / fixture）；`cf5642b` motion(01): 统一动效 token 并移除悬停抬升（实现）。本提交只登记验收与状态。测量与实现分开提交。
- 范围：开始前 `git pull --rebase origin design/native-motion`，基线 `7cb816f`。只执行 01，不改 brief、步骤说明、安全边界、IPC、数据路径或证据语义。
- 改动摘要：
  - `motion.css` / `motion.ts` 定义同一套时长、曲线及动态减弱动效订阅；`main.tsx` 在 styles 后立即导入。原 `--ease-out` 值不变。
  - styles、codex-alignment、inventory-evidence、session-evidence 中现有过渡统一为 token。去掉悬停抬升、按下缩放及对应 transform 过渡。阴影取值保留，但不插值 box-shadow；不改颜色、尺寸、间距、圆角等静态值。
  - 减弱动效只允许 opacity / color / background-color / border-color 的 120ms linear 反馈，空间属性即时到位；既有菜单入场在此模式只淡入。spinner、骨架与运行环停止；welcome-rescan、usage-spin 保留原有局部停止规则；活动标题 sweep 仍只在 no-preference 下运行，未重复添加覆盖。
  - `SidebarActivity` 原 FLIP 改用 300ms / easeStruct，并复用订阅在系统偏好变化时取消动画；未抽取新 FLIP 实现。
  - fixture 增加 `--motion-tokens-only`，且纳入默认 UI 测试。所有原先直接导入 styles 的 fixture 补齐 motion 导入，防止 token 缺失导致过渡失效、出现假阳性。另增 `--dev-motion-only`，通过生产 main/preload/renderer 和既有合成 Provider 验证真实 App；不调用真实 Provider。
- 验收环境：macOS 27.2（26B5112a）、arm64、Node 22.22.1、Electron 42.10.1、App 0.2.219。测试 / 截图使用独立 HOME、userData 与临时 workspace；未访问真实会话数据。
- 验收：
  - [x] `rg -n 'transition:[^;]*\b(1[0-9]{2}|2[0-9]{2})ms' src/renderer --glob '*.css'` → 无结果（exit 1）。没有需列出的硬编码 transition 例外；减弱动效的 `transition-duration: 120ms` 是规格明确的独立规则。
  - [x] `rg -n 'translateY\(-[12]px\)' src/renderer --glob '*.css'` → 无结果（exit 1）；定位 transform 与循环动画不作无关修改。
  - [x] `npm run test:unit -- src/renderer/motion.test.ts src/renderer/performance-style.test.ts src/renderer/sidebar-activity.test.ts` → 3 文件、17 测试通过。覆盖 CSS/TS token 对齐、订阅变化/解除及原性能合同。
  - [x] `npm run typecheck:web`、`npm run typecheck`、`npm run build` → 通过。
  - [x] `node scripts/session-capability-ui-smoke.mjs --motion-tokens-only` → 真实 CSS token 为 300ms；深浅色工具卡、发送按钮、侧栏与指标悬停/聚焦无 transform。正常重排有 300ms FLIP 正对照；CDP 开启 reduce 后跨组重排即时提交、transform 动画为 0，颜色过渡为 0.12s linear。
  - [x] 负对照：把 token 临时改为旧 FLIP 时长 420ms，该 fixture 失败 `the slow token is not 300ms`；恢复后通过。再恢复旧 CSS `.runtime-composer .send:hover:not(:disabled)` 的 `translateY(-1px)`，同一检查失败 `dark send button moved on hover/focus`；随后删除旧值并再次通过。负对照未留在源码。
  - [x] `npm run test:renderer:ui` → 全链通过，含 Credits、原生输入、历史、权限/归属及新 motion fixture。最终完整日志 `/tmp/scry-motion-01-ui-tokens.log`；不是仅运行新组件 smoke。
  - [x] `node scripts/electron-security-smoke.mjs --dev-motion-only` → 当前构建的隔离生产 App 中，真实输入发送给合成 Provider，打开工具卡；深浅色检查侧栏、工具卡、composer 发送按钮、分析页刷新按钮悬停均无位移，切分析页再返回仍保留准确的未发送草稿。已查看深/浅聊天与分析页截图（本机临时目录 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-motion-app-743BYZ`）；最新重放通过，截图在 `scry-motion-app-HxuX6A`，均不入库。
  - [x] `git diff --check` → 通过。最终 diff 自审确认仅表现层与验收代码；实际改动与 `scripts/performance-paths.json` 的 sources 交集为空。按 01 豁免，不运行 `performance:measure`，不宣称 L1/L2/L3 性能改善。
  - [x] 安装流程附带完整验证：单 worker 环境 `VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 npm run install:mac:dev` 中，unit 为 299 文件通过、3701 测试通过、4 跳过；`test:shell` 通过。4 个原有跳过项为 performance-correlation、billing-admin-real、p0-integration、p1-integration，未授权/未开启真实探针，不改其开关。
  - [ ] 标签指示条滑动：按本步第 6 项允许的退路，只做 CSS 部分。侧栏是自然宽度 tab + 每项底边框；surface 是可增删、自然宽度的包装 tab，不能在不改 DOM、不硬编码标签宽度的条件下可靠共享一个滑动条。保持布局与 DOM 不变、标签文字即时更新；独立指示条留 04。本步不声称已验证指示条滑动。
  - [ ] 安装完成：未通过私有 CLI 运行校验，详见「问题」。没有手工覆盖 App 或跳过发布检查。
- 首轮失败与处理：
  - 新单测最初直接引用 Node 环境不存在的 window；改用 `vi.stubGlobal` 并还原。fixture 首轮未展开默认折叠的真实工具组，且缺少该 fixture 的 data: 图标许可；增加原生点击展开，沿用现有 sidebar fixture 的 img-src data: 范围，仅影响隔离 fixture。
  - 全 UI 首轮遇到 sidebar 旧断言要求 reduced-motion 的 transition 为 none；规格现已要求保留颜色淡化。只更新这一预期，仍保留 layout=0、sweep=0、标题不透明等保护，并由新 fixture 增加 120ms linear 正向断言；focused 与完整 UI 均通过。另一次全 UI 被用户中断，未计为通过。
  - npm ci 时缺少 Electron binary / native binding；安装 Electron 42，并分别为 Node 测试与 Electron 测试重建 better-sqlite3。曾因 ABI 127/146 不匹配导致 Credits、分析页验收失败，按实际运行时重新构建绑定后通过；未修改生产降级逻辑。
  - 新生产 App smoke 最初尝试发送种子目录行，触发真实 session context gate 拒绝；改为原生点击新建会话后发送，不绕过 gate。另修正分析导航 selector，并在切页导致重挂载后重新展开工具组。
  - 安装第一次完整 unit：3700 通过、1 超时、4 跳过（未改动的 Pi Node 选择测试，5000ms）；当时 load average 38.45/32.41/37.53，focused 原断言 948ms 通过。第二次：3699 通过、2 失败、4 跳过，均为未改动 Git 性能夹具真实命令超时。调查后第三次只降低 worker 并发，不删测试、不缩小 workload、不扩大超时，完整 unit/shell 通过；但随后打包产物 CLI 被 SIGKILL。保留三次日志 `/tmp/scry-motion-01-install.log`、`/tmp/scry-motion-01-install-final.log`、`/tmp/scry-motion-01-install-serial.log`，不以最后通过抹去首次失败。
- 与规格的偏差：无新增动效场景；按明示退路将独立标签指示条留 04。安装未完成，明确登记，不弱化校验。
- 未验证：物理显示器上 120Hz 连续手感、真实 Provider 运行不在本步验收范围；合成 Provider 不等于真实 Provider 验收。安装产物尚不可宣称可运行。
- 安装与现场：`/Applications/Scry.app` 未被本任务替换，用户无需为本次验收重启。隔离 App / fixture 进程已退出，临时用户数据按既有 harness 清理；仅本机临时日志、合成数据截图与未通过检查的 ignored `dist/mac-arm64/Scry.app` 留作排查。等待设计方核验，不执行 02。

#### 核验（设计方，2026-10-22）

- 结论：**需修改**（一处，范围小）。其余部分通过；修正后直接进入 02，不需要再等一轮核验，除非修正中发现新问题。
- 核验方式与边界：读 `7cb816f..033d87d` 的全部 diff；在 Chromium（Playwright）里单独复现减弱动效规则的层叠行为。这次核验的云端环境连不上 npm 源，**没有重跑**单测、类型检查、构建与 UI fixture；这些以本节上方执行方的记录为准。
- 通过的部分：
  - `motion.css` / `motion.ts` 与 brief 完全一致；`styles.css` 不再定义 `--ease-out`；`main.tsx` 的导入位置正确；token 单测核对 CSS 与 TS 双向一致，并覆盖订阅与解除。
  - 去悬停抬升与按下缩放：抽查 `codex-alignment.css`，只删位移与 `transform` 过渡，底色、描边、阴影的悬停反馈都保留。没有改颜色、尺寸、间距、圆角的取值。
  - `SidebarActivity` 改用 `MOTION.durSlow` / `MOTION.easeStruct` 与 `subscribeReducedMotion`，原有「先读后写、可打断、按住不漂移」语义未变。
  - 测量 / fixture 与实现分开提交；新增 `--motion-tokens-only` 纳入默认 UI 测试；`--dev-motion-only` 只加了一个分支，没有改动 `electron-security-smoke.mjs` 已有的安全检查；所有直接导入 `styles.css` 的 fixture 都补了 `motion.css`，避免假阳性。负对照做了两次并已撤销。
  - 标签指示条按第 6 项退路留到 04：接受，已在 `steps/04-lists.md` 补上这一项。
- **需修改：减弱动效的全局规则让原本没有过渡的元素也开始淡变。**
  - 位置：`styles.css` 约 8046 行 `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { … } }` 中的 `transition-duration: 120ms !important`。
  - 现象：这条规则同时强制了 `transition-property` 与 `transition-duration`，所以减弱动效下**每个元素**的颜色、底色、描边变化都会淡入 120ms，包括没有声明过渡、或明确写了 `transition: none` 的元素。Chromium 实测：同一规则下，无过渡元素、`transition: none` 元素、`transition: background-color 100ms` 元素、`transition: transform 300ms, background-color 100ms` 元素，改底色后都出现一个 120ms 的 `background-color` 过渡。`sidebar-activity-ui-checks.mjs` 里被改掉的那条旧断言（`.sb-sesstext` 的 `transitionProperty` 从 `none` 变成四个属性）就是这个现象。
  - 为什么要改：① 违背原则 1——会话行、导航项等的选中态在减弱动效下反而变慢，常规模式下却是即时的；执行方只给标签页加了例外，其他选中态没覆盖。② 选了「减弱动态效果」的用户看到的过渡比常规模式更多。③ 切主题时整棵 DOM（包括长转录）同时起颜色过渡，有不必要的开销。
  - 要求的行为：减弱动效下，**没有声明过渡的元素保持即时**；已有过渡的元素只插值 `opacity / color / background-color / border-color`，线性，时长不超过它自己声明的时长。
  - 建议改法（实测有效）：删掉通配规则里的 `transition-duration: 120ms !important`，保留 `transition-property`、`transition-timing-function: linear`、`transition-delay: 0ms` 的覆盖。这样 `transition: none` 与无过渡元素的时长仍为 0；有过渡的元素沿用自己的时长（01 之后都是 `--dur-micro` 或不超过 `--dur-slow`）。如果因此标签页例外规则变得多余，就一并删掉。
  - 验收：
    - `--motion-tokens-only` 增加一条：减弱动效下，给一个无过渡元素和一个会话行改底色，`getAnimations()` 都为空；给有 `--dur-micro` 过渡的元素改底色，只有一个 ≤100ms 的线性颜色过渡。
    - 把 `sidebar-activity-ui-checks.mjs` 那条断言改成检查「改色后没有过渡动画」（`getAnimations()` 为空，或 `transitionDuration` 为 `0s`），不要检查 `transitionProperty` 字符串。
    - 负对照：把 `120ms` 那行加回去，新断言须失败一次。
    - 重跑 `npm run test:renderer:ui`。
- 关于安装受阻（不阻塞后续步骤）：本步只改 CSS、一个 TS 常量文件与测试脚本，不可能影响私有 CLI 二进制，`SIGKILL` 大概率是环境问题（macOS 27.2 对签名或隔离属性的处理），不是动效改动引起的。请在 `main`（`531e88c`）上按同样流程打包一次，确认是否同样复现：复现就记成既有问题，列在「问题」里留给维护者，02 起照常推进，每步仍尝试安装并如实记录；不复现再停下来排查。无论哪种情况都不要绕过 `check:packaged-app`。
- 规格补充（设计方已在本次提交中写入步骤文件，执行方按新版执行）：
  - `steps/04-lists.md`：加入 01 留下的「标签指示条」。
  - `steps/03-overlays.md`、`steps/04-lists.md`、`steps/05-loading.md`：01 的全局规则只把关键帧动画的时长压到 120ms，不会去掉关键帧里的 `transform`。所以新增的、带位移或缩放的 `@keyframes` 必须像 `surface-menu-in` 一样，在减弱动效下提供只含透明度的版本；05 的不定进度条在减弱动效下改为静态细条加文案，不能被压成一次 120ms 后就消失。

### 01-fix · 减弱动效核验修正（2026-10-22）

- 提交：`3abbfeb` motion(01-fix): 验证减弱动效不会新增颜色过渡（fixture / smoke）；`22b0358` motion(01-fix): 保留元素原有过渡时长与即时状态（实现）。
- 改动：删除全局 `transition-duration: 120ms !important`；无过渡及 transition:none 元素保持 0s，已有过渡只限颜色 / 透明度并沿用自己的时长。删掉侧栏 tab 的多余例外；surface tab 已声明 100ms 背景过渡，仍需排除 color，避免全局 property 覆盖给其选中文字新增淡化。没有改全局关键帧动画时长或循环动画规则。
- 验收：`--motion-tokens-only` 真实 CSS 下修改无过渡元素、显式 none 元素、真实会话行 `.sb-sess-row` 与 `.sb-sesstext` 的底色，`getAnimations()` 均为空；有生产 `.btn` micro 过渡的元素只有一个 ≤100ms 的 linear background-color 动画。正常 FLIP 300ms 正对照、reduce 下无空间动画均继续通过。sidebar 检查已改为实际改色后的动画计数，不再依赖 transitionProperty 字符串。
- 负对照：临时加回被核验否决的 120ms 行，新断言真实失败：`#motion-instant` 产生一个 120ms background-color 动画；日志 `/tmp/scry-motion-01-fix-negative.log`。随后删除该行，motion 与 sidebar focused smoke 均通过，负对照未留源码。
- `npm run test:unit -- src/renderer/motion.test.ts src/renderer/sidebar-activity.test.ts`：11 通过；`npm run typecheck`（含 web）、`npm run build`：通过；`npm run test:renderer:ui`：完整通过，含 Credits / 新断言 / 既有安全与归属检查，日志 `/tmp/scry-motion-01-fix-ui.log`。`git diff --check`：通过。
- 首轮失败：本轮唯一故意失败为上面的负对照；没有删断言、扩大超时或改动保护以变绿。
- main 打包已按要求对照并登记到「问题」；main 未复现，设计分支旧产物当前也不复现，历史 SIGKILL 的根因仍未知。未安装 main，也未将旧产物恢复运行当成新修正已安装。
- 01 修正通过后按授权开始 02 的合同预检；发现真实平台行为与规格冲突，依协议暂停并请求决定。未改步骤文件；未进入 03。

### 02 · 结构过渡：实时 DOM 入场（2026-10-23）

- 状态：待核验。实现 `e00dedc3`；测量与验收 `4440dcd2`，与生产实现分开提交。没有改 brief、步骤规格、依赖、权限或 IPC 边界，没有进入 03。
- 已批准偏差：采用 `structural-motion.ts`，不再实现生产 `view-transition.ts` / 原生快照伪元素。页面 240ms、6px 上升与透明度；会话 180ms 透明度；reduce 120ms linear 透明度；主题即时提交。旧内容 110ms 退场与主题 260ms 整窗交叉淡化取消，以上是用户明确选择，不是未告知的降级。
- 接入：顶栏以下的 `.main-content` 包含转录、分析、Meta Prompts、远程内容与 composer；页面确认仍在提交之前。会话 authority 和高亮保持同步；历史实际到达时才入场，流式 trace 路径不加动画。撤回原生方案的异步会话展示 seam，`useAgentSession.ts` 保持原合同。
- 中断：下一次结构入场取消前一次；面板操作取消结构入场；页面 / 主题切换先结束面板动效。系统切为 reduce 时取消正在播放的空间动画。面板保留 F：布局只提交一次，面板自身 300ms transform / opacity；退场面板 fixed、inert、pointer-events:none，结束后清理。

#### 面板 V / F 实验

- 有效实验为可见 300 轮 Markdown 转录、1280×800、各 10 次开关。转录视口高度 778px、scrollHeight 75705px；前两次未证实可见布局的采样不作为结论。
- 每次 >25ms 的帧数：V `[3,7,2,5,2,4,2,5,2,5]`；F `[1,1,1,1,1,1,1,1,1,1]`。按 ≤1 / 次的本次观测选择 F；V 仅留在隔离测量 fixture，不进入生产。
- 实验在实时 DOM 取舍之前完成；F 的逐帧逻辑未变，最终接入另经当前 App 验收。经 timing-run 串行，10 核、负载 11.60→11.48，highLoad:true。只报告本次帧计数与方案取舍，不宣称可信 L2 毫秒提升。日志 `/tmp/scry-motion-02-pane-visible.log`。

#### 验收与首轮失败

- [x] `structural-motion.test.ts` 5 项：同步提交 / 异常、隐藏或测试环境、连续取消、reduce 映射与运行中开启 reduce。与会话 hook、历史缓存、选择、组件渲染合计 5 文件 **298 项通过**，日志 `/tmp/scry-motion-02-focused-final.log`。
- [x] `npm run typecheck`（含 node / web）与 `npm run build` 通过；build 日志 `/tmp/scry-motion-02-live-build.log`。本轮安装命令内的完整 typecheck 也通过。
- [x] `npm run test:renderer:ui` 最终完整通过，含 Credits、安全 / authority、远程及会话 `--structure-only`，日志 `/tmp/scry-motion-02-live-ui-verified.log`。真实原生输入在入场仍活动时首击聚焦并输入成功；高亮首帧同步、迟到历史拒绝、快速切换与 reduce 均检查，原生 capture 调用数为零。此前原生实现的失败是输入回归负对照，不以等待动画结束掩盖。
- [x] 当前构建的独立 App、临时 userData / workspace，light / dark 分别检查分析、Meta Prompts、会话、新建、即时主题、面板 F、最大化 / 恢复、侧栏键盘折叠 / 展开、草稿与原生发送。转录宽度在面板动画中不逐帧变化；选取深浅截图复核，截图未入库。命令 `node scripts/electron-security-smoke.mjs --dev-structure-only`；日志 `/tmp/scry-motion-02-live-app-final.log`。
- [x] 远程使用完整 App 的隔离 Electron fixture 与 host-scoped 内存文件 transport，深浅主题均以真实原生确认框验证：取消后保留未保存编辑且无入场，确认后才导航；不写文件、不回退本地。它不代表双机真实网络 / Provider 验收。
- 首轮 UI 失败保留：旧 terminal ownership / source-control 坐标 helper 在面板运动时立即取点，且 source-control 确认按钮未等异步预检显示。改为等待该功能验收所需的 `scry-pane.finished`，并等待确认框存在；没有 sleep、扩大超时或删断言。terminal 两种情形与 source-control focused 均通过；动画中输入另有不等待入场结束的独立检查。日志 `/tmp/scry-motion-02-live-ui-final2.log`、`/tmp/scry-motion-02-live-ui-complete.log`、`/tmp/scry-motion-02-terminals.log`、`/tmp/scry-motion-02-sourcecontrol.log`。

#### 性能与安装限制

- [x] `npm run performance:measure -- --scenario history.page --compare HEAD --out /tmp/scry-motion-02-perf-history`：相对 `35bd6a8d`，IPC bytes **10020→10020**、messages **1→1**、stringify **1→1**，ratchet 通过，无 worse。日志 `/tmp/scry-motion-02-perf-history.log`。
- [ ] navigation L1 为 **unavailable**：`navigation` 与实际路径 ID `navigation.catalog` 均已尝试，但仓库没有对应 counter collector，命令明确失败，不能记成 0 / 通过。日志 `/tmp/scry-motion-02-perf-navigation.log` 与 `/tmp/scry-motion-02-perf-navigation.catalog.log`。没有为本步新增 collector 或放宽 ratchet。
- 已经 timing-run 执行现有 `performance:bench`，2 项通过、覆盖各用户路径；输出 `/tmp/scry-motion-02-l2.json`、日志 `/tmp/scry-motion-02-l2.log`。10 核，负载 **91.06→75.64**，highLoad:true；不据此声称 L2 改善或把不可比较的毫秒数字当成回归结论。
- [ ] `npm run install:mac:dev`：typecheck 通过后，完整 unit **3686 通过 / 20 失败 / 4 原有跳过（3710）**，8 文件失败，耗时 1004.67s。失败集中于 Git、CLI 探测、Pi lifecycle、文件计数、本地 TLS 与 performance fixture 的超时 / 后续状态断言；没有安装、没有新产物验证，也没有停止用户实例。日志 `/tmp/scry-motion-02-install.log`。
- 调查而非盲重跑：同 8 文件改用 `--maxWorkers=1`，**196 通过 / 3 失败（199）**；10 核负载 43.67→89.90。剩余是文件计数 5s 超时、CLI wrapper 探测未 ready、本地 TLS 5s 超时。日志 `/tmp/scry-motion-02-failed-files-serial.log`。未改 test timeout / skip / 预期。
- 独立 `git archive 35bd6a8d` 源码对照 `/private/tmp/scry-motion-02-head-control.hUTsuW`，使用同一依赖与单 worker，三个文件 **73 通过 / 2 失败（75）**：同一个文件计数与 TLS 用例仍超时；CLI 用例通过。日志 `/tmp/scry-motion-02-head-control.log`。这支持既有环境 / 时限问题，**不声称全部 20 项已被完全归因或修复**；本轮未修改这些 main / counter 实现与测试。
- 未验证：安装产物、本轮完整 unit 通过、真实双机远程网络、真实付费 Provider、物理 120Hz。安装通过前，用户当前 App 不会加载本轮改动。执行方待机器低负载重跑原安装流程；设计方核验 02，本轮不继续 03。


#### 核验（设计方，2026-10-23）

- 结论：**需修改**（两处，范围小）。修正并按下文验收后直接进入 03，不需要再等一轮核验，除非修正中发现新问题。
- 01-fix 一并确认通过：全局规则只剩 `transition-property / timing / delay` 覆盖；新断言改为检查「改色后无动画」；负对照真实失败后撤销。
- 核验方式与边界：读 `bfa0616..2005599` 的全部 diff。这次核验的云端环境仍连不上 npm 源，**没有重跑**单测、类型检查、构建与 UI fixture；这些以执行方记录为准。
- 方案调整已登记：用户批准放弃原生 View Transitions，改为实时 DOM 入场、主题即时切换、面板采用 F。原因是两条平台事实（更新回调异步执行；转场期间被捕获区域吞掉首次点击），执行方在真实 Electron 里做了可重复的探针，并在发现后按协议停下，处理得当。设计方已把 brief 的场景 1–5 与 `steps/02-structure.md` 更新为现行方案。
- 通过的部分：
  - `structural-motion.ts`：先 `flushSync(commit)` 再在实时 DOM 上播入场，提交与异常都同步；可打断；减弱动效只做 120ms 透明度；系统中途切到减弱动效会取消。
  - `pane-motion.ts`：布局只提交一次，只动面板自身的 `transform / opacity`；退场面板固定在原位置、`inert` 且不接收指针，结束后恢复；面板与结构入场互相取消。V/F 实验用可见的 300 轮转录、每方案 10 次，选择依据清楚，并如实标注高负载下不作毫秒结论。
  - 接入：`changeView` 的未保存确认仍在提交之前；侧栏选中与会话 authority 保持同步；流式路径没有加动画；`ConversationView` 与 `RemoteChat` 只在首次呈现历史时入场。
  - 新增 `.main-content` 包裹层：`.main-area` 原本就是 `overflow: hidden`，不会新增裁切；固定摘要相关选择器已同步改成 `:is(.main-area, .main-content)`。
  - 首轮 UI 失败（坐标取点早于面板动画结束、确认框未等预检）的修法合理，没有 sleep、扩大超时或删断言。
- **需修改 1：同一个会话被重复替换时，整个主内容区会再淡入一次。**
  - 位置：`App.tsx` 的 `replacePresentedSession`。它对每次 `parsed.length > 0` 的替换都调用 `runStructuralTransition('session', …)`，没有区分「换了会话」还是「同一会话的内容刷新」。
  - 会触发的路径：切到一个有缓存的会话时，先用缓存页替换一次（淡入）；历史读完后如果缓存已过期（`cacheConfirmed` 为 false，正好是会话有新活动的常见情况），会对同一个会话再替换一次，主内容区（包括 composer）从透明度 0 再淡入一次，用户正在看的内容闪一下。`onFocusedRun` 聚焦到当前已打开会话的运行时也是同样情况。
  - 要求：只有当呈现的会话 ID 与当前屏幕上的会话不同才播入场；同一会话的刷新、缓存确认、聚焦都即时替换。参照 `RemoteChat` 已有的 `presentedHistoryContext` 写法，用一个 ref 记录当前呈现的会话 ID；`newConversation` 与 `clearTurns` 时重置它。
  - 验收：`--structure-only` 增加一条：用有缓存且已过期的会话（缓存页与读到的历史不同），切换后主内容区只出现一个 `scry-structure` 动画；在已打开会话上触发一次聚焦或刷新，没有 `scry-structure` 动画。负对照：去掉守卫后该断言须失败一次。
- **需修改 2：退路分支丢掉了 `flushSync`，而且生产代码按测试模式分支。**
  - 位置：`structural-motion.ts` 与 `pane-motion.ts` 开头的 `document.hidden || import.meta.env.MODE === 'test'` 分支直接调用 `commit()`。
  - 问题：`newConversation()` 原本刻意用 `flushSync` 同步清空界面再 `await`；现在窗口隐藏时（例如最小化后经菜单、快捷键或远程触发）就不再同步提交，行为取决于窗口是否可见。另外，单测走的是 `MODE === 'test'` 分支，从未覆盖生产里真正执行的 `flushSync` 路径。
  - 要求：所有分支都用 `flushSync(commit)` 提交，只把「是否播动画」做成条件；用特性检测（例如 `typeof Element.prototype.animate !== 'function'`）代替 `import.meta.env.MODE === 'test'`。`env.d.ts` 里为此新增的 `vite/client` 引用如不再需要就删掉。
  - 验收：`structural-motion.test.ts` 与面板对应单测断言隐藏文档与无 `animate` 环境下 commit 也在 `flushSync` 内执行（可以 mock `react-dom` 的 `flushSync` 记录调用）；其余已有断言不变。
- 不阻塞，但要知道：
  - 安装仍未完成，所以 01、02 的改动都还没进到 `/Applications/Scry.app`。这次失败发生在完整单测阶段，执行时机器负载达到 91（10 核），旧提交的同一批用例在同环境也超时，更像是负载问题。请在机器空闲时重跑 `npm run install:mac:dev`；不要为了通过而改超时或跳过用例。03 可以照常推进。
  - `navigation` 没有计数采集器，记为 unavailable 是对的；本任务不要求新增采集器。
  - 页面入场期间 `.main-content` 带 `transform`，会成为其中 `position: fixed` 后代的定位参照，持续 240ms。已在 `steps/03-overlays.md` 加了一条验收：切页后立刻打开主内容区里的菜单或弹窗，位置要正确。

### 02-fix · 同会话刷新与退路提交修正（2026-10-23）

- 按「02 · 核验」修正后直接进入 03 的授权执行。实现 `42f3f9dc`；断言与负对照 `3145cd79`，与生产分开提交。
- `App.tsx` 以 ref 记录实际呈现的会话 ID：同一会话的缓存更新、刷新、聚焦不重复入场；清空 / 新建时重置。所有本地 clearTurns 调用经过同一重置函数；不改 authority、selection sequence 或流式路径。
- 两个动效 helper 在所有退路中也使用 `flushSync`；是否播放仅由 document 可用性 / hidden / Element.animate 决定。删除测试 MODE 分支及不再需要的 vite/client 引用。
- 验收：`npm run test:unit -- src/renderer/structural-motion.test.ts src/renderer/pane-motion.test.ts src/renderer/hooks/useAgentSession.test.ts src/renderer/session-history-cache.test.ts src/renderer/session-selection.test.ts src/renderer/components/render.test.tsx`：6 文件 **304 项通过**；完整 typecheck、build、`--structure-only` 均通过。日志 `/tmp/scry-motion-02-fix-{focused,type,build,structure-final}.log`。
- 新 UI 断言覆盖过期缓存 v1→v2 只播一次、当前会话刷新和聚焦零动画、新建后重新选择仍入场；原有首击输入、首帧高亮、迟到历史、reduce 断言保留。单测用 flushSync mock 的执行区间断言提交确实在内部，不只看 callback 被调用。
- 负对照 1：临时去掉会话 ID 守卫，真实 Electron 在 `Stale cache refresh replayed the session entrance` 处失败（exit 1），日志 `/tmp/scry-motion-02-fix-negative-cache.log`。
- 负对照 2：临时恢复两处退路直接 commit，**6 个断言失败 / 5 通过**；日志 `/tmp/scry-motion-02-fix-negative-flush-final.log`。首次负对照暴露 Element mock 不是可调用构造器，导致 Vitest 错误序列化失败，不能作为验收证据；改成真实 class 后才取得上述有效负对照。两个故意破坏均已撤回，正向重新通过。
- `performance:measure -- --scenario history.page --compare HEAD` 相对 `5befaff4`：10020 bytes、1 message、1 stringify 均不变，无 worse，ratchet 通过；日志 `/tmp/scry-motion-02-fix-perf.log`。导航 collector 缺失沿用核验允许的 unavailable，不新增 collector。
- 开始时 10 核负载 19.70 / 16.37 / 16.81，不能视为空闲；暂不重跑安装，03 完成后再检查。未触碰用户运行实例，未提前标注已安装。

### 02-fix · 跨页缓存入场补充回归（2026-10-23）

- 实现 `3305911d`；断言 `06defe55`，与生产分开提交。
- 相邻路径发现：在分析页选择已有缓存的会话，缓存替换先 flush，动画会落在即将卸载的分析页上。仅把既有 `setView('chat')` 前移到缓存替换之前，让它参加同一次提交；不调整 selection / authority 顺序。
- 归档负对照：`a1387de3` 的独立代码归档加新断言后，真实 Electron 失败于 `Cached navigation entrance targets detached old page`；前移该行后通过。日志 `/tmp/scry-motion-02-cache-nav-{probe,fixed}.log`；现场 `/private/tmp/scry-motion-02-cache-nav.XPNEEa`。没有在 main 或用户工作区复现。
- 当前版本 `--structure-only` 通过，除原有断言外，切换前实际导航到分析页，且在解析新历史之前断言动画目标就是当前 `.main-content`。日志 `/tmp/scry-motion-02-fix-nav-final.log`；最终完整 UI 同样执行该检查。

### 03 · 共享弹窗与浮层入场、出场（2026-10-23，待核验）

- 提交：`b6f42801` motion(03): 为共享弹窗菜单与悬停卡加入可打断出场；`5e3e14ee` motion(03): 验证关闭焦点首击与转场内浮层定位。实现、fixture / 测量分开提交。另有经用户确认的既有验收前置修正 `7fbbf106`。
- 参考：检索现有组件与个人组件库后复用 `ModalFrame` / `ModalCloseButton` / 既有悬停所有权，不引入第二套库；已查阅 W3C APG 原始 [Modal Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) 的 Esc、嵌套焦点与返回触发点约定，本机摘录 `/tmp/scry-motion-03-dialog-reference.txt`。
- 改动摘要：
  - `hooks/usePresence.ts`：enter / exit、一次关闭、仅响应自身 animationend、`exitMs + 80ms` 兜底、reduce 为 120+80ms、卸载清理。重复关闭不改第一次的 reason；下一次原生指针 / 键盘事件先同步结束旧退出，不把重开的同一布尔弹窗留在关闭状态。
  - 实际共享壳名为 `ModalFrame`。遮罩入场 180 / 出场 160ms；面板入场 260ms（0.97、6px）/ 出场 150ms（0.98）。按钮、Esc、遮罩均接入；出场先 inert / pointer-events none、退还焦点、退休焦点陷阱与初始 rAF。新弹窗不被旧出场阻挡；嵌套焦点只由顶层持有。body portal 避免页面 transform 改变 fixed 包含块。
  - 关闭按钮显式调用共享关闭入口，未改 `ModalCloseButton` primitive 合同。保留各调用方原有 busy / saving 拒绝、Meta Prompts 未保存确认、删除取消的错误提示差异；保存成功等父状态直接关闭仍立即卸载。去掉远程目录框重复的外层 portal。
  - 右侧 Surface、会话、项目、工作区 4 类菜单入场 160 / 出场 100ms；操作立即执行，退出期间不挡后续点击。固定菜单移到 body；悬停卡保留 350ms 显示 / 120ms 离开意图延迟，所有权换人立即移除旧卡，普通退出 100ms。reduce 同名关键帧只含透明度。
- 验收（Node 22.22.1、Electron 42.10.1、App 0.2.219；均为隔离临时数据，无真实账号 / Provider 费用）：

| 项目 | 结果 | 命令 / 证据 |
| --- | --- | --- |
| presence 与相关单测 | 10 文件 **320 项通过**，其中 presence 8 项；原 render 245 项、Settings copy 与 primitive 原断言保留 | `npm run test:unit -- src/renderer/structural-motion.test.ts src/renderer/pane-motion.test.ts src/renderer/hooks/usePresence.test.ts src/renderer/hooks/useResizablePane.test.ts src/renderer/hooks/useAgentSession.test.ts src/renderer/session-history-cache.test.ts src/renderer/session-selection.test.ts src/renderer/components/render.test.tsx src/renderer/components/SettingsModal.copy.test.tsx src/renderer/components/primitives/ModalCloseButton.test.tsx`；`/tmp/scry-motion-03-focused-final.log` |
| 类型 / 构建 | 完整 node + web typecheck、build 通过 | `npm run typecheck`；`/tmp/scry-motion-03-typecheck-final.log`；最终完整 UI 内两次 `npm run build`，renderer 为 `index-BF23CW1f.js` |
| overlays 专项 | 规格 6 条通过；最终 12 次关闭全部收到真实 CSS animationend，170.1–217.7ms，均 ≤250ms | `node scripts/session-capability-ui-smoke.mjs --overlays-only`，已纳入完整 UI 独立进程；最终数据见 `/tmp/scry-motion-03-ui-accepted.log` 的 overlays JSON |
| 关闭与首击 | 按钮 / Esc / 遮罩、退出时即还焦点、退出中首次原生点击会话行生效、同一弹窗立即重开、替换、父忙碌不抢子焦点、直接父卸载、reduce 透明度均通过 | 原生 sendInputEvent / insertText、坐标 hit-test、真实 React；不等退出结束再测首击 |
| 页面 transform 中定位 | 页面 240ms 入场仍有 transform 时，于第 0ms 打开主内容里的真实菜单与共享弹窗；与静止基准的 viewport / layout 坐标差 ≤1px | 专项记录 `placementDuringPageTransformAtMs: 0`，不是等转场结束后截图 |
| 完整 UI | **通过**，含 Credits、remote settings 嵌套、source-control、conversation ownership / 三轮 IPC、Pi 原生历史 | `npm run test:renderer:ui`；`/tmp/scry-motion-03-ui-accepted.log` |
| 当前构建真实 App | 独立 userData / HOME / 临时工作区，深浅各检查设置 / Skills / MCP / LLM 性能、右侧 +、悬停卡；原生发送、未发送草稿、面板及侧栏相邻路径通过 | `node scripts/electron-security-smoke.mjs --dev-structure-only`；`/tmp/scry-motion-03-app-final.log` |
| 性能计数 | 对 `a1387de3`：history.page 10020 bytes / 1 message / 1 stringify 不变，无 worse，ratchet 通过 | `npm run performance:measure -- --scenario history.page --compare a1387de3 --out /tmp/scry-motion-03-perf-final`；候选 `5e3e14ee`，`/tmp/scry-motion-03-perf-final.log` |

- 单测覆盖：自身 / 后代 animationend 区分、重复只关闭一次且保留首个 reason、缺少事件时 240ms 兜底、reduce 200ms 兜底、卸载清掉 timer / node 与 document listener、下一次输入同步结束退出、父卸载不再调用孩子的旧回调、菜单取消退出后可再关闭。
- 负对照均已恢复：
  - 去掉遮罩 mousedown 的 preventDefault，失败于 `backdrop did not restore focus at exit start`；`/tmp/scry-motion-03-negative-focus.log`。
  - 把弹窗 portal 临时放回 `.main-content`，失败于 `dialog moved under the page transform`：遮罩从 `[0,0,1280,900]` 变为 `[238,58,1042,848]`；`/tmp/scry-motion-03-negative-portal.log`。
  - 在已修正测试前置条件后临时恢复全局 `transition-duration:120ms !important`，仍失败于 `#motion-instant` 出现未声明的 120ms background-color 过渡；`/tmp/scry-motion-03-negative-micro-precondition.log`。原判定未弱化，生产 motion.css 无改动。
- 首轮失败及修正（不以重跑抹去）：
  - 新 fixture 自己的缓存控制条遮住关闭按钮；只在 overlays fixture 隐藏这条控制条。早期关闭计时包含取点与轮询开销，改为原生事件 capture 到 MutationObserver 移除时刻；保留 ≤250ms。重复声明诊断变量改为局部块；CSS fill:both 的 finished 动画仍在 getAnimations 中，等待条件改查 playState 而非数组为空。
  - 原生遮罩 mousedown 会在归还焦点后清掉它，修复为防止该默认动作；负对照已证明。普通隐藏窗口的根合成动画一直 pending，依赖 240ms 兜底，其中一轮实际 331ms 超限。诊断排除了 inert 本身；仅对新 overlays fixture 启用隐藏 offscreen 绘制，真实 compositor 后最终 12/12 收到 animationend。没有显示窗口、抢 OS 焦点、加 sleep / retry 或扩大时限；其他 fixture / V/F workload 未变。日志 `/tmp/scry-motion-03-overlays-{first,second,third,fourth,fifth,timeline,timeline2,painted}.log`。
  - 全量第一次失败在远程配对：旧断言要求 Esc 后嵌套框即刻消失。按 03 的退出保留合同，先增加「父设置仍在且子框 exit」断言，再等子框移除；未删父框 / 焦点保护。focused remote settings 通过；日志 `/tmp/scry-motion-03-ui.log`、`/tmp/scry-motion-03-remote-settings.log`。
  - 后一次完整重跑暴露上述 01 前置主题颜色竞态，旧 02 归档也失败；用户批准后才改前置条件。日志 `/tmp/scry-motion-03-ui-verified.log`、`/tmp/scry-motion-03-motion-baseline.log`。之后当前代码完整 UI 通过；旧失败仍保留。
- 视觉检查：已读当前构建深浅两张 6 场景 contact sheet，检查遮罩、尺寸、菜单锚点、悬停卡与长转录相邻布局；早一轮另读设置 / LLM 原图。当前截图 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-structure-app-wI2dH6/`；仅本机保留，不入库。未改 UI 文案 / 尺寸，无新增依赖 / IPC / 权限或安全边界。
- 限制与规格偏差：按本轮用户确认的点名范围交付；独立工作区确认框、Picker 弹出层未迁移。隐藏真实 App 的 8 次关闭走允许的计时兜底，241.7–243.4ms；不能把它当成前台 animationend 或日常手感证据，真实 CSS 事件由 offscreen 专项另证。未做前台 OS 焦点、120Hz、真实账号 Provider 或真实远程宿主验收；未声称 L2/L3 更快。性能映射所列 `navigation.catalog / compose.drafts / send.codex-fixture / evidence.projection` 没有 counter collector，明确为 unavailable，未加假计数或修改 ratchet。
- 安装：**本轮未重跑，不是已安装或安装成功**。用户要求仅空闲时顺带安装；收尾 10 核机器两次采样：06:38 load 18.15 / 11.58 / 9.34、内存 31G 使用 / 11G compressor；06:53 load 11.66 / 16.14 / 15.92，仍不满足空闲条件，未再启动完整 pack。未升版本、未更换 `/Applications/Scry.app`，未停止或要求重启用户实例；历史安装阻碍仍保留。
- 已自审 source / test diff：补齐 footer 取消关闭接线、保留原有 busy 拒绝与错误提示、删除重复 portal 和未使用的第二套关闭入口；最终 `git diff --check` 通过。独立 test 实例已退出，临时日志 / 截图 / 诊断归档留作本机核验。03 标「待核验」，不进入 04。


#### 核验（设计方，2026-10-23 · 02-fix 与 03）

- 结论：**02-fix 通过，03 通过。** 有一项小修正请在 04 开头以 `motion(03-fix)` 单独提交，不需要为它再等一轮核验。
- 核验方式与边界：读 `5befaff..7138e85` 的全部 diff。这次核验的云端环境仍连不上 npm 源，**没有重跑**单测、类型检查、构建与 UI fixture；这些以执行方记录为准。
- 02-fix：
  - `presentedSessionId` 守卫只在呈现的会话 ID 变化时入场，所有 `clearTurns` 入口都经 `clearPresentedSession` 重置；过期缓存 v1→v2 只播一次，有负对照证明。
  - 两个动效 helper 的所有分支都在 `flushSync` 内提交，测试模式分支和 `vite/client` 引用已删除。
  - 相邻路径修正（`setView('chat')` 前移，让缓存替换的入场落在新的 `.main-content` 上）合理，且只改变同一次批量提交内的顺序，不影响选择序号与 authority。
- 03 通过的部分：
  - `usePresence`：一次关闭、只认自身 `animationend`、计时兜底、卸载清理、下一次原生输入先同步结束旧出场，覆盖完整；出场一开始就 `inert` 并归还焦点，符合 H2。
  - `ModalFrame` 渲染到 `document.body`，避开页面入场期间 `transform` 造成的定位偏移，有负对照（放回 `.main-content` 后遮罩从全窗变成主内容区大小）。已检查没有依赖 `.app`、`.main-area` 等祖先的弹窗选择器（`.settings-modal` 是弹窗自身的类名），不受影响。
  - `Escape` 与焦点陷阱改由弹窗栈的顶层持有；仓库里另外两个自定义对话框在右侧工作区内，不会与 `ModalFrame` 嵌套。
  - 4 类菜单与悬停卡：抽成独立组件后菜单项行为不变；会话菜单的焦点归还从 `onClose` 的 rAF 移到出场开始，没有丢；点遮罩关闭右键菜单时，遮罩在出场期间仍在 DOM 中，点击落到 `body`，不会穿透触发下方按钮。
  - 减弱动效下的同名关键帧只含透明度，按 01 核验后的要求补齐。
  - 范围取舍（工作区确认框、Picker 弹出层不迁移）经用户确认，已如实记录。
- **请在 04 开头修：入场动画用 `both` 填充，结束后会一直留着 `transform`。**
  - 位置：`styles.css` 中 `.modal-overlay[data-state='enter'] > .modal`、`.menu / .ctxmenu / .session-hover-card[data-state='enter']` 的 `animation: … both`。
  - 问题：入场结束后 `transform: scale(1) translateY(0)` 仍然生效（执行方记录里也提到 finished 动画仍留在 `getAnimations()` 中）。只要 `transform` 不是 `none`，元素就会成为其中 `position: fixed` 后代的定位参照并单独占一个合成层。目前弹窗里没有固定定位的后代，所以还没出问题，但以后在弹窗里加下拉菜单或提示就会错位，原因也很难查。
  - 要求：入场改用 `backwards` 填充（动画结束后不留样式），出场保留 `both` 或 `forwards`（需要停在透明状态直到卸载）。
  - 验收：`--overlays-only` 增加一条：入场结束后，`.modal` 与一个菜单的 `getComputedStyle(…).transform` 为 `none`，且 `getAnimations()` 中没有已完成的入场动画。负对照：改回 `both` 后该断言须失败一次。
- 安装：01–03 的改动**都还没进到 `/Applications/Scry.app`**。执行方用「机器空闲」作为重跑安装的前提，但记录里机器一直处于中等负载（load 11–19）；最初失败时的负载是 38–91。是否在当前负载下直接重跑安装，由用户决定。

### 03-fix · 入场结束释放变换与动画（2026-10-23）

- 实现 `77e33c72`；断言 `001eb687`，分开提交。按「02-fix 与 03 · 核验」及 04 第 0 项，modal backdrop / dialog、共享 menu / ctxmenu / hover card 与 surface menu 的入场统一 `backwards`；所有出场仍保留 `both`。不改尺寸、事件或卸载合同。
- `--overlays-only` 新增真实 `.probe-modal` 与 `.sb-session-menu` 入场结束断言：computed transform 为 `none`，且不留 finished 的入场 CSS animation。
- 有效负对照两次：原实现 `both` 时 `.probe-modal` 保留单位矩阵及 1 个 finished 入场，新断言失败；仅将菜单改回 `both`，`.sb-session-menu` 也独立失败。日志 `/tmp/scry-motion-03-fix-fill-negative-{modal,menu}.log`。均已恢复。
- 当前代码 `node scripts/session-capability-ui-smoke.mjs --overlays-only`、`npm run typecheck:web`、`npm run build` 通过。专项保留全部原关闭 / 焦点 / 首击 / 定位 / reduced 回归，12/12 关闭收到真实 animationend、178.1–210.2ms。日志 `/tmp/scry-motion-03-fix-fill-{final,type,build}.log`。未用等待卸载代替入场结束样式检查。
- 第 0 项通过后可按核验授权进入 04；用户随后明确选择「保持 160ms 上限」与「超限列表不播 FLIP」。本步短内容展开 240ms / 收起 160ms，FLIP 只对总 keyed 节点 ≤40 的列表生效，超限只取消装饰动画，不删 DOM / 数据或缩减 workload。上文规格问题已获决定；brief 与步骤文件不改。安装初始失败保留，不把本次 build 当成已安装。

### 04 · 列表、折叠、标签与真实流式新块（2026-10-23，待核验）

- 提交：`5f3484c1` 实现；`6ffa5eed` 原生 fixture / 单测与既有检查的静止布局前置条件；`72abd3e3` 补齐运行 authority、真实指标及历史打开全过程回归。实现与测量 / 断言分开提交。03 第 0 项见上节；`458742bf` 保留原 SessionRename 断言，修正菜单接管时公开 tooltip dismiss 的立即退休合同，普通离开仍走装饰退出。
- FLIP：抽出 `useFlipList`，保留先全部读再统一写及打断续接；新行 220ms、存活行移动 300ms。接入活动、项目及置顶会话、队列、后台任务。总 keyed 节点 >40 时不读几何、不播 FLIP，恢复预算内只重建基线；45 行 DOM 全保留。活动原有每组 40 行、提升规则、溢出提示和按住指针冻结逻辑不改。
- 首屏：`useFirstReadyList` 从真实数据就绪开始，前十项 0–144ms / 16ms 错开，第十一项起无 delay，刷新不重播；接入分析、技能、MCP、LLM 性能列表及 Meta Prompts。减弱动效为整组一次 120ms opacity。
- 折叠：共享 `Disclosure` 懒挂载、退出后卸载，关闭当帧 inert / aria-hidden；初始已展开内容静态呈现，不用启动高度动画阻挡已有操作。项目、技能、工具与子代理短内容展开 240ms / 收起 160ms，>40 行内容只做 160ms opacity。Thinking 保留原生 details，以 `::details-content` / `interpolate-size` 过渡，不改为自制折叠。
- 标签：侧栏及 surface 独立指示条只做 220ms transform；文字颜色同步改变，列表增删和 resize 直接定位，减弱动效不移动；保留键盘选择、关闭焦点及指示条未就位时的选中表达。
- 流式：按运行 owner、加载 / 缓存 / 会话身份及挂载基线识别新增工具、稳定 Hook phase/script 行及真实轮次指标，180ms 入场。历史、恢复与切换不入场；token 更新不重播，Hook 生命周期不冒充新行。结构投影沿用已有稳定引用，不新增逐 token 结构扫描；未修改贴底滚动与用户主动跳转语义。

#### 验收与有效负对照

| 项目 | 实际检查与结果 | 证据 |
| --- | --- | --- |
| 类型、unit、构建 | Node 22.22.1：`npm run typecheck`、`npm run test:unit`、`npm run build` 通过；303 文件 / 3725 测试通过，4 个既有条件检查跳过（性能相关性及三个真实探针） | `/tmp/scry-motion-04-final-{type,unit,build}.log` |
| FLIP 单测 | 5/5，覆盖先读后写、打断续接、减弱、超限与恢复；临时放宽 40→400 后，预期 0 次读几何实际 41 次，新断言失败；恢复后通过 | `/tmp/scry-motion-04-budget-negative.log`，`src/renderer/hooks/useFlipList.test.ts` |
| 深浅主题列表 | `node scripts/session-capability-ui-smoke.mjs --lists-only` 通过：12 行分析 delay、刷新不重播、45 行超限保留、项目关闭退休、置顶 220/300ms、侧栏 / surface 220ms、动态标签 / resize 无移动、队列 / 任务存活行 300ms | `/tmp/scry-motion-04-lists-complete-authority.log` |
| 原生折叠与流式 | 同专项通过短技能 grid 240ms、原生 Thinking 的真实中间高度帧 240ms、55 行工具输出仅 160ms opacity；50 个历史工具与已知指标在逐个展开的连续 rAF 观测期间始终无入场；真实新增工具 / Hook / 指标各 180ms；token 与生命周期不重播；cache、loading、会话身份切换均重新建立基线；减弱动效仅 opacity | 同上；UA details 插值未暴露为可读 Animation / transitionend，使用 computed pseudo 的连续实际帧证明，不仅检查 CSS 源码 |
| 首屏 / 置顶 / 历史负对照 | 暂将 delay 归零，新断言拒绝全零；去掉置顶列表 revision，新存活行检查失败；强制所有工具卡 / 指标挂入场动画，历史连续观测明确失败。全部已恢复，再跑正例通过 | `/tmp/scry-motion-04-{stagger,pinned,history}-negative.log` |
| 完整 renderer 与后台 | `npm run test:renderer:ui` 全套通过，含原 `--sidebar-activity-only`、Credits、`test:background-ui`、真实 IPC 及 Pi 43 轮历史；最终加强版在 Node 24.18.0 / Electron 42.10.1 通过，上一完整版本在 Node 22.22.1 也通过 | `/tmp/scry-motion-04-ui-delivery.log`、`/tmp/scry-motion-04-ui-complete-final.log` |
| 独立实际 App | `node scripts/electron-security-smoke.mjs --dev-structure-only` 通过深浅主题临时 App：侧栏、分析、技能 / MCP / LLM、Meta、pane、草稿焦点与 fixture Provider 原生发送。隐藏隔离 userData / workspace，不激活用户窗口，不用真实 Provider 或个人数据 | `/tmp/scry-motion-04-final-app.log`；截图只留临时目录，抽看实际 App light chat / dark skills 和列表 light analytics / dark MCP 四张，不宣称逐张审阅全部截图 |

- `--lists-only` 扩充到真实指标、独立会话身份及连续历史观测后，复用既有 `native-ui-pointer.mjs` 的绘制就绪、坐标命中与原生输入。单次工作量超过原 30s 子进程 watchdog，按 structure / history / live 拆为三个全新隔离 campaign；每个仍是原 30s，所有 45/50 行及原断言不减少，合并为一个结果。其他 fixture 的执行方式未改。
- 实际 App 的 modal 关闭仍记录 fallback 241.8–243.7ms / `nativeAnimationEnd: false`，不将它当成 CSS animationend 证据；03 独立原生浮层 fixture 的 12/12 真实 animationend 证据见上节。

#### 首轮失败与修正

- 立即安装的原 tooltip 断言首败完整保留；以 `458742bf` 修公开 dismiss 合同，未延长原断言 timeout。首次长工具输出回归实际检测到 grid 240ms，随后改为长内容的 opacity-only 路径，不改测试预期。
- 初始已展开 Disclosure 的入场高度曾使既有 cache 点击目标尚未稳定：改成初始静态展示，后续用户开合仍动画。测试侧旧 `first/last-child` 因独立指示条失效，改为既有 activity/projects 语义 ID，不减断言。
- motion token 检查曾采入正在进行的 240ms 工具组动画，增加等待该有限动画结束的前置条件；仅该 fixture 使用 offscreen。曾全局 offscreen 导致 LLM 焦点测试失败，已撤回；旧键盘和性能 fixture 不变。packaged dock 几何检查曾在 300ms pane 入场、约 520px 位移中取点，现等待已有 scry-pane 完成（原静止布局断言不变），不是降低几何标准。
- Thinking 的 UA pseudo 动画未由动画枚举 / transitionend 暴露，改用真实帧插值证明。加强版 attachLive 的旧 DOM 曾满足就绪条件，改为等新 run 的实际 DOM；删除无必要的 flushSync 实验，没有生产防御分支。
- 一次既有 workspace `dirty=false` UI 首败，focused 及后续完整套件通过；根因未确认，不声称已经修复。一次将类型 / unit / 全 UI 串在一个 600s 工具调用中，工具在后段超时；检查部分日志与进程收敛后，单独运行全 UI 通过，未扩大任何测试 timeout。

#### 性能与偏差

- 与 `db53ca71` 对比，在 `6ffa5eed` 测量，随后仅强化 fixture / 断言。使用实际 collector ID：`npm run performance:measure -- --compare db53ca71 --scenario history.page --out /tmp/scry-motion-04-head-history-page`，以及 `--scenario trace.delivery --out /tmp/scry-motion-04-head-trace-delivery`，两者 ratchet 通过。history 为 10020 bytes / 1 message / 1 stringify，trace 为 165996 bytes / 2 messages，均未变化（L1）。规格的逻辑名 history / stream 不等于 CLI collector ID；首次误用 history、renderer.batch 被拒绝的日志保留，不当作测量成功。
- 另按现有固定 17 场景 `npm run performance:bench`，同 Node 22 / harness，使用 `timing-run.mjs` 串行锁对比基线与当前。history.page 的计算 batchMeanP95 0.108→0.121ms（+12.9%）、trace.delivery 1.317→2.807ms（+113.0%）、remote.loopback 1.162→1.268ms（+9.1%）；均在该 comparator 门限内，但不能据此否认回归。基线 load 15.27→14.27，当前 17.03→16.64（10 核），两次 `highLoad: true`；相关计算路径未改，高负载混杂，原因无法从这次测量判定，不作为可靠 L2 结论。renderer.batch 0.223→0.212ms 也不宣称更快。
- 该全场景 comparator **exit 1**：唯一失败为未变化的 `persistence.archive` bytes 10577→10577，超过既有 10555 ceiling。未修改 collector、workload、ratchet、计数归属或预算。证据 `/tmp/scry-motion-04-head-comparison.md`、`/tmp/scry-motion-04-compute-{baseline,head}.json`；这不是浏览器绘制或真实 Provider 延迟，也没有 L3 日常样本。
- 用户已批准的规格取舍仍仅为短收起 160ms，以及总 keyed 节点 >40 不播 FLIP且不截断业务数据；真实 LLM 列表位于 `LlmPerformancePanel.tsx`，不为匹配文件名搬到 Modals。brief 与步骤文件未改。
- 提交途中共享 pre-commit 新启用 20KB 硬上限，而旧分支没有该脚本；独立运行 main 的同一检查，现有 harness 143464 bytes、列表检查 22488 bytes 被拒绝，原进度文档也已有 59187 bytes。用户明确选择「仅本次豁免大小检查」：仅本次旧分支交付使用命令级 hook 路径豁免，不修改共享配置，不跳过测试、安全或安装门禁。未为大小规则擅自重写协议要求保留的旧记录。

#### 安装与未验证

- 完整 `npm run install:mac:dev` 最后执行于 `6ffa5eed`，2026-10-23 10:16:19→10:22:46 PDT，exit 1。Node 22.22.1，10 核 load 9.01 / 9.34 / 11.25→17.18 / 11.08 / 11.08。typecheck、3725 unit（4 跳过）、shell、build / CLI build、签名打包与 packaged check 通过（App 0.2.219、私有 CLI 0.2.51），external link / crash smoke 通过；随后上述终端录制安全 gate 阻挡，后续 gate 和安装未执行。日志 `/tmp/scry-motion-04-install-head{,-load}.log`。不能把成功产物构建说成安装成功；后续提交只加强测试与记录，没有改 App 产物源码。
- 先前 09:32→09:38:59 的完整安装在 pane 静止几何检查失败，load 8.25 / 13.05 / 14.46→9.85 / 11.48 / 13.27；日志 `/tmp/scry-motion-04-install-final.log`。修正等待实际动画完成的前置条件后，最后一次通过该项，才暴露基线也失败的终端 gate。最初 07:08 的 tooltip 安装首败见「问题」，不覆盖任何第一次失败。
- 未验证真实付费 Provider、真实远程手机、120Hz 设备与低负载 L2 / 发布后 L3；本步使用真实 Electron 输入和本地 fixture Provider，不以虚构数据假冒这些场景。基线临时 worktree 已移除，截图 / 日志留本机临时目录、不提交。用户当前 App 未更新、未要求用户重启作为验收前置条件。
- 下一步由设计方核验 04；维护者另行决定终端录制 gate 排查与低负载复测。本执行方推送后停下，不进入 05、不更改无关终端业务。

### 03-fix 与 04 · 核验（2026-10-24，设计方）

结论：**03-fix 通过；04 需修改（两处）**。核验方式：读完 `db53ca7..3e460f0` 全部实现与测试 diff，并对照 `electron-security-smoke.mjs` 与 `App.tsx` 定位安装阻挡。核验环境连不上 npm 源，单测、构建与 UI 套件未重跑，依据执行方记录。

**03-fix 通过**
- 入场统一 `backwards`、出场保留 `both`，负对照两次有效。
- `458742bf` 把悬停卡对外的 `dismiss` 改为立即退休，与菜单接管合同一致；普通离开仍走装饰退出。通过。

**04 通过的部分**
- `useFlipList`：先读后写、打断续接（`offsetTop` 不受 transform 影响，加上当前位移得到显示位置）、减弱动效直达终点，逻辑正确。
- `useFirstReadyList`：只在首次就绪时错开，刷新不重播，pointerdown / keydown 立即结束，减弱动效整组淡入。符合规格。
- `Disclosure`：懒挂载、收起后卸载、收起当帧 inert + aria-hidden；初始已展开的内容不播入场，`lockedOpen` / 待回答问题走 `immediate`。长内容只淡入。Thinking 保留原生 details。符合规格。
- 流式新块：`useLiveArrivalKeys` 以「运行中 owner + 会话身份 + 就绪状态」为重置键，挂载基线后才判新增，历史、缓存、切换不入场，token 更新不重播。设计合理，负对照有效。
- 标签指示条：只在选中变化且标签顺序不变时滑动，增删与 resize 直接定位。符合规格。

**必须修正 1：安装阻挡是 03 引入的回归，不是既有问题**
- 失败点是 `electron-security-smoke.mjs` 录制冒烟里 `button('终端录制历史').click()` 之后的 `waitFor(() => !!query('[data-recording-id="…"] button'))`。`query()` 把选择器限定在 `[data-session-surface-current="true"]` 内。
- 03（`b6f42801`）让 `ModalFrame` 经 `createPortal` 挂到 `document.body`，`TerminalHistory` 用的就是 `ModalFrame`，所以这个弹窗已不在 session surface 里，测试永远找不到它。
- 执行方的「基线」`db53ca71` 已包含 03，所以基线复现不能说明是旧问题。此前 01、02 的安装都在单测阶段就失败，从未跑到这个 gate。03 核验时我也漏了这一点。
- 修法：测试侧把录制历史弹窗内的查询改为在 `document` 里找（例如 `[data-recording-id]` 前缀的选择器不走 surface 作用域，或在 `.modal-overlay` 里找），其余 surface 内查询保持作用域。这是跟随 03 已核验的 DOM 结构变化，不放宽断言、不改 timeout。另外请 `grep` 所有 smoke / fixture 中经 surface 作用域查询弹窗内容的地方，一并改。
- 验收：`node scripts/electron-security-smoke.mjs --dev` 通过；负对照为把 `ModalFrame` 临时改回不 portal，确认修改后的查询仍能找到（证明不是靠新路径凑巧通过），或说明为何无法做该对照。随后完整 `npm run install:mac:dev`。
- 风险记录（暂不要求改）：非当前 session surface 以 `display: none` 保留挂载，弹窗 portal 后会脱离这层隐藏。目前没找到弹窗打开时切换会话的入口，如果执行方发现有（例如远程控制切会话），请记入「问题」。

**必须修正 2（待用户决定）：动态视图原有的 FLIP 对大多数用户失效**
- 改动前，`SidebarActivity` 的位置过渡作用于整个列表，节点受 `GROUP_LIMIT` 约束（3 组 × 40 行 + 3 个标题，最多 123 个）。
- 现在接入 `useFlipList` 后统一受 40 节点预算约束。「已完成」组只要有 37 条以上会话，整个动态视图就不再播位置过渡，包括会话从「已完成」移到「进行中」这一最主要的场景。有一定历史的用户基本都会超过。
- `--sidebar-activity-only` 仍通过，是因为 fixture 行数少，没有覆盖这种情况。
- **用户已决定（2026-10-24）：动态视图沿用原上限**，按下方设计方建议执行。
- 用户当初选择「超限不播 FLIP」时，问题描述没有指出这会关掉已上线的动态视图动画。设计方建议：`useFlipList` 接受一个预算参数，动态视图沿用原有上限（`GROUP_LIMIT * activityGroups.length + activityGroups.length`），其他列表保持 40。请以用户最终选择为准。
- 验收（若采纳建议）：`--sidebar-activity-only` 增加一个「已完成」组 40 行 + 1 行从已完成移到进行中的用例，断言存活行有 300ms transform；负对照为预算改回 40 时该断言失败。

**不阻塞，顺手处理**
- `useTabIndicator` 的 layout effect 没有依赖数组，每次 Sidebar / RightSurfacePanel 渲染都读一次 `offsetLeft`（强制同步布局），`ResizeObserver` 也每次重建。建议 layout effect 依赖 `[selected, 顺序字符串]`，`ResizeObserver` 只在标签集合变化时重建。
- 减弱动效下长内容折叠仍是 160ms（`[data-long][data-state='enter']` 的优先级高于减弱动效里的 120ms 规则），可补一条覆盖。
- 工具卡、Thinking 的箭头静止方向由「向下」改为「向右」（展开后转为向下），符合 macOS 展开三角惯例，请在截图里给用户确认一眼。
- 性能：`trace.delivery` 计算耗时 +113% 在高负载下测得，执行方已注明不作结论。修正 1 后重跑安装时，如负载低于 10，请顺带重跑这一项。

### 04-fix · 动态视图预算与 portal 弹窗检查（2026-10-24，待核验）

- 提交：`b8537f5e` 实现；`5aa66684` 安全测试查询修正、断言与 fixture。只处理两项必须修正及前两项「不阻塞」；不进入 05，不改 brief / 步骤文件、依赖、业务列表上限、权限或性能门限。
- `useFlipList(root, revision, budget = 40)` 将预算加入 effect 依赖。动态视图传入 `GROUP_LIMIT * activityGroups.length + activityGroups.length`（123，含标题），其余列表仍为 40；不改各组 40 行、溢出、提升、顺序和冻结点击合同。新增单测确认 123 节点可播、124 节点停止测量并取消活动动画，保留默认超 40 的全部原断言。
- 安全 smoke 只将录制历史按钮查询改成 `document.querySelector('.modal-overlay [data-recording-id="…"] button')`，其余 terminal controls 仍在当前 surface 内找。检索 smoke / fixture 中全部 `data-session-surface-current` 及 surface/query 包装调用：其余命中为编辑器、标签 / pane、菜单触发器或实例保留检查，未发现第二处经 surface 查询弹窗内容的调用。
- 标签 hook 接收调用方的渲染顺序键；layout effect 仅在 selected / 顺序字符串变化时定位，ResizeObserver 仅在集合变化时重建；resize 直接定位，选择仍为 220ms transform。无关 Sidebar / RightSurfacePanel 渲染不测量。
- 减弱动效增加长折叠局部 120ms 覆盖。准确说明：完整 App 的 `styles.css` 已有全局 `animation-duration: 120ms !important`，所以单独撤回新增局部规则不会使完整 App 变回 160ms。本次让 motion.css 的局部优先级也自洽，不宣称修复了当前组合样式下已复现的 160ms 用户问题。

#### 验证与对照

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| hooks focused | 2 文件 / 8 测试通过，含自定义预算、无关渲染不读布局 / 不重建 observer | `/tmp/scry-motion-04-fix-hooks-final.log` |
| 动态视图 | `--sidebar-activity-only`：40 行已完成 + 1 行进行中的基线中，既有已完成行移到进行中，DOM 身份保留且存活行有 300ms transform（读取实际 keyframe 的 DOMMatrix m42 非零）；保留键盘、按住目标、搜索、归档及减弱原断言 | `/tmp/scry-motion-04-fix-activity-matrix-positive.log` 及完整 UI 中同一用例 |
| 动态预算负对照 | 临时把预算改回 40，新原生断言失败：`Large activity survivor did not retain its 300ms transform`；恢复 123 后完整 UI 通过 | `/tmp/scry-motion-04-fix-activity-matrix-negative.log` |
| 标签与长内容 | `--lists-only` 及完整 UI：无关 rerender 的真实 offsetLeft / offsetWidth 读取、标签根 observer 重建均为 0；选择 220ms、增删 / resize jump；真正新增的 55 行输出有 long 标记，入场 / 出场各 120ms 且只有 opacity | `/tmp/scry-motion-04-fix-lists-ready.log`、`/tmp/scry-motion-04-fix-ui-matrix-final.log` |
| 补充破坏对照 | 临时让 effect 每次 render 都执行，新单测 2/2 失败；强制长入场 160ms `!important`，原生断言读到 160ms 并失败。均已恢复；不把撤回局部 CSS 后仍通过的尝试冒充有效负对照 | `/tmp/scry-motion-04-fix-tabs-negative.log`、`/tmp/scry-motion-04-fix-reduced-forced-negative.log` |
| dev 安全 | `node scripts/electron-security-smoke.mjs --dev` 通过，recording 的 captured / replayed / readonly / noSpawn / deleted 均 true；原恢复、跨工作区拒绝及其余安全断言通过 | `/tmp/scry-motion-04-fix-security-dev-{first,final}.log` |
| 不 portal 对照 | 临时将生产 ModalFrame 改为直接返回 content，重新 build 后，同一完整 `--dev` 仍通过；恢复原 portal、重新 build 再通过。ModalFrame 最终无 diff，证明查询不依赖恰好 portal 才成立 | `/tmp/scry-motion-04-fix-no-portal-{build,security}.log` |
| 完整 UI | `npm run test:renderer:ui` 通过，含 Credits、后台、source-control、真实 IPC、Pi 43 轮历史及全部列表 / overlay 回归；隔离 fixture / userData，无真实付费 Provider，不激活用户窗口 | `/tmp/scry-motion-04-fix-ui-matrix-final.log` |
| 类型与安装 gates | 最终 `npm run typecheck` 通过；完整安装中的 unit 为 304 文件 / 3728 测试通过、4 个既有条件检查跳过；shell、build、CLI build、签名打包、packaged check、全部 Electron 安全及 remote-host smoke 均通过 | `/tmp/scry-motion-04-fix-type-delivery.log`、`/tmp/scry-motion-04-fix-install.log` |

- 首轮 typecheck 发现新增单测写 readonly RefObject.current，改在 mock ref 宿主中完成绑定，未改变生产类型合同。
- 完整 UI 首轮在 Hook 生命周期检查失败。原检查没有等待原生 phase 展开的 DOM open，也未等 response dispatch 的 React 提交；现增加这两项就绪检查，并单独断言原入场已经结束，保留原不重播断言。专项与完整 UI 通过，未修改生产 Hook、加 sleep 或扩大 timeout。首败 `/tmp/scry-motion-04-fix-ui-full.log` 保留，不把它说成已确认的生产 Hook 回归，也不直接重跑抹掉失败。
- 提交被共享 pre-commit 引用本分支不存在的 `scripts/check-staged-file-size.mjs` 阻挡。用户本轮再次明确批准仅豁免大小 hook，使用命令级 hook 路径覆盖完成本步提交；不修改共享配置，不跳过测试、安全或安装 gate。

#### 性能：L1 保持；高负载计算测量不作 L2 结论

- `npm run performance:measure -- --compare ee5cb859 --scenario history.page --out /tmp/scry-motion-04-fix-history` 及 `--scenario trace.delivery --out /tmp/scry-motion-04-fix-trace` 均通过 ratchet：history 10020 bytes / 1 message / 1 stringify，trace 165996 bytes / 2 messages，与基线相同。候选标记 `ee5cb859-dirty`，对应随后提交的同一实现；未改 collector、workload、ratchet 或 budget。
- 安装开始的 1 分钟 load 为 6.94，按核验备注补跑包含 trace.delivery 的原固定 17 场景计算 bench。基线为独立 detached `ee5cb859`，当前使用相同 harness / lockfile / Node 22，均通过原 2 个 harness 正确性测试。两次经 `timing-run.mjs` 串行锁执行；基线 load 19.78→16.29，当前 16.29→20.05（10 核），均 `highLoad: true`。没有等机器空闲或绕过锁。
- 计算 batchMeanP95 上升项（ms）：startup.recovery 3.264→4.051；providers.catalog 0.494→0.606；history.page 0.101→0.144；compose.drafts 0.567→1.657；persistence.archive 14.379→36.172；evidence.projection 0.116→0.243；analytics.stats 0.563→1.181；workspace.files 23.300→40.369；source-control.diff 460.711→805.112；terminal.delivery 0.337→0.390；trace.delivery 1.315→1.453（+10.5%）。这些固定计算路径未加载本次修改的 hook / CSS；每项上升都保留，不归因为本次新增必要工作，也不能在不同高负载下断言是真实回归或不存在回归。renderer.batch 0.273→0.201 同样不宣称更快。
- comparator **exit 1**：persistence.archive、workspace.files、source-control.diff 的上述耗时超过比较门限；另有旧的 persistence.archive bytes 10577→10577 超过 10555 ceiling。不是全场景性能 gate 通过，未放宽。原始 JSON / 报告 `/tmp/scry-motion-04-fix-compute-{baseline,current}.json`、`/tmp/scry-motion-04-fix-comparison.md`。L2 仍未验证；若需要此结论，由维护者安排低负载同条件测量，无 L3 结论。基线临时 worktree 已移除。

#### 安装与最终状态

- `npm run install:mac:dev` 完整通过（exit 0），本机 2026-10-23 19:43:46→19:50:56 PDT。Node 22.22.1 / Electron 42.10.1 / App 0.2.219 / 私有 CLI 0.2.51；10 核 load 6.94 / 10.78 / 10.96→23.13 / 14.97 / 12.54。日志 `/tmp/scry-motion-04-fix-install{,-load}.log`。安装开始前 `--dev` 已通过；全部原安全门禁执行后才安装。
- 已安装到 `/Applications/Scry.app`，installer 保留 `/Applications/.Scry.app.backup`。installed / dist 的 app.asar SHA-256 同为 `385a88a5206cb22e83f7ce75306d53f3153d568dacc9368557a3521eb698d5e7`。安装于提交前的受测工作树，随后仅测试就绪 / 测量 / 记录变化，App 生产源码未再修改。未停止或重启用户日常实例；用户自行重启后才加载新安装版本，不把安装成功当作当前运行实例已更新。
- 真实付费 Provider、120Hz 与低负载 L2 未验证；只完成本轮要求的前两项非阻塞调整，未额外改箭头视觉或进入 05。日志留本机临时目录，不提交个人数据。推送后停下，交设计方核验 04-fix。

### 04-fix · 核验（2026-10-24，设计方）

结论：**通过，04 整步通过，可进入 05**。核验方式：读完 `ee5cb85..dadb8dc` 全部 diff。核验环境连不上 npm 源，测试与安装依据执行方记录。

- 动态视图预算：`useFlipList` 增加 `budget` 参数并加入依赖，动态视图传入 123，其余保持 40。原生用例为 40 行已完成 + 1 行进行中，读取实际 keyframe 断言存活行有 300ms 位移；预算改回 40 的负对照失败。符合用户决定。
- 安全测试查询：只把录制历史弹窗按钮改为在 `.modal-overlay` 内查找，终端控件仍限定在当前 surface。不 portal 的对照也通过，说明查询不依赖 portal。检索结果显示没有第二处同类查询。归因已在记录中撤回并更正，处理得当。
- 标签指示条：layout effect 依赖 `[selected, order]`，`ResizeObserver` 只在集合变化时重建，有单测与原生计数证明无关渲染不读布局。
- 减弱动效长折叠：局部规则优先级已自洽；执行方如实说明全局 `!important` 规则原本就压到 120ms，没有夸大修复。
- 完整安装通过，installed 与 dist 的 app.asar 哈希一致。用户需自行重启 Scry 才会加载。
- 性能：L1 计数不变。高负载（load 16–20）下的计算对比出现多项上升，但集中在 `source-control.diff`、`persistence.archive`、`workspace.files` 等本分支从未改动的主进程路径，且基线与当前负载不同，不归因于本分支。**合入 main 前**请在低负载下重跑一次 `performance:bench` 对比，确认这些上升是噪声。
- 箭头静止方向由「向下」改为「向右」的视觉变化仍待用户在 App 里看一眼确认，不阻塞 05。

### 05 · 加载防闪（2026-10-24，待核验）

- 已拉取 `ec3193df`，读完「04-fix · 核验」，未修改 brief / 步骤文件，也未进入 06。实现 `7861d4be`，文案集中管理补充 `b74c6726`；断言与 fixture `a9cdc143`、严格 MutationObserver / 原生输入回执补充 `b1380cc9`，实现与验证代码分开提交。
- `useDelayedFlag(flag, delayMs = 150)` 只延迟装饰。结束当帧返回 false，卸载 / 输入变化取消计时器；新周期在 render 内退休上周期 visible，避免 passive effect 尚未刷新的 false→true 周期复用旧提示。没有修改请求触发、超时、取消或缓存策略。
- 会话：150ms 前保留上一个 scope 的同一批真实转录 DOM，立即 inert / aria-hidden；超过阈值以 WAAPI opacity-only 120ms 淡出，完成后不保留 Animation。提示为 2px 不定细条 + 一行原文案，160ms 淡入，窄处允许换行；在时间线外的同一 body 顶层绝对定位，不推移旧内容，且 role=status 位于时间线的 aria-busy 区域之外。新内容仍走既有实时 DOM 180ms session 入场，无快照。
- 发送、分叉、aria-busy 和 live-arrival authority 全部继续使用原始 sessionLoading，第一帧即限制。缓存仍立即展示当前所选会话的缓存页、保留原文案与核对前限制；同 scope 的缓存被撤销时立即移除，不把它误留成「上一个会话」。失败 / unavailable 仍即时使用原说明，不延迟为加载态。减弱动效为静态细条 + 原文案、120ms opacity 淡入，不依赖压缩后的循环动画。
- 本次涉及的新增 / 调整文案统一引用 `constants/copy.ts`；没有依赖、主进程 IPC、Provider 调用或权限边界改动。参考原始资料：[MDN aria-busy](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-busy)，正文保留 `/tmp/scry-motion-05-aria-busy.txt`。

#### 其他加载态逐项登记

| 位置 | 本次处理 | 未改变的语义 |
| --- | --- | --- |
| `AnalyticsView.tsx` | 首次读取块、刷新装饰用同一延迟；有数据时保留已观测数据 | raw loading 仍立即 busy / 禁用刷新；error / unavailable 不作加载 |
| `LocationPicker.tsx` 的 `RemoteProjects`（规格中 RemoteLocation 对应的实际路径） | 远端项目初读提示使用 `DelayedLoadingStatus` | 连接失败 / 缺失主机立即说明，不回落本机、不显示假空项目 |
| `RemoteDirectoryPicker.tsx` | 首次与切目录的提示延迟；未读取时不提前显示 0 / 空目录 | 目录浏览 / 选择 raw busy、连接与授权校验不延迟；已确认页计数保留 |
| `SkillsModal` / `McpModal` | 首次清单、全局读取装饰延迟；未知 / pending 时不显示 0 个结果、0 配置或空结果 | 已知清单 / 运行态、每 server 证据与认证限制不变 |
| 实际 App 的 `CapabilitiesModal` | Skills / MCP 初读与刷新装饰同样延迟；null 证据在请求 effect 启动前也不能冒充空清单；工具明细 testing 的装饰提示复用组件 | 非 null 的失败 / unavailable 说明、认证与 Provider 运行态证据即时呈现；未改请求与能力差异 |

#### 验收与负对照

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| hook / 受影响单测 | hook 6/6：短请求、完整延迟、不被 rerender 重启、false 当帧、卸载清理、自定延迟，以及 passive effects 未刷新的新周期；原 SSR 首帧断言改验 busy / 禁用 / 不伪造空证据，时间行为交给原生 fixture | `src/renderer/hooks/useDelayedFlag.test.ts`、`/tmp/scry-motion-05-copy-focused.log` |
| 类型与构建 | Node 22.22.1：完整 typecheck、build 通过（包含要求的 typecheck:web） | `/tmp/scry-motion-05-copy-type.log`、最后安装日志 |
| 原生加载专项 | `--loading-only`：60ms 请求的 MutationObserver 全程无加载元素（包括同一回调前已移除的 addedNodes）；400ms 在 151.2ms 出现，满足 150±40ms，role / 原文案 / 2px 存在。非空草稿的发送与分叉全程受限；旧 DOM 保持身份和位置、120ms 实时淡出；失败无残留；减弱期间细条 / 文字持续可见且无 transform 动画。分析、实际 Skills / MCP、远端项目与真实目录组件的子目录切换通过 | `/tmp/scry-motion-05-loading-strict.log`：timing-run 串行锁，10 核 load 5.71→5.97、highLoad=false；最终全套中同专项 150.9ms，见下行日志 |
| 完整 renderer / 后台 | `npm run test:renderer:ui` 最终完整通过，含 strict observer、可信 pointerup 回执 / textarea 焦点检查、原缓存 13 次读取、Credits、后台、source-control、真实 IPC 与 Pi 43 轮历史 | `/tmp/scry-motion-05-ui-copy-final.log`；之前通过版本 `/tmp/scry-motion-05-ui-final.log`、`/tmp/scry-motion-05-ui-receipts.log` |
| 完整 unit / shell | 最后安装中 305 文件 / 3734 测试通过，4 个条件检查跳过（性能相关性及三个真实探针）；shell 通过 | `/tmp/scry-motion-05-install-copy-final.log` |
| 独立实际 App | 当前构建 `node scripts/electron-security-smoke.mjs --dev-structure-only` 通过深浅主题、原生发送、草稿、pane / modal 相邻操作；隐藏独立 userData / workspace，没有激活用户实例。modal close 本次仍是 242.3–244.1ms fallback，不声称 native animationend | `/tmp/scry-motion-05-app-final.log`，截图目录 `scry-structure-app-E1IaaE` 留本机临时目录 |
| 有效负对照 | 当前 hook 暂改为直接返回 raw flag：6 项中 5 项失败，原生 60ms 请求在约 12.6ms 挂出加载，关键断言拒绝。静态替代暂改回循环：原生 reducedStatic=false 并失败。全部恢复，hook 与原生正例通过 | `/tmp/scry-motion-05-head-delay-negative-{unit,ui}.log`、`/tmp/scry-motion-05-reduced-negative.log`、`/tmp/scry-motion-05-head-delay-restored-{unit,ui}.log` |

#### 首轮失败与修正

- 初版 hook 只在 passive effect 清除 visible。新增「effects 未刷新即 false→true」回归先在旧实现失败（1 failed / 5 passed），再按本周期 state 修正；未放宽阈值。全套期间也曾出现 warm B 提示 wait / read 不一致；其唯一因果未单独确定，不将一次成功重跑当成根因证明。日志 `/tmp/scry-motion-05-cycle-before-fix.log`、`/tmp/scry-motion-05-ui-complete.log`。
- 第一轮原生 fixture 用了错误 title 选择器；改用已有 pointer helper 的真实会话文本目标。减弱检查随后发现原空态的 justify-items:center 将空细条压成零宽，修正加载样式的宽度、最小高度和对齐；没有把检查改成「存在即成功」。实际 App 首次 Skills effect 启动前还会闪出空结果，已区分 null 未观测证据与成功空结果，且没有提前启动请求。分别保留 `/tmp/scry-motion-05-loading-{first,second,third}.log`。
- 原缓存检查把提示限定在时间线内部，现按新的 status 层查询并保留 raw busy 断言。旧「完全没有转录」检查在跨 scope 切换时改为只能保留 inert / aria-hidden 的旧呈现；同 scope 缓存撤销仍保留严格的 DOM 数量 0 断言，晚到响应 / live focus 检查仍要求 raw busy 且 A 只能是 inert 旧呈现，trace / 草稿 / 无 Provider 与无 fork 的检查保留。`/tmp/scry-motion-05-scope-cache.log`、`/tmp/scry-motion-05-cache-final.log` 保留首次结果。
- 加强 observer 后完整 UI 曾在填充 fixture 草稿时失败：原 helper 仅发 input，没等已注册的原生 pointerup 回执与 textarea 焦点。现检查可信回执、命中与真实焦点后才输入，再以 value 证明效果，不加 sleep、重试或 timeout。首次失败 `/tmp/scry-motion-05-ui-strict.log`，修正后完整通过 `/tmp/scry-motion-05-ui-receipts.log`，最后文案集中管理后再次完整通过。
- 首次 focused 的 5 个失败保留于 `/tmp/scry-motion-05-focused-initial.log`。其中 4 项 SSR 期待首帧可见加载词，新 150ms 合同使该预期不再正确；改验同步 busy / 发送禁用 / 无假 0 / 无假空结果，可见文案与时序由原生真实 DOM 检查。另一项「新会话加载不能显示旧转录」的原断言正确，已修实现并原样保留，不把它改成新的预期。

#### 性能、安装与交付限制

- 在最终 `b74c6726` 执行 `npm run performance:measure -- --compare ec3193df --scenario history.page --out /tmp/scry-motion-05-history-final`。实际 collector ID 是 history.page（步骤的 history 是逻辑名），ratchet 通过；10020 bytes / 1 message / 1 stringify，全部与基线相同，无 worse。未改 collector、workload、ratchet 或预算。这是 L1，未以它宣称 L2 整体更快或 L3 日常改善。
- 最后 `npm run install:mac:dev` 于 2026-10-23 21:37:31→21:44:24 PDT，exit 0，10 核 load 7.07 / 7.45 / 7.87→11.57 / 9.59 / 8.73。typecheck、完整 unit / shell、App / CLI build、签名打包、资源与大小检查、external-links / crash / 完整 security / files / desktop-remote-host gate 全部按默认范围通过，然后安装到 `/Applications/Scry.app`，备份 `/Applications/.Scry.app.backup`。App 0.2.219，私有 CLI 0.2.51；安装与 dist 的 app.asar SHA-256 均为 `edfa1005139e369f1ce0b2ec9fa69735305bde6579b3b9f075216f757a229a66`。日志 `/tmp/scry-motion-05-install-copy-final{,-load}.log`。第一次完整安装也通过（21:04:16→21:11:03 PDT），之后只集中管理已有文案，故按当前源码重新完整安装，不把旧产物当最终产物。
- 普通提交先被共享 pre-commit 调用本分支不存在的 `scripts/check-staged-file-size.mjs` 阻挡（MODULE_NOT_FOUND）。用户本轮明确选择「本轮也豁免大小 hook」，仅命令级 hook 路径豁免；共享配置未修改，目录仅含该 pre-commit 链接，运行 / 测试 / 安全 / 安装门禁没有跳过。
- 已抽看普通加载、减弱加载、远端子目录三个当前生产组件截图；截图与日志仅留本机临时目录（`/tmp` 与系统 temp），未提交个人数据。60 / 400ms 是真实生产 App renderer 的可控 read 桩，不是假 UI；它们不代表真实大归档 I/O、真实远端网络或付费 Provider 的耗时。工具明细的装饰分支未另做独立原生时间案例，不把其代码接入说成单独端到端验收。
- 用户日常实例未停止或重启；已安装不等于正在运行的实例已加载新版本。当前实现 / 验证 / 记录推送后停在 05，等待设计方核验，不进入 06。

### 05 · 核验（2026-10-24，设计方）

结论：**需修改（一处）**，其余通过。核验方式：读完 `ec3193d..eff07bb` 全部实现 diff，并对照 `useIntegrations.ts` 的请求失败路径。核验环境连不上 npm 源，测试与安装依据执行方记录。

**通过的部分**
- `useDelayedFlag`：在 render 内退休上一周期的 visible，避免快速 false→true 复用旧提示；变假当帧生效，卸载清理。正确。
- 会话加载：发送、分叉、`aria-busy` 与 live-arrival 都用原始 `sessionLoading`，第一帧生效。跨会话时保留的旧转录立即 inert + aria-hidden，超过 150ms 用 WAAPI 在实时 DOM 上 120ms 淡出；同一会话的缓存撤销仍立即移除。符合规格与 brief 场景 2。
- 加载条位于时间线的 `aria-busy` 区域之外，读屏能播报；减弱动效为静态细条，有负对照。
- 分析页、远端项目、远端目录、MCP / Skill 装饰提示都改为延迟，原始 busy / 禁用不受影响。未知时不显示 0 或空结果，这个方向是对的。
- 原 SSR 断言的修改理由成立；「新会话加载不能显示旧转录」的断言原样保留并修了实现，处理得当。

**必须修正：清单读取失败后，Skills / MCP 面板变成一片空白**
- `useIntegrations.refreshSkills` 在 `listSkills` 抛错时设置 `skillCapability = null`、`skillsRefreshing = false`。MCP 首次读取（`refreshMcp` → `loadMcpLive`）抛错时，`mcpCapability` 也保持 `null`，`mcpConfigRefreshing` 回到 false。
- 本步把 `capability === null` 一律当作「未观测、可能在加载」：`initialSkillsLoading` 为真，但 `DelayedLoadingStatus loading={refreshing}` 的 `loading` 已是 false，于是什么都不渲染；计数、`summary` 也被隐藏。`McpModal` 与 `CapabilitiesModal` 的 Skills / MCP 两栏同理。
- 结果是读取失败后面板没有任何说明，用户也不知道该点刷新。这违反了步骤里的「不把失败或 `unavailable` 当作加载中处理」，也违背「证据不能说谎」：没有取得清单必须明确说出来。改动前至少还会显示一行空态。
- 修法（不改请求与 `useIntegrations` 的数据语义）：在这几个面板里区分三种情况。① 请求尚未开始或正在进行：保持现在的延迟加载提示。② 请求已经结束但 capability 仍为 `null`：显示明确的「未取得 Skill 清单 / 未取得 MCP 配置，可点刷新重试」，用 `role="status"` 或 `alert`，文案进 `LOADING_COPY`，不显示 0。③ 成功的空结果：保持原有的空态文案。区分 ① 和 ② 只需在组件里记住「本次打开后是否见过 refreshing 为真」，不要提前发起请求，也不要改 hook。
- 验收：原生 fixture 让 `listSkills` 与 `mcpSnapshot` 各抛错一次，断言 Skills 弹窗、MCP 弹窗以及 `CapabilitiesModal` 的两栏都出现「未取得」说明，且没有残留加载条，也没有出现 0。负对照：去掉 ② 的分支后断言失败。

**不阻塞**
- 跨会话保留的旧转录仍会调用 `onTurnRef` 注册旧 runId 的 DOM，直到新内容替换后卸载。它们是 inert 的，目前看不会出错；如果执行方知道 `setTurnRef` 有按 runId 定位或滚动的逻辑会读到这些旧节点，请在记录里说明。

### 05-fix · 清单读取终态与刷新重试（2026-10-24，待核验）

- 提交：`e935f2e8` 实现；`532edf1f` 原生断言 / fixture 与新增 callback 的测试调用方适配；`d4ed56d4` 仅修可选截图的绘制就绪前置条件。开始前从 `eff07bb4` 拉到 `eaf4fe2b`，读完「05 · 核验」。只处理本轮必须修正，未进入 06，未改 brief、步骤说明、依赖、权限、请求时机或 `useIntegrations` 的数据语义。
- `Modals.tsx` 的私有 `useReadStarted` 在每次打开的组件实例内记住是否见过原始 refreshing 为真。① 尚未开始 / 正在读取：保持原 150ms 延迟提示，不显示未知计数或空结果；② 已结束且 capability 仍为 null：SkillsModal、McpModal 与 CapabilitiesModal 两栏显示明确的「未取得」状态，不再空白；③ 成功返回空数组：仍用各自原空态。失败态 `role="status"`，原始 busy / 禁用当帧生效，读取重试期间退休旧失败提示。
- 两条失败文案集中在 `LOADING_COPY`。实际 CapabilitiesModal 的 Skills 栏原来没有刷新入口，因此仅在失败态接上已有 `integrations.refreshSkills`，并复用现有刷新样式 / 文案，避免提示「点刷新」却没有按钮；其余路径复用原刷新入口。MCP 在首次配置读取失败后的运行态刷新，也使用当前真实 loading 显示延迟条，不把上次失败继续当作当前终态。

#### 验收与负对照

| 项目 | 实际检查与结果 | 证据 |
| --- | --- | --- |
| 类型 / 构建 / focused | Node 22.22.1、Electron 42.10.1；`npm run typecheck`、`npm run build` 通过；`npm run test:unit -- src/renderer/components/render.test.tsx src/renderer/hooks/useDelayedFlag.test.ts` 251/251 通过，原 SSR 首帧与防闪断言不减 | `/tmp/scry-motion-05-fix-type-final.log`、`/tmp/scry-motion-05-fix-build.log`、`/tmp/scry-motion-05-fix-focused.log` |
| 四条原生失败与恢复 | `node scripts/session-capability-ui-smoke.mjs --loading-only` 通过。legacy Skills / MCP 与实际 Capabilities Skills / MCP 均用生产 `useIntegrations`，让真实 bridge 方法 `listSkills` / `mcpSnapshot` 各拒绝一次（受控 400ms）；断言未开始时无提前请求，读取中 busy / 延迟条，无假空态或 0；拒绝后显示「未取得」、busy 为 false、无加载残留或 0；随后原生点击刷新，仅新增一次成功读取，恢复各自原成功空态 | `/tmp/scry-motion-05-fix-native-reviewed.log`；四项 `inventoryFailures` 均通过；同时旧 60ms 不闪、400ms 约 151.2ms 显示、减弱静态条、会话权限 / 旧 DOM 淡出等原断言全保留 |
| 四个独立负对照 | 分别仅令四处「读取已结束但未取得」判定恒为 false，四次原生检查均 exit 1，在等待对应「未取得 Skill 清单 / MCP 配置」的新断言失败；未改请求、timeout 或数据。每次 finally 恢复该处后再测下一处，最后恢复正例通过 | `/tmp/scry-motion-05-fix-negative-{legacy-skills,legacy-mcp,capabilities-skills,capabilities-mcp}.log`、`/tmp/scry-motion-05-fix-native-restored.log` |
| 完整 renderer / 后台 | `npm run test:renderer:ui` 在最终测试代码 `d4ed56d4` 全套通过，含本轮四个面板、既有深浅主题列表、Credits、后台、source-control、真实 IPC 与 Pi 43 轮历史 | `/tmp/scry-motion-05-fix-ui-final.log`；此前 `/tmp/scry-motion-05-fix-ui-full.log` 也通过 |
| 独立实际 App | 当前构建的 `node scripts/electron-security-smoke.mjs --dev-structure-only` 通过深浅主题、Skills / MCP / LLM、pane、原生 fixture Provider 发送及草稿保留；独立 userData / workspace、隐藏后台、不操作日常实例。该检查覆盖正常成功路径，四种抛错由上方生产 hook / 组件 fixture 验证 | `/tmp/scry-motion-05-fix-app.log`；App modal close 记录为 242.0–243.3ms fallback，`nativeAnimationEnd: false`，不据此声称 CSS animationend |
| 性能计数 | `npm run performance:measure -- --compare eaf4fe2b --scenario history.page --out /tmp/scry-motion-05-fix-history` 通过；baseline / candidate 均 10020 bytes、1 message、1 stringify，ratchet 通过、无 worse | `/tmp/scry-motion-05-fix-history/measure.json`；候选 `532edf1f`，后续只改截图前置与记录，无 App 生产源码变化；仅 L1，不宣称 L2 / L3 更快 |
| 完整安装 | `npm run install:mac:dev` exit 0；305 文件 / 3734 unit 通过，4 个既有条件检查跳过（性能相关性、三个真实探针）；typecheck、shell、App / CLI build、签名打包、资源 / 大小、external links、crash、完整 security / files / desktop remote host 门禁均按默认范围执行并通过，最终安装 `/Applications/Scry.app` | `/tmp/scry-motion-05-fix-install.log`、`/tmp/scry-motion-05-fix-install-load.log` |

- 所有原生输入沿用 `native-ui-pointer.mjs` 的几何 / 命中与 trusted pointerup 回执；没有 `.click()` 替代、OS 激活、sleep、扩大 timeout、跳过断言或真实 Provider 调用。fixture 只控制读边界与开面板，不模拟请求结束后的 state：失败、finally、重试数据均由生产 hook 写回。四个面板未开始 / 失败 / 成功空态均有独立可运行断言。
- 首轮正例（类型、251 个 focused、四条原生、完整 UI、完整安装）均通过。一次负对照驱动脚本只读取日志尾部，误将已正确失败的第一条判为「Invalid negative control」；读回原始日志首部确认就是对应新断言失败，未重跑以覆盖结果，随后三个负对照从原始日志取证。没有将预期负对照失败写成生产回归。
- 首次可选截图曾捕获到前一张 loading 帧，而同期 DOM 已是失败状态。参照既有 Credits fixture，capture 前 `invalidate()` 并等两次 rAF 后截图与当前 DOM 一致；仅改可选截图分支，随后原生专项与完整 UI 均通过。实际抽看最终 `capabilities-skills-failed` 与 `legacy-mcp-failed` 两张截图，失败说明可见、Skills 刷新按钮居中；不宣称审阅全部截图。文件 `/tmp/scry-motion-05-fix-reviewed-*.png`，不提交截图。

#### 不阻塞项与边界

- 按评审要求补充代码证据：`App.setTurnRef` 将旧 runId 的 DOM 放入 `turnRefs`；`pendingChatEvent` 与 `focusedTurnRunId` 的两个 effect 均先读该 map，再查全局 DOM，没有 inert 过滤。因此程序化定位逻辑确有读到保留旧节点的窗口；这不是「已证明没有风险」。旧转录仍 inert / aria-hidden、不能被用户直接点击，实际误滚动未复现。本轮按评审「不阻塞」只记录，不扩展修改跨会话滚动；设计方在核验时决定是否另开引用生命周期修正。
- 未执行真实付费 Provider、真实远端网络 / 手机、120Hz 与实际屏幕阅读器播报；失败专项为受控本地 read 拒绝，真实 App 正常路径为 fixture Provider。没有将这些范围冒充真实外部端到端验收。未改 collector、workload、ratchet 或性能预算。
- 正常提交首次仍被共享 pre-commit 的 `MODULE_NOT_FOUND: scripts/check-staged-file-size.mjs` 阻挡。用户明确选择本轮 05-fix「本轮也豁免大小 hook」；仅使用命令级 hook 路径豁免，不改共享配置，不跳过 unit、安全、构建或安装门禁。此授权不延伸到下一步。

#### 安装与交付状态

- 安装对应源码 / 测试 `532edf1f`，2026-10-23 22:15:19→22:22:29 PDT，Node 22.22.1，10 核 load 9.61 / 7.60 / 7.48→13.88 / 9.66 / 8.29，exit 0。App 0.2.219、私有 CLI 0.2.51；安装与打包的 `app.asar` SHA-256 均为 `39b38400a202d1c215d874b1f788ab3344a2d15e824a5bdb6a0af74242c07264`；备份 `/Applications/.Scry.app.backup`。安装后仅改测试截图前置与本记录，未改变 App 产物源码。
- 用户日常实例未停止 / 重启；安装成功不代表该运行实例已加载新版，需用户自行重启。日志及截图只留本机 `/tmp` 与系统 temp；协议旧记录与核验不改写。推送后停在 05-fix，等待设计方核验，不进入 06。

### 05-fix · 核验（2026-10-24，设计方）

结论：**通过，05 整步通过**。核验方式：读完 `eaf4fe2..ca137a5` 全部 diff。核验环境连不上 npm 源，测试与安装依据执行方记录。

- 三态区分到位：`useReadStarted` 只在组件实例内记住是否见过 refreshing 为真，不提前发起请求，不改 `useIntegrations` 的数据语义。四个面板在读取结束但 capability 仍为 null 时都显示「未取得」，成功空结果保留原空态。
- `CapabilitiesModal` 的 Skills 栏原本没有刷新入口，现只在失败态接上已有的 `refreshSkills`，避免文案说「可点刷新」却没有按钮。合理。
- 四个独立负对照都在新断言处失败，并且如实记录了一次负对照脚本的误判。
- 小瑕疵（不阻塞）：`CapabilitiesModal` 常驻挂载时，切换 Provider 上下文会先把 capability 清空，下一次读取由 effect 发起，中间可能有一帧显示「未取得」。可接受。

**旧转录 DOM 引用（执行方已补充证据，作为合入前的小修）**
- 执行方确认 `App.setTurnRef` 会登记保留旧转录的节点，`pendingChatEvent` 与 `focusedTurnRunId` 两个 effect 会读这张表。runId 一般不跨会话重复，但 fork 出的会话与原会话共享历史轮次，可能有相同 runId。这时在新会话加载期间定位某一轮，可能滚到即将被替换的旧节点。
- 修法很小：`TranscriptTurn` 在呈现保留的旧转录时不调用 `onTurnRef`（或登记 null）。请与合入前的低负载性能复测放在同一轮，不单独开步骤。

### 2026-10-24 · 用户决定：收尾后继续 06（设计方登记）

- 用户明确同意执行第 06 步（侧栏材质）。顺序：先完成「05-fix · 核验」里的旧转录引用小修，并在低负载（1 分钟 load < 10）下重跑 `performance:bench` 对比，以 `motion(wrap)` 提交、记录；之后直接开始 `steps/06-vibrancy.md`。
- 06 完成后与前面各步一起合入 main，由设计方核验后开 PR。

### wrap · 旧转录引用收尾与低负载性能复测（2026-10-24）

- 提交：`ea911aab` 实现；`9d10073d` 原生断言 / fixture。按「05-fix · 核验」让保留旧转录的 `onTurnRef` 为 undefined：React 退休此前登记，保留期不登记旧 DOM；新会话就绪后正常登记。未更改转录数据、scope、惯性滚动、inert / aria-hidden 或原始加载 authority。
- `node scripts/session-capability-ui-smoke.mjs --turn-refs-only`：真实生产 ChatView 初始登记 → 切到共享 runId 的 fork、旧 DOM 仍连接且 inert，但 map 清空 → 延迟条 / 淡出期间不重登 → fork 就绪、同 runId 正确登记当前节点，全部通过。临时恢复旧 prop，负对照在 `retained transcript remained registered for turn navigation` 精确失败；恢复后通过。日志 `/tmp/scry-motion-wrap-refs-{positive,negative,restored}.log`。新 refs campaign 纳入原 `--lists-only`，不减少原三个 campaign / 数据 / 断言，不扩大 30s watchdog。
- `npm run typecheck` 通过；`npm run test:unit -- src/renderer/components/render.test.tsx src/renderer/hooks/useDelayedFlag.test.ts` 251/251 通过。日志 `/tmp/scry-motion-wrap-{type,focused}.log`。完整 UI / 安装随紧接的 06 执行，不把本节写成已安装。
- 低负载复测沿用之前 04-fix 的基线 `ee5cb859`，候选 `9d10073d`。17 场景的 benchmark、runner、budgets 与基线完全相同，Node 22.22.1 / 同一 node_modules，基线为独立 detached worktree，均经 `timing-run.mjs` 宿主锁串行执行 `npm run performance:bench -- <output.json>`，不改 collector、workload、门限或测量方法。
- 首次基线虽在 load 7.88 启动，但结束 14.53，`highLoad:true`；候选启动 guard exit 78，未运行。这组不作低负载证据，日志 `/tmp/scry-motion-wrap-baseline.log`。之后只等待用户指定的启动条件（连续两次 30s 采样 <10），不重试失败断言、不在 workload 内加 sleep。等待日志 `/tmp/scry-motion-wrap-load-gate.log`。有效基线 load **7.03→6.30**，候选 **6.30→6.79**，10 核，两组 `highLoad:false`、各 2 个 harness 正确性测试通过，耗时 23.475s / 22.552s。原始数据 `/tmp/scry-motion-wrap-{baseline,current}-low.json`，日志同名 `.log`。
- `node scripts/performance-compare.mjs /tmp/scry-motion-wrap-baseline-low.json /tmp/scry-motion-wrap-current-low.json scripts/performance-budgets.json /tmp/scry-motion-wrap-comparison.md`：全部 **17 项毫秒门限通过**。前次异常的 persistence.archive 17.593→14.696ms、workspace.files 21.611→20.046ms、source-control.diff 389.541→347.732ms 均未再超门限，支持之前结果受机器负载混杂，不将这些下降归因于本分支。这里是固定临时工作量的计算 / 磁盘 / 子进程测量，不是原生绘制、真实 Provider 或网络延迟，也不声称整体变快。
- 本轮仍有计时上升：terminal.delivery 0.288→0.597ms（+107.3%）、controls.stop-lifecycle 41.135→47.734ms（+16.0%）、resources-shell.process 47.538→50.007ms（+5.2%）、trace.delivery 1.884→2.804ms（+48.8%）、renderer.batch 0.319→0.392ms（+23.0%），均在原门限内；这些 harness 路径不加载本轮 ChatView 引用改动，未改相关实现，不据单组样本证明因果或无回归。history.page 0.161→0.160ms 基本不变。
- 整个 comparator 仍 **exit 1**，唯一失败是已知未变化的 persistence.archive bytes 10577→10577，超过既有 10555 ceiling；不把它写成全门禁绿，也不放宽预算。报告 `/tmp/scry-motion-wrap-comparison.md{,.json}`。临时 worktree 首次因自建 node_modules symlink 未被忽略而拒绝删除；确认仅该链接未跟踪、源文件无改动后 unlink，再正常移除，未删除其他 worktree。
- 正常提交仍因共享 pre-commit 引用旧分支缺失的大小检查脚本失败。用户明确批准本次 wrap 与 06 命令级豁免该 hook；共享配置不改，其他验证 / 安全 / 安装门禁照常。用户也明确批准 06 本次可见原生 test 窗口 / 焦点 / 采集，只操作独立 test 实例与受控背景，不改壁纸、不操作日常 Scry。
- 收尾完成，按已登记用户决定继续 06。该决定不授权合入 main、开 PR 或 force push；仍只推送 design/native-motion，最终由设计方核验。

### 06 · macOS 侧栏原生材质（2026-10-24，待核验）

- 提交：`fe1e60ca` 实现 / DESIGN；`047acbfb` 断言与原生采集。开始前已拉到 `c8049f86`，读完「05-fix · 核验」「用户决定：收尾后继续 06」，先完成上节三个 `motion(wrap)` 提交，再做本步。未改 brief、步骤说明、依赖、版本、Provider、权限或 IPC 合同；不合入 main、不开 PR、不进入后续步骤。
- `window-chrome.ts` 仅 macOS 增加 `vibrancy: 'sidebar'` / `visualEffectState: 'followWindow'`。创建窗口仍用原深浅不透明启动色；现有受信任 `app:rendererReady` 到达后、show 之前才清 native window background，后续主题切换保持透明。非 macOS 仍返回原值。`index.ts` 的 ready 状态仅控制这一视觉生命周期，不放宽现有 sender / URL 检查。
- renderer 复用已有 `data-platform="macos"`：只有 macOS 的 html / body 清底，侧栏深色 `rgba(21,21,21,.98)`、浅色 `rgba(247,247,245,.996)`；主内容和右侧仍走原不透明背景。只改侧栏颜色而不清 html 和已就绪的 native background，会把原生材质完全挡住；这是测量后找到的共同根因，不能只靠配置存在就声称 vibrancy 生效。
- `prefers-reduced-transparency: reduce` 将 html / body 与侧栏恢复原不透明 token，含浅色的正确 specificity；非 macOS 不变。`DESIGN.md`「Elevation & Depth」记录原生材质、启动清底时机和高不透明度。最终效果刻意很轻，不宣称明显毛玻璃；未压暗文本 token 来换对比度。

#### 验收与有效负对照

| 项目 | 实际检查与结果 | 证据 |
| --- | --- | --- |
| 窗口合同 | `npm run test:unit -- src/main/window-chrome.test.ts` 3/3：macOS 参数、Windows / Linux 不变，以及未就绪仍不透明 / macOS 就绪才透明。临时只把 followWindow 改为 active，unit 1 失败 / 2 通过，恢复后通过 | `/tmp/scry-motion-06-chrome-unit.log`、`/tmp/scry-motion-06-follow-negative-unit.log`；最终完整 unit 再验证恢复源码 |
| 原生背景 / 焦点矩阵 | `node scripts/vibrancy-ui-smoke.mjs --foreground --photo /tmp/scry-motion-06-photo.jpg` 通过全部 12 组：深浅 × 纯黑 / 纯白 / 高饱和照片 × 聚焦 / 失焦。使用真实 NSVisualEffectView、真实生产 Sidebar / CSS，测正文 `.pname` / `.sb-sesstext`、实际时间标签与同背景的 dim2 token；不是仅用 DOM 配置或 CSS 颜色公式推断桌面合成 | `/tmp/scry-motion-06-native-restored-final.log`；最终截图目录 `scry-vibrancy-G6mSIC` 位于本机系统 temp |
| 真实 followWindow 负对照 | 仅把 visualEffectState 改成 active，原生检查在 `Native material did not follow focus` 失败；不是只读配置值。恢复 followWindow 后全部 12 组通过 | `/tmp/scry-motion-06-follow-negative-native.log`、上行最终正例；dark 原生空白背景聚焦 RGB 23 / 失焦 22，证实 native 变化，浅色量化下变化极轻 |
| CSS 平台 / 降低透明度 | `node scripts/session-capability-ui-smoke.mjs --material-only` 通过：非 macOS 原不透明底、macOS root / body 透明与侧栏实际半透明、reduce 后深浅均精确恢复原不透明底。material campaign 已纳入原 lists 全套，各 campaign 原 30s watchdog 不变 | `/tmp/scry-motion-06-material-css-final.log` |
| 真实系统降低透明度 | 用户明确批准后，系统实际开启：NSWorkspace、nativeTheme 和 renderer matchMedia 同时为 true，原生窗口深浅的 root / body / sidebar 全回到原不透明 RGB；随后实际恢复关闭，并回到系统设置原「软件更新」页面，没有安装系统更新 | `/tmp/scry-motion-06-system-reduced.log`；最终 AppKit 回读 `reduceTransparency=false`。该次系统验证后仅普通浅色 alpha .999→.996，受测 reduce 分支未变；最终版 reduce 分支另经上行检查，不冒充最终 App 二进制的系统开关复测 |
| 类型 / 构建 / 完整 UI | Node 22.22.1 / Electron 42.10.1；`npm run typecheck`、`npm run build`、`npm run test:renderer:ui` 通过。完整 UI 含本步 material、wrap 共享 runId 引用生命周期、其余列表 / Credits / 后台 / source-control / 真实 IPC / Pi 43 轮历史 | `/tmp/scry-motion-06-{type,build,ui-full}.log` |
| 独立实际 App | 当前生产构建的 `node scripts/electron-security-smoke.mjs --dev-structure-only --foreground` 通过深浅主题、pane、Skills / MCP / LLM、原生 fixture Provider 发送、草稿保留；新增断言主内容与右侧 canonical slot 的 computed background 均不透明 | `/tmp/scry-motion-06-app-foreground-diagnostic.log`；独立 userData / workspace，非日常实例 |
| 完整安装 | `npm run install:mac:dev` exit 0，305 文件 / 3735 unit 通过、4 个既有条件检查跳过；所有默认 type / shell / build / CLI / 签名 / packaged resource 和 external-links / crash / 完整 security / files / desktop-remote-host gate 执行并通过，最后安装 | `/tmp/scry-motion-06-install.log`、`/tmp/scry-motion-06-install-load.log` |

- 原生 12 组实际合成的最低正文对比度：深色 **8.7838:1**、浅色 **5.7110:1**，均 ≥4.5。dim2 最低深色 **5.4223:1**、浅色 **3.4597:1**，不低于同场景原不透明基线；失焦深色 dim2 为 5.4717:1。原时间小字使用 dim3，最低深色 3.2338:1、浅色 2.1982:1，同样不降低现状，但不声称它们本来就达到正文 AA。
- 用户明确批准本次独立可见 test / 焦点 / 采集；三个背景是测试自建窗口，不改桌面壁纸。公共照片来自 NASA `https://images-assets.nasa.gov/image/carina_nebula/carina_nebula~medium.jpg`，仅下载到 `/tmp`。ScreenCaptureKit 只选两个自建窗口、裁剪测试窗口区域，PNG / JSON 只留本机临时目录；不上传、不提交截图或个人数据。Swift helper 是手动 macOS 14+ 验收工具，不进入 App 产物，也没有新增依赖。
- helper 使用非激活的持久进程；每次采集前后确认 native focus，隐藏字色采真实背景，再恢复原不透明底采 baseline。遮字只影响测量截图、不改几何 / 颜色 token。截图前 invalidate + 实际 compositor paint，避免把上一帧文字错作背景；必须收齐 12 组和最终完成标记，不能以单独 exit 0 冒充完成。原生焦点切换只在自建窗口之间发生。实际抽看最终深色照片聚焦、浅色白底失焦两张整窗图，不宣称逐张审阅全部测量图。
- 系统开关最初结构化 defaults 写入因系统权限被拒绝，回读仍关闭；未 sudo 或绕过权限。按用户另行批准，通过系统设置原生可访问性控件开启 / 关闭。两次动作回执均 unknown，分别用 AppKit / defaults 实际状态确认执行，不重复派发。原先键不存在，系统现在持久化 0；有效状态恢复关闭，不声称偏好文件逐字节未变。

#### 首轮失败与测量边界

- 原生测试原型先后遇到 Swift buffer 排他访问编译失败、Electron builtin require 用错路径、AppKit 未初始化、每次新起采集进程干扰焦点、失焦 rAF 被节流、JSON point 合同不匹配。分别修正工具自身的 buffer、builtin import、非激活 AppKit / 持久 server、仅 fixture 的 backgroundThrottling、明确坐标数据。一次 require 错误导致 180s 工具超时：检查原日志与同范围进程确认收敛后才修工具，不当作 App 冒烟成功。
- 早期 window-all-closed 自动退出曾只产生部分结果却 exit 0，已明确拒绝这种输出并加完整矩阵标记。一次遮字截图仍含旧帧文字，算出约 1:1：读图确认采样帧错误后加真实 paint fence，没有放宽对比度。原始日志 `/tmp/scry-motion-06-native-{first,server,complete,painted,composite}.log` 等保留，只有完整最终矩阵作为验收证据。
- `.72` 起步在清除遮挡后真实对比度不合格；浅色 `.99` 也低于原 dim2 / 时间小字基线，按规格提高不透明度。`.999` 虽能过对比度，却被 Chromium 量化为不透明 computed rgb，新 hidden CSS 断言正确拒绝它，因此最终用 `.996`，未削弱「实际半透明」断言。日志 `/tmp/scry-motion-06-native-{clear-probe,opacity}.log`、`/tmp/scry-motion-06-material-css-diagnostic.log`。
- 一次手动 fixture 把 main wrapper 写成不存在的 `#list-body`，在矩阵前失败；读真实 fixture 后改为 `#list-main` 加生产 main-area 类，最终 12 组通过，未改生产 DOM。实际 App 前台专项首次停在 skills modal 的动画结束等待；增加只在失败时输出动画状态的诊断，不改条件 / timeout，再次完整通过，但未复现、根因未确认，不将后一次通过抹掉首次失败（`/tmp/scry-motion-06-app.log`）。modal close 本次仍为 242.1–243.2ms fallback / `nativeAnimationEnd:false`，不据此声称 CSS animationend。
- 非 macOS 只通过 helper 单测和隔离 CSS 平台分支检查，未运行真实 Windows / Linux App；未验证多显示器 / 120Hz、真实付费 Provider、实际远端手机和屏幕阅读器。可见原生测量仅这台 macOS 的受控背景；高不透明度换取不降对比度，材质视觉很轻。这些限制不以静态 screenshot 或计数伪装成全平台证据。

#### 性能、安装与交付

- 在本次最终生产源码执行 `npm run performance:measure -- --compare c8049f86 --out /tmp/scry-motion-06-counters`，全部 collector 完成、ratchet 通过。43 项均 measured；42 项与本轮基线完全相同，唯一变化 files.fixed-operations/io.read.bytes 1227418→1227438（+20，约 0.0016%），两组 5 次运行范围重叠（baseline 1227394–1227418，candidate 1227394–1227438），调用次数不变。这不是必要新增 I/O；聚合数据无法精确归因这 20 字节，不宣称已证明无回归或更快，若需归因应另做逐路径诊断，不改本次 frozen collector。
- ratchet 中四个 `worse` 相对更早台账而非本次基线：files 的 read 336→417、readdir 18→20、read.bytes 1183197→1227438，persistence.archive/ipc.bytes 10536→10558。对应本次 c8049f86 / candidate 的 read 均 417、readdir 均 20、archive ipc.bytes 均 10558；read.bytes 的 +20 见上项。前三条计数路径及 archive 实现未改，不将既有台账偏差归于本步，也不把 ratchet 通过写成没有 worse。三条 CPU instructions 为 unavailable / missing，不记 0；未改 collector、workload、ratchet 或预算。报告 `/tmp/scry-motion-06-counters/measure.json`。低负载 17 场景毫秒对比及旧 archive byte ceiling 唯一失败已在 wrap 记录，本步不以 L1 宣称 L2 / L3 变快。
- 完整安装对应 `047acbfb`，2026-10-24 **00:33:43→00:41:07 PDT**，10 核 load 6.27 / 7.73 / 8.77→7.98 / 8.52 / 8.84，Node 22.22.1，exit 0。App 0.2.219、私有 CLI 0.2.51；安装到 `/Applications/Scry.app`，备份 `/Applications/.Scry.app.backup`。安装与 dist 的 app.asar SHA-256 均为 `8acfbe0bd6098d5e9d5c801d41b3ed1163dbffa0db7076773c509ca8a692137f`。4 个既有条件跳过为性能相关性与三个真实探针；签名成功，开发流程未配置 notarize，未把开发安装称为正式公证发布。
- 本次 wrap 与 06 的大小 hook 命令级豁免已有用户明确批准，正常提交流程先验证其仍因缺失脚本 MODULE_NOT_FOUND 阻挡；仅使用命令级路径豁免，不改共享配置，不跳过任何运行 / 测试 / 安全 / 安装门禁。用户日常实例未停止或重启，已安装不等于其已加载新版本，需用户自行重启。日志 / 测量 / 截图只留本机临时目录；自建窗口与 helper 已随测试退出，基线临时 worktree 已正常移除。
- 本记录提交并仅推送 `design/native-motion` 后停下，交由设计方核验 wrap 与 06，不进入其他步骤；不将已有 archive byte 门限失败、首轮未复现的 modal 等待或未验证范围隐去。需要继续处理这些诊断项时，由维护者另行确定范围。

### wrap 与 06 · 核验（2026-10-24，设计方）

结论：**wrap 通过；06 满足全部验收条款，但实际效果几乎不可见，是否保留交用户决定**。核验方式：读完 `c8049f8..3002351` 全部实现 diff 与记录。核验环境连不上 npm 源，测试、原生测量与安装依据执行方记录。

**wrap 通过**
- 保留旧转录期间 `onTurnRef` 置为 undefined，React 会用旧回调登记 null 退休引用，就绪后重新登记。共享 runId 的 fork 用例与负对照都有效。
- 低负载复测（load 6–7，`highLoad:false`）17 项毫秒门限全部通过，此前在高负载下超限的三项回落，印证当时是负载噪声。唯一失败仍是 main 上已有的 `persistence.archive` 字节上限，与本分支无关。

**06：实现正确，但效果不值得它带来的改动**
- 实现本身没有问题：仅 macOS 生效；启动帧保持不透明，renderer 就绪后才让窗口背景透明；「降低透明度」回退到原不透明底；主内容与右面板保持不透明。原生 12 组对比度测量和 followWindow 负对照都扎实。
- 问题出在规格本身的约束：要求 `--dim2` 文字对比度不低于现状。执行方实测 0.72 起步不达标，最终只能用深色 98%、浅色 99.6% 的不透明度。深色下材质只让底色在 RGB 22–23 之间变化，浅色基本看不出来。
- 为这个几乎看不见的效果，窗口根背景改成了透明，主进程多了一段背景色生命周期。今后任何新增区域如果没有写不透明背景，都会透出材质，属于长期维护成本。
- 设计方建议：**本次不合入 06**，回退 `fe1e60ca` 与 `047acbfb` 两个 06 提交（wrap 及 01–05 的全部成果保留），06 标为「已评估，暂不采用」。如果用户想要看得见的材质，需要另行放宽对比度约束（例如次要文字只要求 ≥ 3:1），那是一次视觉取舍，应单独评估。

### 2026-10-24 · 用户决定：回退 06，只合入动效（设计方登记）

- 用户选择「回退 06，只合入动效」。执行方用 `git revert`（不改写历史、不 force push）回退 `fe1e60ca` 与 `047acbfb`，以 `motion(06-revert)` 提交；`progress.md` 与 06 的记录保留，作为「已评估，暂不采用」的依据。`DESIGN.md` 中新增的材质段落随回退移除。
- 回退后跑 `npm run typecheck`、`npm run build`、`npm run test:renderer:ui`，再跑完整 `npm run install:mac:dev`，按协议记录、推送后停下。设计方核验后开 PR 合入 main。

### 06-revert · 按用户决定仅保留动效（2026-10-24，待核验）

- 开始前从 `30023519` fast-forward 到 `235d1b09`，完整读取末尾「用户决定：回退 06，只合入动效」。严格使用 `git revert --no-commit` 生成反向改动，再分别提交：`978e128e` 撤销 `047acbfb` 的材质断言 / 原生采集；`41612756` 撤销 `fe1e60ca` 的生产实现 / DESIGN 段落。两个提交均以 `motion(06-revert)` 开头，body 保留完整原提交哈希；没有 amend、reset、改写历史或 force push。
- 回退范围：删除仅服务于 06 的 Swift / 可见材质 fixture 与 material campaign，恢复原窗口 chrome 单测和结构 App 检查；移除 vibrancy / followWindow、renderer-ready 清窗口背景生命周期、macOS 透明 root / body / sidebar CSS 及新增 DESIGN 材质说明。01–05 与 wrap 的源码、测试和旧转录引用修复全部保留。
- 独立内容核对：`git diff --exit-code adc84e63 HEAD -- . ':!designs/scry-native-motion/progress.md'` 为 0，即除记录外，所有 tracked 文件逐字节等于 06 前的 wrap 状态；`git diff --exit-code 235d1b09 HEAD -- designs/scry-native-motion/progress.md` 在追加本节之前也为 0，原 06 的实现、测量、核验与用户决定完整保留。不是用新 CSS 覆盖或在症状处掩盖材质。

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck` | Node 22.22.1，node / web 均通过 | `/tmp/scry-motion-06-revert-type.log` |
| `npm run build` | main / preload / renderer 构建通过 | `/tmp/scry-motion-06-revert-build.log` |
| `npm run test:renderer:ui` | 最终完整套件通过，含 01–05、wrap refs、加载失败重试、Credits / 后台 / source-control、真实 IPC、Pi 43 轮历史；只随指定提交移除 06 专用检查，不改保留路径断言 | `/tmp/scry-motion-06-revert-ui-final.log` |
| 实际 App 深浅主题重放 | `node scripts/electron-security-smoke.mjs --dev-structure-only` 通过，含 pane、弹窗、原生 fixture Provider 发送、草稿保留；使用隔离 userData / 临时 workspace，不操作日常实例 | `/tmp/scry-motion-06-revert-app.log`，截图目录 `scry-structure-app-zqc0nv`（系统 temp）；抽看 light-chat / dark-settings 两张，不宣称审阅全部截图 |
| 热路径 L1 | 因回退涉及 index.ts，补跑 `npm run performance:measure -- --compare 235d1b09 --out /tmp/scry-motion-06-revert-counters`，全部 collector 完成，ratchet 通过 | `/tmp/scry-motion-06-revert-counters/measure.json` |
| 完整安装 | `npm run install:mac:dev` exit 0；305 文件 / 3734 unit 通过、4 个既有条件检查跳过。typecheck、shell、App / CLI build、签名、packaged resource / size 及 external-links / crash / 完整 security / files / desktop-remote-host 默认门禁全部执行并通过，随后安装 | `/tmp/scry-motion-06-revert-install.log`、`/tmp/scry-motion-06-revert-install-load.log` |

- 首轮失败保留：第一次完整 UI 在既有远程输入历史用例的 `typing still opens command completion` 等待超时，DOM 仍为回忆的 slash prompt，没有菜单。检查 fixture / ChatView 历史与输入调用链后，未修改任何代码，执行 `node scripts/desktop-remote-ui-smoke.mjs --composer-history-only` 通过，再完整 UI 通过。日志 `/tmp/scry-motion-06-revert-ui.log`、`/tmp/scry-motion-06-revert-composer-focused.log`；根因未确认、不声称已修复，也不以复跑通过抹去首败。未加 sleep / retry 分支、扩大 timeout、删断言或顺手改 01–05。
- L1 对比 43 项均 measured：42 项不变，仅 files.fixed-operations/io.read.bytes 1227428→1227427（-1，运行范围重叠），不据此宣称性能提高。ratchet 相对更早台账的四个 worse 仍为 files read 336→417、readdir 18→20、read.bytes 1183197→1227427、archive ipc.bytes 10536→10558；本次 235d1b09 基线同样为 read 417 / readdir 20 / archive 10558，bytes 仅上述轮内差异，不是回退新增工作。三项 CPU instructions 为 unavailable / missing，不记 0。未修改 collector / workload / ratchet / 预算；未另跑毫秒 bench，不对 L2 / L3 作结论。
- 安装对应 `41612756`，2026-10-24 **01:11:25→01:18:17 PDT**，10 核 load 7.15 / 6.94 / 6.96→8.10 / 7.45 / 7.14，Node 22.22.1 / Electron 42.10.1。App 0.2.219、私有 CLI 0.2.51；已安装 `/Applications/Scry.app`，备份 `/Applications/.Scry.app.backup`；安装与 dist 的 app.asar SHA-256 均为 `a06feff4e3d44353902596626c46add1c3bac51368b4543d23917cf357750629`。3734 比 06 少 1 个仅为透明背景时序新增的 unit，随指定 `047acbfb` 一并 revert；4 跳过仍为性能相关性及三个真实探针，不是本次跳过新失败。
- 共享 pre-commit 的正常运行仍因本分支缺 `scripts/check-staged-file-size.mjs` 报 MODULE_NOT_FOUND。用户针对本轮另行明确选择「本轮也豁免大小 hook」，仅命令级豁免，不改共享配置；没有跳过测试、安全、构建或安装门禁。
- 与要求无额外偏差：本次未重新开启 06、未更改系统透明度设置、未运行付费 Provider 或真实手机操作。真实 Windows / Linux、120Hz、屏幕阅读器及日常运行实例未验收；modal close 仍为 242.0–243.9ms fallback / nativeAnimationEnd false，不冒充 CSS animationend 证据。旧 06 记录中的材质验收是历史评估，不代表本次安装仍含材质。
- 用户日常实例未停止或重启，需自行重启才加载已安装的回退版。截图 / 测量 / 日志只留本机临时目录，不提交个人数据；测量临时 worktree 由原流程正常清理。仅推送 `design/native-motion` 后停下等待设计方核验，不开 PR、不合入 main；首轮未稳定复现的输入测试问题如需继续排查，由维护者另行确定范围。

### 06-revert · 核验与合入方案（2026-10-24，设计方）

- 06-revert 通过：除记录文件外，代码树与 wrap 完成时（`adc84e6`）完全一致。
- **不能直接开 PR**：main 已于 2026-10-23 整体重写历史（本分支起点 `531e88c` 在 main 上对应 `b8730b6d`，内容相同但哈希不同），两者没有共同祖先；main 之后又有 94 个提交，包括把 `ChatView.tsx` 拆进 `components/chat-view/`；main 新增 20,000 字节单文件提交上限；`designs/` 已被 main 的 `.gitignore` 排除。
- **用户决定（2026-10-24）**：本次合入跳过大小检查。

#### 移植要求（执行方）

1. 从最新 `origin/main` 新建分支 `motion/native-motion-main`。不要改写 `design/native-motion`，它保留为规格与记录的归档。
2. 要移植的内容是 `git diff 531e88c caef2d2 -- . ':!designs'`（01–05、各 fix、wrap；06 已回退，净差为零）。可用 `git diff … | git apply -3` 起步，冲突按 main 当前结构落到对应位置（例如 ChatView 的逻辑可能已在 `chat-view/transcript.tsx`、`ComposerQueue.tsx` 等文件）。行为与断言以本分支为准，不顺带改动 main 的重构。
3. 不提交任何 `designs/` 文件。代码注释里如引用了 `designs/scry-native-motion/…` 路径，改为不依赖该路径的说明。
4. 按步骤分成若干提交（`motion: 01 基础`、`motion: 02 结构过渡` … `motion: wrap`，或合并为更少但边界清楚的提交），提交说明写明来源步骤。
5. 大小检查：用户只批准本次合入跳过，仅用命令级方式跳过该 hook，不改 `.githooks` 或检查脚本。新增的动效代码尽量放在新的小文件里（如 `motion.css`、各 hook），不顺带拆分旧的大文件。新文件本身应 ≤ 20,000 字节；`scripts/lists-ui-checks.mjs` 等超限的新测试文件按职责拆分。
6. 验证：`npm run typecheck`、`npm run test:unit`、`npm run build`、`npm run test:renderer:ui`（含 `--lists-only`、`--overlays-only`、`--loading-only`、`--turn-refs-only`、`--sidebar-activity-only` 等本系列专项）、`node scripts/electron-security-smoke.mjs --dev`，最后完整 `npm run install:mac:dev`。`performance:measure` 对 `origin/main` 做 L1 对比，每个 worse 说明原因。
7. 只推送 `motion/native-motion-main`，不开 PR、不合入 main、不 force push。把移植记录（冲突点及处理、验证结果）追加到本文件（在 `design/native-motion` 分支上），然后停下等待核验；设计方核验后开 PR。

### 01–05 与 wrap · 新 main 基线移植（2026-10-24，待核验）

- 代码分支：从当时最新且交付前再次 fetch 确认未变的 `origin/main`（`ba1a20c5bdc632e3fb782d1fb7aa9269ec084634`）新建 `motion/native-motion-main`。按指定的 `git diff 531e88c caef2d2 -- . ':!designs'` 移植净改动，未将两套历史合并，未移入已回退的 06 材质。
- 提交：`8a2bdb47` **motion: 01–05 与 wrap 运行时代码移植**（50 文件）；`ba9c9a1a` **motion: 01–05 与 wrap 原生断言移植**（44 文件）。提交说明列明来源步骤，按共享运行时 / 断言两条清楚边界合并，避免拆出中途不自洽的 presence / loading 调用链。代码已仅推送到 `motion/native-motion-main`，本机与远端均为 `ba9c9a1afdeae32b337b777d8f16d66105decc78`；未开 PR、未合入 main、未 force push。本记录仅提交在归档 `design/native-motion`。

#### 冲突与适配

- 三方应用后四处冲突：`package.json` 保留 main 所有新增门禁，再接入本系列专项；`desktop-remote-ui-smoke.mjs` 合并 structure 开关而不丢失 main 新场景参数；`RemotePairing.tsx` 同时保留 main 的 visibility polling 和 modal close 路由；`ChatView.tsx` 保留 main 拆分后的结构，手动落入当前模块，不恢复旧大组件。
- 下列源码路径均指代码分支：`ChatView.tsx` 只承载延迟加载、旧真实 DOM 的装饰保留及 live owner 识别；`chat-view/transcript.tsx` 仅补入场 props，保留 main 的共享 observer、虚拟高度锚定、选中保留和 memoized ref callback；队列 FLIP 落在 `chat-view/ComposerQueue.tsx`。保留的旧转录仍只限跨 scope、无当前 cache 的读取期，当帧 inert / aria-hidden / 不登记 onTurnRef，未把旧展示恢复为当前会话 authority。
- main 的 provider 分组 / 搜索模型选择器、provider+model 选中键、新 turn navigation 与远端完成后 durable queue 对账次序均保留；相关 main-only 源文件未回退。`RemoteChat` 只增加页面装饰过渡。主进程、共享数据 / IPC 合同、权限和 Provider 调用未改。
- 超限的新列表检查按 structure 与其余 campaign 职责拆为 `lists-structure-ui-checks.mjs` / `lists-ui-checks.mjs`，由现有 launcher 序列化传入同一隐藏 fixture。32 个新文件全部 ≤20,000 bytes，最大 16,541 bytes；没有为大小规则拆分 main 的既有大文件。代码分支不含任何 `designs/` 变更，也没有依赖本归档路径的源码注释。
- 大小 hook 仅按本次用户批准，通过每条提交命令的 `git -c core.hooksPath=/dev/null commit …` 豁免；共享配置、`.githooks` 与检查脚本未改。其余测试、安全、打包和安装门禁全部照常执行。

#### 验证

环境：Node 22.22.1、Electron 42.10.1，App 0.2.221 / 私有 CLI 0.2.51。独立临时 workspace / HOME / userData 与 fixture Provider，不写用户真实会话、不启动真实付费 Provider、不停止用户日常实例。

| 项目 | 实际执行与结果 | 证据 |
| --- | --- | --- |
| 类型 / unit / build | `npm run typecheck`、`npm run test:unit`、`npm run build` 通过；319 文件 / 3871 测试通过，4 个既有条件检查跳过（性能相关性及三个真实探针）；安装内再次通过相同全量检查 | `/tmp/scry-motion-port-{type-final,unit,build}.log`、`/tmp/scry-motion-port-install.log` |
| 原生专项 | `node scripts/session-capability-ui-smoke.mjs` 分别运行 `--turn-refs-only`、`--sidebar-activity-only`、`--overlays-only`、`--lists-only`、`--loading-only`、`--structure-only` 全通过；活动原有 123 预算、其余列表 40 预算、45 行保留 / 50 历史工具、深浅主题、短 / 长折叠、标签与真实新增 / 缓存 / 加载 / 切换边界均保留 | `/tmp/scry-motion-port-{turn-refs,sidebar-activity,overlays}-first.log`、`/tmp/scry-motion-port-{lists,loading,structure}-second.log` |
| wrap 负对照 | 临时恢复旧 `onTurnRef={onTurnRef}`，新原生断言明确失败：`retained transcript remained registered for turn navigation`；恢复移植实现后相同检查通过 | `/tmp/scry-motion-port-refs-{negative,restored}.log` |
| 完整 renderer UI | `npm run test:renderer:ui` 最终全套通过；含上述系列专项、main 新模型搜索 / turn navigation / unknown receipt 正负例、Credits、后台、source-control、真实 IPC 与 Pi 55 轮历史；默认 capability 完整路径亦单独通过 | `/tmp/scry-motion-port-ui-fourth.log`、`/tmp/scry-motion-port-capability-final.log` |
| 完整 dev 安全测试 | `npm run build:cli` 后 `node scripts/electron-security-smoke.mjs --dev` 通过；115 preload API、终端录制捕获 / 回放 / 只读 / noSpawn / 删除及 session / reload / window 安全链路均执行 | `/tmp/scry-motion-port-build-cli.log`、`/tmp/scry-motion-port-security-dev.log` |
| 独立实际 App | 当前构建的 `node scripts/electron-security-smoke.mjs --dev-structure-only` 通过深浅主题、pane / modal、草稿焦点和原生 fixture 发送；只抽看当前 light-chat / dark-settings 两张截图，不声称逐张审阅所有截图 | `/tmp/scry-motion-port-structure-app.log`；截图仅留本机临时目录 |

- loading 专项实际观测 151.2ms onset，保留 60ms 无闪烁、400ms 慢读、四种真实 useIntegrations 失败后重试与减弱动效静态条。actual App modal 关闭仍是 242.2–244.1ms fallback / `nativeAnimationEnd: false`，不冒称 CSS animationend；原生 overlay 专项本轮记录 11 次 animationend、1 次 fallback，入场结束释放 transform 的断言通过。

#### 首轮失败与修正

- 列表检查职责拆分后首跑漏传 `contents`，得到 ReferenceError；补齐同一已有 context 参数，再跑通过，没有改断言或 watchdog。
- 完整 UI 首轮远端 opening 期望 `Alpha Default`，而 main 新合同显示 `claude / Alpha Default`。在未改源码 / 未改断言的独立 `ba1a20c5` worktree 复现同一失败；依据 main 的 qualified copy，将八处模型标题期望改为完整 provider-qualified 字符串，仍校验 provider+model 绑定，不改成宽泛 includes。第三轮暴露漏改的两处 Remembered，再补齐。证据 `/tmp/scry-motion-port-ui-first.log`、`/tmp/scry-motion-port-main-opening-control.log`、`/tmp/scry-motion-port-ui-third.log`。
- 第二轮旧默认模型用例仍要求隐藏 scrollbar / 聚焦当前项，与 main 新 thin scrollbar / 搜索输入焦点合同冲突；沿用 main 专用模型原生门禁的语义修订该旧用例，保留 search、逐项键盘选择与重复打开定位断言。其 wait helper 原只观测 DOM mutation，不能看到纯 focus 改变，补 `focusin` 监听及清理，原 5000ms deadline 不变。随后原生 SelectAll 仅获 dispatch 时就输入，留下已有草稿；补等待真实 selectionStart / selectionEnd 再插入，草稿隔离断言保留。日志 `/tmp/scry-motion-port-{ui-second,capability-model-adapted,capability-model-focus}.log`；最终默认 capability 正例通过。
- 一次远端 focused 测试触发既有 55000ms watchdog、无结果；先检查原进程已退出及 fixture 进度，再临时加只读 checkpoint 定位，完整诊断旅程通过（含准备 58.3s）。已移除诊断输出；最终全 UI 在原 watchdog 下通过。首次超时根因未确认，不把后续通过当成它从未发生；没有扩大 deadline、加 sleep 或自动重试分支。日志 `/tmp/scry-motion-port-{remote-model-final,remote-checkpoints,ui-fourth}.log`。
- 暂存分组脚本曾首败并产生未发布的混合提交；只软回退该自有未发布节点、保留全部文件后重分为上述两个提交，没有改写归档、main 或任何已发布历史，也没有丢用户改动。

#### L1 对比与每项 worse

- `npm run performance:measure -- --compare origin/main --out /tmp/scry-motion-port-counters` → 通过，固定基线 `ba1a20c5`；candidate 报告为提交前 `ba1a20c5-dirty`，生产源码即上述运行时提交，后续只适配测试。43 项均 measured，42 项与 main 完全相同；history 10020 bytes / 1 message / 1 stringify、trace 165996 bytes / 2 messages 均不变。
- 对 main 唯一增加为 `files.fixed-operations / io.read.bytes`：1227421→1227446（+25B，约 0.002%）。原 main 五次读量 1227421 / 1227405 / 1227395 / 1227399 / 1227415，candidate 为 1227446 / 1227438 / 1227426 / 1227424 / 1227426；相关生产 I/O 函数与 collector 完全未改，调用次数一致。补充一个只留临时诊断、原样保留 workload 的六测试正例：五次总读量 1227413 / 1227407 / 1227450 / 1227412 / 1227420，减去索引 `mtimeMs` / `ctimeMs` / `ino` 数字序列化长度后，五次余量均为 1216660B。变化可由 fixture 真实文件元数据的可变数字长度解释，不是新增读取；未把非零差异抹成零。日志 `/tmp/scry-motion-port-bytes-diagnostic.log`，临时诊断文件已删除，既有 collector / workload 未修改。
- ratchet 的四个旧 ledger worse 逐项核对：`io.read` 336→417（main 已是 417）；`io.readdir` 18→20（main 已是 20）；`io.read.bytes` 1183197→1227446（main 已是 1227421，另 +25B 见上）；`persistence.archive / ipc.bytes` 10536→10558（main 已是 10558）。两项调用计数和归档 payload 没有本次新增工作，读取字节微差有上述诊断；ratchet 仍通过，没有放宽预算。证据 `/tmp/scry-motion-port-counters/measure.json`、`/tmp/scry-motion-port-counters.log`。不把 L1 计数或该非耗时诊断当作 L2 / L3 更快结论。

#### 安装与交付边界

- 最终 `npm run install:mac:dev` 在 `ba9c9a1a` 完整执行，**exit 0**，2026-10-24 02:48:24→02:56:41 PDT，10 核 load 13.38 / 23.39 / 28.11→17.26 / 16.05 / 21.76。typecheck、3871 unit（4 条件跳过）、shell、App / CLI 构建、签名、打包资源与体积检查、external links、crash recovery、完整 packaged security / files / 默认 desktop remote host gates 全通过，再完成安装；没有绕过任何 gate。日志 `/tmp/scry-motion-port-install{,-load}.log`。
- 安装目标 `/Applications/Scry.app`（App 0.2.221 / 私有 CLI 0.2.51），备份 `/Applications/.Scry.app.backup`。安装与 dist 的 `app.asar` SHA-256 均为 `82e92e3831b111b6ee2999005d02ba655886ff21547cc8f58fdb917bd0b83df3`。用户日常实例未停止 / 重启；需要用户自行重启才加载新安装版本，不能把安装成功当作当前运行实例已更新。
- `git diff --check` 通过；新增文件大小独立检查全过；源码 / 原生 fixture / 日志使用临时目录，不提交截图或个人数据。基线对照 worktree 与临时诊断已清理；本记录单独在归档分支提交，代码工作区保持新分支已验证的干净版本。
- 未验证真实付费 Provider、真机手机 / 真实远程网络、120Hz、真实屏幕阅读器、低负载 L2 与发布后 L3；默认 files smoke 中未启用的可选外部文件动作不作为已执行场景。停下等待设计方核验移植，不开 PR、不合入 main、不进入新步骤。

### 移植 · 核验（2026-10-24，设计方）

结论：**通过，可开 PR**。核验方式：对 `origin/main`（`ba1a20c5`）与 `motion/native-motion-main`（`ba9c9a1a`）做逐文件对照。
- 设计分支改动的 91 个文件中，main 未改动的 72 个与本分支 `caef2d2` 逐字节一致；`lists-ui-checks.mjs` 按职责拆为两份。
- 双方都改动的 19 个文件，用 `git merge-file`（基线 `531e88c`）重放后与移植版对照：14 个完全一致；`package.json`、`RemotePairing.tsx`、`desktop-remote-ui-smoke.mjs` 的冲突解决保留了 main 的新增内容；`ChatView.tsx` 的逻辑按 main 的拆分落在 `ChatView.tsx` / `chat-view/transcript.tsx` / `chat-view/ComposerQueue.tsx`，`liveRunId` 的推导与 main `Composer.tsx` 中的 `inFlightTurn` 等价。
- 测试侧另修了 main 自身已失败的模型标签与搜索焦点断言（执行方在未改动的 `ba1a20c5` 上复现了失败）。这部分超出动效范围，PR 说明中单列。
- 无 `designs/` 文件，新文件均 ≤ 20,000 字节，大小 hook 仅以命令级方式跳过。

<!--
### NN · <步骤名>

- 提交：`abc1234` motion(NN): …；`def5678` motion(NN): 测量 / fixture …
- 改动摘要：（按文件或主题列出，说明为什么）
- 验收：
  - [x] <验收条目>：`<实际命令>` → <结果；数字注明机器负载>
  - [ ] <未通过或未执行的条目>：<原因>
- 首轮失败：（第一次运行就失败、后来修好的检查，写明原因与修法）
- 与规格的偏差：（无 / 具体说明）
- 未验证：（例如 120Hz 屏、某个 Provider、某个弹窗）
- 安装：`npm run install:mac:dev` 结果；用户当前运行的实例需重启才会加载新版本

#### 核验（设计方填写）

- 结论：通过 / 需修改
- 依据：
- 需修改：
-->
