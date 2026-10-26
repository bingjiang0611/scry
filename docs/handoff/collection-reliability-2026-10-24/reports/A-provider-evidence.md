### 每一步的诊断原始字段

日志中 A2/A3/A4 对应前文 A-2/A-3/A-4。after-terminal-grace 为按终态时间确认后的收敛检查；log-archived 为把 skip 日志移到 evidence 目录之后的健康检查。原先的 skip 条目并未删除，更没有删除 records 来清告警。

#### OpenCode 1.18.31

以下标签对应 `/tmp/scry-A-manual.dx5bmD/opencode-authorized/logs/<标签>-snapshot.json`，其同名前缀的各 CLI `.stdout/.stderr/.meta.json` 是原始命令证据。

```jsonl
{"step":"A1","turnsList":{"exit":0,"count":0},"health":{"droppedEvents":0,"orphanEvents":0,"missingStartTerminals":0,"pendingCount":1,"recoveredRecords":0,"lastError":null},"recover":{"exit":0,"recovered":0,"pending":1,"expired":0},"doctor":{"status":"degraded","healthy":false,"hookSkips":{"count":0,"lastAt":null,"scope":"retained_log_window","truncated":false},"exit":5,"hook.skips":"pass"}}
{"step":"A1-after-grace","turnsList":{"exit":0,"count":0},"health":{"droppedEvents":0,"orphanEvents":0,"missingStartTerminals":0,"pendingCount":1,"recoveredRecords":0,"lastError":null},"recover":{"exit":0,"recovered":0,"pending":1,"expired":0},"doctor":{"status":"degraded","healthy":false,"hookSkips":{"count":0,"lastAt":null,"scope":"retained_log_window","truncated":false},"exit":5,"hook.skips":"pass"}}
{"step":"A2","turnsList":{"exit":0,"count":1},"health":{"droppedEvents":0,"orphanEvents":0,"missingStartTerminals":0,"pendingCount":0,"recoveredRecords":1,"lastError":null},"recover":{"exit":0,"recovered":1,"pending":0,"expired":0},"doctor":{"status":"error","healthy":false,"hookSkips":{"count":2,"lastAt":"2026-10-25T06:40:22Z","scope":"retained_log_window","truncated":false},"exit":5,"hook.skips":"fail"}}
{"step":"A3","turnsList":{"exit":0,"count":1},"health":{"droppedEvents":0,"orphanEvents":1,"missingStartTerminals":1,"pendingCount":0,"recoveredRecords":1,"lastError":{"at":"2026-10-25T06:41:23.337Z","message":"orphan recorder event: Stop (missing_start)"}},"recover":{"exit":0,"recovered":0,"pending":0,"expired":0},"doctor":{"status":"error","healthy":false,"hookSkips":{"count":2,"lastAt":"2026-10-25T06:40:22Z","scope":"retained_log_window","truncated":false},"exit":5,"hook.skips":"fail"}}
{"step":"A4-invalid","turnsList":{"exit":1,"count":null,"stderr":"scry: recorder storage unavailable: invalid_config (Expected property name or '}' in JSON at position 1 (line 1 column 2))\n"},"health":{"droppedEvents":0,"orphanEvents":1,"missingStartTerminals":1,"pendingCount":0,"recoveredRecords":1,"lastError":{"at":"2026-10-25T06:41:23.337Z","message":"orphan recorder event: Stop (missing_start)"}},"recover":{"exit":0,"recovered":0,"pending":0,"expired":0},"doctor":{"status":"error","healthy":false,"hookSkips":{"count":4,"lastAt":"2026-10-25T06:42:06.178Z","scope":"retained_log_window","truncated":false},"exit":3,"hook.skips":null}}
{"step":"A4-restored-confirmed","turnsList":{"exit":0,"count":1},"health":{"droppedEvents":0,"orphanEvents":1,"missingStartTerminals":1,"pendingCount":1,"recoveredRecords":1,"lastError":null},"recover":{"exit":0,"recovered":0,"pending":1,"expired":0},"doctor":{"status":"error","healthy":false,"hookSkips":{"count":4,"lastAt":"2026-10-25T06:42:06.178Z","scope":"retained_log_window","truncated":false},"exit":5,"hook.skips":"fail"}}
{"step":"A4-after-terminal-grace","turnsList":{"exit":0,"count":2},"health":{"droppedEvents":0,"orphanEvents":1,"missingStartTerminals":1,"pendingCount":0,"recoveredRecords":2,"lastError":null},"recover":{"exit":0,"recovered":1,"pending":0,"expired":0},"doctor":{"status":"error","healthy":false,"hookSkips":{"count":4,"lastAt":"2026-10-25T06:42:06.178Z","scope":"retained_log_window","truncated":false},"exit":5,"hook.skips":"fail"}}
{"step":"A4-log-archived","turnsList":{"exit":0,"count":2},"health":{"droppedEvents":0,"orphanEvents":1,"missingStartTerminals":1,"pendingCount":0,"recoveredRecords":2,"lastError":null},"recover":{"exit":0,"recovered":0,"pending":0,"expired":0},"doctor":{"status":"healthy","healthy":true,"hookSkips":{"count":0,"lastAt":null,"scope":"retained_log_window","truncated":false},"exit":0,"hook.skips":"pass"}}
```

