# 使用与运行语义

本页说明 recorder 采集的证据、轮次生命周期和运行开销。安装与日常命令见 [根 README](../README.md)。

## 采集什么

默认全开,每项都可在 `scry.config.json` 里关闭:

```json
{
  "capture": {
    "prompt": true,
    "assistant": true,
    "toolOutput": "full",
    "diff": true,
    "hooks": true,
    "patchExcludeBasenames": []
  }
}
```

`scry doctor` 输出的 `capture` 是解析后的生效值,包含配置里省略的默认值。

关闭某项后对应证据段记为 `disabled` 并带 `omissionReason: ... disabled by config`,与 Provider 不支持的 `unavailable`、以及"真的没发生"的空数组是三个不同状态 —— 记录自己就能解释当时采了什么。

> ⚠️ **关闭正文不等于脱敏。** 即使 `prompt`、`assistant` 关闭且 `toolOutput: "none"`,以下内容仍会落盘:**工具入参**(Bash 命令原文、Edit 的 old/new 字符串)、**文件路径**、**diff patch**(除非 `diff: false`)。当前没有单独关闭工具入参的开关。要求本地不留代码与命令的场景,应设 `diff: false` 并评估工具入参是否可接受,或者干脆不在该仓库启用。

## 工具正文：默认 `full` 原文

当前源码中，`scry init` 和省略 `capture.toolOutput` 的配置默认使用 `full`，记录原始工具 input/output，不再脱敏。旧配置的 `full-redacted` 作为迁移别名解析为 `full`，**不再表示保密承诺**。历史已脱敏内容及标记保留，不尝试恢复。此变更需构建/安装当前源码后生效，不改变已发布的旧版 CLI。

> ⚠️ 原文可能包含密钥、令牌、Cookie 和私钥，会进入 `.scry`、App archive/SQLite、备份及已配置的 uploader。分享/上传前必须自行检查。支持包和认证诊断的防泄露规则不因此移除。

以下是默认生效值：

```json
{
  "toolOutput": "full",
  "toolContentFieldBytes": 8192,
  "toolContentTurnBytes": 131072
}
```

- 已有配置中**显式**设置的 `none/summary` 继续生效，重复 `init` 不覆盖；旧版自动生成的 `summary` 与用户选择无法可靠区分，不根据猜测迁移。无 `scry.config.json` 的工作区仍不自动启用 recorder。
- 同时保存 `inputContent` / `outputContent`，不再把 `outputSummary` 当作全文。摘要从保留的原文生成。正文可能是字符串、JSON 或截断的 JSON 文本片段；只有 `encoding: "json"` 可按完整 JSON 解析。
- 单字段默认 8 KiB、最大 64 KiB；最终轮次记录新增正文合计默认 128 KiB、最大 1 MiB。按 UTF-8 字节裁剪，不截坏字符。预算按稳定调用顺序分配，input 在 output 之前；这只是 inline 预览预算，不是整个 `.scry` 的磁盘配额；完整正文另存 `.scry/content/sha256/` 并通过 `contentRef` 引用，事件暂存、archive、队列也有各自副本。
- 每个字段包含 `content`（省略时不存在）、`encoding`、`savedBytes`、`source`、`sourceCompleteness`、`redaction`、`storage`、`reasons`。`sourceCompleteness: "unknown"` 表示上游没有完整性承诺；`storage: "complete"` 只表示完整保存了当前收到的值，**不证明 Provider 原始输出完整**。
- 新采集的 `redaction` 为 `disabled`；历史 `applied/unchanged/failed/not_run` 仍可读取。旧版 reader 可能拒绝新增状态/原因，读取新记录时应同步升级 App、CLI 和下游消费方。原因区分 `provider_missing`、`source_truncated`、`field_budget`、`turn_budget`、`serialization_failed`、`not_collected`，历史 `redaction_failed` 保留。上游裁剪仍标 partial，不能从旧摘要恢复全文。
- 原文保留不取消结构安全：循环引用、accessor、自定义对象等无法安全序列化的值记为 omitted + `serialization_failed`，不调用 payload 的 getter/toJSON。字符串不因看起来像 JSON、URL 或 form 而被重排或替换。
- App 原始 transcript 镜像允许继续写入，但仍先校验 workspace/session 身份和受管路径。关闭脱敏不改变文件授权、trust gate 或 renderer 隔离。
- 普通轮次及 managed 恢复工件保留字节预算；旧 `full-redacted` 重试也不再对新内容脱敏，但已有正文的历史 provenance 不变。不要在活跃轮次中移动/删除配置或更换 dataDir。
- 外围上传端必须透传这两个新字段，看板需要展示正文及完整性状态；ACK 只证明接收成功。Scry CLI 不实现远端看板，也不负责外围多 active workspace 的 session 唯一绑定。

