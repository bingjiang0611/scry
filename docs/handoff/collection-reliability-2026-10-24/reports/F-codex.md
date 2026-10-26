# F-Codex. Codex hook 执行排查与 F-1/F-2 真机验收

本文件是 [F 报告](F.md) 的 Codex 专项子报告。按单文件 20 KB 门禁**按职责拆分**（不是为凑行数），内容与原 F 报告一致，未删改。

## Codex 排查记录（执行方，2026-10-26，只观察、不改代码）

按 [F 报告](F.md) 核验意见里「Codex：需要排查」的四步执行。结论：**不是 sandbox 阻止写入，是 hook trust 没建立。** `codex exec` 在缺少持久化 hook trust 时不会执行项目 `.codex/hooks.json` 里的 hook，但仍会打印 `hook: UserPromptSubmit` / `hook: UserPromptSubmit Completed` 这类阶段行。所以「Completed」不能证明 hook 跑过，F-1/F-2 里「hook 显示完成却没有任何 `.scry` 写入」就是这样产生的。加 `--dangerously-bypass-hook-trust` 后，同一 workspace、同一份 hooks.json 立刻正常投递并落 record。

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

## Codex 真机验收（F-1 / F-2，2026-10-26，用户配合在 TUI 确认 `/hooks` trust）

构建：`bce204dc` → `npm run build:cli`，构建后立即快照到 `/tmp/scry-fa/dist-f1f2`，三个场景只用该快照。每个场景各自独立 workspace + HOME（复制 `~/.codex/auth.json`，0600）+ `XDG_STATE_HOME`，并依次执行 `init --providers codex` → `integrations repair --yes` → `recorder restart`；hook 命令包成 trace 包装器（`/tmp/scry-fa/f12/trace-hook.sh`），trace 写在 workspace 之外。临时 HOME 只预置 `[features] hooks = true`（与真实配置一致）和启动目录的 folder trust，**hook trust 由用户在 TUI 的 `/hooks` 里逐条确认**。

| 场景 | 启动目录 | hook 是否执行 | `[hooks.state]` 记录 | record 数 | 结论 |
|---|---|---|---|---|---|
| S1 单仓库，根目录 | `…/S1/ws` | 是（UserPromptSubmit×2、Stop×2，退出码均 0） | 5 条 | 2 | **F-1 Codex 通过** |
| S2 单仓库，`src/deep` 子目录 | `…/S2/ws/src/deep` | 是（同样 2+2，退出码均 0） | 5 条 | 2 | **F-2 子目录通过**（C-U2） |
| S3 多仓库，子仓库 `one/` | `…/S3/ws/one` | **否** | **0 条** | 0 | **F-2 子仓库：完全没有加载 hook** |

**S1**：trace 里 cwd=`ws`、`CODEX_PROJECT_DIR=<unset>`（走 cwd 回退）；真实轮次 record `provider=codex`、`status=completed`、`endReason=provider_terminal`，`user`「只回复 ok，不改文件」、`assistant`「ok」；`recorder recover` 返回 `recovered:0, pending:0`；doctor `healthy`。

**S2**：cwd 与 `pwd -P` 都是 `…/ws/src/deep`，`CODEX_PROJECT_DIR` 同样未设置；hook 靠向上查找找到 `ws/.scry/provider-hook.sh`，2 条 record 落在 `ws/.scry/records`；doctor `healthy`。

**S3**：`/hooks` 里没有项目 hook 可确认（用户实际执行了 `/hooks` 和那一句话，见该场景 `history.jsonl`）。`config.toml` 只多了一条 Codex 自己写的 folder trust `[projects."…/S3/ws/one"]`，`[hooks.state]` **0 条**；trace 文件根本没生成；`turns list` 为空；doctor `healthy`，只有与本次无关的 `repositories.depth` warn。根因可定位：**Codex 从启动目录向上找 `.codex/hooks.json` 时到 git root 就停**，`ws/one` 的 git root 是 `ws/one`，而 Scry 把 hooks.json 写在 workspace 根 `ws`，所以永远读不到——这不是 trust 问题，而是「子仓库里根本看不到项目 hook」。

两条观察（只记录，不改代码）：

- 每个场景除真实轮次外还多 1 条 record：Codex 自动生成任务标题的内部请求（`user` 是「Generate a concise, single-line task tit…」，`assistant` 为 null，耗时 2.5 s / 10 s）。sequence 按完成时间分配，所以它排在真实轮次之前编号。
- S1/S2 的 `UserPromptSubmit` 各出现两次、`Stop` 各出现两次（其中一次在退出会话时），全部退出 0；没有重复 record、没有 orphan，`recover` 也没有待处理项。

**F-1 结论更新**：Codex 通过（前提是先 `/hooks` 确认 trust）；OpenCode 通过（12 条）；Pi 额外通过（限流轮次仍落盘）；**Claude：用户决定不验收，不计为通过**；Qoder：凭据已刷新，尚未重跑，仍记为阻塞。
**F-2 结论**：Codex 在子目录启动通过；在子仓库启动时 hook 完全没加载（未通过），原因见上，属需要另行决定的产品缺口。

证据：`/tmp/scry-fa/f12/{S1,S2,S3}/{hook-trace.log,prepare.log,doctor.json,turns.json,ws/.scry/records}`、`/tmp/scry-fa/evidence/f12-prepare.log`。
