# 批次 E：投递链路（H3、M2、M3、M4）

分支：`reliability/collection`。2026-10-25 用户已回答 uploader 行为的三个问题，本文据此重写。

## 用户确认的 uploader 行为（2026-10-25）

uploader 不在本仓库，位于团队工作区的 `.claude/hooks/scry_turn_uploader.py`、`.claude/hooks/scry-record-committed.py`、`agent-adapters/shims/run-hook-async.py`。

**核心结论：recorder 拿到的 ACK 只保证「通知任务已入队」，既不保证完整记录已被接管，也不保证已经上传。**

| 问题 | 答案 | 依据（用户提供） |
|---|---|---|
| Q1 env 缺失时怎么退出 | `SCRY_TURN_UPLOAD_ENABLED` 未设置时默认开启；`SCRY_INSTALLATION_ID` 缺失时自动生成并固定在 `.scry/upload/installation.json`。**显式设置 `SCRY_TURN_UPLOAD_ENABLED=0` 时返回 0、不上传，recorder 照常推进 ACK。** 另外，uploader 对部分不可重试的错误也返回 0。 | `scry_turn_uploader.py:496、969`，`scry-record-committed.py` |
| Q2 ACK 前保存了什么 | commit hook 返回 0 之前只入队一个异步任务，内容是 `recordId`、`sequence` 等标识，**没有正文**。worker 之后才把完整 record 序列化进 `.scry/upload/outbox/`，持久化后推进自己的游标。即使正文已经在 outbox 里，`require_committed_record()` 仍会回源到 `.scry/records/` 校验，原记录被归档后校验失败，发送会被阻止。 | `run-hook-async.py:319、893`，`scry_turn_uploader.py:386–473` |
| Q3 归档与脚本改动 | 仓库里没有自动归档的配置，本机也没有归档状态文件，但不能排除有人手动归档。uploader 有 21 个相关提交，改动不算少。指纹变化后 recorder 会重投所有仍保留的记录通知；uploader 有自己的游标，不会因此重传正文，但每条通知都会触发一次回源校验。 | — |

## 据此调整的风险判断

- **H3（daemon env 串会话）范围缩小，但仍然成立。** 变量缺失不是问题；问题出在会话 A 显式设置了 `SCRY_TURN_UPLOAD_ENABLED=0` 并且恰好冷启动了 daemon：之后同一 workspace 里其他会话的记录也会带着 `=0` 投递，被 ACK 但不上传。反过来，A 想关闭上传，结果 daemon 用的是别人的 env，A 的记录照样被上传。
- **M4（ACK 与归档的竞态）确认存在，而且比原先判断的更严重**：正文进 outbox 之后，归档仍然会因为回源校验失败而阻止发送。
- **新增 U3：不可重试错误返回 0。** recorder 视角看这条记录已投递，实际上被丢掉了。需要 uploader 侧确认这类错误会进入 dead letter 并且可查。
- **M3 降级为低优先级**：重投只带来重复校验的开销，不会重传正文。
- **M2 降级为低优先级**：commit hook 只负责入队，几乎总是返回 0，在 recorder 层出现队头阻塞的可能性很小。

## 任务

### recorder 侧（本仓库，执行方在本分支做）

**E1（H3）上传相关 env 按轮次快照。**
- 开始事件时，把 `COMMIT_HOOK_ENV_KEYS` 中与上传相关的键（至少包括 `SCRY_TURN_UPLOAD_ENABLED`、`SCRY_INSTALLATION_ID`、`SCRY_INSTALLATION_ID_FILE`、`RATE_NATIVE_ASYNC_QUEUE_DIR`、`TMCP_TRACE_URL`、`SCRY_UPLOAD_*`）快照进 `open.json`，提交时随记录保存到旁路文件（不写进 record 正文，避免凭据或 URL 进入分析数据）。投递时用这条记录自己的快照，而不是 daemon 进程的 env。
- shell 快路径要把这些键带给 daemon（例如放进 header，或者在 body 外包一层）。不能新增进程启动，只能用 shell 内建操作。
- 会话级的 `SCRY_RECORDER_ENABLED=0` 也要能经由快路径生效。
- **先证实**：daemon 用 env A（`SCRY_TURN_UPLOAD_ENABLED=0`）启动，会话 B（没有设置该变量）的一轮经快路径提交，断言 commit hook 收到的 env 里是 B 的值。旧实现收到的是 A 的值。

**E2（M4 recorder 部分）通知带上内容指纹。**
- `RecordCommittedNotification` 新增 `recordPath`（相对于 dataRoot）和 `sha256`（record 文件内容的哈希），让 commit hook 不必扫描目录就能接管并校验正文。schema 版本递增，保持向后兼容（旧字段不变）。
- README 写清楚 ACK 的语义：**hook exit 0 表示「已接管完整记录」**。这是 uploader 侧 U1 完成后才成立的约定。在那之前，归档前要先人工确认 uploader 的 outbox 已经覆盖待归档的记录（README 现有归档章节补充这一句）。

**E3（M3、M2）**：2026-10-25 起 M2 部分改为必做。新 uploader（`reliability/uploader`）把「正文已接管」作为 ACK 前提，哈希不符、路径不符、源文件缺失时会持续返回非 0；recorder 现在遇到非 0 就停在该 sequence，后面的记录全部卡住（`store.ts:515-521`）。至少要做到：按 sequence 计失败次数，超过阈值把该条移入 recorder 侧死信并继续投递后面的记录，doctor 报出「卡在哪个 sequence、失败几次」。稳定 `commitHook.id`（M3）仍可选。原文：配置增加稳定的 `commitHook.id` 作为 ACK key，与 trust 指纹分离（trust 指纹仍然每次校验，fail closed）；按 sequence 计失败次数，超过阈值进入 recorder 侧死信。执行方评估成本后决定做或放弃，放弃时在 STATUS 写明理由。

### uploader 侧（不在本仓库，需要用户决定由谁、在哪个仓库做）

- **U1 ACK 即接管**：`scry-record-committed.py` 在返回 0 之前，把完整 record 复制进 `.scry/upload/outbox/`（原子写加 fsync），并用 E2 提供的 `sha256` 校验。之后 recorder 的 ACK 才真正等于「正文已接管」。
- **U2 回源校验不阻止发送**：`require_committed_record()` 改为校验 outbox 副本的 sha256；原记录不在 `records/` 时，到归档目录按 `manifest.json` 查找，不能仅因为原记录已被归档就阻止发送。
- **U3 不可重试错误进入 dead letter**：确认每一种返回 0 的不可重试错误都会写入 dead letter，带上原因和 recordId，并且有计数或日志可查，不会被静默丢弃。
- **U4 区分显式关闭**：`SCRY_TURN_UPLOAD_ENABLED=0` 时，在 `.scry/upload/` 下记一条 `skipped_disabled`（recordId 和时间），让分析侧能区分「主动关闭」和「丢失」。

## 顺序

E1 → E2 → E3（可选），在 C、D 之后做。uploader 侧的 U1–U4 与 recorder 侧相互独立，可以并行；其中 U1 依赖 E2 的通知字段，但也可以先用 `recordId` 自行定位 record，不必等 E2。

红线：commit hook 的 trust 校验继续 fail closed（CLAUDE.md「权限与 trust 不是一回事」）；ACK 语义仍是至少一次；不把上传相关的 env 值写进 record 正文。
