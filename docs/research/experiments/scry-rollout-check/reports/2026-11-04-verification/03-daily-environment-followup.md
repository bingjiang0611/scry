## 11. 用户授权后的日常环境处理（2026-11-04T13:40Z 之后）

用户答复：「1.可以 2.3.qoder现在登录上先跳过」，随后告知「qoder可以了」。因此本节做完了三件事：把 `~/.local` 升到 0.2.57/0.2.10（11.1）、对 <user-workspace> 的 2210 条死信执行红投（11.3，结论：做不到）、Qoder 最小复现 2 轮（11.7，结论：根因在 Qoder `-p` 模式）。

### 11.1 升级动作与验证

| 动作 | 结果 | 证据 |
|---|---|---|
| `npm install -g --prefix ~/.local <recorder 内部包名>@0.2.57 <uploader 包名>@0.2.10` | exit 0 | `<evidence-root>/before-daily/` 存升级前版本号 |
| `~/.local/lib/node_modules/<recorder 内部包名>` | 0.2.53 → **0.2.57** | `~/.local/bin/scry --version` = 0.2.57 |
| `~/.local/lib/node_modules/<uploader 包名>` | 0.2.8 → **0.2.10** | 直接跑 `dist/cli.js --version` = 0.2.10 |
| 陈旧 re-exec 副本 `~/.local/lib/.scry-cli-updates/%40ali%2Fscry-turn-recorder/0.2.56-JK58P5` | 移到 `<evidence-root>/before-daily/staged-recorder-0.2.56/`，`~/.local/lib/.scry-cli-updates` 已无副本 | `~/.local/bin/scry --version` 仍是 0.2.57 |
| launchd `com.scry.uploader` 的 `ProgramArguments[1]` | 指向 `~/.local/lib/node_modules/<uploader 包名>/dist/cli.js`，升级后即 0.2.10，plist 无需改写 | `plutil -p`、`launchctl print` `runs = 15` `last exit code = 0` |
| 四个入口版本一致 | `nvm scry` 0.2.57、`~/.local/bin/scry` 0.2.57、`nvm scry-upload` 0.2.10、`~/.local/bin/scry-upload` 0.2.10 | 逐一 `--version` |

**F2 的 `~/.local` 部分已修好**：Pi 集成 `executable()` 偏好的 `~/.local/bin/scry` 现在就是 0.2.57，0.2.56 staging 副本已不存在。

**F2 的第二半：App 侧的记录器也走 `~/.local`**。<user-workspace> 的记录器守护进程命令行是
`node ~/.local/lib/node_modules/<recorder 内部包名>/dist/cli/scry.js recorder serve --workspace <user-workspace> --socket …/.scry/recorder-v1.sock`（pid 69078，已运行 2 天），而 `…/.scry/recorder-v1.sock.owner.json` 写的是 `recorderVersion: 0.2.56`。也就是说 App 不是用自带副本，而是启动我刚刚升级的那个路径。
结论：**守护进程重启后就会用 0.2.57（F2 实际被修好），但当前活着的进程仍然是 0.2.56**。重启它等于打断用户正在用的录制会话，本次未做，留给用户决定。

### 11.2 我自己的操作事故（已修复，如实记录）

`~/.local/bin/scry-upload` 原本是指向 `~/.local/share/scry-uploader/versions/0.2.10/` 的 bash 包装脚本。我用 `cp` 把备份复制回该路径时，`~/.local/bin/scry-upload` 当时已被 npm 改写成**符号链接**，`cp` 穿透链接，把 `~/.local/lib/node_modules/<uploader 包名>/dist/cli.js` 覆盖成了那 190 字节脚本。后果：所有走该路径的 uploader 调用都变成 `SyntaxError: Unexpected token '.'`（`<evidence-root>/logs/daily-worker-direct.log`）。

修复：重新 `npm install -g --prefix ~/.local <uploader 包名>@0.2.10`（`dist/cli.js` 恢复为 7021 字节 JS，`--version` = 0.2.10），再用 `rm` + `install -m 700` 写回包装脚本（不再穿透链接）。复验：包装脚本仍指向 `versions/0.2.10`，`--version` = 0.2.10。
教训（已写进本轮操作）：恢复文件前先确认目标是否已变成符号链接。

