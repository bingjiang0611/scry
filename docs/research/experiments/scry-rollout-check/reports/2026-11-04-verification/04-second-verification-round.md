## 12. 推广前验证第二轮（用户新授权 20 轮）

执行范围：第 1 节只读（<user-workspace>，未改文件、未 flush、未 redrive）；第 4/5 节真实 Provider；第 6 节性能复跑。全程未改任何产品代码。

### 12.1 F8 只读调查：结论是「写到了另一个内容库」

38 条失败记录的逐条清单见 `<evidence-root>/evidence/08-f8-records.json`（seq / startedAt / recorderVersion / provider / missing / total / 与其他记录共享数）。摘要：

| 项 | 值 |
|---|---|
| 失败记录数 | 38（全部 provider=pi） |
| recorderVersion 分布 | 0.2.53 × 12、0.2.56 × 26 |
| 缺失 contentRef / 总 contentRef | 每条都是 **N/N 全缺**（最少 1，最多 228） |
| 不同缺失 hash 数 | **1715** |
| 其中被其他记录也引用的 | 60 个（47 个同时被已上传记录引用，最早 seq 1880 @ 2026-10-12） |
| 这 1715 个是否存在于工作区 `.scry/content` | **0 个** |
| 这 1715 个是否存在于 App 内容库 | **1715 个（100%）** |

App 内容库路径：`~/Library/Application Support/scry/trace-content-v1/<traceId>/content/sha256/xx/<sha>.bin`（61 个 trace 目录，317,897 个 blob）。对照：seq>2725 中**已上传**记录引用的 80 个 hash，**80/80 在工作区 `.scry/content`**（只有 24 个同时存在于 App 库）。

记录里的 `contentRef` 写的是 `{"storage":"recorder-content-v1","sha256":…}`——即声明"内容在工作区 recorder store"，但实际字节只在 App 的按 trace 分仓库里。**dangling ref 的来源是写入位置不一致，不是内容丢失。**

recorder 正文保留/清理逻辑（代码位置）：

| 位置 | 行为 | 能否删掉尚未导出的记录所引用的 blob |
|---|---|---|
| `dist/core/turn-recorder/maintenance.js:61-77` | 只删 `content/sha256/*.bin` 中 **不在 `listRecords()` 全部记录引用集合内** 且 `mtime <= now - grace` 的孤儿 | **不能**（referenced 覆盖盘上所有记录） |
| `dist/core/turn-recorder/config.js:46` | `storage.orphanGraceHours` 默认 **24h**（范围 1–8760） | 新写入的 blob 24 小时内不会成为候选 |
| `dist/cli/records-command.js:30` | 清理只由 `scry records maintain --apply` 触发（默认 dry-run）；守护进程/doctor 都不调用 | 未运行即不删 |
| `dist/core/turn-recorder/store.js:14-57` (`commitRecord`) | 只写记录 JSON，**不写内容**；内容由 finalize 阶段先写 | — |
| `dist/core/turn-recorder/content-store.js:36-63` (`writeRecorderContent`) | 写入失败直接抛错，没有静默降级 | — |
| 0.2.56 vs 0.2.57 `maintenance.js` | `diff` 为空，逐字节相同 | 不是版本差异 |
| uploader `dist/custody/index.js:320-360` (`pruneAckedBodies`) | 只删 `.scry/upload/outbox/committed/` 的**副本**，30 天以上，且写 `bodyPrunedAt` | **不碰** `.scry/content` |

blob 现状：`.scry/content` 共 2677 个 blob、13.9 MB、中位 573 B；mtime 最早 `2026-10-11T10:20:30Z`，最晚 `2026-11-04T11:37:36Z`；按天：10-27 211、10-26 325、10-12 627、10-19 553、11-02 42、11-03 36、11-04 2。

