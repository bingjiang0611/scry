# F · macOS 全量门禁与总结

状态：**部分完成**。门禁命令都已在本机跑过并留下完整日志；`npm run pack` 因为不是本分支引入的超时失败而退出码 1，证据见下。

## F1 `npm run pack`

`pack` = `typecheck` → `npm test`（5,759 个测试）→ `build` → `build:cli` → `electron-builder` → `check:packaged-app` → `smoke:electron`。

| 次 | 命令 | 结果 | 日志 |
|---|---|---|---|
| 1 | `npm run pack`（`9681c98b`） | 10 个失败：1 个真实回归 + 9 个超时，`Tests 10 failed \| 5745 passed \| 4 skipped (5759)`；`pack` 停在 `npm test`，未到打包段 | `/tmp/scry-f-logs/pack.log` |
| 2 | `npm run pack`（`db5b07be`，修完回归后重跑） | 14 个失败，全部是 `Test timed out in 5000ms`，`Tests 14 failed \| 5741 passed \| 4 skipped (5759)` | `/tmp/scry-f-logs/pack2.log` |
| 3 | `npm run pack:artifact` | **通过（`EXIT=0`）**：`build` → `build:cli` → `electron-builder` → `check:packaged-app` → `smoke:electron` 全跑完 | `/tmp/scry-f-logs/artifact.log` |

第 3 次是为了把 `pack` 因单测超时没能走到的打包段单独跑出来：`pack` 本身仍是退出码 1，但打包、产物校验与 Electron 冒烟都真实执行并通过（产物 `dist/mac-arm64/Scry.app`，未安装到 `/Applications`）。

第 1 次的 10 个失败逐个判定：

| 失败 | 判定 | 依据 |
|---|---|---|
| `renderer radius system > keeps component radii on shared tokens` | **本分支真实回归**，已修 | E1 的卡片入口按钮写了 `border-radius: 999px`，违反 token 约束；改为 `var(--r-pill)` 后同一测试还要求 `corner-shape: round`，一并补上 |
| `pacman raw description contract` ×4 | 非本分支 | 同一文件在未改动的 `origin/main`（`5760dd71`）上也超时失败；症状是 `Test timed out in 5000ms`，这些测试每个用例都要 `spawnSync` 一个 node shim，本机单次 spawn 实测 1,225ms（首次）/52ms（其后），在 load average 10–13 的情况下稳定超过 5,000ms |
| `concurrency trace launcher contract` ×2 | 非本分支 | 同上，未改动 `origin/main` 上同样超时（10,519ms） |
| `Pi RPC Provider > cold-resumes an existing native session` / `preserves tool delivery outside identity-scoped managed Claude` ×6 | 非本分支 | 第 2 次重跑时同样一批文件（`pi-settlement`、`managed-tool-hooks`、`concurrency-trace-launcher`、`check-pacman`）在 `origin/main` 上也是 9 个失败、同一批用例，原因是 `Test timed out in 5000ms` |
| `hook installation and real commits` / `loads Hook instrumentation from a path containing spaces` / `preserves tool delivery outside identity-scoped managed Claude ('codex')` / `runtime and evidence fixed workloads` | 非本分支 | 单独重跑同一批 4 个文件：本分支 1 失败 35 通过，`origin/main` 也是 1 失败 35 通过，且失败的是同一个超时用例 |

对照方法：`git worktree add /tmp/scry-baseline origin/main`（`5760dd71`），软链 `node_modules`，跑同样的文件。

## F2 `npm run test:renderer:ui`

| 次 | 结果 | 说明 |
|---|---|---|
| 1 | 通过（`EXIT=0`） | **作废**：跑到一半时仓库被外部切到 `main`（`git reflog`：`03:23:41 checkout: moving from claude/sweet-ptolemy-qxysuh to main`，随后 `pull --ff-only`），因此这一轮跑的是 main 的代码，不是本分支 |
| 2 | 通过（`EXIT=0`，无 `AssertionError`、无 `smoke failure`） | 在本分支 `db5b07be` 上重跑；日志 `/tmp/scry-f-logs/ui-branch.log`，03:38–03:51 |

第一轮暴露的是一个环境事实，不是代码事实：执行期间不要在同一检出上切分支。第二轮才是本分支的证据。

## F3 性能门禁

本次改动没有触及 `scripts/performance-paths.json` 中任何 `sources` 列出的文件（`Workflow*`、`ChatTurnTool*`、`workflow-*` 都不在里面），因此不需要 `npm run performance:measure -- --compare origin/main`。没有改动 `performance-ratchet.json`。

## F4 自查

按 `docs/agent/pr-workflow.md`「本地提交前自查」逐项看过：需求与批准（README/W.md 的工作包与硬约束）、改动范围（只碰 workflow 面板、聊天卡片入口、归档回放脚本、报告）、风险边界（没有改流式输入、审批、权限、trust、renderer 隔离、`.scry/records` schema、recorder core 依赖；没有放宽任何门禁；没有安装到 `/Applications`）、验证证据（见 A/C/D/E 报告）、待提交内容（`git status` 只剩不提交的 `docs/cli-team-rollout-readme-drafts/`）。

## 未验证

- `npm run pack` 作为一个整体命令在本机拿不到退出码 0：两次都停在 `npm test` 的超时用例。已用 `origin/main` 对照证明这些超时与本次改动无关（本机 spawn 首次 1,225ms、load average 10–13），打包段改用 `npm run pack:artifact` 单独验证通过。
- `npm run pack` 与 `test:renderer:ui` 的证据版本是 `db5b07be`。此后 `ccb9ea40` 改了 4 个 renderer 文件（阶段未声明提示、CSS token），已用 `typecheck`、`build`、受影响单测和归档回放覆盖；未在最终提交上重跑整个 `pack`/UI 门禁。
- 真实 Provider 运行相关的门禁（B、C 的运行态、E2/E3）被网关 429 阻塞。
