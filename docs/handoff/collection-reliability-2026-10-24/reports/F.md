# F. 合入前汇总验收执行记录

日期：2026-10-26。执行方在本机对分支最终构建跑了 [USER-VERIFY](../USER-VERIFY.md#合入前的汇总验收a-e-全部核验后2026-10-26) 的 F-1～F-8。结论先写：**F-3～F-8 通过；F-1 只有 OpenCode 与 Pi 通过，Claude/Codex/Qoder 未通过或阻塞；F-2 的 Codex 场景未通过。** 未通过项都给出可复现的现象与证据，没有把「Provider 报了错」当成 Scry 通过。

## 环境与被测构建

| 项 | 值 |
|---|---|
| 分支 / 提交 | `reliability/collection`，`6e2012e7` |
| 构建 | `npm run build:cli`（`/tmp/scry-fa/build-cli-final.log`），构建后立即把 `packages/turn-recorder-cli/dist` 快照到 `/tmp/scry-fa/dist-pinned-6e2012e7`，后续所有探针只用该快照，避免并行会话重建 dist 改变被测代码 |
| 版本 | codex-cli 0.164.0、qoder 1.1.73、opencode 1.18.31、node v24.18.0、scry/recorder 0.2.51 |
| 隔离 | 每个场景独立临时 workspace + `HOME` + `XDG_STATE_HOME` + `SCRY_GRANT_DIR`；不在开发仓库驱动真实 Provider；`.codex/auth.json` 与 `.claude.json` 复制进临时 HOME（0600），结束后删除 |
| 机器负载 | 1 分钟负载 58–190，期间有并行会话跑全量测试（`/tmp/unit-full-2.log`）。超时类失败保留原始日志，不用重跑掩盖 |

## 结果汇总

| # | 场景 | 结果 | 关键证据 |
|---|---|---|---|
| F-1 | Claude / Codex / OpenCode 各一轮 | **部分通过** | OpenCode 真实轮次产出 12 条 record；Pi（额外）在 Provider 限流仍落 1 条 record；Claude、Codex 见下；Qoder 阻塞于凭据 |
| F-2 | Codex 子目录 / 子仓库启动 | **未通过** | Codex 轮次完成（exit 0、1877 tokens、输出 `ok`），hook 打印 `UserPromptSubmit`/`Stop` Completed，但 workspace 无 record，`health.json` 计数全 0 |
| F-3 | 长路径 workspace（socket 路径 > 100 字节） | **通过** | `.scry/recorder-socket-path` → `/var/folders/.../scry-502-ccddab83….sock`（95 字节，真实 socket）；1 条 record；doctor healthy |
| F-4 | 多仓库覆盖 root / `one/` / `a/b/c` | **通过** | record `diff.discovery.requestedRoots=["<ws>","<ws>/one"]`、`maxDepth=2`、`depthLimitedDirectories=2`、diff `available`；doctor `repositories.depth` warn 且 detail 含 `a/b/c`；单仓库深目录对照 pass |
| F-5 | 每轮 env：daemon 以 `SCRY_TURN_UPLOAD_ENABLED=0` 启动，会话 B 不设该变量 | **通过** | 4 次投递：seq1/seq2 `enabled=null`（未设置），seq3 `"0"`，seq4 `"1"`；`installation` 逐轮正确 |
| F-6 | 通知 v2 与新 uploader 接管 | **通过** | 41 次投递全部 `schemaVersion=2` 且 `sha256` 校验一致；receiver 按 `recordPath` 读取后才返回 0；ACK 4、backlog 0、outbox 4 份 |
| F-7 | uploader 短暂故障后恢复 | **通过** | 失败后 `attempts=1`、`nextRetryAt=+60s`、`deadLetterCount=0`；退避内第 2 次 drain 未再调用（5→5）；到期后补投 1 次、ACK 前进到 5、无死信目录 |
| F-8 | kill daemon 之后继续使用 | **通过** | `kill -9` 后 socket 变 stale、`running=false`；下一轮 record 5→6，daemon 自动拉起（新 pid）、inbox 0 |

证据文件：`/tmp/scry-fa/evidence/final-oc/steps.log`（F-1/F-5～F-8 逐步输出）、`/tmp/scry-fa/evidence/f3f4.log`（F-3/F-4）、`/tmp/scry-fa/evidence/calls.jsonl`（41 次 receiver 调用）、`/tmp/scry-fa/evidence/env.txt`（版本与遗留进程清单）、`/tmp/scry-fa/evidence/f1b.log`（Claude/Codex 尝试）、`/tmp/scry-fa/evidence/pinned-head.txt`。

## 失败与阻塞项（如实记录）

**Claude：未通过（本机隔离环境里 CLI 挂住）。** `claude -p "Reply with the single word ok"` 在临时 HOME（已复制 `~/.claude.json`）里没有任何输出，两次分别在 150 秒、180 秒后被 `timeout` 以 SIGKILL 终止（`f1x`、`f1y` 两次尝试，输出 0 字节）。没有 record 是对的——Provider 没有产生轮次，不是 Scry 丢证据。推测与首次运行的 onboarding/交互提示有关，未确认。

**Codex：未通过（hook 执行了但没有任何 `.scry` 写入）。** `codex exec` 正常完成并打印 `hook: SessionStart / UserPromptSubmit / Stop ... Completed`，但 workspace 里没有 `records/`、`runtime/`，`health.json` 的 `orphanEvents`、`pendingCount` 全为 0，也没有 `logs/hook-skip.log`。换 `--sandbox workspace-write` 后，`UserPromptSubmit` 之后整轮挂住直到 240 秒超时（exit 124），仍无 record。hook 是 fail open 的，所以「没写也没报错」符合设计，但**当前状态下 Codex 的汇总验收拿不到 record**。临时 HOME 里没有 `~/.codex/config.toml`，运行的 hook 究竟由哪份配置加载、是否被 sandbox 拒绝写入，均未确认；需要一次带 `/hooks` 交互信任的正常 TUI 会话才能定论。

**Qoder：阻塞。** 真实轮次返回未授权/凭据失效（沿用 2026-10-25 的记录），需要在日常环境刷新 Qoder 登录后再跑。

**F-2 的 Codex 子目录/子仓库场景**因此同样未通过：它依赖 Codex hook 能真正投递，上面两个现象（无 record、sandbox 下挂住）在单仓库与子目录里都会挡住结论。

**OpenCode 观察**：真实轮次多次被上游限流（`模型提供方限流`），每次仍落一条 record；12 条 record 里含限流结束的轮次，`endReason` 如实反映失败，没有伪装成正常结束。

## 自动化复跑（同一构建）

| 检查 | 结果 | 说明 |
|---|---|---|
| `npm run test:unit`（06:04 起，833.85 s） | **2 failed / 4087 passed / 4 skipped（4093）** | 失败：`scripts/check-staged-file-size.test.ts > installs idempotently and blocks a real commit …`（5 秒超时）、`src/core/turn-recorder/commit-environment.test.ts > shell fast path pins the starting session env …`（`ENOENT …/delivered.jsonl`） |
| 同上两文件 focused 重跑（07:10） | **2 failed / 13 passed** | 负载 70–134，且有并行 vitest；同一对文件在 03:54 负载较低时 focused 通过（6 passed）。判断为负载敏感，不是本分支新增回归；未在空闲机器上复测确认 |
| `npm run test:shell` | 通过 | `setup-scry-workspace` PASS |
| `npm run smoke:cli-package` | 通过 | 隔离 HOME/XDG/TMPDIR/缓存；`bin:ok`、`hook:recorded`、`doctor:healthy`、`concurrentNotifications:isolated`、`legacyCursor:preserved` |
| `npm run performance:measure -- --scenario source-control.diff` | 通过 | `subprocess.git 8 → 8`，ratchet passed；本批未改该路径 |
| `npm run typecheck` / `build:cli` | 通过 | 日志 `/tmp/scry-VE-final-typecheck.log`、`/tmp/scry-fa/build-cli-final.log` |

## 未验证 / 限制

- Claude、Codex、Qoder 的真实轮次；F-2 的 Codex 子目录与子仓库。
- 真实外部 uploader 的整链路（本轮 receiver 是本地夹具，只验证 recorder 侧契约）。
- 真机重启：F-8 用 `kill -9` 模拟，没有做整机重启。
- 有 1 条先行观察未复现，未定论：更早一次（旧构建、opencode workspace 上并发执行显式 drain 时）出现过 `attempts=2` 且 `lastFailureAt` 相同的历史重投记录；在 `6e2012e7` 上用干净 workspace 受控复测为 `attempts=1`、退避正确，未再出现。

## 现场清理

结束后停止全部探针进程（`/tmp/scry-fa` 下的 `scry recorder serve`、Codex app-server daemon 等），删除复制到临时 HOME 的 `.codex/auth.json`、`.claude.json`；保留日志与 receiver 证据目录供审查方复核。

## 核验意见（审查方，2026-10-26）

**结论：F-3 到 F-8 通过，接受；F-1 和 F-2 还不能下结论，其中 Codex「hook 显示 Completed 但没有任何 `.scry` 写入」需要专门排查，排查之前不建议合入。**

### 接受的部分

F-3（长路径）、F-4（多仓库覆盖，单仓库深目录对照 pass）、F-5（每轮 env）、F-6（通知 v2 与 receiver 接管，41 次 sha256 全部一致）、F-7（退避后补投，无死信）、F-8（`kill -9` 后 daemon 自动拉起，inbox 为 0）都与核验时的合同一致。被测构建固定成快照，避免并行会话重建 dist，做法正确。

### Codex：需要排查（阻塞合入）

`codex exec` 打印出 `UserPromptSubmit / Stop ... Completed`，但 workspace 里没有 `records/`、`runtime/`，也没有 `logs/hook-skip.log`，health 计数全是 0。这正是本次工作要消除的「静默丢失」。批次 A 手验时，Codex 0.164.0 用真实 TUI 并在 `/hooks` 确认 trust 后能正常落盘，所以差别可能在 `exec` 模式、sandbox 或配置加载上。最值得怀疑的是 `codex exec` 默认的只读 sandbox：如果 hook 进程也在 sandbox 里，写 `.scry` 和写 skip 日志都会失败，而 hook 是 fail open，于是什么都不留。`--sandbox workspace-write` 时整轮挂住 240 秒也需要解释，因为 hook 自身有 15 秒超时。

排查步骤（只观察，不改代码）：

1. 用 C-U2 的包装脚本记录 hook 的 cwd、`CODEX_PROJECT_DIR`、退出码和 stderr，但日志写到 workspace **之外**（例如 `$RUN/hook-trace.log`），这样才能区分「hook 没跑」和「hook 跑了但写不进去」。
2. 依次在 TUI（`/hooks` 确认 trust）、`codex exec` 默认 sandbox、`--sandbox workspace-write`、`--sandbox danger-full-access` 下各跑一轮，记录 record 数和 trace。
3. 在 workspace-write 挂住时，用 `ps` 看挂住的是哪个进程（hook shell、curl、scry CLI 还是 Codex 本身），以及它在等什么。
4. 结论写进本报告：若确认是 sandbox 阻止 hook 写入，再由审查方决定 recorder 侧要不要改（例如把 skip 记录写到 sandbox 允许的位置，或者 doctor 能检测出来），并在 README 里说明 Codex 的 sandbox 要求。

### Claude、Qoder

- Claude：在临时 HOME 里 `claude -p` 两次都没有输出、被超时杀掉，没有产生轮次，因此不能用来判断 Scry。建议用户在日常登录状态下，于一个临时 workspace 里跑一轮。
- Qoder：凭据失效，需要用户刷新登录后重跑。

### 分支里混入了性能工作（提醒用户）

`c7388c3..234dabc` 之间有 35 个提交来自另一个性能会话：它从 `d822f84` 分出，经 `bda0c85` 合并进来，改动涉及 renderer、main、`scripts/performance-ratchet*`，以及 Recorder Core 的 `io.ts`、`content-store.ts`。F 的被测构建 `6e2012e` 已经包含这些改动。我只粗看了 recorder 部分：`mkdirDurable` 对已经存在的祖先目录仍然做 fsync；批量写入在所有祖先目录 fsync 之后才发布文件名；内容去重改为按字节比较，地址仍由 sha256 决定。持久性保证看起来没有被削弱，但**这些提交不在本交接的核验范围内**。合入 main 时，它们会和可靠性修复一起进去，是否合在一起合入由用户决定。

## Codex 排查记录（执行方，2026-10-26，只观察、不改代码）

按上节「Codex：需要排查」的四步执行。结论：**不是 sandbox 阻止写入，是 hook trust 没建立。** `codex exec` 在缺少持久化 hook trust 时不会执行项目 `.codex/hooks.json` 里的 hook，但仍会打印 `hook: UserPromptSubmit` / `hook: UserPromptSubmit Completed` 这类阶段行。所以「Completed」不能证明 hook 跑过，F-1/F-2 里「hook 显示完成却没有任何 `.scry` 写入」就是这样产生的。加 `--dangerously-bypass-hook-trust` 后，同一 workspace、同一份 hooks.json 立刻正常投递并落 record。

### 步骤 1：hook 跟踪日志（写在 workspace 之外）

- 把 5 个事件（`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`Stop`）的命令分别换成 `/bin/sh /tmp/scry-fa/codexobs/trace-hook.sh <event>`；原命令存到 `orig/<event>.sh` 原样执行。trace 同时写 `$TMPDIR/scry-codexobs-hook-trace.log` 和 `/tmp/scry-fa/codexobs/hook-trace.log`，记录时间、cwd、`CODEX_PROJECT_DIR`、退出码和执行后 `.scry` 目录快照。
- 实测：hook 进程的 cwd 就是 workspace，`CODEX_PROJECT_DIR` **未设置**（Scry 的 hook 走 cwd 回退分支）；两个位置的 trace 都写得进去，`.scry` 也正常创建。即 **hook 进程不在 Codex 的 sandbox 内**，只读 sandbox 不会挡 `.scry` 或 skip 日志。

### 步骤 2：四种启动方式的对照

| 场景 | hook 是否真的执行 | record | 证据 |
|---|---|---|---|
| TUI 里 `/hooks` 确认 trust | 未能自动验证 | — | expect 驱动 TUI 只回显 `codex resume …`，没有执行一轮；`/hooks` 交互确认需要真人在场，本轮没有自动化。A 批次的人工 TUI 记录仍是这条路径的唯一证据 |
| `codex exec` 默认 sandbox（未 bypass） | **否** | 1 → 1 | 4 行 `hook:` 全是阶段行，trace **0 行**；`[features] hooks = true` 与 `[projects."…"] trust_level = "trusted"` 都配上也不执行 |
| `codex exec` 默认 sandbox + `--dangerously-bypass-hook-trust` | **是** | 1 → 2 | trace 5 行：`UserPromptSubmit` 15:17:46→:48、`Stop` 15:18:17→:18，退出码均为 0；轮次 exit 0，record `provider=codex`、`status=completed`、`diff=available`，`doctor` healthy |
| `--sandbox workspace-write` + bypass | 是 | 未新增 | hook 1 秒内正常退出并写入 `.scry`；整轮卡在模型请求上 |
| `--sandbox danger-full-access` + bypass | 是 | 未新增 | 只有 `UserPromptSubmit` 到达，轮次同样卡在模型请求 |

两条附带观察，未继续深挖：
- ~~bypass 那一轮落下的 record 里 `user.text`、`assistant.text` 为空~~ —— **已撤回**：那是我读错了 JSON 路径（读了顶层 `user.text`，实际在 `user.value.text`）。逐字段复核见下节，record 里文本完整。
- hook 被跳过时也没有 `logs/hook-skip.log`、health 计数也没有变化——因为 Scry 的 hook 根本没被调用，这不是 Scry fail open 丢记录。

### 步骤 3：`workspace-write` 挂住时挂的是谁

- 跑到 45 秒时 `ps -Ao pid,ppid,etime,stat,command` 快照：没有残留的 `trace-hook.sh`、`provider-hook.sh`、`scry.js` 或 recorder 进程；挂着的是 Codex 自己等模型响应，日志中有 `failed to refresh available models: request timed out`。
- 结论：挂住的是 Codex 的模型请求（本机网络/限流），不是 hook。hook 的 15 秒超时因此从未触发——它在 1 秒内就返回了。

### 步骤 4：recorder 侧要不要改（交给审查方决定）

- 不为 sandbox 改 recorder：hook 不在 sandbox 内，写入不受影响。
- 可考虑但本批未做：README 补一句「`codex exec` 需先建立 hook trust（TUI `/hooks`）或显式加 `--dangerously-bypass-hook-trust`，否则 Codex 会显示 hook 阶段完成但不执行」；若希望 doctor 提前告警，需要读 Codex 自己的 trust 配置，已超出当前 recorder 的观测边界。

证据：`/tmp/scry-fa/evidence/codexobs-ab.log`（A/B 对照）、`/tmp/scry-fa/evidence/codexobs-prepare.log`（hooks.json 包装）、`/tmp/scry-fa/codexobs/{A-nobypass.out,B-bypass.out,exec-write.out,exec-full.out}`。

## record 文本证据只读复核（执行方，2026-10-26，只读，不改代码）

对象：Codex `--dangerously-bypass-hook-trust` 那一轮（`sequence=2`，`recordId=c2283652f4fb70deba6e1c56f5f50d8d`，workspace `/tmp/scry-fa/codexobs/ws`）。命令：`scry turns show 2 --workspace <ws>`（被测构建 `6e2012e7` 的 CLI 快照），随后直接读 `.scry/records/00000000000000000002-….json` 核对原始字段。

| 字段 | status | quality | omissionReason | 文本 |
|---|---|---|---|---|
| `user` | `available` | `exact` | 字段不存在（未写入，不是空字符串） | `Reply with the single word ok` |
| `assistant` | `available` | `exact` | 字段不存在（未写入，不是空字符串） | `ok` |

原始字段（`source` 与摘要原样）：

```json
"user": {"status": "available", "quality": "exact",
         "source": ["provider_transcript+lifecycle_hooks"],
         "value": {"text": "Reply with the single word ok",
                   "textHash": "sha256:dd85e9d6021986923088877c3e542ca639c9b43e6bb677c1b554b060bf2a2c3a"}}
"assistant": {"status": "available", "quality": "exact",
              "source": ["provider_transcript+lifecycle_hooks"],
              "value": {"text": "ok",
                        "textHash": "sha256:2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df",
                        "contentRefs": [{"storage": "recorder-content-v1",
                                         "sha256": "2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df",
                                         "bytes": 2, "encoding": "utf8"}]}}
```

结论：两项都是 `available` 且文本非空，**没有出现「available 但空字符串」的问题**；`omissionReason` 在可用证据上根本不写入，不需要补 null 或空串。上一节把它记成「文本为空」是读错路径的误判，已在该处标注撤回，未改任何代码。

证据：`/tmp/scry-fa/evidence/codex-record-2-show.json`（`turns show` 原样输出）。
