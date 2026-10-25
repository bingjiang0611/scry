# Workspace / session / turn diff 与首次发送工作区：实现验收

日期：2026-10-24。实现分支：`feat/workspace-diff-worktree`，基于 `4b3483fd2135eff7478628663baf16cc4821d733`。工作树：`scry-workspace-diff`。未修改原 `scry` 检出的其他任务。本文记录本地证据，不代表完整 UI 门禁全绿、真实付费 Provider 验收、公证发布或已经安装。

## 实现范围

| 范围 | 实现与证据 |
|---|---|
| 入口拆分 | main/preload、App、integrations、agent-session、runtime、recorder Git、Source Control 按已有职责拆分。所有本次完整文件 ≤20,000 UTF-8 字节。保留动态 window、startup recovery、session identity、React refs/effect 清理与请求代际。新拆分模块的超长依赖行已展开，并比较编译后 JS AST；检查同时有空白变化正对照和值变化负对照。 |
| A：三个 diff 范围 | 工作区比较 HEAD→一次捕获的不可变 tree；不再拼接两次读取的统计与正文。会话使用 baseline→最新净变化；单轮使用 before→after。零、失败、不可用不跨范围回退。历史有归档正文就显示归档正文，不拿当前文件补历史。 |
| A：界面 | 保留 shell/composer。小摘要按需打开可关闭 inspector。范围标签、轮次选择、来源时间、刷新、文件/代码虚拟列表、键盘导航、主题及窄屏替换布局；窄屏对话 inert，关闭恢复焦点。 |
| B：选择器 | 本地与已缓存 remote refs、真实 worktree 清单、搜索、分页、占用/锁定/失效状态。composer 下方细条的左右入口分别向上展开轻量菜单；点选即保存，不使用模态表单或应用按钮。已有 worktree 分支只读。新分支自动命名 `scry/<短 UUID>`，新建选项 tooltip 说明不复制未提交文件。最近成功准备并登记的 worktree 根据同 commonDir 的已有操作账本置顶，不用文件 mtime 猜测。 |
| B：草稿 | 复用现有有界草稿存储，按 cwd/provider/profile/session 隔离；选择不改 Git。损坏选择保留文本但阻止发送。发送按钮明确切换、创建或复用；准备期间保留真实输入并禁止重复发送。ACK 只消费匹配操作及已提交输入，保留期间新输入和其他草稿。 |
| C：真实首次发送 | 保留 legacy `App → useAgentSession.send → agent:start`。复用 SourceControlService commonDir 队列和 journal，保留预约直到授权、trust、baseline 收敛及同步 runs.register。登记前不启动 Provider，不制造 renderer 串行 IPC 的空窗。 |
| C：目标与权限 | 宿主控制新路径 `userData/worktrees/<repo-id>/<operation-id>`；原生 ref 校验；已检出分支复用对应 worktree。切脏分支拒绝；目标 tree 的 filter/submodule、native checkout hooks 先检查。实际 cwd/commonDir/HEAD/分支再读回，经原项目 authority 和既有 trust/fingerprint 链绑定。 |
| C：故障与恢复 | `planned → git_requested → prepared → start_requested → registered`，请求哈希和命令收据约束重放。未知 Git/启动结果只读核查，不自动重试。已建 worktree 不因 Provider 失败被删除。晚到 ACK 按精确 run catalog alias 恢复，不能抓同目录最新会话。 |
| D：验收 | 真实临时 Git、生产 trusted IPC wrapper、隔离完整 Electron App、canonical recorder records、负向控制、全量 unit/shell、CLI、打包和性能计数。Provider 为已有离线 smoke adapter，不是付费真实服务。 |

没有引入 fetch、stash/reset、任意目标路径、worktree 初始化脚本、自动清理、自动提交/推送或第二套锁。Scry 仍不是安全沙箱。项目 authority 沿用目录选择器的现有同步持久化入口；没有另建异步 writer 来冒险丢失授权。该必要工作包含在外层 `workspace.prepare` / `ipc.agent:start` 中，不能只用内层 `agent.start` 声称首次发送更快。

## 有界实现