清理相关日志/字段：`<evidence-root>N/.scry/logs/*` 里**没有任何** maintenance/orphan-content 记录（只有 `orphan pi … no_matching_open_turn` 这类 hook 事件日志）。health 字段：`droppedEvents 4163`、`orphanEvents 28798`、`missingStartTerminals 29`、`pendingCount 4`、`oldestPendingAgeMs 4851271915`（≈56 天）、`recoveredRecords 475`、`lastSuccessAt 2026-11-04T14:38Z`。

**结论**：三个选项里既不是"被清理删掉"，也不是简单的"从没写入"，而是 **"写到了另一个内容库"**：App 托管的 Pi 轮次把正文写进 `trace-content-v1/<traceId>/content`，但把记录（带 `storage: recorder-content-v1` 的 ref）提交到工作区 `.scry/records`。uploader 只从工作区 `.scry/content` 读（`dist/content.js:80 captureContent` → realpath ENOENT），因此 38 条永久不可上传、导出游标钉死在 2725。**无法判断的部分**：老记录（≤2725 中 47 个共享 hash）当时在工作区存在的 blob 后来为何不在（无删除日志）。

附带发现（同一次只读 `scry doctor`，`<evidence-root>/evidence/10-doctor-<user-workspace>.json`）：
- `status: corrupt`、`healthy: false`；`verifyStore` 报 **sequence gap**（如 87、113、123…），说明 `.scry/records` 历史上也有文件缺失。
- 43 条 recorder dead letter（最新 20 条含 sequence 2813、2807、2806，各 5 次失败尝试）。
- 43 个 stale open turn（最老 2026-10-11，≈580h）：codex 37、pi 4、qoder 2。

### 12.2 F6 判定：doctor 符合规则，规则本身让新丢的轮次 24h 内不可见

修正上一版报告的计数：`<evidence-root>/a` 的 `runtime/qoder` 下是 6 个**目录**，但只有 **3 个是 open turn**（其余 3 个是已收尾 session，没有 `open.json`）。

| provider | sessionId | startedAt | 年龄 | transcript 最后修改 |
|---|---|---|---|---|
| qoder | 17cde7a3 | 2026-11-04T12:50:30Z | 1.8h | 2026-11-04T12:50:33Z |
| qoder | b700ec9f | 2026-11-04T12:52:01Z | 1.8h | 2026-11-04T12:52:11Z |
| qoder | 2747345b | 2026-11-04T14:26:23Z | 0.2h | 2026-11-04T14:26:37Z |

规则代码：`dist/core/turn-recorder/runtime-state.js:83-104`（`recorderStaleOpenTurns`）+ `dist/core/turn-recorder/recorder-contracts.js:166`（`OPEN_TURN_EXPIRY_MS = 24h`）。条件为三者同时成立：`status === 'open'`、`now - startedAt > 24h`、且 transcript 的 mtime 也超过 24h；`open.managedByScry` 为真时直接跳过。

**判定：符合规则。** 三个 open turn 分别只有 0.2h / 1.8h，未满 24h，所以 `staleOpenTurns: []` 是正确的，不是 bug。代价是"刚被丢弃的轮次"在 24 小时内完全不可见（F6 应这样定义，而不是"永远不可见"）。反向对照：<user-workspace> 有 43 个超过 24h 的 open turn，doctor 确实全部列出。

### 12.3 uploader `dist/cli.js` 损坏窗口（13:43–13:45Z）对 <user-workspace> 的影响

| 检查项 | 结果 |
|---|---|
| `doctor` 的 hook-skip 计数 | `hookSkips {count: 0, recentCount: 0, lastAt: null, scope: retained_log_window}`；`userHookSkips` 也是 0 |
| 该窗口内是否有轮次 | **没有**：13:35Z–14:00Z 之间 <user-workspace> 0 条记录（seq 无空洞） |
| 是否缺轮 | 不缺；记录路径由 App 的记录器守护进程（pid 69078）负责，与损坏的 uploader 无关 |
| 上传影响 | 约 2 分钟内 launchd 的 `_recover` 无法启动 uploader；恢复后 `runs = 18`、`last exit code = 0` |

