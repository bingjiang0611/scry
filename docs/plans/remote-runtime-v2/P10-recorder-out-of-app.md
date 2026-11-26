# P10 · 把轮次记录器移出 App

状态：设计已定（2026-11-25）。评审意见和维护者的决定都已并入，没有待定项。

修订记录：
- 2026-11-25 初稿。
- 同日并入 CodeLens 采集评审的 9 条意见（§4–§8）。更正：初稿把 `managed-turn-commit` 写成了「提交关联（轮次挂到 git 提交）」，这是错的。它实际是 App 替记录器封存托管轮次，并触发提交回调（上传）。见 §2 和 §7。
- 同日第二轮：来源标记要加（§9）；记录器改动单独提 PR（§6）；App 只有维护者在用，去掉升级提示界面，CodeLens 不再阻塞 App 发版（§5.2、§6）。
- 11-26：#205–#209 合入后更新前置条件；冷启动归 Inbox v2 草案，W23 只测量（§5.4）。

## 1. 目标与非目标

**目标**：Scry App（Electron 主进程、daemon、supervisor）不再打包、启动、调用或读取轮次记录器（`scry` CLI，包名 `scry-turn-recorder`）。在 App 里开的会话，只以 App 自己的采集链为准：Provider 适配器事件、App 的 git capture 和 daemon 的检查点。这和 t3code 的做法一致。

**收益**：Qoder 和 Claude 复用进程的障碍消失；不再要求 CLI 版本和 App 一致，也不会再有 hook 事件和运行对不上号的问题；主进程模块数和打包体积下降。

**非目标**：
- 本阶段不把 CLI 搬到新仓库。迁出、`exports` 契约和消费方测试放到 W24。
- 不改 App 自己采集链的数据格式。

**记录器本身要做的改动**（初稿写的是「不改记录器」，评审指出这和遗留托管状态冲突，现改为）：只做「去掉 App 之后，记录器能独立收尾、不留永久挂起」所必需的改动，即 §4、§5、§8 列出的这些。不借机改别的行为。

## 2. 现状

App 是**按工作区**决定是否使用记录器的：
- `run-recovery.ts:44` 调用 `managedRecorderMode(cwd)`。只有执行过 `scry init` 的工作区才会返回 `enabled`。
- 其余工作区本来就完全不用记录器。这条「禁用路径」现在已经在跑，也有测试覆盖。

`enabled` 时，App 会多做这些事：

| 位置 | 做什么 |
|---|---|
| `electron-builder.yml:43-57`、`build/scry-cli` | 把 CLI 打包成 `Resources/bin/scry` |
| `recorder-cli-runtime.ts`、`supervisor.ts:146`、`bootstrap/trust.ts`、`bootstrap/startup-recovery.ts` | 解析 CLI 路径、校验版本，传递 `SCRY_CLI_PATH` |
| `claude.ts`、`claude-mcp.ts`、`codex-client-pool.ts`、`qoder-launch.ts`、`qoder-run.ts`、`qoder-plugin-reload.ts`、`qoder-session-identity.ts`、`antigravity-launch.ts` | 启动 Provider 时注入 `SCRY_RECORDER_MANAGED`、`SCRY_MANAGED_RUN_ID`、`SCRY_MANAGED_PROMPT_HASH` 等 |
| `bootstrap/run-provider.ts:173` | 给 Claude、Qoder、OpenCode、Pi 附上 `managedRecorderIdentity` |
| `bootstrap/run-live-state.ts:166` | `ingestionRecorder`：把运行中的证据交给记录器 |
| `bootstrap/archive.ts:145-221` | 按托管记录器证据汇总、落盘 |
| `bootstrap/run-recovery.ts:79` | `recoverManagedRecorderTurns`：启动时按记录器证据恢复，并投递提交回调 |
| `providers/pi-run-success.ts:119`、`providers/opencode-run.ts`、`providers/qoder-log-fallback.ts` | 按记录器证据判断结束，或做兜底 |
| `managed-turn-commit.ts`、`bootstrap/run-completion.ts`、`bootstrap/run-failure.ts` | **替记录器封存托管轮次**（`commitManagedRecorderTurn`），封存后由记录器投递提交回调 |
| `commit-hook-startup.ts`、`commit-hook-trust.ts`、`bootstrap/startup-recovery.ts:66` | **App 启动时，对已授权的工作区重投最近一次提交回调**（`redeliverGrantedCommitHooksAtStartup`） |
| `qoder-run.ts`、`qoder-session-pool.ts`（`e4dfbab6`） | 启用记录器的 Qoder 会话只跑一轮就关闭 |

