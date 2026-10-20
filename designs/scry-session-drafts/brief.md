# Scry · 会话草稿标记

## D-20261019-scry-session-drafts

- 状态：用户明确选择 A，随后要求本地重试安装。A 已实现并安装为 **0.2.209**，本地与远程隔离 Electron 交互回归通过；真实日常 App 交互仍待用户手动打开后验收。安装身份与完整证据见下方续装记录。
- 用户要求：「当对话框中有输入的时候 切换会话可以显示下有草稿吗 先出设计稿」。2026-10-19 当前会话，附桌面端原始截图。
- 目标仓库与实际 cwd：`/Users/baobingjiang/IdeaProjects/vibecoding/scry`。开始时已有大量远程、iOS、composer 相关 WIP；本次不修改、提交或安装这些改动。
- 产物：[交互设计稿](index.html)，预览 `http://127.0.0.1:8956/`。本机 HTTP 服务只暴露此目录。无外部依赖、网络 API、真实 Provider 或真实草稿读取。文本仅存在本页内存中，刷新重置。

### 保留与行为

保留项目分组、Provider 图标、会话标题、选中态、时间、未读点及运行状态。不加退出确认、弹窗、常驻解释或新的草稿管理入口。

拟定规则（待设计确认，不代表已接入生产）：

1. 有非空白输入即显示「草稿」，当前会话与切走后的会话一致。
2. 点回会话继续编辑，不自动发送，不因切换清空。
3. 清空输入后标记消失；生产实现只能在发送成功并且该草稿确已消费后移除，发送失败必须保留。
4. 草稿与运行中、未读、待回答是独立信息，不能相互替代。不改变会话按活动时间的原有排序。
5. 接入时同样考虑只有附件的草稿；使用已有 store 与会话身份，不新建第二套存储。原型仅演示文本，不验证附件、远程身份、持久化或真实发送。

### 两种局部方向

| 方向 | 结构 | 取舍 |
| --- | --- | --- |
| A（推荐） | `Provider · 草稿 · 标题 … 时间 · 运行状态`；草稿为低饱和暖色文字，无底框 | 时间与运行状态区保持原结构；有草稿时标题起点后移 |
| B | `Provider · 标题 … 草稿标签 · 时间 · 运行状态` | 标题起点一致；标签和时间、运行状态挤在同一区域，长标题可用空间更少 |

「草稿」是文字，不靠颜色单独表达状态；不使用红色告警或绿色成功语义。300px 侧栏，标题允许省略，标记本身不截断。原型提供相同示例内容下的 A/B 与深浅色切换。

### 调研与复用映射

| 来源 / 区域 | 实际观察 | 采用 / 不采用 → 本次检查 |
| --- | --- | --- |
| 用户提供的原始截图 / 左栏会话与 composer | 标题右侧已经有相对时间与运行图标；有输入时无草稿标记 | 保留原有信息，只在会话行增加局部标记；检查长标题及运行中叠加。截图属于本次已查看的外部原始参考，不上传其内容 |
| `src/renderer/components/Sidebar.tsx:635–680` | Provider、标题、metadata 与运行状态分区渲染 | A 把标记放在标题一侧；不把草稿塞进 runtime 生命周期 |
| `src/renderer/composer-drafts.ts:55–100` | 已有 input + attachments 草稿结构、同步 store 及订阅 | 后续复用现有状态；本次不改正在并行变化的 store |
| `src/renderer/codex-alignment.css:1–78` | 现有深浅色 token、蓝色选择态、灰阶层级 | 原型沿用现有表面和选中态，不新造主题；草稿色为本次未索引的局部设计判断，待确认 |
| 库 `D-20261018-scry-sidebar-activity` / 原 brief 开头 | 已确认的侧栏工作方向强调保留状态区与现有外层入口 | 不重做导航，不把草稿变成新的动态分类 |
| 库检索 `Scry sidebar` / `draft` / component:`sidebar` / page:`Scry` | 项目记录可用；没有匹配的可复用侧栏组件；部分历史来源 stale | 复用项目结构与 token，不导入无关个人组件。不是“已抽取生产组件” |

额外尝试读取 Slack 官方 Send and read messages 页面，但返回内容没有可用草稿说明；不把它当作成功调研证据。本任务以用户提供的原始截图作为相关外部原始来源。