深工作目录（包括显式过长的 `SCRY_RECORDER_SOCKET`）自动映射为工作区/endpoint 哈希短路径；临时目录本身过长时回退 `/tmp`。路径按字节限制为不超过 100 字节，保留原有 daemon 所有权校验。

## 未结束的轮次与终止时间

一轮从 `UserPromptSubmit` 开始、`Stop` 结束。Provider 被 `kill -9`、崩溃或终端被直接关闭时,结束事件永远不会到,这一轮会停在 `.scry/runtime/`。

**`completedAt` 只能来自这一轮自己的证据。** 0.2.38 之前，未收到 `Stop` 的轮次会被下一次 `UserPromptSubmit` 的时间收口，把用户的空闲等待算成 Agent 执行时长（实例：17:26 真实中断被拉到 17:49，时长虚增至 ~36 分钟）。现在下一次输入只触发收口，**不再作为上一轮的结束时间**。

每条记录新增 `termination` 证据，说明结束时间怎么来的：

| `completedAtSource` | 含义 | envelope |
|---|---|---|
| `provider_transcript` | Provider transcript 的终态时间 | available/exact |
| `provider_terminal_event` | 终止事件自带的显式时间 | available/exact |
| `recorder_observed_terminal` | 终止事件到达时 Scry 自己的时铟 | available/estimated |
| `last_observed_activity` | 无终止事件，取最后一次真实活动（**下限**） | partial/estimated |
| `turn_start` | 既无终止事件也无活动，结束时间未知 | partial/inferred |

`reason` 区分 `provider_terminal`、`session_end`、`run_ended`（managed 运行边界）、`superseded_by_next_turn`、`expired`。早于 0.2.38 的记录**没有**这个字段；缺失只代表 legacy，不能当作结束时间可信。

- `status !== 'available'` 时，`durationMs` 是下限而不是完整时长；turns summary 的 `wall` 同时给出 `exactEndTurns` / `boundedEndTurns` / `unknownEndEvidenceTurns`。看板的用户等待区间应从 `completedAt` 之后开始。
- 超出轮次窗口的时间戳（早于 `startedAt`、或超出本地时钟 60s 以上）不被信任，会退到下一个可信来源。
## 会话结束（SessionEnd）

收到 `SessionEnd`、`session.end`、`session_end`、`session.exited`、`process.exit` 时，当前 open turn 立即定界为 `interrupted`（`reason: session_end`），**不会**因为会话结束而被当成完成。

- Hook 只做两件事：写入生命周期事件、把终止时间与结论固定到 `open.json`，然后返回 `pending`。transcript 解析与 Git diff 由 daemon/`scry recorder recover` 在后台完成（daemon 在每次请求后重置为 1s 轮询）。结束时间已先固定，所以推迟聚合不会拉长时长；Hook 被杀也只是留下一个 closing turn，仍可恢复。
- 重复 SessionEnd 幂等：未完成时反复返回 `pending` 而不改写边界，已提交后返回 `duplicate`。普通采集、managed 与 journal recovery 共用同一套语义。
- `scry init` **只为 Claude 注册** `SessionEnd`，timeout **3 秒**（`Stop` 仍为 15 秒）：依据是 Claude SDK 的 `HOOK_EVENTS` 包含 `SessionEnd`。**Codex、Qoder 没有经过核实的会话结束 Hook，OpenCode 根本没有这类事件**，因此不注册，也不假装 parity；这些 Provider 仍靠上面的结束时间解析。已安装的工作区跑 `scry init` 或 `scry integrations repair` 才会补上。
- 外部已有自己的 SessionEnd Hook（例如其他平台封装）时，也可以不让 Scry 注册，直接转发：`scry recorder hook --provider claude --event SessionEnd --workspace "$PWD" --stdin --quiet`。

> ⚠️ **Connection reset 不会触发 SessionEnd。** 连接断开但会话仍在时，靠的是上一节“不再借用下一次输入时间”；SessionEnd 只能让真正结束的会话更早收口。