记录器对托管轮次的处理（评审指出，已核对代码）：
- 托管轮次是带 `managedByScry` 的 open 轮次。收到终止事件后只标记为 `closing`，等 App 来封存。
- 后台巡检遇到托管轮次直接跳过（`recorder.ts:244`）。
- 同一会话里来了一个非托管的开场时，有两种情况（`recorder-hook-locked.ts:83-91`）：
  - 如果已有的托管轮次还开着，新开场会被**忽略**；
  - 如果新开场本身是托管的，旧轮次会被隔离成 `managed_replaced`。隔离项之后没有任何东西处理，实际见过滞留 76.9 天的。

App 还借用了记录器目录里的**通用代码**：
- `io`、`content-store`、`content-policy`、`tool-content`、`change-journal`；
- `git`、`git-command`、`git-workspace-snapshot`、`git-diff-history`；
- `store` 里的 `safeKey`、`stableHash`；
- `config`、`aggregate`。

`src/cli/mcpguard-core.ts` 是 App 自己的功能（MCP 信任检查），只是文件放在 CLI 目录里。

## 3. 目标状态（App 侧）

1. **所有工作区都走现在的禁用路径**。`managedRecorderMode` 以及所有 `managedRecorder*` 参数、分支，都从 App 里删掉。
2. **App 启动 Provider 时，不注入任何 `SCRY_RECORDER_*`、`SCRY_MANAGED_*` 或 `SCRY_CLI_PATH`**，也不再读写工作区里的 `.scry/` 记录器文件。唯一的例外是 §9 的来源标记 `SCRY_LAUNCH_CLIENT=scry-app`。
3. **删除托管封存和提交回调相关的代码**：`managed-turn-commit`、`commit-hook-startup`、`commit-hook-trust`，以及运行收尾、失败和启动路径上的相关调用。由此留下的职责，按 §7 交给记录器。
4. **不再打包 CLI**：删除 `electron-builder.yml` 里的 `scry-cli` 和 `bin/scry` 两项，以及 `build/scry-cli`。`bin/scry-host` 不动，它是 P5 的宿主 CLI。
5. **通用代码复制进 App 自己的目录**：放到 `src/shared/` 或 `src/host-runtime/` 下合适的位置，按用途命名。记录器保留自己的副本，两边从此各自演进。出处按 §8 记录。
6. **`mcpguard-core` 搬到 `src/shared/`**，`src/cli/mcpguard.ts` 改成从新位置引用。
7. **静态边界**：`src/main`、`src/daemon`、`src/host-runtime`、`src/shared`、`src/preload`、`src/renderer` 都不得 import `src/core/turn-recorder` 或 `src/cli`，检查违反就失败。
8. **Qoder 复用放开**：撤销 `e4dfbab6` 的「一轮即关」。
9. **项目规则同步**：`AGENTS.md`、`docs/agent/change-checklists.md`、`docs/agent/architecture.md` 里关于 App 私有 CLI 和托管两阶段提交的说法，改成新的边界。

## 4. 遗留的托管状态（必须收尾，不能永久挂起）

升级那一刻，工作区里可能有三类托管状态：
- **open**：托管轮次还开着，可能是 Provider 正在跑，也可能是旧 App 崩溃留下的；
- **closing**：已经收到终止事件，在等 App 封存；
- **隔离项**：历史上的 `managed_replaced`。

新 App 不会再来处理它们。如果不管，open 的托管轮次还会让同一会话之后的非托管开场一直被忽略，也就是**这个会话从此不再有记录**。

**方案：由记录器给「没有管理者的托管轮次」加过期规则，如实降级封箱。不在 App 里做一次性收尾。**

理由有三：
- App 做收尾就得保留记录器代码，违反 §3 第 7 条；
- 没有升级 App、或者卸载了 App 的机器，也需要这些规则；
- 状态在记录器手里，规则也应该在记录器里。

