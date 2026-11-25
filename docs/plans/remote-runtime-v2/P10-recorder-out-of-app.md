# P10 · 把轮次记录器移出 App

状态：设计已定（维护者 2026-11-25：CLI 独立出去，App 不再使用它；App 里的提交关联删除）。日期 2026-11-25。

## 1. 目标与非目标

**目标**：Scry App（Electron 主进程、daemon、supervisor）不再打包、启动、调用或读取轮次记录器（`scry` CLI，包名 `scry-turn-recorder`）。在 App 里开的会话，只以 App 自己的采集链为准：Provider 适配器事件、App 的 git capture 和 daemon 的检查点。这和 t3code 的做法一致。

**收益**：
- 托管身份不用再通过 env 逐轮传递，Qoder 和 Claude 复用进程的障碍消失。原计划的「记录器按会话取身份」不再需要。
- 不再要求 CLI 版本和 App 一致，也不会再有 hook 事件和运行对不上号的问题（例如 Qoder 的 Stop 归属）。
- App 主进程的模块数和打包体积都会下降。

**非目标**：
- 本阶段不把 CLI 搬到新仓库。它暂时留在本仓库，但 App 不再引用它。迁出、`exports` 契约和消费方测试放在下一阶段（W24）。
- 不改记录器自身的行为。在终端开的会话和 trade-telemetry 照常使用独立的 CLI。
- 不改 App 自己采集链的数据格式。

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
| `bootstrap/archive.ts:145-221` | 按托管记录器证据汇总、落盘（`aggregateTurnEvidence`） |
| `bootstrap/run-recovery.ts` | `recoverManagedRecorderTurns`：启动时按记录器证据恢复运行 |
| `providers/pi-run-success.ts:119`、`providers/opencode-run.ts`、`providers/qoder-log-fallback.ts` | 按记录器证据判断结束，或做兜底 |
| `managed-turn-commit.ts`、`commit-hook-*.ts`、`bootstrap/run-completion.ts`、`bootstrap/run-failure.ts` | 提交关联：把轮次挂到 git 提交上 |
| `qoder-run.ts`、`qoder-session-pool.ts`（`e4dfbab6`） | 启用记录器的 Qoder 会话只跑一轮就关闭 |

另外，App 还借用了记录器目录里的**通用代码**，这些和记录器进程本身无关：
- `io`、`content-store`、`content-policy`、`tool-content`、`change-journal`；
- `git`、`git-command`、`git-workspace-snapshot`、`git-diff-history`；
- `store` 里的 `safeKey`、`stableHash`、`RECORDER_VERSION`；
- `config`、`aggregate`。

用到它们的有会话历史、轨迹、归档、运行中 diff、daemon 检查点（`checkpoint-service.ts`）和数据库写入。

`src/cli/mcpguard-core.ts` 是 App 自己的功能（MCP 信任检查），被 main、shared、preload 和 renderer 引用，只是文件放在 CLI 目录里。

## 3. 目标状态

1. **所有工作区都走现在的禁用路径**。`managedRecorderMode` 以及所有 `managedRecorder*` 参数、分支，都从 App 里删掉，不保留开关。
2. **App 启动 Provider 时，不注入任何 `SCRY_RECORDER_*`、`SCRY_MANAGED_*` 或 `SCRY_CLI_PATH`**，也不再读写工作区里的 `.scry/` 记录器文件。
3. **提交关联整块删除**：`managed-turn-commit`、`commit-hook-*`，以及运行收尾和失败路径上相关的调用（维护者已定，见 §9）。
4. **不再打包 CLI**：删除 `electron-builder.yml` 里的 `scry-cli` 和 `bin/scry` 两项，以及 `build/scry-cli`。`bin/scry-host` 不动，它是 P5 的宿主 CLI，和记录器无关。
5. **通用代码搬进 App 自己的目录**：放到 `src/shared/` 或 `src/host-runtime/` 下合适的位置，按用途命名，不再带 `turn-recorder` 字样。记录器那边保留自己的副本。两边从此各自演进，不再共享源文件。
6. **`mcpguard-core` 搬到 `src/shared/`**，`src/cli/mcpguard.ts` 改成从新位置引用。
7. **静态边界**：`src/main`、`src/daemon`、`src/host-runtime`、`src/shared`、`src/preload`、`src/renderer` 都不得 import `src/core/turn-recorder` 或 `src/cli`。把这条检查加进 `npm run typecheck` 或现有的导入检查脚本里，违反就失败。
8. **Qoder 复用放开**：撤销 `e4dfbab6` 的「一轮即关」，同一对话的第二轮复用同一个进程。

## 4. 已经 `scry init` 过的工作区

