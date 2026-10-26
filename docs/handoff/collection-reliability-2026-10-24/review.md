# 采集可靠性审查（main@205521e）

只读审查，未复现。行号以 `205521e` 为准。范围：`src/cli/workspace-init.ts`（hook 脚本）、`src/cli/scry.ts`（`recorder hook`）、`src/core/turn-recorder/{daemon,recorder,store,io,config,commit-hook-grant,git,maintenance}.ts`。

流程图里的 REQ 绑定、`scry_turn_uploader.py`、Aone `reportAgentTurns`、dead letter **不在本仓库**，未审查。

## 高：静默丢数据

### H1. 缺开始事件时，Stop/SessionEnd 被当作 duplicate，整轮丢失

- `recorder.ts:2891-2893`：没有 open turn 时，`END_EVENTS` / `SESSION_END_EVENTS` 直接返回 `duplicate`，不区分「已提交过」和「开始事件根本没到」。
- 开始事件缺失的常见原因：UserPromptSubmit hook 超时被宿主杀掉；那一刻 CLI 路径失效（H2）；Provider 中途才加载或信任 hook；`open.json` 未 fsync 在崩溃中丢失（L2）。
- 结果：整轮无记录，`orphanEvents` 也不加。
- 同类：其他无 open turn 的事件记为 orphan（`recorder.ts:2895-2902`、`2925-2931`），但 orphan 文件只存 `event` 与时间，payload 被丢弃。
- 判定「已提交」可用的现有信息：`state.json` 的 `lastCommittedRecordId`、`committedProviderTurnIds`（`recorder.ts:2679-2687`），`isCommittedProviderTurn`（`recorder.ts:2777`），以及 records 里该会话最后一条的 `completedAt`。

### H2. hook 脚本多处 `exit 0` 静默跳过

- `workspace-init.ts:186-218`：`read -r scry_bin < .scry/cli-path || exit 0`、`node-bin-dir` 同理；managed 下 `[ -x "$SCRY_CLI_PATH" ] || exit 0`；回退前 `[ -x "$scry_bin" ] || exit 0`；CLI 回退的返回码被丢掉。
- `init` 写入的是 realpath 后的 CLI 与 node 路径（`workspace-init.ts:461-463`、`795-797`）。nvm/fnm/volta 切换或删除旧版本、重装全局包后路径失效，之后每个事件都被静默跳过。
- `config.ts:206-207`：`scry.config.json` 解析失败返回 `enabled:false, reason:'invalid_config'`，与用户主动禁用同一分支，hook 不记错误。

### H3. daemon 用冷启动时的环境变量

- `daemon.ts:533-540` 把 daemon 进程自身的 `env` 传给 `handleRecorderHook` 和 `drainRecorderDelivery`；该 env 来自拉起 daemon 的那次 hook（`daemon.ts:305-310`）。
- `COMMIT_HOOK_ENV_KEYS`（`store.ts:63-75`）透传给 uploader 的 `SCRY_TURN_UPLOAD_ENABLED`、`SCRY_INSTALLATION_ID`、`RATE_NATIVE_ASYNC_QUEUE_DIR`、`TMCP_TRACE_URL` 等，全部取这个快照。会话 B 的记录可能带着会话 A 的 env 投递。若 uploader 在「未启用」时 exit 0，记录被 ACK 但从未上传。
- 反方向：会话级 `SCRY_RECORDER_ENABLED=0` 在 daemon 路径下被忽略。

### H4. inbox 重放失败或读失败即删除

- `recorder.ts:3043-3072`：`applyHookLocked` 抛错、或 `readJson` 返回 null，都执行 `rm(path)`。
- `io.ts:5-11`：`readJson` 吞掉所有错误（EMFILE、EIO、EACCES 都变成 null）。瞬时错误变成永久丢失。

## 中

### M1. recover 中单个会话出错中断整轮

