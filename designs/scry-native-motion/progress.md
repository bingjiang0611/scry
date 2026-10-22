# 进度与核验

执行方每完成一步，在「记录」末尾按模板追加一节；设计方核验后在同一步下追加「核验」。不要删除或改写已有记录。

## 当前状态

| 步骤 | 状态 | 最近提交 |
| --- | --- | --- |
| 01 基础 | 待核验 | `cf5642b`（实现）；验收记录见本提交 |
| 02 结构过渡 | 未开始 | — |
| 03 弹窗与浮层 | 未开始 | — |
| 04 列表 | 未开始 | — |
| 05 加载防闪 | 未开始 | — |
| 06 侧栏材质（可选） | 需用户确认 | — |

状态取值：待开始 / 进行中 / 待核验 / 需修改 / 通过。

## 问题

（执行方发现规格有误、做不到或需要用户决定的事项写在这里，并停下等待回复。）

- 01 安装受阻：`npm run install:mac:dev` 已执行。完整测试、shell、构建及打包完成后，`check:packaged-app` 执行产物的 `Contents/Resources/bin/scry --version` 收到 `SIGKILL`；单独读版本再次复现（退出 137）。`codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Scry.app` 通过，但不能据此认定产物可运行。未绕过校验，未安装到 `/Applications/Scry.app`，未停止用户实例。签名/系统终止的根因未确定；由维护者决定是否另开打包排查，恢复后需重新走完整安装流程。本步实现与下列验收已提交待设计方核验；不进入 02。

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