规则（阈值是初值，由 W23 用测试和现有数据确认）：
1. **判定「没有管理者」**：托管轮次的最后活动早于 `T_orphan`（初值 30 分钟），并且本机没有存活的旧版 App 在托管这个工作区。判断旧版 App 是否存活，用记录器现有的托管运行标记和进程存活检查。如果判断不了，就只按时间判定。
2. **closing 的托管轮次**：满足第 1 条后，按现有的非托管收尾路径封存，状态如实标注：
   - `completed` 加 `partial`，证据来源写「托管方缺席，由记录器收尾」；
   - 不补造 App 才有的证据。
3. **open 的托管轮次**：满足第 1 条后，按 `interrupted` 加 `partial` 封存。
   - 同一会话再来非托管开场时，如果旧的托管轮次已经满足第 1 条，就先封存它，再正常开始新一轮，不再忽略。
   - 不满足第 1 条时，维持现在的行为。这样旧版 App 还在跑时不会被打断。
4. **隔离项**：后台巡检把早于 `T_quarantine`（初值 24 小时）的 `managed_replaced` 项，按 `interrupted` 加 `partial` 封存进记录。原始文件保留到现有保留期结束，然后清理。不再无限期滞留。
5. **后台巡检**不再对托管轮次一律跳过，改为按上面的规则判断。
6. 降级封存同样会投递提交回调（§7），只投一次。

这些改动放在记录器里，单独提 PR，合入并发布之后才做 App 侧（§6）。PR 描述里必须说明下面几点，评审方会逐条看：
- **怎么判断旧版 App 还在托管**：依据哪些证据（进程存活、最近活动时间等），判断不了时偏向哪一边处理，为什么；
- **超时时长**：取多少，为什么；
- **如实标注**：过期封存的记录标 `partial`，原因写「托管方不再提供证据」，不认领缺失的正文和用量；
- **回归测试**：过期之后，同一会话后续的非托管开场能正常开轮；
- **回调只投一次**：重复投递时靠什么保证幂等；
- **状态迁移**：改动前后的迁移对照，以及对应的测试。

## 5. 已经 `scry init` 过的工作区

### 5.1 App 启动的会话怎么被记录
- App 不再注入托管标记之后，在这些工作区里，App 启动的 Provider 触发 hook 时会走**非托管路径**：记录器把它当成普通轮次记录，并照常投递提交回调。App 不读取、也不等待它的结果。
- 是否给这类记录加「从 App 发起」的来源标记，见 §9。

### 5.2 不能静默停止记录
`.scry/cli-path` 指向旧 App 包里 `Resources/bin/scry` 的工作区，升级后 hook 会按 `skip` 退出，数据从此不再产生。

桌面 App 目前只有维护者自己在用，所以**不做提示界面**，写进发版说明：
- 升级后，凡是执行过 `scry init` 的工作区，都要先安装独立 CLI，再在工作区里重新执行一次 `scry init`；
- 确认 hook 指向哪份 CLI：
  - `cat .scry/cli-path` 看工作区记的路径；
  - 用独立 CLI 执行 `scry doctor` 看 hook 和 CLI 的版本是否一致；
  - 检查 shell 环境里有没有指向旧 App 包的 `SCRY_CLI_PATH`，有就删掉。

App 不读、也不改工作区里的 `.scry` 文件。

### 5.3 同一工作区里有两套 hook
既执行过 `scry init`、又配置了 CodeLens 采集的工作区，以前靠托管标记避开重复记录。去掉托管标记之后，App 启动的会话会同时触发两套 hook，可能有两个不同版本的记录器写同一个 `.scry` 目录。

要满足三条不变式（守护进程的所有权沿用现有的 `<socket>.owner.json` 机制；如果要改，必须和 Inbox v2 草案 §3 的 `consumer.json` 唯一消费者设计保持一致，不另起一套）：
- 每一轮只产生一条记录；
- 记录器守护进程只有一个所有者；
- 不会因为两套 hook 交替调用，在两个版本之间来回切换。

W23 用测试证明这三条。如果现有的 handler 标记和守护进程所有权机制不足以保证，就在记录器里修，修法写进报告。