### 12.4 OpenCode 3 轮：仍未执行（换了根因，仍是阻塞）

| 尝试 | 命令 | 结果 |
|---|---|---|
| 1 | `opencode run …`（当前环境） | `Error: fetch() URL is invalid` |
| 2 | `zsh -lc 'opencode run …'` | `模型提供方限流 invalid_request_error` |
| 3 | 同上重试 | 同上（限流） |
| 4 | `--model opencode/big-pickle` | 280s 超时，无任何回复 |

- 第 1 次的根因不是登录，而是 `~/.config/opencode/opencode.json` 用 `{env:OPENCODE_ANTHROPIC_API_KEY}` / `{env:OPENCODE_ANTHROPIC_BASE_URL}`；我的非登录环境里这两个变量不存在，`zsh -lc` 里存在（长度 32 / 48）。登录状态本身没问题。
- 之后两次都撞上**模型提供方限流**（`anthropic/claude-opus-4-8`）；换免费模型 `big-pickle` 直接挂死。
- **新发现 F10（证据质量）**：这三次失败的调用仍然各自生成了记录（seq 30/31/32，provider=opencode），`status: completed`、`termination.reason: provider_terminal`、`errors.value` 为空。Provider 调用明明失败（限流 / URL 无效），记录却报告"完成且无错误"。推广前应确认这是否是 OpenCode 适配器的预期映射。

### 12.5 Qoder 交互模式 2 轮：PASS

驱动方式：Python pty（`<evidence-root>/bin/qoder-tty.py`）跑 `qodercli -i "<prompt>" --permission-mode bypass_permissions`，真实交互 TUI，不操作 `/quit` 菜单；中断只发一次 SIGINT。

| 轮 | 场景 | 结果 |
|---|---|---|
| 33 | 正常完成（只回复一行文字） | `status: completed`、`termination.reason: provider_terminal`、hooks = `UserPromptSubmit, Stop` |
| 34 | 中途停止（提示词要求 4×`sleep 5`） | 接受证据：14.1s 出现新 session 目录；26.2s 发 SIGINT；**28.3s 落盘**（SIGINT 后 2.1s）；`status: interrupted`、`termination.reason: session_end`；退出码 130；**没有新增 stale open turn** |

**结论**：交互模式下"正常完成 = completed"和"中途停止 = 有记录"都成立，0.2.57 的行为符合清单预期。F1 只存在于 `-p`（非交互）模式：`-p` 不派发 `Stop`，且被 SIGINT 时连 `SessionEnd` 也没有。

### 12.6 S18 三次复跑：机器始终不空闲，结果不稳定

负载轮询 12 分钟（30s 一次）：`load1` 最低 8.81、最高 27.85，**从未降到 5 以下**。占用者主要是 `AliEntSafe CloudShell`（152% CPU）、WindowServer、Chrome 助手进程、`Mole`，都属于用户日常应用，不是我的测量进程。

| run | load1（开始→结束） | p50 | p95 | 判定（门限 1500ms） |
|---|---|---|---|---|
| 1 | 18.57 → 21.09 | 758ms | **887ms** | PASS |
| 2 | 21.09 → 27.07 | 907ms | **1978ms** | FAIL |
| 3 | 27.07 → 22.62 | 693ms | **1144ms** | PASS |

p95 中位 **1144ms**，2/3 通过；唯一 FAIL 出现在负载最高的那一次（load1≈27）。因此本轮**不能**当作"空闲基线"结论：只能说"在 load1 10–27 的日常负载下，p95 落在 887–1978ms，2/3 通过门限"。

附带：run 2 在测量完成、写出报告后崩在清理阶段（`rmSync ENOTEMPTY`，`run.mjs:414`），属于 harness 清理健壮性问题，不影响该次的 p95 数值；残留临时目录已手工删除。

### 12.7 本轮轮次统计