**同时满足**「超过 24 小时」与「transcript 已停止增长」的轮次判定为不可能再收敛,由 `scry recorder recover`(daemon 空闲时自动跑)收敛为 `interrupted`。两个判据都必需:只看年龄会把跑了 30 小时的长任务误判为中断,而长任务会持续追加 transcript。

```bash
scry doctor            # 退出 5，turns.stale 报出数量与最久时长
scry recorder recover  # {"recovered":1,"pending":0,"expired":1}
```

收敛后的记录:`status` 为 `interrupted`,已观测的证据段降级 `partial` 并说明原因,未观测的段保持 `unavailable`。`diff` 段固定 `unavailable` —— 基线可能是几天前的,发布它等于把之后所有改动(包括别的轮次的工作)算到这一轮头上。

### 结束事件到了却写不出记录

另一种卡法:结束事件**已经到达**(轮次进入 `closing`),但写最终记录时在 transcript 里找不到这一轮 —— Provider 已经把它轮转掉了。这种轮次原本会无限期停在 `closing`,每次 recovery 重试、每次都失败。

超过同一个窗口(以 recorder **最后一次写状态**的时间计,不用 Provider 给的时间戳,避免时钟偏移触发破坏性判定)后不再重试:

| | `status` | 正文 | `diff` |
|---|---|---|---|
| 结束事件从未到达 | `interrupted` | `unavailable` | `unavailable` |
| **结束事件到了但正文已丢** | **`completed`** | `unavailable` | `unavailable` |

`completed` 是诚实的:终态确实观测到了(这才是它进 `closing` 的原因),丢的只是内容,所以降级的是证据而不是生命周期结论。

两类卡住的轮次都会让 daemon 长期不退出(有活干时不退场),收敛后它才会正常空闲退出 —— 也才轮到 daemon 侧的自动更新。窗口固定 24 小时,不可配置:调小会把仍在工作的轮次误判为中断,并丢弃它的 diff 归因。

## 性能与资源

hook 在 Provider 每个生命周期事件上同步执行,所以这条路径的成本直接决定你是否感觉到卡顿。daemon 已运行时,hook 脚本用 `curl --unix-socket` 直投,省掉每事件一次 Node 启动;daemon 不在、`curl` 缺失、`SCRY_RECORDER_TRANSPORT=direct` 或 HTTP 状态码非 200 时自动回退到 CLI —— stdin 会先读进变量再投递,保证回退能重发,不丢事件。

实测基线(macOS / Apple silicon,单个 git 进程约 75ms,取 3–7 次中位数):

| 场景 | 快路径 | 回退到 CLI 自己落盘 | 提速 |
|---|---|---|---|
| 单个工具事件 | **108ms** | 550ms | 80% |
| 轮次起始事件(含 git 基线) | **874ms** | 1232ms | 29% |
| 一轮 · 5 次工具调用 | **2.60s** | 8.22s | 68% |
| 一轮 · 30 次工具调用 | **8.00s** | 34.56s | 77% |

轮次起始只快 29%,因为它的成本主要不是进程启动,而是 git 基线快照:

| `beginGitTurnDiff` | p50 |
|---|---|
| 干净工作树 | 335ms |
| 3 个未跟踪小文件 | 722ms |
| 300 个小文件 | 962ms |
| 一个 50 MB 未跟踪文件 | 1004ms |

`npm run bench:git-diff` 可复现这张表(信息用途,不是门禁)。仓库数量会线性放大这一项:壳仓库套 15 个子仓库时,`begin` 并行后仍需 1.6–2.0s。

- **CPU**:daemon 静置几乎不占 CPU(30 秒窗口 CPU time 增量 <0.2s;20 个进行中轮次约 1.3% 单核)。
- **内存**:单 daemon 启动后 RSS 约 71 MB,静置 30 秒回落到 64 MB。GC 后堆稳定(40 轮只留 1.7 MB),不是泄漏;RSS 不归还属 V8 高水位。
- **daemon 是每 workspace 一个,没有全局上限** —— 并行多个 worktree 时占用会叠加,只在需要采集的 worktree 执行 `init`。

不想要常驻进程:`export SCRY_RECORDER_TRANSPORT=direct`(行为等价,更慢)。

存量 workspace 升级 CLI 后需要重新生成 hook 脚本才能拿到快路径:`scry integrations repair --yes`(不做也不会错,只是慢)。
