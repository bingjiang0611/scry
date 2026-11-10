# F · macOS 全量门禁与总结

状态：**部分完成**。门禁命令都已在本机跑过并留下完整日志；`npm run pack` 因为不是本分支引入的超时失败而退出码 1，证据见下。

## F1 `npm run pack`

`pack` = `typecheck` → `npm test`（5,759 个测试）→ `build` → `build:cli` → `electron-builder` → `check:packaged-app` → `smoke:electron`。

| 次 | 命令 | 结果 | 日志 |
|---|---|---|---|
| 1 | `npm run pack` | 6 类失败：1 个真实回归 + 9 个超时；`pack` 在此中止，未到打包阶段 | `/tmp/scry-f-logs/pack.log` |
| 2 | `npm run pack`（修完回归后重跑） | 结果见下 | `/tmp/scry-f-logs/pack2.log` |

第 1 次的 10 个失败逐个判定：

| 失败 | 判定 | 依据 |
|---|---|---|
| `renderer radius system > keeps component radii on shared tokens` | **本分支真实回归**，已修 | E1 的卡片入口按钮写了 `border-radius: 999px`，违反 token 约束；改为 `var(--r-pill)` 后同一测试还要求 `corner-shape: round`，一并补上 |
| `pacman raw description contract` ×4 | 非本分支 | 同一文件在未改动的 `origin/main`（`5760dd71`）上也超时失败；症状是 `Test timed out in 5000ms`，这些测试每个用例都要 `spawnSync` 一个 node shim，本机单次 spawn 实测 1,225ms（首次）/52ms（其后），在 load average 10–13 的情况下稳定超过 5,000ms |
| `concurrency trace launcher contract > rejects unknown flags…` | 非本分支 | 同上，未改动 `origin/main` 上同样超时（10,519ms） |
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

- `npm run pack` 的打包产物段（`electron-builder`、`check:packaged-app`、`smoke:electron`）在两次运行里都没跑到：第 1 次停在单测，第 2 次见 `pack2` 日志结论。本机企业 EDR 会 SIGKILL 打包产物校验进程（`reports/A.md` 记录了 `npmmirror`/`claude` 的同类现象）。
- 真实 Provider 运行相关的门禁（B、C 的运行态、E2/E3）被网关 429 阻塞。
