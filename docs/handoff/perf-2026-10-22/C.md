# 批次 C：工作区 diff 只读路径（#5）

分支：`perf/c-git-readonly`（已从 `perf/handoff` 的交接提交切出，只改本批范围）。先读 [README.md](README.md) 与 [review.md](review.md) #5，以及 `docs/performance-opportunities.md` 中 git 相关条目与 `docs/performance-experiments/20261016-git-subprocess-gating.md`、`20261017-service-diff-revision.md`，避免重复已做过的实验。

## 范围

只改 `agent:gitDiff` 的只读视图路径：`src/main/git.ts:12` → `gitNumstat`（`src/core/turn-recorder/git.ts:1326`），以及 renderer 的 `loadGitDiff`（`src/renderer/hooks/useIntegrations.ts:770`、`:1168`）。

**不要改 `beginGitTurnDiff` / `finishGitTurnDiff` 及轮次 diff、managed recorder 的任何路径。** recorder 需要可持久的 before tree，那套管线是正确的，只是不该被只读视图复用。

## 先测

在现有 git 基准（`npm run bench:git-diff`、`scripts/git-turn-diff-bench.mjs`）基础上，为 `gitNumstat` 增加：spawn 次数、哈希/写对象数、端到端耗时；小仓库与 5000 文件仓库各一组；含未跟踪文件、含被排除路径。单独提交。

## 改法方向

1. **新只读实现**（例如 `readWorkspaceNumstat`）：目标是用尽量少的 git 进程得到与 `gitNumstat` 等价的结果，例如 `status --porcelain=v2 -z --untracked-files=all` + `diff --numstat -z HEAD`，未跟踪文件的行数单独计算（有上限）。不写临时对象库、不 `add -A`。
2. **合并并发请求**：同一 cwd 同时只有一个进行中的请求，后来者共享结果。
3. **缓存**：键包含 canonical cwd、HEAD、index 的 `mtime/size/ino`；工作区文件变化无法廉价感知，所以缓存只用于合并短时间内的重复请求（例如可见性抖动），并且必须标来源时间。
4. **renderer**：刷新时保留旧结果并显示“刷新中”，不再 `setGitDiff(null)` 清空；保持现有 `seq` 防乱序。

## 红线（逐条在报告中说明如何满足）

- **不执行仓库控制的代码**：所有会读取工作区内容的 git 命令都要带 `snapshotGitArgs` 的加固参数，以及 `loadSnapshotOverrides` 的 filter 驱动覆盖（`clean/process/required`）和禁用 hooks；`diff` 保留 `--no-ext-diff --no-textconv`。worktree 对比会触发 clean filter，这一点最容易漏。
- **等价性**：与旧 `gitNumstat` 在 fixture 上逐项对比——修改/新增/删除、未跟踪文件、二进制文件、子目录 scope（`capturePathspec`）、`excludedPaths`、非 git 目录、空仓库/无 HEAD、超时。不等价的项必须显式返回 `unavailable/partial` + 原因，**不能静默少报**。
- 状态枚举（`captured / failed / timeout / unavailable` 及 reason）与 renderer 展示语义不变。
- `src/core/turn-recorder/` 保持无 Electron/SQLite 依赖；若新函数放在 core，CLI 构建（`npm run build:cli`）必须仍通过。

## 测试

`src/main/git.test.ts`、`src/main/git-ipc.test.ts`、`src/main/git-terminal-pair.test.ts`、`src/core/turn-recorder` 下 git 相关测试；新增等价性测试；`npm run test:source-control:ui`；`npm run performance:measure`（`--scenario` 选 `scripts/performance-paths.json` 中 workspace / source-control 路径对应的场景）。

## 完成后

写 `reports/C.md`，push `perf/c-git-readonly`。并行分支**不改 STATUS.md**（避免多分支冲突），由审查方在 `perf/handoff` 上维护。