`hook-skip.log` 原文（A-2 的前两行在 A-3 不变；其余为 A-4 新增；清告警前原样保存到 `logs/preserved-hook-skip.log`）：

```text
2026-10-25T06:40:19Z	opencode	UserPromptSubmit	cli_not_executable	0
2026-10-25T06:40:22Z	opencode	Stop	cli_not_executable	0
2026-10-25T06:42:02.682Z	opencode	UserPromptSubmit	invalid_config	0
2026-10-25T06:42:06.178Z	opencode	Stop	invalid_config	0
```

#### Qoder 1.1.73

以下标签对应 `/tmp/scry-A-manual.dx5bmD/qoder/logs/<标签>-snapshot.json`，其同名前缀的各 CLI `.stdout/.stderr/.meta.json` 是原始命令证据。

```jsonl
{"step":"A1","turnsList":{"exit":0,"count":0},"health":{"droppedEvents":0,"orphanEvents":0,"missingStartTerminals":0,"pendingCount":1,"lastError":null},"recover":{"exit":0,"recovered":0,"pending":1,"expired":0},"doctor":{"status":"degraded","healthy":false,"hookSkips":{"count":0,"lastAt":null,"scope":"retained_log_window","truncated":false},"exit":5,"hook.skips":"pass"}}
{"step":"A1-after-grace","turnsList":{"exit":0,"count":1},"health":{"droppedEvents":0,"orphanEvents":0,"missingStartTerminals":0,"pendingCount":0,"recoveredRecords":1,"lastError":null},"recover":{"exit":0,"recovered":1,"pending":0,"expired":0},"doctor":{"status":"healthy","healthy":true,"hookSkips":{"count":0,"lastAt":null,"scope":"retained_log_window","truncated":false},"exit":0,"hook.skips":"pass"}}
{"step":"A2","turnsList":{"exit":0,"count":1},"health":{"droppedEvents":0,"orphanEvents":0,"missingStartTerminals":0,"pendingCount":0,"recoveredRecords":1,"lastError":null},"recover":{"exit":0,"recovered":0,"pending":0,"expired":0},"doctor":{"status":"error","healthy":false,"hookSkips":{"count":2,"lastAt":"2026-10-25T06:29:23Z","scope":"retained_log_window","truncated":false},"exit":5,"hook.skips":"fail"}}
{"step":"A3","turnsList":{"exit":0,"count":1},"health":{"droppedEvents":0,"orphanEvents":1,"missingStartTerminals":1,"pendingCount":0,"recoveredRecords":1,"lastError":{"at":"2026-10-25T06:30:40.059Z","message":"orphan recorder event: Stop (missing_start)"}},"recover":{"exit":0,"recovered":0,"pending":0,"expired":0},"doctor":{"status":"error","healthy":false,"hookSkips":{"count":2,"lastAt":"2026-10-25T06:29:23Z","scope":"retained_log_window","truncated":false},"exit":5,"hook.skips":"fail"}}
{"step":"A4-invalid","turnsList":{"exit":1,"count":null,"stderr":"scry: recorder storage unavailable: invalid_config (Expected property name or '}' in JSON at position 1 (line 1 column 2))\n"},"health":{"droppedEvents":0,"orphanEvents":1,"missingStartTerminals":1,"pendingCount":0,"recoveredRecords":1,"lastError":{"at":"2026-10-25T06:30:40.059Z","message":"orphan recorder event: Stop (missing_start)"}},"recover":{"exit":0,"recovered":0,"pending":0,"expired":0},"doctor":{"status":"error","healthy":false,"hookSkips":{"count":6,"lastAt":"2026-10-25T06:38:35.228Z","scope":"retained_log_window","truncated":false},"exit":3,"hook.skips":null}}
{"step":"A4-restored-confirmed","turnsList":{"exit":0,"count":1},"health":{"droppedEvents":0,"orphanEvents":1,"missingStartTerminals":1,"pendingCount":1,"recoveredRecords":1,"lastError":null},"recover":{"exit":0,"recovered":0,"pending":1,"expired":0},"doctor":{"status":"error","healthy":false,"hookSkips":{"count":6,"lastAt":"2026-10-25T06:38:35.228Z","scope":"retained_log_window","truncated":false},"exit":5,"hook.skips":"fail"}}
{"step":"A4-after-terminal-grace","turnsList":{"exit":0,"count":2},"health":{"droppedEvents":0,"orphanEvents":1,"missingStartTerminals":1,"pendingCount":0,"recoveredRecords":2,"lastError":null},"recover":{"exit":0,"recovered":1,"pending":0,"expired":0},"doctor":{"status":"error","healthy":false,"hookSkips":{"count":6,"lastAt":"2026-10-25T06:38:35.228Z","scope":"retained_log_window","truncated":false},"exit":5,"hook.skips":"fail"}}
{"step":"A4-log-archived","turnsList":{"exit":0,"count":2},"health":{"droppedEvents":0,"orphanEvents":1,"missingStartTerminals":1,"pendingCount":0,"recoveredRecords":2,"lastError":null},"recover":{"exit":0,"recovered":0,"pending":0,"expired":0},"doctor":{"status":"healthy","healthy":true,"hookSkips":{"count":0,"lastAt":null,"scope":"retained_log_window","truncated":false},"exit":0,"hook.skips":"pass"}}
```