### 5.4 hook 耗时
- 没有记录器守护进程时，第一个 hook 事件要冷启动一次 Node。实测 0.6–2.2 秒，高负载时会超过门卫预算，后果是整场会话没有记录。
- 新 App 不会拉起记录器守护进程。
- W23 要测量：已 init 工作区里 App 启动的会话，每个 hook 事件的耗时，分守护进程在跑和没在跑两种情况；没在跑时，从第一个事件开始多久守护进程能起来。
- **W23 只测量，不修。** 冷启动丢会话是记录器已知的问题，main 上已有专门的设计草稿 [Recorder Inbox v2 契约草案](../recorder-inbox-v2-contract-draft.md)（#209，待评审，未实现），里面已经比较了预热、首认领直写和整会话迁移三条路。
- W23 的测量结果交给这份草案作为输入，尤其是「App 不再托管之后，已 init 工作区里冷窗口有多大」。W23 不实现 inbox v2，不加预热，也不调整门卫预算。
- 这部分风险目前只落在维护者本机，在草案定稿前接受。发版说明里写明：升级后 hook 第一次触发时如果记录器守护进程没在跑，这一轮可能不被记录。
- App 不拉起记录器守护进程（§3 第 7 条的边界）。

## 6. 发布顺序与 PR

1. **记录器先行，单独提 PR 合进 main。** 记录器的改动会随 CodeLens 自带的版本到达所有 CodeLens 用户，而且和最近的 #201–#205 改的是同一片状态机代码，评审方要对照着读。所以：
   - 本地 agent 从 main 拉独立分支，开 PR，可以拆成两三个；
   - 范围包括：§4 的过期规则和封存、§7 的回调重投、§5.3 要求的修复、§9 记录器侧的来源字段。§5.4 只测量，不修；
   - PR 描述写明改动前后的状态迁移和测试，§4 的那几点逐条说明；
   - 评审方读过后合入 main，再从本仓库发布 `scry-turn-recorder`。合并和发布都由维护者执行。
2. **App 侧**：记录器的 PR 合入并发布之后，W23 的开发分支 merge main，再继续做 App 侧。
3. **App 发版**：发版说明写明需要的记录器最低版本、§5.2 的重新 init 步骤，以及「记录器不再随 App 分发」。

**CodeLens 那两项不再是 App 发版的前置条件**，由 CodeLens 按普通优先级自行安排：
- 显式指定的 `SCRY_CLI_PATH` 不存在时，退回自带的记录器，并在 doctor 里告警；
- 把 §9 的来源值加进它的客户端名单。

## 7. 提交回调（上传）由谁负责

现在有三条投递路径，W23 之后各自的去向：

| 现在 | 去向 |
|---|---|
| App 封存托管轮次后投递回调（`managed-turn-commit`） | App 启动的会话改走非托管路径，由记录器封存并投递，和终端会话一样 |
| App 启动时恢复托管轮次并投递（`recoverManagedRecorderTurns`） | 由 §4 的过期规则封存并投递 |
| App 启动时，对已授权工作区重投最近一次回调（`redeliverGrantedCommitHooksAtStartup`） | W23 第一步盘点时确认记录器自己有没有重投机制（`commit-delivery-ledger`、`redeliverLatestCommitNotification`）。没有就在记录器里补上，例如守护进程启动或下一次 hook 时补投；不能依赖 App |

- 在没有配置提交回调、也没有 CodeLens 的机器上，记录只留在本地。这和今天终端会话的情况一样，不是新问题，写进发版说明。
- 回调的授权按现有权限策略（2026-09-21，自动授权、首次执行和指纹变化时重验）。删掉 App 这一侧之后，记录器那一侧的校验不能变弱。

## 8. 复制出去的代码要留出处

S3 把通用代码复制进 App 时，要写一份出处清单 `docs/plans/remote-runtime-v2/recorder-split-provenance.md`，内容包括：
- 来源提交；
- 每个文件的「原路径 → 新路径」，以及复制时的内容哈希；
- 最近几项需要两边关注的修复：
  - 转录和锚点扫描的读取上限；
  - 符号链接挂载仓库的发现；
  - 基线晚于写入时不报 0 改动。

之后任何一边修了这批模块，都要在清单里登记，并判断另一边是否需要同步。

## 9. 来源标记（已定：要）

去掉托管标记之后，App 启动的会话在记录里和终端会话没有区别。加一个只表示来源、不带会话或用户身份的标记：

