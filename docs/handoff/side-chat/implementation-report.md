# 侧边会话实现与验收报告

状态：进行中，尚未达到交付条件。本文件由主 agent 维护，最后以实际检查结果更新，不把设计稿或子 agent 的自述当作验收证据。

## 已确认合同

- Claude / Codex / Qoder / OpenCode / Pi；完整 Agent、共享工作区、不同会话可并行。
- 只读来源已完成消息建立冻结快照；不接管、不迁移、不停止正在运行的主会话。
- 每个主会话关联多个持久侧聊；独立消息、草稿、发送、审批和停止；关闭页签不停止或删除。
- 入口位于 Surface 选择器与现有 `+` 菜单，保留原六个工具；依照当前设计稿实现。
- 不伪造上下文完整性、并发文件独占归因或 Provider 能力；权限/trust gate/renderer 隔离不放宽。

## 执行方式与决策

主 agent 负责规划、决策、集成与最终验收；实现子任务指定 `qoder/dfmodel`。同一工作区保持单 writer，不并行改同一棵源码；只读检索可以并行。

按依赖顺序推进：

| 阶段 | 责任 | 状态 / 完成条件 |
| --- | --- | --- |
| 代码核对与拆分 | Qoder scout + 主 agent | 已定位关键链路；scout 达到 22 轮预算后返回定向结果，主 agent 已复核快照/发送/ownership 决策所依赖代码 |
| 来源快照 / 持久化 / IPC | Qoder worker，主 agent 审核 | 首版完成，主 agent 验证核心 95 tests 通过；独立 Qoder 审核发现原生正文来源、创建预算、默认目标与分页缺口，继续修正，尚未验收 |
| Provider / 并行运行 | Qoder worker，主 agent 决策 | 五 Provider 输入路径、异步身份、双向并行 admission 与重叠证据已实现并经过聚焦验证；仍需分清 Qoder 输入已接收与运行失败的独立语义 |
| Surface / 双会话 UI | Qoder worker，主 agent 视觉验收 | 独立实时流与提交确认已实现；页签、独立控制器、草稿/未知状态恢复及真实双视图重放待完成 |
| 集成验证 / 交付 | Qoder worker + 主 agent | 待开始；本地合同/安全/UI/性能检查，独立 App test 实例与正式安装流程 |

### 关键实现决策

1. 冻结快照使用子对话自有的内容存储与 manifest，不伪造 trace archive / 执行轮次，也不借用父 nativeSessionId 作为子 binding。
2. 将快照的不可变消息引用纳入 continuation 缺失历史规划、首次输入、覆盖回执和受限 reader；子对话自身 `turns` 只记录它真正执行的轮次。禁止「创建成功但首轮没带快照」。
3. 主聊来源适配只读稳定前缀；已有 adoption 写权限保护保持不变。并行需同时修正 managed admission 和 legacy 写入口的 cwd 级互斥，不能只解锁一个方向。
4. 旧源码因文件大小门禁需改动时，先做职责明确的抽取，保留旧合同测试；不通过给对象 monkey patch、伪造 Provider receipt 或绕过 hook 来省事。
5. Qoder / OpenCode 以原生用户消息 UUID / messageID 与精确正文校验输入回执；不把传输返回成功当作输入已被确认。暂不声称这两个 Provider 有受限历史 reader，无法完整内联时在创建前拒绝并允许用户缩小范围。
6. Codex / OpenCode 仍用现有 session-scoped interrupt，禁止为停止单侧聊杀共享 transport。scout 提出的 Codex reader 共享风险只在复用同一 reader 连接时成立；生产发送每次创建随机 token/snapshotId，当前没有必要为假想状态重构 Codex adapter。

## 环境与前置检查

- 工作区：`scry/88d17fe3`；实现开始时 Git 工作区干净，设计稿提交 `06a69a74`。
- Node：使用本机 Node 22.22.1 执行项目检查；不改全局 Node 配置。
- 修改源码前：`npm run typecheck` 通过；5 个核心 focused 测试文件共 72 tests 通过（conversation service/store/history/handoff、context admission）。
- `npm ci` 成功，664 个包安装完成。npm 报告锁定依赖现有 18 个漏洞（5 moderate / 10 high / 3 critical）；不在本任务中擅自升级依赖或运行 `audit fix`。
- 仓库 hook 对完整暂存文件实行 20,000 bytes 上限。已有部分核心文件超过上限；如需修改，将按职责抽取并验证，不绕过 hook 或任意切行。