`hook-skip.log` 原文（A-2 的前两行在 A-3 不变；其余为 A-4 新增；清告警前原样保存到 `logs/preserved-hook-skip.log`）：

```text
2026-10-25T06:29:17Z	qoder	UserPromptSubmit	cli_not_executable	0
2026-10-25T06:29:23Z	qoder	Stop	cli_not_executable	0
2026-10-25T06:37:10.464Z	qoder	UserPromptSubmit	invalid_config	0
2026-10-25T06:37:16.048Z	qoder	Stop	invalid_config	0
2026-10-25T06:38:30.372Z	qoder	UserPromptSubmit	invalid_config	0
2026-10-25T06:38:35.228Z	qoder	Stop	invalid_config	0
```

#### Codex 0.164.0

以下标签对应 `/tmp/scry-A-manual.dx5bmD/codex/logs/<标签>-snapshot.json`，其同名前缀的各 CLI `.stdout/.stderr/.meta.json` 是原始命令证据。

```jsonl
{"step":"A1","turnsList":{"exit":0,"count":1},"health":{"droppedEvents":0,"orphanEvents":0,"missingStartTerminals":0,"pendingCount":0,"lastError":null},"recover":{"exit":0,"recovered":0,"pending":0,"expired":0},"doctor":{"status":"healthy","healthy":true,"hookSkips":{"count":0,"lastAt":null,"scope":"retained_log_window","truncated":false},"exit":0,"hook.skips":"pass"}}
{"step":"A2","turnsList":{"exit":0,"count":1},"health":{"droppedEvents":0,"orphanEvents":0,"missingStartTerminals":0,"pendingCount":0,"recoveredRecords":0,"lastError":null},"recover":{"exit":0,"recovered":0,"pending":0,"expired":0},"doctor":{"status":"error","healthy":false,"hookSkips":{"count":2,"lastAt":"2026-10-25T06:29:03Z","scope":"retained_log_window","truncated":false},"exit":5,"hook.skips":"fail"}}
{"step":"A3","turnsList":{"exit":0,"count":1},"health":{"droppedEvents":0,"orphanEvents":1,"missingStartTerminals":1,"pendingCount":0,"recoveredRecords":0,"lastError":{"at":"2026-10-25T06:30:20.616Z","message":"orphan recorder event: Stop (missing_start)"}},"recover":{"exit":0,"recovered":0,"pending":0,"expired":0},"doctor":{"status":"error","healthy":false,"hookSkips":{"count":2,"lastAt":"2026-10-25T06:29:03Z","scope":"retained_log_window","truncated":false},"exit":5,"hook.skips":"fail"}}
{"step":"A4-invalid","turnsList":{"exit":1,"count":null,"stderr":"scry: recorder storage unavailable: invalid_config (Expected property name or '}' in JSON at position 1 (line 1 column 2))\n"},"health":{"droppedEvents":0,"orphanEvents":1,"missingStartTerminals":1,"pendingCount":0,"recoveredRecords":0,"lastError":{"at":"2026-10-25T06:30:20.616Z","message":"orphan recorder event: Stop (missing_start)"}},"recover":{"exit":0,"recovered":0,"pending":0,"expired":0},"doctor":{"status":"error","healthy":false,"hookSkips":{"count":6,"lastAt":"2026-10-25T06:38:15.079Z","scope":"retained_log_window","truncated":false},"exit":3,"hook.skips":null}}
{"step":"A4-restored-confirmed","turnsList":{"exit":0,"count":2},"health":{"droppedEvents":0,"orphanEvents":1,"missingStartTerminals":1,"pendingCount":0,"recoveredRecords":0,"lastError":null},"recover":{"exit":0,"recovered":0,"pending":0,"expired":0},"doctor":{"status":"error","healthy":false,"hookSkips":{"count":6,"lastAt":"2026-10-25T06:38:15.079Z","scope":"retained_log_window","truncated":false},"exit":5,"hook.skips":"fail"}}
{"step":"A4-log-archived","turnsList":{"exit":0,"count":2},"health":{"droppedEvents":0,"orphanEvents":1,"missingStartTerminals":1,"pendingCount":0,"recoveredRecords":0,"lastError":null},"recover":{"exit":0,"recovered":0,"pending":0,"expired":0},"doctor":{"status":"healthy","healthy":true,"hookSkips":{"count":0,"lastAt":null,"scope":"retained_log_window","truncated":false},"exit":0,"hook.skips":"pass"}}
```

