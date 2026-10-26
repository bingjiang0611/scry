# 批次 A：不再静默丢整轮（H1、H2、L2）

分支：`reliability/collection`。先读 [README.md](README.md) 的硬约束，再读 [review.md](review.md) 对应小节。

这一批解决的是「整轮消失且没有任何痕迹」。做完后，就算还会丢，也一定能在 `.scry/` 里查到丢在哪。

## A1（H1）缺开始事件时不再把终态事件当成 duplicate

**先证实**（单独提交）：在 `src/core/turn-recorder/recorder.test.ts` 加测试：
- 某会话从未收到 `UserPromptSubmit`，直接收到 `Stop`（payload 含 `transcript_path` 和 session id）。旧实现返回 `duplicate`，records 为空，health 无任何计数。
- 对 Claude、Codex、Qoder 各覆盖一次（OpenCode 走插件，按插件实际发出的事件名覆盖）。

**改法方向**
1. `recorder.ts:2891-2893`：只有能**正面证明**该终态属于已提交轮次时才返回 `duplicate`。可用依据：`state.json` 的 `committedProviderTurnIds` / `lastCommittedRecordId`、该会话最后一条 record 的 `completedAt` 与终态时间戳的比较。现有测试 `SessionEnd ... repeats stay idempotent`（`recorder.test.ts:185` 附近）必须继续通过。
2. 证明不了时：
   - 至少把**完整 payload** 落盘到 `runtime/<provider>/<session>/orphans/`（现有 orphan 只存 event 名和时间），新增 health 计数（例如 `missingStartTerminals`），写 `recorder.log`。
   - 能从 transcript 定位这一轮时，生成一条降级 record：`endReason` 新增值（例如 `missing_start`），user/startedAt 等字段标 `inferred` 或 `partial` 并写原因，diff 标 `unavailable`（没有轮首基线，不能归因）。各 Provider 能否可靠定位由执行方逐个判断，做不到的 Provider 只落 orphan，不要猜。
3. 工具事件的 orphan（`recorder.ts:2895-2902`、`2925-2931`）同样保留 payload，便于事后排查。注意 payload 可能很大且含敏感内容，沿用现有 content policy 与字节上限。

**红线**
- 证据诚实：降级 record 不能填任何没有证据的值（token、耗时、diff）。
- 不能因此产生重复 record：重复 Stop、重放 inbox、recover 重入都要幂等，recordId 需稳定。
- 不改变已有 `duplicate` 正常路径的行为。

## A2（H2）hook 脚本的每个跳过分支都留痕

**先证实**：在 `src/cli/workspace-init.test.ts`（或现有 shell fixture）中，生成 hook 脚本后把 `.scry/cli-path` 指向不存在的文件、删掉 `.scry/node-bin-dir`、managed 下给无效 `SCRY_CLI_PATH`，执行脚本：旧实现退出 0 且 `.scry/` 下没有任何记录。

**改法方向**
- 每个 `exit 0` 跳过分支用 shell 内建追加一行到 `.scry/logs/hook-skip.log`（时间、provider、event、原因码，例如 `cli_path_missing`、`node_bin_dir_missing`、`managed_cli_invalid`）。不记录 payload。日志要有上限（例如超过 1 MB 时由 CLI 侧轮转，shell 只追加）。
- CLI 回退分支：保留返回码，非 0 时同样记一行。
- `scry recorder status` / `doctor` / support-bundle 汇总 hook-skip 计数与最近一次时间，`doctor` 报 `error`。
- `config.ts:206-207`：`invalid_config` 不再与用户主动禁用混用。hook 路径上记录错误（写到 `.scry/logs/` 或 health），`doctor` 报 `error`。用户主动禁用（`.scry-disabled`、`SCRY_RECORDER_ENABLED=0`、`enabled:false`）保持现状。
- 考虑在 `cli-path` 失效时，按顺序尝试 `SCRY_CLI_PATH` → `command -v scry`，找到时仍记一行 `cli_path_stale_fallback`。注意 README 374 行的既有约定：显式设置 `SCRY_CLI_PATH` 时不回退 PATH，这条不能破。是否加这个回退，执行方评估后在报告中说明。

**红线**
- daemon 在线时的 curl 快路径不能新增进程启动。
- 脚本仍然 `exit 0`，不能让 Provider 看到失败。
- 生成脚本变了，`providerHookScriptState` 会把存量脚本判为 `outdated`。报告写明需要 `scry integrations repair --yes`。

## A3（L2）开始事件的 open.json 持久化

**改法方向**：`beginOpenTurn` 首次写 `open.json` 与 `state.json`（`recorder.ts:2206-2207`）改为 sync 写；终态事件钉住 `closing` 状态那次（`recorder.ts:2982` 附近）同样 sync。其余中间状态保持 `sync:false`。

**先测**：这是 fsync 次数增加，先用计数（L1）记录每轮 fsync 次数的变化，写进报告。不需要毫秒结论。

## 测试

`npm run test:unit -- src/core/turn-recorder/recorder.test.ts src/cli/workspace-init.test.ts src/cli/scry.test.ts`，`npm run typecheck`，提交前全量 `npm run test:unit`。

## 用户验证（写进报告）

参考 [USER-VERIFY.md](USER-VERIFY.md) 的 A 节。