- 工作区统计沿用 1,000 文件、16 MiB 未跟踪内容、默认 5 秒限制。无 HEAD / 非 Git 仍能正常聊天，diff 不可用。
- 工作区 inspector 的 patch 读取总预算为 256 KiB。超预算正文明确 unavailable/truncated，完整统计不伪装成截断正文的行数；没有弱化 recorder 默认正文策略。超大正文需求应升级为按文件、同 snapshot 分页，不能直接抬升全量 IPC。
- refs/worktrees 清单上限 1,000，单页 100，响应超过 256 KiB 明确拒绝并提示缩小搜索。分支搜索先在 Git 中筛选，能找到第一批 1,000 以外的匹配项。worktree 总量超限不假装没有占用关系。
- 最近排序只使用 Scry 已成功登记的准备记录；没有记录的目录保持 Git 清单顺序，不宣称完整跨工具使用历史。
- 文件与代码 DOM 虚拟化。真实 App 的 1,000 文件 / 2,000 行检查证明文件节点 <80、代码节点 <100，且能用原生键盘到最后文件/行，不是只截掉后面的数据。

## Diff 下拉与逐轮选择的增量验证

- 沿用右侧既有 Diff 标签及面板控制；内部改成单行范围工具栏。下拉包含未提交改动、最新一轮、轮次子菜单，以及保留的本会话净差异。子菜单展示轮次序号和提示词摘要，支持键盘导航、Escape 返回、窗口内定位和虚拟滚动。
- 删除仅列最近 100 轮的静默限制。所有已加载轮次均可选择；原生会话复用已有历史分页入口，序号包含 archive offset。统一对话仍通过对话里的“更早记录”分页，菜单展示当前已加载页，不假装已加载全部历史。未采集或未保留的 patch 仍显示不可用，绝不从当前工作区补历史。
- `npm run typecheck` 和 `npm run test:unit -- src/renderer/hooks/useDiffInspector.test.tsx src/renderer/hooks/useAgentSession.test.ts`：通过，2 文件、44 测试。新增检查覆盖 150 轮及分页序号、旧轮切回最新空轮、缺失轮次不借用其他证据。恢复旧的 `slice(-100)` 后，150 轮检查按预期失败；恢复修复后通过。负向控制使用 `-t`，未修改或新增 skip。
- `npm run test:workspace:ui`：构建及隔离完整 App 通过；原生输入切换两轮及最新一轮，真实临时 Git 的旧文件在改写后仍显示原 patch，两个轮次的文件集合互不混用。深浅主题、窄屏、子菜单边界、键盘及已有 workspace/session/turn 场景通过。证据：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-workspace-session-ui-VrxWue/`，包含 `diff-scope-menu-dark.png`、`diff-turn-menu-dark.png`、`diff-first-turn.png`。
- `npm run performance:measure -- --scenario source-control.diff --out /tmp/scry-diff-turn-menu-performance`：两项计数各 5 次、均为 8，ratchet 通过；不据此宣称菜单毫秒提速。不新增 fetch、Provider 探针或安装动作。

## T3 风格简化后的增量验证（`45b1fcc5`）

用户查看 test 实例后要求 UI 与提供的 T3 Code 截图对齐。保留两端入口，删除大表单、手填新分支名、应用按钮、常驻准备说明及正常选择时的核查按钮。异常恢复仍可核查，权限、首次发送、持久化及 Git 行为不变。远端仍是已获取的 ref，不新增自动 fetch 开关。

- `npm run typecheck`：通过。
- `npm run test:unit -- src/renderer/workspace-drafts.test.ts src/renderer/hooks/useDiffInspector.test.tsx src/renderer/hooks/useAgentSession.test.ts src/renderer/components/WorkspacePicker.test.tsx`：4 文件、54 测试通过。新增 SSR 检查只证明正常选择不展示表单、核查失败仍可恢复；不把 SSR 当作真实交互证据。
- 当前代码构建后，`node scripts/electron-security-smoke.mjs --dev-unified-conversation-only --workspace-start`：完整工作区/发送/diff 场景通过；新加真实窗口的菜单开关、外部点击、Escape/焦点、Enter 提交、100 项虚拟列表末项导航、自动命名、深浅主题及 960px 宽度检查。证据：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-workspace-session-ui-c4vABH/`。
- 新增主题重载检查首轮失败：重载过渡期 `document.documentElement` 尚不存在，测试直接访问 `.dataset`。改为等待文档存在后检查原条件，未增加超时、跳过断言或重试写入；随后上述完整场景通过。首轮证据：`scry-workspace-session-ui-v0VMD1`。新增 SSR 的段落断言曾把 SVG `<path>` 误判成 `<p>`，改为精确标签边界；不是删去无说明文案的要求。负向控制：暂时仅在返回 operation 时显示恢复入口，核查失败测试按预期失败；恢复修复后通过。
- `npm run performance:measure -- --scenario source-control.diff --out /tmp/scry-compact-workspace-performance`：两项计数各 5 次，Git/总子进程均 8，ratchet 通过。只是既有 Git 计数门禁，不宣称菜单 L2/L3 更快。
- 用户已明确保留 `/Applications/Scry.app` 0.2.223；此次仅构建当前源码供独立 test 实例，不覆盖安装。下节全量/打包结果属于之前交付，不冒充此次重跑。