`hook-skip.log` 原文（A-2 的前两行在 A-3 不变；其余为 A-4 新增；清告警前原样保存到 `logs/preserved-hook-skip.log`）：

```text
2026-10-25T06:29:00Z	codex	UserPromptSubmit	cli_not_executable	0
2026-10-25T06:29:03Z	codex	Stop	cli_not_executable	0
2026-10-25T06:36:51.766Z	codex	UserPromptSubmit	invalid_config	0
2026-10-25T06:36:55.061Z	codex	Stop	invalid_config	0
2026-10-25T06:38:11.324Z	codex	UserPromptSubmit	invalid_config	0
2026-10-25T06:38:15.079Z	codex	Stop	invalid_config	0
```

### 收尾、限制与留给用户决定的事

- 三个正式仓库最终各 2 条 record、1 个 orphan，droppedEvents=0、orphanEvents=1、missingStartTerminals=1、pendingCount=0；doctor healthy、退出 0。旧 skip 日志已原样移至各自 logs/preserved-hook-skip.log，原始错误、失败请求和字段投影都还在 RUN 下。
- 临时 Codex app-server 使用其原生 daemon stop 停止（status=stopped）；随后对仍存活的测试 TUI 和 pid-update-loop，逐 PID 重验 executable 与隔离 HOME 后发送 SIGTERM。最终查询确认本次三个 Provider 无存活进程，没有模糊 pkill，也没有停止日常实例。
- 临时认证副本已清理：Codex auth.json、Qoder .auth 目录、两份 OpenCode 临时 env 中的认证变量。全局 Provider 配置/认证未修改；workspace、原始本地日志、独立 worktree 保留供核验。原始 Provider stdout/transcript 可能含内容，**不上传、不纳入 Git**；报告只有必要元数据。
- 本次是三种原生 CLI 的真实非交互轮次验收，Codex 信任走真实 TUI；不是 mock、不是 Scry App/SDK 验收，也不是 daemon curl 快路径、实际工具调用或掉电测试。a21110c 的结果不能证明 B/V3 的真实 Provider 表现；V3 的时间分级由独立受控回归验证。
- **留给用户决定的事**：是否接受 A-1 在 OpenCode/Qoder 上现有的 180 秒终态宽限及随后 recover 才落盘？若标准要求终态后第一次 recover 就有 record，本次这条即时标准未通过，应另列修复，执行方没有借手验扩大生产改动。其余已授权场景已有上述结果；本轮不进入 C 或后续批次。