## 授权与验证边界

- 子 agent 的 Qoder / dfmodel 调用是本次用户明确指定的执行方式。
- 五个真实 Provider 的账号/费用探针没有得到单独授权；默认使用隔离的本地 transport/进程 fixture 验证真实代码路径，不假称真实线上探针通过。
- 不干扰用户当前 App。App 行为验证使用独立 userData 和临时 workspace；完成对应检查后按仓库流程构建安装。
- 仓库约定默认仅提交本次改动，不 push。最终报告分别列出 commit、安装、待重启与未验证项。

## 证据与最终结果

### 阶段 A 首版（尚未最终验收）

- 实现子 agent：`qoder/dfmodel`，run `fb1ff9d8-ad30-4e04-a284-2b58e6fd0143`；进程结束已确认。完成子对话自有快照、幂等本地创建、历史覆盖/首次发送、三个 typed IPC，以及按职责拆分旧大文件。
- 主 agent 独立检查：`npm run typecheck` 通过；8 个 focused 文件共 95 tests 通过；`git diff --check` 通过。子 agent 另报告 181 个相关 tests、149 个 Provider tests 与 build 通过，未把这些自述直接当最终验收。
- `npm run test:conversation:ipc` 的 build 与 ownership IPC 通过，unified IPC 首次失败在 stats `unavailable !== ready`。定位为本工作区 `better-sqlite3` 是 Node ABI 127，Electron 需要 ABI 146，并非忽略失败后重跑。
- 已通过 Electron 安装脚本补齐二进制，并用仓库现有 `@electron/rebuild --only better-sqlite3` 重建。Electron 内存 SQLite 读写探测通过；再次执行 `node scripts/electron-security-smoke.mjs --dev-unified-conversation-only` 通过（21 次隔离 fixture 调用、2 次重启）。这些是既有 Conversation 流程，不代表新侧聊 UI 已验收。
- 独立 Qoder 审核 run `aa83baa6-ccc4-4e21-8970-67239904a9d2` 找到应修复的合同缺口：原生来源只读了 Scry archive、缺少 profile/cwd catalog 校验、预览无法缩小范围、创建前 handoff 预算未核对、目标模型/effort 未持久化、Steer 消息未投影、40 条历史不可翻页。主 agent 接受有证据的问题，将逐一修复，不降级设计合同。

### 阶段 A 修正与 B1 Provider 接入

- A 修正子 agent `50b8fe2a-d8f3-4b24-90e8-05b0699e661b` 已结束。新增原生 Claude/Pi 文件读取与 catalog 校验、缩小边界预览、创建前预算、持久初始目标、accepted steer、真正分页、仅在确定未发布时清理快照。子 agent 报告最终 27 files / 201 tests 通过。
- B1 子 agent `239bda2e-99a2-46ea-965e-7be572290865` 已结束。Qoder / OpenCode adapter 按职责拆分，新增历史输入、原生输入回执与 continuation identity，发送目标扩为五 Provider。子 agent 报告 44 files / 690 tests 通过；首轮 Provider 全量有 11 个 Pi 超时失败，之后两轮无代码变化通过，保留为负载相关待最终串行验证项，不用重跑掩盖。
- 主 agent 在 A 修正 + B1 当前代码上独立运行 `npm run typecheck`、11 个 focused 文件（80 tests）、`git diff --check`，均通过。
- 主 agent 后续审查仍发现需修正点：原生文件来源把「有助手正文」误当已完成，应依赖明确终止证据并排除运行中尾部；原生读取应落实来源字节上限；新增 Provider 身份计算使用同步文件 I/O，不符合 main 热路径约束；OpenCode 有界消息页若已找到精确 parentID/正文，足以证明该条输入，不能因页面有界一概记 unknown。下一轮修正后继续集成，尚未宣称功能完成。

### A3 / B1 审查修正