Craft：应用 [Hover 克制](https://craft.gustavofior.com/hover-restraint)、[等宽数字](https://craft.gustavofior.com/tabular-numbers)、[HTML 根背景](https://craft.gustavofior.com/html-background)。改动前无草稿识别；改动后局部文本标记即时变化，时间等宽，根背景随主题切换。未引入 hover 动画、噪点或新装饰。

### 实际验证

通过 Chrome Relay 查看真实 HTML 渲染，不以源码代替截图。当前版本交互采用原型内存数据，不代表真实 App 验收。

| 检查 | 结果 / 证据 |
| --- | --- |
| A/B 局部布局 | 已查看两种布局截图；A 标记、时间、运行图标均可见，长标题省略；B 的右侧标签更拥挤 |
| 会话切走与切回 | issue → project → issue 后原输入仍在；原型截图与输入替换前的 valueLength=19 一致 |
| 空白输入 | 替换为三个空格后该行「草稿」消失，模拟发送 disabled；其他会话草稿仍在 |
| 有效输入 | 替换为「先给我一份修复方案。」后标记恢复、模拟发送可用 |
| 模拟发送 | 旧稿与最终稿均演示了输入被消费、对应行标记消失、按钮禁用；最终稿同时不显示旧示例用量 |
| 最终稿 / 主题 | 深浅色截图已查看；最终深色为 1512×708 CSS viewport。截图 `pi1_browser_artifact_423e66cd-8c94-40f6-92c8-9cecffcc5a61`，SHA-256 `87966c4febf1be85ba5bda9719380a995833b5a5e40eab4defbe9f4b22b2ad2b` |
| 静态检查 | `node --check designs/scry-session-drafts/prototype.js`、`node --check designs/scry-session-drafts/copy.js`、`git diff --check` 通过 |

减法：删除无操作的侧栏快捷键装饰；不增加草稿数量、提示气泡、额外列表或 composer 状态条。渲染自审发现文案集中化后的 Provider 标签误用了图标字体，已把 CSS 限定至图标并重新查看最终截图。行的辅助名称含「有草稿」，按钮保留键盘 focus-visible；完整键盘路径和屏幕阅读器未验收。局部新增状态，不是整体重设计，未另做独立 critic。

### A 方案实施记录（2026-10-19）

- 新增 `SessionDraftIndicator`，直接订阅已有 `ComposerDraftStore` 的布尔 presence：非空白文本或附件即有草稿。标记在 Provider 图标之后、标题之前；时间、运行中、待回答、未读和排序语义不变。
- 覆盖本地、置顶、动态、逻辑 conversation 与远程会话。沿用现有 Provider/profile/cwd/native-session 和 remote host 键，不建第二套草稿存储，不读取正文作列表摘要，不增加 IPC 或自动发送。
- 实现 worktree：`/tmp/scry-session-draft-indicators`，基线 `67f03e7`；不混入主工作区的远程/iOS 等 WIP。
- 回归对照：新 `SidebarDrafts.test.tsx` 在旧实现上 5 项失败、2 项通过；实现后 7 项全通过。与 composer/remote 单测合跑 32 项通过；`npm run typecheck`、`npm run build` 通过。
- 原生输入验证：`session-capability-ui-smoke.mjs --selection-only` 10 个场景通过，新增切走保留、清空移除、空白不标、元数据位置与输入焦点断言；`desktop-remote-ui-smoke.mjs --composer-history-only` 通过，新增远程切换及草稿归属断言。未调用真实 Provider。
- 性能：`performance:measure -- --compare 67f03e7` 既有工作量计数一致、ratchet 通过，无 worse；机器负载 14.45→15.64（10 核，highLoad），不宣称毫秒改善。该计数集不直接覆盖侧栏逐键开销；本次不修改 collector、workload 或门限。
- 安装预检时，日常 `/Applications/Scry.app` 为 0.2.208，不能用主分支 0.2.204 的隔离代码直接覆盖。已找到 `~/.local/state/scry-catalog-current-8GWCgkE7/source` 的同版快照：1221 项 manifest 的可执行源码无漂移（只有性能机会文档变化和单独的 skill symlink），13 个已编译 out 文件与当前安装 ASAR 内容逐字节一致。当前安装 ASAR SHA-256 为 `568cd059efcb467f1829d188cb9a7a72f9155a40cead7917c43eac92f6c8c3cf`；旧安装记录的不同 ASAR hash 不冒充本次实测值。
- 主分支功能提交 `8826602`，测试 fixture 修正 `962acc5`。通过重建前后文件内容核对，原主工作区 WIP 保留；主分支最终 typecheck 通过。主工作区受影响单测为 33 项通过（含原有并行附件 helper 测试），隔离实现基线为 32 项通过。

### 首次安装候选与阻碍（历史，已由下方续装替代）

候选在原 0.2.208 已装快照上仅叠加本次 9 个源码/测试文件与 App 版本变更，升级为 0.2.209；没有把主分支的其他 WIP 顺带打包。CLI 保持 0.2.49。交付 worktree 已从 `/tmp/scry-drafts-install` 移至 `~/.local/state/scry-draft-delivery-20261019/source`，交付分支提交为 `e34016b` / `9971768`；其中原已装版本的未提交快照按原样保留，不纳入任务提交。

| 当前候选检查 | 实际结果 |
| --- | --- |
| typecheck / unit / shell | 通过；3482 unit 通过、4 个既有 opt-in 跳过；Node 24.18.0，macOS arm64 |
| App/CLI build、原生依赖重建、开发签名 | 通过；未公证 |
| `codesign --verify --deep --strict` | 当前包通过磁盘签名校验 |
| packaged check | 未通过：内置 CLI `--version` 被 SIGKILL；系统日志报告 provenance sandbox 错误。不能宣称包可运行 |
| 当前候选源上的两项 focused Electron UI | 本地 10 场景、远程 composer history 均通过；通过 `ELECTRON_OVERRIDE_DIST_PATH` 使用现有同版本 Electron 42.10.1 运行，不把它冒充新包 runtime 验证 |
| 其余 packaged/security smoke、安装、日常 App 验收 | 未到达；没有绕过门禁，没有自动启动/停止/重启用户 App |

首次失败保留：①候选基线的远程行新增 `canDelete/needsUpgrade`，新测试 fixture 起初未提供；补全 fixture，断言未削弱。②共享 `node_modules` symlink 使 electron-builder 漏收传递依赖；只移除本任务 symlink，以不变 lockfile 执行 `npm ci` 后重建，原缺依赖问题消失。③新包 CLI 被系统杀死；检查签名及针对性系统日志，并把任务 worktree 移至用户状态目录后仍 SIGKILL，因此停止安装，不关闭系统安全机制、不跳过校验。依赖安装另报告 22 项既有审计告警（含 3 critical），没有升级依赖或执行 audit fix。

验收末尾再次检查，外部安装已变化为 **0.2.206** / ASAR `cc514d0aa0b94be8435a000115ed11c3611876948e36f48612c48e4eebd3574e`；5 个已装 renderer JS/CSS 资产均没有 `sb-draft`。本任务没有运行安装器、没有覆盖该安装。故原 0.2.208 基线候选除运行门禁失败外，也已不适合直接安装：必须重新匹配最新已装快照，不能拿旧候选覆盖并行交付。

证据保留于 `~/.local/state/scry-draft-delivery-20261019/evidence/`：`delivery-status.json`、1223 项 `source-manifest.json`、首次失败和最终 unit/pack/UI/performance 日志、`system-policy.log`。候选 ASAR SHA-256 `72553fe075881a18a07f95e42bcb38d79c03009caf32843f0bb3df3f0a311c1e`，标记为 **不得直接安装**，不是已验收产物。

首次受阻后询问是否沿用 mac2；用户明确回答「重试安装」。实际随后在本机完成续装，没有传输源码或使用 mac2。

### 本地续装成功（当前交付）

- 新冻结 worktree：`~/.local/state/scry-draft-delivery-20261019/source-retry`，交付提交 **`e3ee731`**。主分支功能/fixture 提交仍为 `8826602` / `962acc5`；不提交或推送原有无关 WIP。
- 先按已安装 0.2.206 的 `source-snapshot.json` 恢复 `67f03e7 + source.patch`（SHA-256 `1a767b1560da69805474f2c4b62903193b4b0533bf30226264676a818b3f43d8`），补齐快照的 11 个未跟踪文件，重建后 **13 个编译文件与已安装 ASAR 逐字节一致**，才叠加本次改动。不是从旧 0.2.208 候选直接覆盖。
- 仅改变本次 9 个实现/测试文件与 App package/lockfile 版本。最终冻结 1228 项源文件，差异清单与 hash 在 `retry-final-source-manifest.json`。CLI 保持 0.2.49。
- 用户要求重试时，原候选 CLI 的只读版本检查已经恢复可运行；SIGKILL 根因仍 unknown。本次在全新 worktree/dist 生成完整包，并通过全部原门禁，未修改系统安全策略、签名要求、测试断言、重试次数或超时。

| 当前 0.2.209 检查 | 结果 / 证据 |
| --- | --- |
| `npm run pack` | 通过：typecheck、3476 unit 通过 / 4 项既有 opt-in 跳过、shell、App/CLI build、原生 rebuild、packaged check 与全部 `smoke:electron`；Node 24.18.0，macOS arm64 |
| packaged check | 311 个运行时依赖、资源/体积、CJS preload、node-pty、私有 CLI 与版本均通过；开发签名，未公证 |
| 本次原生 UI 回归 | 新冻结源上的 `--selection-only` 10 场景与远程 `--composer-history-only` 全通过；使用该 worktree 的正常 Electron，不再使用 runtime override |
| 安装前检查 | 已装仍为 0.2.206 / ASAR `cc514d0a…`，随后才执行原 `node scripts/install-macos.mjs`；未跳过 `install:mac:dev` 的 pack 与安装校验链 |
| 安装后身份 | `/Applications/Scry.app` 为 **0.2.209**，私有 CLI **0.2.49**；ASAR SHA-256 **`535a825f7c1260b8b2d7d518d246008d9db43a5ef1e97b259f4093d38d470ee3`** |
| 同一产物证明 | 安装包与已装 bundle **338 个文件/链接完全一致**，差异 0；已装 deep/strict codesign 校验通过，已装 renderer JS 与 CSS 均含草稿实现 |
| 启动与真实使用 | 没有自动启动、停止或重启 App；安装前后匹配的用户 App 进程均为空。用户手动打开后仍需重放真实输入/切换；受控 fixture 不替代真实 Provider 验收 |

成功安装时间：`2026-10-20T02:29:26.394Z`。证据位于同一 `evidence/`：`retry-baseline-comparison.json`、`retry-baseline-source-manifest.json`、`retry-final-source-manifest.json`、`retry-pack.log`、`retry-selection-ui.log`、`retry-remote-ui.log`、`retry-install-preflight.json`、`retry-install.log`、`retry-installed-verification.json`。`delivery-status.json` 指向当前成功交付；首次受阻记录另存为 `delivery-status-initial-blocked.json`，原 0.2.208 候选仍标记不得安装。安装器保留旧版于 `/Applications/.Scry.app.backup`。

下一步由用户手动打开 Scry，输入内容后切换会话，再点回确认草稿标记与内容；无需发送消息。若实际体验不符，由助手基于新版本继续定位，不能用上述构建或 fixture 结果代替反馈。

### 设计阶段交付边界（历史）

- 待用户选择 A 或 B，再接入真实 store 与侧栏。批准本稿不代表真实 App 验收。
- 附件草稿、远程/本地会话身份隔离、发送失败保留、重启恢复、待回答与草稿共存须在接入阶段补 focused 回归并于当前版本真实 App 重放。
- 本轮仅设计，不构建、安装、重启或发送到 Provider；不把并行 WIP 打包交付。
- 无新增跨项目视觉偏好；A 方向已被用户明确选择，不代表当前真实 App 交互已验收。
- 共享检索回执：已 register 为 `D-20261019-scry-session-drafts`，`search 'Scry 会话草稿'` 首条命中本文件。`build` exit 0（53 条）；`check` exit 1，因为原有 5 个失效来源：`P-PI-MODEL-SELECTOR`、`D-20260912-scry-ios-remote`、`D-20261008-scry-ios-continuity`、`P-SCRY-SESSION-HISTORY`、`D-20261010-scry-llm-sidebar`。本次条目可读且可检索，不宣称全库健康；日志在 `/tmp/scry-session-drafts-library-{build,check}.log`。