- **App 侧**：启动任何 Provider 时设置环境变量 `SCRY_LAUNCH_CLIENT=scry-app`。值固定，不带会话、运行、用户或机器的任何信息。
- **记录器侧**：在非托管路径上读取 `SCRY_LAUNCH_CLIENT`，只接受符合 `client` 规则（小写标识符，最长 32 个字符，`session-capture-contract.ts:121`）的值，记为这一轮的来源。不合规的值丢弃，不报错，不影响记录。
- **CodeLens 侧**：在 CodeLens 采集的工作区里，`client` 由 CodeLens 的门卫按一张固定的客户端名单判断后传给记录器，名单外的值会被拒绝。CodeLens 会把「`SCRY_LAUNCH_CLIENT=scry-app` → `scry-app`」加进名单，不阻塞 App 发版。
- **上传**：服务端是否接受 `client=scry-app` 还没验证。**验证之前，这个值不得出现在任何会被上传的记录字段或导出内容里**，只能记在本地，以免新值导致整条记录被拒收。验证通过后，再改成写进上传的 `client`。
- **验证**（有空再做，不阻塞）：
  - 读得到服务端校验代码，就读代码确认；读不到，就在隔离环境里用一条自己构造的测试记录真实上传一次，确认回执是 `inserted`。
  - 核对 0.2.84 及以后的读取端遇到这个值时，不会把整条记录判为非法。
  - 做法和上次新增 `baseline_after_write` 时一样。

## 10. 和其他工作的关系

- **前置**（已满足，2026-11-26）：记录器的 Qoder Stop 归属修复 #205（按原生请求身份 `parent_request_set_id` 归属）已合进 main，之后又合了 #206、#208 两项 Qoder 首认领修复，main 上的记录器版本是 0.2.93。W23 的记录器 PR 基于最新 main。
- **Inbox v2 草案**（#209）：§5.4 的测量结果交给它，W23 不碰它的范围。
- **W24**：CLI 迁到独立仓库，补 `exports` 契约、兼容别名和消费方测试，解决对 `src/main/normalize`、`src/main/danger` 的反向依赖；doctor 识别 §5.2 的失效路径。
- **之后**：Claude 常驻会话可以单独开工。

## 11. 验收

- §3 的九条全部做到；静态边界检查能拦住违规引用（故意加一条违规 import，检查要失败）。
- `rg "SCRY_RECORDER_MANAGED|SCRY_MANAGED_|managedRecorder|SCRY_CLI_PATH|commitManagedRecorderTurn" src/main src/daemon src/host-runtime src/shared` 没有命中，测试和注释说明除外。
- 打包产物里没有 `scry-cli/` 和 `bin/scry`，`bin/scry-host` 还在。
- §4 的每条规则都有测试：open、closing、隔离项各自按规则封存；旧版 App 还在托管时不被打断；同一会话的非托管开场不再被永久忽略；每条记录只投递一次回调。
- §9：App 启动的会话带上 `SCRY_LAUNCH_CLIENT=scry-app`；记录器记下来源，但在服务端验证之前不进入上传内容。有测试证明。
- 记录器侧的改动已经通过独立 PR 合入 main（§6）。
- §5.3 的三条不变式有测试证明；§5.4 的耗时数字写进报告，并以「冷窗口测量」一节补充给 Inbox v2 草案的评审。
- 已 init 工作区里，App 启动的五家 Provider 都能正常完成，界面数据和未 init 的工作区一致。
- Qoder 同一对话的第二轮复用同一个进程，有测试证明。
- App 主进程模块数比改动前下降，并且不超过 192。
- 全量 typecheck、`--strict` 导入检查、全量 vitest、`check:cli-runtime`、开发版和打包版冒烟、原生性能门都通过。

## 12. 维护者决定

1. **方向**（已定，2026-11-25）：CLI 独立出去，App 不再使用。
2. **托管封存和提交回调**（已定，2026-11-25，按更正后的含义）：从 App 删除，职责交给记录器（§7）。
3. **已 init 工作区里 App 启动的会话**（已定）：由记录器当作普通轮次记录（§5.1）。
4. **来源标记**（已定，2026-11-25）：要。服务端验证和 CodeLens 名单同步有空再做；验证之前不随记录上传（§9）。
5. **记录器改动单独提 PR**（已定，2026-11-25）：先合入并发布，再做 App 侧（§6）。
6. **升级提示**（已定，2026-11-25）：App 只有维护者在用，不做界面，写进发版说明（§5.2）。