## 首次功能交付验证（`81ddc4b2` 及之前）

环境：macOS arm64，Node 24.18.0，Electron 42.10.1，App 包版本 0.2.222，私有 CLI 0.2.51。所有自动化使用隔离 userData / 临时工作区。

| 命令/检查 | 结果 | 本机证据 |
|---|---|---|
| `npm run typecheck && npm test` | 326 文件、3,889 测试通过；4 项既有 opt-in 跳过；shell 通过 | `/tmp/scry-workspace-final-unit.swbdbQ` |
| `npm run test:workspace:ui` | 原生坐标输入；当前目录切分支、新 worktree、复用已有 worktree、后续轮 cwd/native resume、晚 ACK、Provider 失败保留目录、草稿刷新恢复、过期选择拒绝、范围/零/不可用、虚拟滚动、深浅主题和窄屏通过 | `/tmp/scry-workspace-final-delivery.pUBxOk`；`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-workspace-session-ui-EihOwI/` |
| `npm run test:conversation:ipc` | 生产 ownership 拒绝/正对照及 unified conversation 多轮、重启通过 | 同一 delivery 日志；`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-unified-rendering-FnCEVT/` |
| `npm run check:cli-release` | 627 测试、NodeNext 类型/构建、CLI package smoke 通过 | `/tmp/scry-workspace-cli-release-fixed.SW6UnY` |
| `npm run pack:artifact` | 构建、开发签名、产物检查和 packaged 安全/终端/记录/远程宿主 smoke 通过；未公证 | `/tmp/scry-workspace-final-delivery.pUBxOk`；当次包 298,680,908 字节，低于 346,030,080 上限 |
| 额外 focused Electron | selection 10 场景、models、terminals、cache、performance、Pi permission fresh/saved 通过；partial bridge 使用显式 unavailable，不是假空 Git | `session-capability-ui-smoke.mjs` 对应 `--selection-only/--models-only/--terminals-only/--cache-only/--performance-only/--pi-permission-only` |
| `npm run performance:measure -- --out …` | 43 观测，每项 5 次；ratchet 通过，未放宽账本/门限 | `/tmp/scry-workspace-performance-final.jmUQ5u/measure.json` |

最后一次完整新功能 UI 检查有 5 次显式离线 Provider 调用；保存 4 份后续验收用 canonical records（另核对当前目录首次记录）。每次 send 都断言恰好新增一次调用。压力、重载和选择操作不启动 Provider。Provider 失败记录为 `failed`，新目录与分支仍存在。测试结束收敛自己的 App，不重启用户正在用的实例。

4 项跳过为 `performance-correlation`、`billing-admin-real`、`p0-integration`、`p1-integration`，没有为本任务新增 skip。真实账号、费用、Linux/Node 多版本矩阵和长期使用 L3 不由这些本机测试证明。

### 负向控制