- 修正子 agent `e3ea0a22-50bc-41bd-9975-9dfcce78c765` 因 turn budget 在 177 turns 后被终止；进程终止已确认，本工作区没有遗留 Vitest/tsc。没有把此任务记为子 agent 成功完成，也没有重复执行未知写入。
- 主 agent 检查已落盘改动：原生终止证据与有界读取、异步身份计算/有界指纹缓存、OpenCode 有界页中的正向输入证据、禁止以侧聊创建原生 fork 均已加入。为满足 20 KB 门禁拆分了 normalize 与 Pi native parser。
- 主 agent 在该确切工作区版本上运行 `npm run typecheck`（node+web）及 17 个相关测试文件，**203 tests 全通过**；`git diff --check` 通过。覆盖原生完成/不完整尾部、源身份与字节上限、历史解析、快照/幂等/预算/分页、两个新 Provider 回执、禁止嵌套 fork。当前证据仍不包含真实 Provider 或新侧聊 UI。

### B2 并行运行与证据

- 实现 worker `1c482abe-34f6-42ee-8466-5f2fa84e9670` 已结束，进程与登记资源关闭已确认。前向/反向工作区围栏已改为同一会话身份冲突；新增共享工作区重叠证据与原生别名嵌套保护。
- 主 agent 独立运行 node+web typecheck、8 files / **44 tests**、`git diff --check`，全部通过。子 agent 另报告真实隐藏 App 的 `test:conversation:ipc` 通过（22 次隔离 fixture 调用）；恢复旧围栏后新增并行 smoke 失败，恢复修复后通过。它不是五个真实账号探针。
- 旧 adoption **来源**仍限 Claude/Codex/Pi；通用发送**目标**支持五 Provider。主 agent 决定保留两条不同合同：拒绝 Qoder/OpenCode adoption 来源；被配置禁用的 Qoder 目标诚实报告 disabled。旧 smoke 改用真正不支持的目标验证拒绝，并额外验证禁用目标、来源字节不变与零 Provider 调用。
- 全量 Vitest 首轮另有两项失败：未改动的 `source-control/workspace-choices.test.ts` 在并行负载下 5000 ms 超时（独立 6/6 通过，不抹去首轮失败）；设计稿的 `prototype.test.mjs` 使用 Node test runner，却被 Vitest 默认发现为无套件。后者由本次设计文件引入，必须修正发现路径并继续保留其 Node 检查，不称作无关失败。**已在 C1a 修复**：文件改名为 `prototype.check.mjs`，Vitest 不再发现它，`node --test docs/handoff/side-chat/prototype.check.mjs` 在 Node 22.22.1 与 24 上均 12/12 通过。
- 主 agent 的独立时钟探测找到了重叠证据的边界缺口：仍开放的兄弟窗口会因一次中间采集被误排除；跨已淘汰记录的 session 窗口未降级；按 cwd 保留的完成窗口缺总量上限。继续修正后再验收，不把现有测试全绿当作这些场景已正确。

### C1a 独立实时流与重叠修正

- Qoder worker `37bb25fa-6d07-4c11-8764-5dac303d25c7` 实现最多两个可见 run 的独立有界流、独立审批/停止通知、trusted IPC/preload、按帧更新与提交 ACK，移除 ConversationView 每秒读取全部 activeRuns 的轮询。订阅不改变主会话焦点，未订阅的侧聊仍正常运行和归档。
- 主 agent 发现首版仍有真实竞态：重同步在响应返回前就清除降级、同一已包含 delta 可被追加两次（`AB` 变 `ABB`）、订阅响应前的审批/停止/终态会丢失，以及文案文件超过 20 KB。原子 agent 恢复为 `52556710-715b-4349-ab2e-50970d2d7ef2` 后修正；新增负向检查先分别失败，再通过。
- 修正后使用 generation + snapshot token 划定快照边界，只在对应 React 提交后确认；旧 generation、不明响应、未提交快照不清除降级。首次订阅统一按顺序保存 trace/审批/停止/终态。缺少 bridge 时报告 unavailable，而非健康静止界面。文案移入独立 `constants/conversation-copy.ts`。
- 主 agent 独立运行 `npm run typecheck`、9 files / **142 tests** 和 `git diff --check`，全部通过。另以独立时钟探测确认开放兄弟窗口、淘汰历史后的 partial 覆盖、500 个 cwd 的有界保留均符合合同（128 条完成记录 + 1 个活动 cwd）。
- 子 agent 报告当前新构建的 `test:conversation:ipc` 通过（22 次隔离 fixture 调用、2 次重启）；`trace.delivery` 计数为 2 messages / 165996 bytes，门禁通过且不变。它尝试的 `send.codex-fixture` 没有对应计数 collector，因此该项没有测量结果，不宣称提速。
- 两个真实可见聊天实例尚未接入 Surface，以上是传输/合同与既有 App 路径验证，不能替代后续 UI 验收。