### 11.3 死信红投：做不到（与版本无关）

- `scry-upload redrive --workspace <user-workspace> --record-id 746acf55…`：exit 3，`reason: payload_unavailable`。
- 全量 `redrive`：`redriven: 0`、`skipped: 2208`，原因全部是 `payload_unavailable`（`<evidence-root>/logs/daily-redrive-full.log`）。
- 根因：`<evidence-root>N/.scry/upload/payloads/` **0 个文件**；2211 个死信文件里只有 2 个（`discovery` 类）带 `payloadPath`，且这两个也不存在。
- 死信构成：`remote_conflicted` 2206、`oversize_record` 1、`oversize_after_redaction` 1、`export_rejected_record` 2（1 个无法解析）。其中 2206 条是服务端返回 `conflicted`，即使有载荷重投也会再次冲突。
- 结论：升级 uploader 不能让这 2210 条复活；要恢复只能从记录源重新生成载荷，而源记录的内容 blob 也已缺失（见 11.4）。**不存在"升级后重投即可清空死信"的路径，推广文档不应暗示有。**

### 11.4 新发现 F8（本文第 6 节）：缺 blob 卡死导出游标

用户工作区当前状态（升级后仍在）：`health.json` → `enqueuedThrough: 2725`、`lastFailureCode: discovery_blocked`、`lastFailureTransportStage: export`、`lastSuccessAt: 2026-11-04T13:08`；`status` → `jobs 1`、`dead 2210`。直接调用 `enqueueSnapshot()` 复现出真正的错误（不是"没有变更"，是硬错）：

```
ERROR code= ENOENT
message= ENOENT: no such file or directory, realpath '…/.scry/content/sha256/11/11c7625e….bin'
  at captureContent …/uploader/dist/content.js:80
  at retainContent …/uploader/dist/custody/index.js:45
```

逐条统计见 `<evidence-root>/evidence/06-content-blob-gap.json`：seq > 2725 的 90 条记录中，38 条上传失败的记录**全部** `contentRef` 缺失（12–228 个，全缺），52 条上传成功的记录 blob **全部完整**。旁证：recorder 自己的 `health.json` 已有 `droppedEvents 4163`、`orphanEvents 28798`、`pendingCount 4`、`oldestPendingAgeMs 4848399882`（约 56 天）。

这是本轮验证之外、但会直接决定"能不能推广"的事实：**一条内容文件缺失的记录就能把整个工作区的快照对账永久钉死，而且没有任何隔离/降级/告警，只有每 60 秒一条同样的错误。**

### 11.5 现场与备份

- 升级前状态备份在 `<evidence-root>/before-daily/`：`local-bin-scry.js`、`local-bin-scry-upload.js`、`com.scry.uploader.plist`、`workspaces.json`、`local-recorder-version.txt`（0.2.53）、`local-uploader-version.txt`（0.2.8）、`staged-recorder-0.2.56/`。
- 未处理的陈旧副本：`~/.local/opt/node-v22.23.1-darwin-arm64/lib/node_modules/<recorder 内部包名>` 仍是 0.2.8。它不在 PATH、不被 `~/.local/bin/scry` 或 launchd 引用，本次未动；如需彻底清掉需另行确认。
- 被我终止的陈旧进程：`pid 81857`（23 小时、0% CPU、`_worker` 0.2.8、持有 <user-workspace> 的 `standalone.lock.native`），SIGTERM 后正常退出，未强杀。
- 新增日志证据：`<evidence-root>/logs/daily-{flush1,flush2,flush3,worker-direct,recover-direct,redrive-sample,redrive-full,enqueue-repro}.log`。

### 11.6 需要用户决定

<user-workspace> 的 38 条记录（2026-11-02T08:15Z 起，含今天的轮次）内容已不可恢复，因此无法上传；它们的记录文件还留在 `.scry/records`，而导出游标被第一条坏记录钉死。可选：