App 不再注入 `SCRY_RECORDER_MANAGED=1` 之后，在这些工作区里，App 启动的 Provider 触发 hook 时，hook 脚本会走**非托管路径**：把这一轮当成普通的终端轮次，交给独立记录器。

- **推荐：保持这样，不另加跳过开关。**
  - 理由一：独立 CLI 的用户（包括 trade-telemetry）在 App 里开的会话照样有记录。
  - 理由二：非托管路径本来就要处理同一进程多轮的情况，这是终端会话的常态。
  - App 不读取、也不等待它的结果。
  - hook 的开销和现在一样：有记录器守护进程时走 socket，没有时启动一次 Node。
- 如果 `.scry/cli-path` 指向的是旧 App 包里的 `Resources/bin/scry`，升级后这个文件不存在了，hook 会按 `skip` 记一条日志后退出，不会影响 Provider。
  - App 不去改用户工作区里的文件。
  - 修复方法是用独立 CLI 重新执行一次 `scry init`。这条写进 CLI 的 `doctor`（W24）和发版说明里。

## 5. 替代来源

原则：**现在禁用路径的行为就是目标行为。** 只有当用户在界面上能看到的数据会消失、而禁用路径又没有替代时，才需要补齐。

需要逐项确认（W23 第一步的盘点报告）：
- **Qoder**：`qoder-log-fallback.ts` 和记录器里的 `pending-qoder-transcript` 补的是哪一类数据，App 自己的事件流有没有覆盖。
- **Pi**：`pi-run-success.ts:119` 的托管分支用记录器证据判断成功；禁用路径怎么判断，两者结果是否一致。
- **OpenCode**：`opencode-run.ts` 从 `core/turn-recorder/recorder` 引用了什么，删掉之后会不会改变结束判定。
- **归档**：`archive.ts` 的托管持久化（`useManagedPersistence`）和禁用路径相比，字段有没有差异。
- **启动恢复**：`recoverManagedRecorderTurns` 能恢复、而 App 自己的恢复（outbox、持久队列、A3 的终态证据）恢复不了的情况，有没有。
- **用量和分析**：确认分析页和 LLM 性能页的数据都来自 App 自己的写入（`db-turns`、span ledger），不依赖记录器。

## 6. 数据与兼容

- App 自己的数据库、归档和检查点不受影响，历史会话照常显示。
- 工作区里 `.scry/` 下由记录器写的数据，App 原本就只在托管模式下读取。删掉之后，App 不再显示这部分。已经落进 App 自己归档里的内容不受影响。
- 协议、能力位和 iPhone 端不变。

## 7. 和其他工作的关系

- **前置**：等记录器里的 Qoder Stop 归属修复（PR #205）合进 main 之后再开工，避免冲突，也让迁出时自然带上这份修复。
- **W24（下一阶段）**：把 CLI 迁到独立仓库，补上 `exports` 契约、深层路径的兼容别名和消费方测试，并解决记录器对 `src/main/normalize`、`src/main/danger` 的反向依赖。这一步需要维护者先建好仓库。
- **之后**：Claude 常驻会话（TODO 里的 C1 Claude 部分）不再受记录器 env 的限制，可以单独开工。P6 恢复时，模块数超限的问题预计随本阶段一起解决。

## 8. 验收

- §3 的八条全部做到，静态边界检查能拦住违规引用：故意加一条违规 import，检查要失败。
- `rg "SCRY_RECORDER_MANAGED|SCRY_MANAGED_|managedRecorder|SCRY_CLI_PATH" src/main src/daemon src/host-runtime src/shared` 没有命中，测试和注释说明除外。
- 打包产物里没有 `scry-cli/` 和 `bin/scry`，`bin/scry-host` 还在。
- 在已经 `scry init` 的临时工作区里，App 启动的 Claude、Codex、Qoder、Pi、OpenCode 都能正常完成，界面上的历史、diff、用量和执行禁用路径时一致。
- Qoder 同一对话的第二轮复用同一个进程（测试证明）。真实 Provider 的复测有额度时再做。
- App 主进程模块数比改动前下降，并且不超过 192。
- 全量 typecheck、`--strict` 导入检查、全量 vitest、`check:cli-runtime`（记录器自身仍要通过）、开发版和打包版冒烟、原生性能门都通过。

## 9. 维护者决定

1. **方向**（已定，2026-11-25）：CLI 独立出去，App 不再使用。
2. **App 里的提交关联**（已定，2026-11-25）：删除。以后如果想在 App 里看「这个提交是哪几轮改的」，用 App 自己的数据重做，另开任务。
3. **已经 `scry init` 的工作区里，App 启动的会话**：默认由独立记录器当作普通轮次记录（§4），App 不加跳过开关。
