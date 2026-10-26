# 批次 B 回报：inbox 与 recover 失败隔离

基线：`a21110c4`；分支：`reliability/collection`。仅做 B1 / B2，未开始 C。
实现与本地验证完成，**待用户核验**。没有执行真实 Provider 请求、安装日常 CLI、构建安装 App、开 PR 或合入 main。

## 结论与提交

| 条目 | 结论 | 证实测试提交 | 修复提交 |
|---|---|---|---|
| B1 / H4 | **已修复**：重放/读取失败不再删除原事件；隔离、有限重试，后续条目继续处理 | `549b928a` | `15fd68e2` |
| B2 / M1 | **已修复**：恢复逐会话隔离；通知投递进入 finally；daemon 后台异常写日志 | `52a0a90c` | `c93f081a` |

所有提交 author / committer 均为 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。用户另行明确授权了 **仅批次 B** 的既有大文件 pre-commit 大小门禁豁免；提交使用临时 `core.hooksPath=/dev/null`，没有修改持久配置、大小检查脚本或 recorder commit hook 的 trust gate。

## 旧实现失败证据

### B1

在只有测试的 `549b928a` 上执行：

```sh
npm run test:unit -- src/core/turn-recorder/recorder-inbox.test.ts
```

首次 6 项失败；补齐“可读首条后的 EACCES”及 ENOENT 对照后，提交前 8 项全部失败。以下为 `/tmp/scry-B1-before.log` 的输出节选，省略临时目录随机前缀：

```text
preserves a failed apply verbatim and still applies the next arrival
  ENOENT: .../inbox-failed/001792901926847-1.json
retries a failed event on the next recover and removes it only after success
  ENOENT: .../open.json
stops after five failed attempts, counts one drop, but retains the evidence and pending warning
  AssertionError: expected 1 to be 5
retains EACCES instead of deleting it, and does not block the next file
  ENOENT: .../open.json
retains invalid JSON instead of deleting it, and does not block the next file
  ENOENT: .../open.json
does not delete a non-ENOENT read failure after a readable first entry
  ENOENT: .../inbox-failed/001792901927199-2.json
skips ENOENT without a failure or drop when an entry has disappeared
  AssertionError: expected 1 to be +0
keeps a quarantine-only session eligible for daemon recovery and counts its pending age
  ENOENT: .../inbox-failed/001792901927366-1.json
Test Files  1 failed (1)
Tests       8 failed (8)
```

首次 apply 用真实 recorder / 锁 / 临时文件，只对目标 `open.json` 写入注入异常。读取测试只对指定 inbox 文件注入 EACCES；另有真实损坏 JSON。旧实现不仅删失败事件，还用首条 JSON 取得 session id，导致首条不可读时整个 inbox 不执行。ENOENT 对照证实旧实现把已消失文件也计为 dropped。

测试提交前全量：`8 failed | 3913 passed | 4 skipped`，失败均为上述新增测试；typecheck 通过。

### B2

在 B1 已修复、只有 B2 测试的 `52a0a90c` 上执行：

```sh
npm run test:unit -- src/core/turn-recorder/recorder-recovery-isolation.test.ts src/core/turn-recorder/daemon.test.ts
```

`/tmp/scry-B2-before.log` 节选：

```text
logs sync background recovery failures without stopping the daemon
  promise rejected "Error: injected sync recovery failure" instead of resolving
logs async background recovery failures without stopping the daemon
  ENOENT: .../logs/daemon.log
continues after S1 finalize fails, commits S2 and drains its trusted callback
  promise rejected "Error: injected s1 finalize failure" instead of resolving
  at commitRecord (.../recorder-recovery-isolation.test.ts:15:64)
  at finalizeOpenTurn (.../recorder.ts:2685:27)
  at Module.recoverRecorder (.../recorder.ts:3310:20)
counts a live session lock deadline as pending and continues with S2
  promise rejected "Error: lock timeout: ..." instead of resolving
  Serialized Error: { code: 'ELOCKTIMEOUT' }
drains already committed notifications even when the final health refresh throws
  ENOENT: .../notifications.jsonl
Test Files  2 failed (2)
Tests       5 failed | 19 passed (24)
```