- `recorder.ts:3192-3306`：第二次 `withRecorderSessionLock`（3225 行起）没有 try/catch；锁超时或 `finalizeOpenTurn` 抛错会让 `recoverRecorder` 整体抛出，后面的会话不再收敛，末尾 `drainCommitNotifications`（3303 行）也不执行。
- Claude 的 Stop 与所有 SessionEnd 依赖 recover 完成聚合（`recorder.ts:2976-2991`）。daemon 的 `runRecovery` 把异常吞掉（`daemon.ts:402-409`），外部看不到。

### M2. commit hook 队头阻塞，无重试上限

- `store.ts:503-529`：按 sequence 串行投递，某条一直非 0 退出就 `return`，后面全部卡住，只有一行日志。

### M3. ACK 游标绑定 bundle 内容指纹

- `commit-hook-grant.ts:93`：指纹 = entry + 全部 files 的 sha256；`store.ts:400-433` ACK 按指纹隔离。改一行 uploader → 新身份 → 从 sequence 1 全量重投。
- bundle 校验失败时只写日志（`recorder.ts:3155-3163`），`drainCommitNotifications` 拿不到 hook，返回 `pending: 0`，看起来像「没有积压」。

### M4. ACK 只代表回调 exit 0

- 通知只含 `recordId/sequence`（`store.ts:306-316`）；ACK 后 `records archive` 可把记录移出 `.scry/records/`。若 uploader 是「入队 ID、之后异步读文件」，归档后会找不到文件。

### M5. 回退链路接近宿主超时，且易三重处理

- shell curl（Stop 4s、其他 1s，`workspace-init.ts:204-213`）→ CLI 再试 daemon（同样 4s/1s，`scry.ts:141-153`）→ 直写等锁 3s。Stop 最坏约 11s + 处理，宿主上限 15s。
- 非 Claude Provider 的 Stop 在 hook 里同步 `finalizeOpenTurn`，git diff 截止 20s（`git.ts:26`），远超 curl 4s，于是常见「daemon 还在算 → curl 超时 → CLI 再试 → 直写进 inbox」，同一事件处理三次，靠去重兜底。

### M6. 子目录启动时找不到 hook 脚本（需实测）

- `hookCommand`（`workspace-init.ts:221-224`）用 `${CODEX_PROJECT_DIR:-$PWD}` 等。若 Provider 不设该变量且从子目录启动，`$PWD/.scry/provider-hook.sh` 不存在，`sh` 退出 127，整段会话不采集。

## 低

- **L1** 长路径：socket 超过 100 字节时 daemon 改用 `$TMPDIR` 下的哈希路径（`daemon.ts:124-137`），shell 只检查 `$workspace/.scry/recorder-v1.sock`（`workspace-init.ts:203`），快路径永远失效，每事件启动一次 Node。
- **L2** runtime 状态不 fsync：`open.json` / `state.json` / orphan 用 `sync:false`（如 `recorder.ts:2206-2207`、`2971`）。与 H1 叠加时，崩溃会造成整轮静默丢失。
- **L3** `commitRecord` 在 commit 锁内全量 `readdir`（`store.ts:281`），drain 与 status 同样 O(N)。
- **L4** 投递每条 spawn 一次、串行、10s 超时。
- **L5** live PID 持锁超 5 分钟会被抢占（`io.ts:166-173`），没有 fencing。

## 设计与覆盖面

- hook 写在每个 checkout 的本地配置（如 `.claude/settings.local.json`），每个 clone / worktree 都要单独 `init`；Codex 需人工 `/hooks` 信任。新同事、新 worktree 完全没数据，端上不报错。
- `discoverRepositories` 默认 `maxDepth: 2`（`config.ts:223`），更深的子仓库静默不在采集范围内；record 里看不出「本轮应该有几个仓库、实际采了几个」。
- 日常数据（见 `docs/performance-experiments/20261021-cli-multirepo-concurrency.md`）：6,691 份仓库快照中 353 份 timeout、67 份 failed。diff 证据缺失需要在 record 中如实可见。
- 建议服务端按 `installationId + workspaceId` 检查 `sequence` 连续性，做端到端对账（不在本仓库）。