| Provider | 用到 | 明细 |
|---|---|---|
| OpenCode | 4 | 1 次 URL 无效、2 次限流、1 次超时（均未完成任何真实内容轮） |
| Qoder | 2 | 交互正常完成 1、交互中途停止 1 |
| Codex / Pi / Claude | 0 | — |
| 合计 | **6 / 20** | 剩余 14 轮未用 |

未改代码、未 push、未创建 PR；<user-workspace> 全程只读（无 flush、无 redrive、无文件改动）。

### 12.8 补充：OpenCode 换模型后仍不可用（第 7–9 轮）

用户建议改用 `bailian/deepseek-v4.1-flash`。实测该模型在本机 opencode 里**不存在**，随后两次替代尝试都失败：

| 轮 | 命令 | 结果 |
|---|---|---|
| 7 | `opencode run --model bailian/deepseek-v4.1-flash` | `UnknownError` / `Unexpected server error`（`ref err_b45bbca4`）；本机 `opencode models` 只注册了 `anthropic`、`opencode` 两个 provider，没有 `bailian` |
| 8 | `--model opencode/deepseek-v4.1-flash-free` | 240s 超时，无任何输出（与 `big-pickle` 相同：免费模型挂死） |
| 9 | 回到默认 `anthropic/claude-opus-4-8` 重试 | 仍是 `模型提供方限流 invalid_request_error` |

`opencode models` 结果：30 个模型，provider 只有 `anthropic`（7 个）与 `opencode`（23 个，多为 `*-free`）。
结论：OpenCode 3 轮**仍未执行**。要继续需要以下之一：注册 `bailian` provider（`~/.config/opencode/opencode.json` 里加 baseURL/apiKey）、换一个当前不限流的 `anthropic/*` 模型、或等限流解除。这是环境/账号条件，不是 recorder 的问题。

附带确认：这三次失败调用同样各自生成了记录（seq 35、36 …），`status: completed`、`errors` 为空，与 12.4 的 F10 一致。

### 12.9 S18 在低负载机器复跑：3/3 PASS

机器：`test@<remote-test-host>`（macOS 26.3.2 arm64，node v24.18.0）。按清单把被测版本装到该机独立前缀 `~/scry-bench`（`scry 0.2.57` / `scry-upload 0.2.10`），harness 与 protocol.json 放在 `~/scry-s18`（均不在任何仓库内）。

| run | load1（开始→结束） | p50 | p95 | 判定（门限 1500ms） |
|---|---|---|---|---|
| 0（预跑） | 4.08 → — | 798ms | **862ms** | PASS |
| 1 | 4.82 → 4.60 | 820ms | **920ms** | PASS |
| 2 | 4.60 → 4.64 | 819ms | **894ms** | PASS |
| 3 | 4.64 → 5.71 | 837ms | **922ms** | PASS |

正式三次 p95 = 920 / 894 / 922ms，**中位 920ms**，最大 922ms，全部远低于 1500ms 门限。

与 12.6 的本机负载数据对照（887 / 1978 / 1144ms，load1 18–27）：**S18 的首测 FAIL 是机器负载造成的，不是版本回归。** 在 load1 < 6 的机器上，hook 路径 p95 稳定在 0.9s 附近，三次离散度只有 28ms。

附带（harness 缺陷，非产品问题）：每次 run 在完成测量并写出报告后，`run.mjs:414` 的清理会抛 `rmSync ENOTEMPTY`（本地和远程都复现，共 5 次）。测量结果已经落盘可用，但退出码非 0，容易让自动化误判；远程残留临时目录已清理。

### 12.10 修正后的轮次统计

| Provider | 用到 | 明细 |
|---|---|---|
| OpenCode | 7 | URL 无效 1、限流 3、免费模型超时 2、未知模型 1（0 个内容轮完成） |
| Qoder | 2 | 交互正常完成 1、交互中断 1（均 PASS） |
| 合计 | **9 / 20** | 剩余 11 轮 |

`<evidence-root>/a` 记录数：36（含 7 条 Provider 调用失败的记录，见 F10）。

---

返回 [索引](README.md)。