S1 为 Claude、S2 为 Codex，使用生产遍历顺序保证先到 S1，不依赖目录排序。两者都在临时目录构造有终态边界的 closing 状态；最终提交故障只注入 S1。锁测试真实持有当前活进程的 session 锁，等待生产 10 秒 deadline；新测试从一开始就使用 15 秒预算，没有提高已有测试超时。callback 是临时脚本，经生产 activation / fingerprint gate 执行。

测试提交前全量：`5 failed | 3922 passed | 4 skipped`；typecheck 通过。没有修复原有失败。

## 改动后的行为

### B1：原事件保留在哪里

- 新增纯 Node `src/core/turn-recorder/inbox.ts`；没有改通用 `readJson` 的语义。inbox 读取仅 ENOENT 跳过；EACCES、损坏 JSON、无效事件身份均进入失败处理。
- 原文件按原名移至 `.scry/runtime/<provider>/<safeKey(sessionId)>/inbox-failed/<name>.json`，保留原始字节。旁边 `<name>.json.failure.json` 保存 `attempts`、`lastError`、`lastFailedAt`；不是正式 turn record。
- 先原子持久化失败次数，再 rename 原文件并同步源/目标目录；隔离失败时不删除源文件，写 WARN 并继续处理后续条目。未删除任何既有 fsync。
- 普通 live hook 仍重放 inbox；显式/daemon recover 合并 inbox 与 inbox-failed，按原文件名的到达序排序，每轮每条最多尝试一次。首条损坏也能按目录 session key 取得与 live hook 相同的锁。
- **最多共 5 次失败尝试（含初次）**。前 4 次不增加 `droppedEvents`；第 5 次计一次 drop、记录错误，并永久保留原文件及元数据，之后不自动重试。修复了故障且未耗尽的事件，在下一次 recover 成功后才移除事件/元数据。
- 可重试隔离事件会让 daemon 保持 recovery 资格；只有耗尽文件且没有 open turn 时，不让 daemon 永久空转。耗尽文件仍计入 pending，不能假装积压消失。
- `recorderPendingHealth` 统计原 inbox、隔离文件及已有待恢复轮次；sidecar 不计数。age 使用队列文件名中的到达时间，不用修复后的 mtime 冒充到达时间。
- `recorder status` 新增 `health`（recorder 未启用时为 null），包括刷新后的 `pendingCount`；doctor 的 `turns.pending` 对积压报 warn，文案明确是“turns or queued hooks”，耗尽文件给出检查路径。
- `.scry/logs/recorder.log` 示例：`WARN inbox pi/<sessionKey>/<name>: injected inbox apply failure`；耗尽后有 `ERROR inbox retries exhausted ...`。

**顺序取舍**：保证每一轮按到达序尝试，但早到失败项重试时可能晚于已经成功的后续项。严格跨重试 FIFO 与“不阻塞后续条目”不能同时成立，本批选择文档要求的后者。成功 apply 后、删除队列前崩溃仍可能重放；沿用生命周期去重，未承诺 exactly-once。

### B2：一个会话不能打断后续会话

- `recoverRecorder` 的 inbox admission、open-turn 锁与 finalize 包在逐会话 try/catch 中。失败会话 `pending++`，继续处理下一个；不清掉它的 closing 状态。
- 非锁超时写 `health.lastError = { at, message }` 和 `recorder.log ERROR recovery <provider>/<sessionKey>: ...`；锁超时写 WARN 并计 pending。保留待恢复证据，不虚增 `droppedEvents`。
- `drainCommitNotifications` 移到 finally。即使最后 health 刷新或 managed recovery 抛错，也尝试投递之前已提交的通知。仍使用原 activation / fingerprint 校验与 durable ACK，没有旁路。
- `daemon.ts` 的 `runRecovery` 同步/异步异常都记录到 **socket 所在目录**的 `logs/daemon.log`：`ERROR recovery: ...`；保持原来的后台容错与退避。该路径不一定是 workspace 的 `.scry/logs`。
- 没有增加恢复并行度、缩短锁超时或伪造终态。真实锁持有者仍可让当前 recover 在该会话等待最多现有 10 秒，再继续。

### 是否需要 integrations repair

B 没改生成的 hook/plugin。A 已正确接入的 workspace 不需要为 B 重新 repair；必须加载本批 CLI 代码，已有 daemon 要在测试 workspace 内重启。旧 daemon 不会因文件更新自动变成新代码。

新测试仓库直接用本分支 CLI `init`。若沿用的是 A 之前的旧 hook/plugin，按 A 报告另行 repair；不要把这当作 B 的新增要求。