1. **隔离坏记录**（把 seq 2726 起的 38 个记录文件移到备份目录，让导出游标前进）——这会让这 38 轮从 App 的本地历史里消失，属于删数据，需要用户明确同意。
2. **不动**，接受每 60 秒一次的 `discovery_blocked`，以及这 38 轮永不上传。
3. **等上游修**：uploader 应对"内容文件缺失"走隔离（像 `export_rejected_record` 那样跳过并记死信），这是代码改动，不在本轮授权范围。

### 11.7 Qoder 最小复现（用户告知"qoder 可以了"后执行，2 轮）

前置：`qodercli --version` = **1.1.83**（签名 `Signed in Browser Login`）；在 `<evidence-root>/a` 重跑 `scry init --providers qoder`，`.qoder/settings.json` 的 hooks 为 `UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop, SessionEnd`（**Stop 已注册**）。用 `~/.local/bin/scry` = 0.2.57。

| 轮 | 场景 | 结果 | 证据 |
|---|---|---|---|
| 78 | `qodercli -p "只回复一行 MARK-…" --permission-mode bypass_permissions` | 命令 exit 0、回复正常返回；记录 `seq 29` 生成了，但 `status: interrupted`、`termination.value.reason: session_end`（`source: lifecycle_hooks`、`completedAtSource: recorder_observed_terminal`） | `<evidence-root>/logs/f1-qoder-round1.out`、`<evidence-root>/a/.scry/records/00000000000000000029-173082db….json` |
| 79 | 同一 `-p` 模式，跑 `sleep 4 ×4`，22 秒后对 CLI 进程发 **一次 SIGINT**（从未 SIGTERM） | 进程 4 秒内正常退出；**没有生成记录**；新增一个 `status: open` 的 turn 目录（`2747345b-1e87-40dd-97ee-1e464652712d-e4bfec3aacda`，`turnIndex 1`，14:26:23 起） | `<evidence-root>/a/.scry/runtime/qoder/2747345b-…/open.json`、`<evidence-root>/logs/f1-qoder-round2.out` |

**第 78 轮的决定性证据**——记录里实际收到的 hook 只有两个：

```
UserPromptSubmit  14:25:26.195Z
SessionEnd        14:25:40.775Z      ← 没有 Stop
```

`hooks.status: partial`、`omissionReason: "provider only delivered hook lifecycle events; per-hook command, outcome and exit code were not observable"`。

结论（F1 定性完成）：
- **根因在 Qoder 侧，不在 recorder**。Qoder CLI 1.1.83 的非交互 `-p` 模式不派发 `Stop`，recorder 只能靠 `SessionEnd` 收尾，于是正常完成的一轮被标成 `interrupted`。
- 用户截图证明**交互模式是会跑 Stop hooks 的**（`Running Stop hooks… 2/2`），所以这是 `-p` 模式的事件缺口，不是 Hook 没配好。
- 被 SIGINT 的 `-p` 轮连 `SessionEnd` 都没有，recorder 只能保留 open turn，记录彻底消失；这解释了第 3 步"被接受的中途停止轮无记录"。
- 上传侧没问题：第 78 轮的记录正常入队（`outbox 1`、`dead 0`、`lastError` 无），第 3 步的 2 条 Qoder 记录当时也都 `uploaded` + `remoteStatus: inserted`。

**F6 同步复现**：此时 `<evidence-root>/a` 有 **6 个** stale open turn（含 2 天前的 5 个），但 `scry doctor --workspace <evidence-root>/a --json` 仍返回 `status: healthy`、`staleOpenTurns: []`、`health.orphanEvents: 0`。丢弃的 Qoder 轮次在 `doctor` 里完全不可见。

**副作用与预算**：这两轮把 `<evidence-root>/a` 的 open turn 从 5 增至 6，`records` 仍 29。真实 Provider 轮次累计 **79 / 80**（Codex 45、Pi 23、Qoder 4、OpenCode 0，另 7 次无记录调用）。

---

返回 [索引](README.md)。
