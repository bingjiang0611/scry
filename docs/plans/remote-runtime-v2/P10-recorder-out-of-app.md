# P10 · 把轮次记录器移出 App

状态：设计已定，评审意见已并入（2026-11-25）。维护者定了方向：CLI 独立出去，App 不再使用它。§10 里还有一项待维护者决定。

修订记录：
- 2026-11-25 初稿。
- 同日并入 CodeLens 采集评审的 9 条意见（§4–§8）。更正：初稿把 `managed-turn-commit` 写成了「提交关联（轮次挂到 git 提交）」，这是错的。它实际是 App 替记录器封存托管轮次，并触发提交回调（上传）。见 §2 和 §7。

## 1. 目标与非目标

**目标**：Scry App（Electron 主进程、daemon、supervisor）不再打包、启动、调用或读取轮次记录器（`scry` CLI，包名 `scry-turn-recorder`）。在 App 里开的会话，只以 App 自己的采集链为准：Provider 适配器事件、App 的 git capture 和 daemon 的检查点。这和 t3code 的做法一致。

**收益**：
- 托管身份不用再通过 env 逐轮传递，Qoder 和 Claude 复用进程的障碍消失。
- 不再要求 CLI 版本和 App 一致，也不会再有 hook 事件和运行对不上号的问题。
- App 主进程的模块数和打包体积都会下降。

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

App 还借用了记录器目录里的**通用代码**，这些和记录器进程本身无关：
- `io`、`content-store`、`content-policy`、`tool-content`、`change-journal`；
- `git`、`git-command`、`git-workspace-snapshot`、`git-diff-history`；
- `store` 里的 `safeKey`、`stableHash`；
- `config`、`aggregate`。

`src/cli/mcpguard-core.ts` 是 App 自己的功能（MCP 信任检查），只是文件放在 CLI 目录里。

## 3. 目标状态（App 侧）

1. **所有工作区都走现在的禁用路径**。`managedRecorderMode` 以及所有 `managedRecorder*` 参数、分支，都从 App 里删掉。
2. **App 启动 Provider 时，不注入任何 `SCRY_RECORDER_*`、`SCRY_MANAGED_*` 或 `SCRY_CLI_PATH`**，也不再读写工作区里的 `.scry/` 记录器文件。唯一的例外是 §9 的来源标记（如果维护者决定要）。
3. **删除托管封存和提交回调相关的代码**：`managed-turn-commit`、`commit-hook-startup`、`commit-hook-trust`，以及运行收尾、失败和启动路径上的相关调用。由此留下的职责，按 §7 交给记录器。
4. **不再打包 CLI**：删除 `electron-builder.yml` 里的 `scry-cli` 和 `bin/scry` 两项，以及 `build/scry-cli`。`bin/scry-host` 不动，它是 P5 的宿主 CLI。
5. **通用代码复制进 App 自己的目录**：放到 `src/shared/` 或 `src/host-runtime/` 下合适的位置，按用途命名。记录器保留自己的副本，两边从此各自演进。出处按 §8 记录。
6. **`mcpguard-core` 搬到 `src/shared/`**，`src/cli/mcpguard.ts` 改成从新位置引用。
7. **静态边界**：`src/main`、`src/daemon`、`src/host-runtime`、`src/shared`、`src/preload`、`src/renderer` 都不得 import `src/core/turn-recorder` 或 `src/cli`，检查违反就失败。
8. **Qoder 复用放开**：撤销 `e4dfbab6` 的「一轮即关」。
9. **项目规则同步**：`AGENTS.md` 和 `docs/agent/change-checklists.md` 里「App 私有 CLI 与全局 npm CLI 是两个分发面」「managed recorder 两阶段提交」等说法，以及 `docs/agent/architecture.md` 的相关段落，改成新的边界。

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

这些改动放在记录器里，随记录器发版（§6），**必须先于这一版 App 发布**。

## 5. 已经 `scry init` 过的工作区

### 5.1 App 启动的会话怎么被记录
- App 不再注入托管标记之后，在这些工作区里，App 启动的 Provider 触发 hook 时会走**非托管路径**：记录器把它当成普通轮次记录，并照常投递提交回调。App 不读取、也不等待它的结果。
- 是否给这类记录加「从 App 发起」的来源标记，见 §9。

### 5.2 不能静默停止记录
`.scry/cli-path` 指向旧 App 包里 `Resources/bin/scry` 的工作区，升级后 hook 会按 `skip` 退出，数据从此不再产生。

**方案：App 升级后首次启动时提示，只提示，不改工作区文件。**
- App 检查自己已知的项目根（已授权项目、最近会话的工作区），只读每个根下的 `.scry/cli-path`。
- 指向任意版本 App 包内 `bin/scry` 的，列成一张清单。
- 也检查 App 启动环境里的 `SCRY_CLI_PATH`：指向 App 包内的，同样列出。
- 提示内容包括：受影响的工作区，以及修复命令（安装独立 CLI，然后在该工作区执行 `scry init`）。用户可以关掉提示；同一个工作区修好之前，每次大版本启动时提示一次。
- 读取 `.scry/cli-path` 只是读一个文本文件，不 import 记录器代码，不违反边界。