### C2 生产 UI 集成（当前工作区版本，尚未最终验收）

- 单一 writer 在既有 WIP 之上完成 C2：右侧工作区页签模型改为「工具实例 + 侧聊实例」同级 discriminated union，`right-surface-storage.ts` 承载持久化（`localStorage` 每会话键、`v1` 一次性迁移、显示上限 8、坏行丢弃不静默重置）；`RightSurfaceTabStrip` 提供方向键/Home/End 与关闭后邻位焦点。
- 入口按设计稿：`打开一个 Surface` 中横向宽卡为同一 grid 的第一项，`+` 菜单前两项为「侧聊」和「历史」，原六个工具不变；无法创建时卡片 `disabled` 并直接显示真实原因，不做无效果点击。
- 创建路径先固定 scope/source/target/commandId，再 `previewSideChat`，随后在派发前把命令元数据（仅 id/指纹，不含正文或凭据）写入有界账本（最多 8 条，写入失败即拒绝创建）。响应丢失只读回查 `findSideChatCommand`：`not-found` 记 unknown 并保留命令，绝不重发。
- `SideChatSurface` 挂载于稳定子节点 ID 根，只有激活子页签渲染；标题单层、快照改为 `ModalFrame` 模态（焦点陷阱/Escape/焦点归还），页签切换对每个子对话恢复滚动位置与草稿，模型/effort/权限按子对话持久化。
- 历史按显式子 ID 分页（每页 40），`listSideChats` 增加有界 `ids`（1–8）做摘要校验：读成功且缺 ID 才判定删除并移除页签，读取失败保留全部页签；`restoreTabOutcome` 把判断做成纯函数并单独测试。
- 侧栏聚合对已加载项目做一次遍历：`side-chat-index.ts` 统计每个父行子对话总数/运行中/待处理，`questionKind` 区分 `permission` 与 `clarification`，父条目已消失的子对话进入独立分组；父计数是 `<span>` 文本，没有嵌套按钮。
- 性能：新增 `conversation-read.ts` + `conversation-turn-history.ts`，`loadTurns` 按 binding/session 分组，每个归档只读一次并只投影被请求轮次；回归证明只切换页签不会重读整份归档。
- 响应式：`ResizeObserver` 测得会话区宽度 < 880 时改单列，主区与右侧各自保留挂载，右侧自带「隐藏右侧工作区」返回；未新增轮询、未改 PaneSplitter。

C2 首轮检查（Node 22.22.1）：`tsc` web/node、`npx vitest run` 437 files / 4603 tests（4 skipped）、`npm run build`、`--dev-structure-only` 均通过；当时只有结构交互证据，真实流程在后续阶段补齐。

已知剩余缺口（交给后续阶段）：

- 未运行 `npm run performance:measure`；新增 main 模块已登记到 `scripts/performance-paths.json` 的 history sources，毫秒结论留给测量阶段。
- `docs/handoff/side-chat/README.md` 中原型说明与当前实现仍需主 agent 复核，避免文档声称未验证的行为。

## C2 复核轮

C2 复核的十项修复、当时失败与通过的证据由 [c2-review-round.md](c2-review-round.md) 保存；其中「仍未验证」的条目在下方 D1 阶段逐条补证。

## D1 交互验收与当前交接

阶段记录、五 Provider 目标缺陷及证据限制见 [d1-interaction-acceptance.md](d1-interaction-acceptance.md)：续作轮修好发送目标与窄窗口响应式冲突，并用真实 `BrowserWindow.setContentSize` 重放窗口尺寸验收。

最新执行状态、已保留状态和后续步骤见 [continuation-checkpoint.md](continuation-checkpoint.md)。
## D2 最终验收缺口轮（Node 22.22.1）