- 临时取消 commonDir 活动预约检查，并发登记测试如预期失败；恢复后正例通过：`/tmp/scry-workspace-gate-negative.QuykaJ`。
- 临时把 unavailable 当成 available，零值 UI 测试如预期失败；恢复后通过：`/tmp/scry-diff-evidence-negative.EcOJr1`。
- 工作区 snapshot 测试在捕获后改文件，仍要求统计和 patch 对应原不可变 tree，同时核对真实 index 字节/mtime 与对象库未被改写。

## 不能写成“全绿”的结果

`npm run test:renderer:ui` 完整复合入口仍失败。没有修改这些断言、skip 或超时来变绿。其余 20 个命令曾逐项执行：18 通过、2 失败，加上入口首个失败共 3 个，涉及两类原有问题：

1. remote model 文案期待 `Alpha Default` / `Alpha Remembered`，现有 UI 为 `claude / …`。在独立归档的原始 `4b3483fd` 上分别复现。日志：`/tmp/scry-baseline-remote-opening.dPdRZQ`、`/tmp/scry-baseline-remote-default.EisqLH`。原脚本与基线逐字相同。
2. session-capability 期待隐藏 model scrollbar，但现有 CSS 是 thin；同一基线也失败。证据：`/tmp/scry-renderer-baseline.zQjil3/core-check.log`。

逐项结果：`/tmp/scry-workspace-ui-gates-I18qyk/state.json` 及编号日志；首个复合入口日志 `/tmp/scry-workspace-renderer-gate.g6zAdH`。这些是需要另行处理的既有门禁问题，不代表新的工作区流程失败，也不允许宣称完整 UI gate 通过。

保留的首次失败与修复：
- App SSR 曾因新 hook 依赖浏览器 window / 缺少 server snapshot 失败；已补 SSR 合同，全量 3,889 测试通过。CLI 曾因 NodeNext import 扩展名失败，修复后完整 CLI gate 通过。
- 真实 App 捕获 Provider 结束早于 ACK 的空白历史问题；修为精确 catalog alias，保留暂停 renderer 的反例场景。
- 一个 focused 并发 Git 测试在负载 14.47（10 核）时超时：`/tmp/scry-workspace-contract-final.LJUt3s`。未增加超时或删断言；后续原配置完整 `npm test` 通过，不能抹掉首轮失败。
- 新的 DOM 检查放在 Debugger.pause 后导致两次测试运输停滞；改为暂停前同步读取真实 draft，再暂停等待 canonical record。两次隔离 App 已无存活进程，临时现场保留 `scry-electron-smoke-MTxMw8` / `scry-electron-smoke-t8UOa6`。这是测试编排错误，不是未知业务写入的重试依据。
- 增加一个显式 Provider 失败场景后，原压力测试总调用预期 4 已不适用；改为 5，保留每次恰好一次的断言。首轮日志 `/tmp/scry-workspace-final-ui.zFIQv8`；后续整条 delivery 通过。

## 性能解释

最终计数为 33 unchanged、4 better、4 worse、2 pass、3 missing。missing 是 macOS 不可用的 CPU instruction 指标，不记 0。最终运行负载 4.44→5.94 / 10 核；这些是 L1 工作量计数，仍不等于新功能 L2 或日常 L3 更快。

4 个 worse 与较老账本比较出现：read 417（账本 336）、readdir 20（18）、read bytes 最大 1,227,445（1,183,197）、archive IPC 10,558（10,536）。同 collector 对精确基线 `4b3483fd` 的比较已证明 read/readdir/archive 值相同；bytes 样本区间重叠，不能据最大值的个位字节差异作速度结论。

基线比较证据：`/tmp/scry-workspace-performance-base.Z8IQXv/measure.json`、`/tmp/scry-workspace-performance-archive.ufscmV/measure.json`。没有通过缩小 workload、换计数入口、升门限或挪走工作来制造改善。新建 worktree 的必要 Git/authority/trust/baseline 工作没有被承诺“免费”。

## 交付边界

提交仅在独立分支，不推送、不合入原检出。最终提交哈希与最后一次产物核验见交付消息。安装前发现 `/Applications/Scry.app` 已为 0.2.223，高于此分支 0.2.222；不能静默覆盖用户的新版本。是否替换需用户明确选择；打包成功不等于安装或用户当前进程已更新。临时证据位于本机 `/tmp`，不上传会话内容。