不采用「在原路径保留转发脚本」的做法：那样包里仍然留着 `bin/scry`，还会把 hook 转发给版本不确定的记录器，而且没装独立 CLI 时依旧是静默跳过。

### 5.3 同一工作区里有两套 hook
既执行过 `scry init`、又配置了 CodeLens 采集的工作区，以前靠托管标记避开重复记录。去掉托管标记之后，App 启动的会话会同时触发两套 hook，可能有两个不同版本的记录器写同一个 `.scry` 目录。

要满足三条不变式：
- 每一轮只产生一条记录；
- 记录器守护进程只有一个所有者；
- 不会因为两套 hook 交替调用，在两个版本之间来回切换。

W23 用测试证明这三条。如果现有的 handler 标记和守护进程所有权机制不足以保证，就在记录器里修，修法写进报告。

### 5.4 hook 耗时
- 没有记录器守护进程时，第一个 hook 事件要冷启动一次 Node。实测 0.6–2.2 秒，高负载时会超过门卫预算，后果是整场会话没有记录。
- 新 App 不会拉起记录器守护进程。
- W23 要测量：已 init 工作区里 App 启动的会话，每个 hook 事件的耗时，分守护进程在跑和没在跑两种情况；没在跑时，从第一个事件开始多久守护进程能起来。
- 如果超出门卫预算会丢整场会话，在记录器里修（例如第一个事件就异步拉起守护进程，或者调整开场事件的预算），不由 App 来拉。

## 6. 发布顺序

1. **记录器发版**：包含 §4 的过期规则，§5.3 和 §5.4 如需修复也一并带上。从本仓库发 `scry-turn-recorder`，版本号由维护者定。
2. **CodeLens 发版**，必须在 App 之前：
   - 显式指定的 `SCRY_CLI_PATH` 不存在时，退回自带的记录器，并在 doctor 里告警；
   - 自带的记录器升级到第 1 步的版本。
   - 现状是：指定的路径不存在时，CodeLens 不会退回，而是解析失败，采集停止。指定值指向 App 包内 `bin/scry` 的机器，App 一升级就会受影响。
3. **App 发版**。发版说明写明：
   - 需要的 CodeLens 最低版本和记录器最低版本；
   - 已 init 工作区的修复方法；
   - 记录器不再随 App 分发。

第 1、2 步的发布由维护者和 CodeLens 维护方执行，W23 只准备代码和说明。

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

## 9. 来源标记（待维护者决定）

去掉托管标记之后，App 启动的会话在记录里和终端会话没有区别。如果平台统计需要区分「从 App 发起」，可以加一个只表示来源、不带任何身份的标记：
- App 启动 Provider 时设置一个环境变量，值固定为 `scry-app`；
- 记录器在非托管路径上，把它写进现有的 `client` 字段。这个字段的规则是小写标识符，最长 32 个字符（`session-capture-contract.ts:121`）。

推荐加上。成本很小，不影响边界：App 不依赖它的结果，记录器只是多记一个字段。

## 10. 和其他工作的关系

- **前置**：记录器的 Qoder Stop 归属修复（PR #205，正在按新方案重写，用 `parent_request_set_id` 归属）合进 main 之后，再开工。
- **W24**：把 CLI 迁到独立仓库，补上 `exports` 契约、兼容别名和消费方测试，并解决记录器对 `src/main/normalize`、`src/main/danger` 的反向依赖。CLI 的 doctor 要能识别 §5.2 的情况。
- **之后**：Claude 常驻会话可以单独开工。

## 11. 验收

- §3 的九条全部做到；静态边界检查能拦住违规引用（故意加一条违规 import，检查要失败）。
- `rg "SCRY_RECORDER_MANAGED|SCRY_MANAGED_|managedRecorder|SCRY_CLI_PATH|commitManagedRecorderTurn" src/main src/daemon src/host-runtime src/shared` 没有命中。§5.2 的只读检测除外，测试和注释说明也除外。
- 打包产物里没有 `scry-cli/` 和 `bin/scry`，`bin/scry-host` 还在。
- §4 的每条规则都有测试：open、closing、隔离项各自按规则封存；旧版 App 还在托管时不被打断；同一会话的非托管开场不再被永久忽略；每条记录只投递一次回调。
- §5.2 的提示：有受影响工作区时出现，没有时不出现，并且不写工作区文件。
- §5.3 的三条不变式和 §5.4 的耗时数字写进报告。
- 已 init 工作区里，App 启动的五家 Provider 都能正常完成，界面数据和未 init 的工作区一致。
- Qoder 同一对话的第二轮复用同一个进程，有测试证明。
- App 主进程模块数比改动前下降，并且不超过 192。
- 全量 typecheck、`--strict` 导入检查、全量 vitest、`check:cli-runtime`、开发版和打包版冒烟、原生性能门都通过。

## 12. 维护者决定

1. **方向**（已定，2026-11-25）：CLI 独立出去，App 不再使用。
2. **托管封存和提交回调**（已定，2026-11-25，按更正后的含义）：从 App 删除，职责交给记录器（§7）。
3. **已 init 工作区里 App 启动的会话**（默认）：由记录器当作普通轮次记录（§5.1）。
4. **来源标记**（待定）：见 §9。推荐加。