只补四项缺口，不加新能力。源码仍 0.2.227；未提交、未推送、未升版本、未安装（实例仍 0.2.229）。

**1. 多页签（显式需求）与根因**：旧驱动 `openChildFromHistory` 打开历史前关闭全部页签，准备动作自己删掉了其它页签，故不能证明任何产品边界。现在有页签时点 `+` 菜单的「历史侧边会话」、无页签时用 chooser 底部同一动作，都不关闭页签；恢复步骤新增断言“动作前的页签仍在”（实测 1 → 2）。退出前把工作台建成确定状态：1 个工具页签（纵览）+ 3 个子会话页签（未发送草稿、未决回执、普通），按打开顺序，草稿子会话激活；`localStorage` 的 `scry.session-right-surfaces.*` 行必须已含该顺序与激活页签。重启后先在**任何修复/重开动作之前**读回保存行，再读页签条，两者都必须与退出前一致。实测 `workbench` 三 ID、`tool ["纵览"]`、`selected`=草稿子会话、`openIds ["overview"]`，`restart.tabs` 一致；草稿/图片/回执与“无重放”不变。

**2. 挂载态竞态（此前无覆盖）**：新增 `scripts/fixtures/side-chat-workspace-races.tsx` + `side-chat-workspace-races-smoke.mjs`，在 sandboxed 独立窗口挂载生产 `useSideChatWorkspace`，API 是“按需放行”的 promise 队列，故 preview / create 结果 / 页签校验 / 历史页 / 窄化 / 丢失回执都在切到另一父会话**之后**才作答。断言：可见父会话页签、通知、窄化、历史对话框、created 不变；迟到的 create 只按原 scope 与原冻结来源记一次打开；迟到的页签校验不丢弃当前页签；迟到的历史页不写入当前对话框；未知命令只读核对不重发（create 2 → 2），全部 create 来源元组等于原父会话的 provider/profile/cwd/session。负控：`fenceHolds` 恒真后第一项立即失败（create 派发到 `scope-B`）。自称组件夹具证据，不替代 App/Provider。

**3. 原生来源 → 统一对话（用户显式切换 Provider）**：复核“只把子会话的 conversation 来源扩成原生别名”的怀疑属实——原生来源子会话原先只返回原生键，父 Provider 会话被用户显式切换/收养成统一对话后，按新对话 ID 查不到此前冻结的子会话。修复在共享规范来源匹配层：`conversation-side-chat.ts` 用同一 `nativeIdentity` 拼写，原生来源子会话额外归入“绑定完全相同 provider/profile/cwd/nativeSession 的对话”；围栏与创建/预览来源身份、指纹均未变。双向别名回归（`conversation-side-chat-handoff.test.ts`，真实 ID）：按 `conversation:<id>` 与 `ids` 有界查询都能查到，按原生元组仍能查到，换原生会话/换工作区/换 profile 均查不到；负控去掉扩展后失败（`[]`）。App 侧新增 adoption 步骤：子会话以 claude 运行、父 codex 空闲，用户真实点击父输入框选择 claude；断言活动行变成对话且 binding 指向父原生会话、3 个子会话页签与激活页签不变、子会话 id/runId 不变、记录/来源/轮次数不变、只有 1 个 body 与 1 个 composer、subscribe/unsubscribe 各 ≤ 2、fixture 只收到一次提示；新对话 scope 的 `listSideChats({ids})` 与真实历史对话框都能列出切换前的子会话。

**4. 子会话文件引用/diff/控件隔离**：子会话最后运行真实写入的 `side-chat-pi2.txt` 只出现在子会话正文（tool=`Write`），父会话正文不含它；子会话输入框无工作区选择器。其余控件隔离沿用既有步骤（Provider 芯片/停止/审批、只读共用工作区、快照只读一次）；不外推为“文件系统沙箱”。

**验证与限制**：`npm run test:side-chat:ui`（build + 快照夹具 + 竞态夹具 + `--dev-side-chat-only`）退出码 0，`verification.json` 记录当次 `out/` 产物 sha256 与全部断言。不宣称：真实付费账号、快照多页（仅组件夹具）、发布 gate、性能测量。
