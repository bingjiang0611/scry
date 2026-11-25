# 证据口径

- 无调用记为 `available + []`;Provider 未暴露的记为 `unavailable`,**不会伪装成 0**。
- `普通工具` / `MCP` / `Skill` / `子 Agent` 四列互斥,总调用等于四列之和。
- Hook 同时报告"处理器实例"与"生命周期事件";文件同时报告结构化证据与 Bash 推断读取,并保留 quality/coverage —— 分母不同不可直接相比。
- Codex 子 rollout 必须匹配父会话、父轮次、cwd 与 fork 身份；不重复合入继承历史。每轮最多读取 64 个子会话、单文件 16 MiB、合计 64 MiB；同月跨日查找最多扫描 4096 个目录项，身份头最多读取 256 KiB。超限、缺失或不匹配均为 `partial`。原始 exec 程序保留但不执行；token 与最终回复只取顶层权威值，子回复单独保留在 modelSegments。Codex rollout 不含原生 Hook 事件，Hook 通常为 `unavailable`。
- Qoder 通过唯一主用户消息的 requestSetId → promptId 关联账单身份，不把 request-set ID 当 promptId。子工具依靠主日志 agent-result 与受限 sidecar 的 session/cwd/agent/parent 身份关联，拒绝符号链接；最多 64 个一级子会话、单文件 256 KiB、合计 4 MiB。缺失、超限或嵌套委派标 `partial`；需支持更大或多级子会话时，应扩展有界分页与身份链，不能移除上限。Ultimate 等逻辑档位写入 modelTier，不冒充具体 model。
- Pi 扩展把 assistant 的 UTF-8 内联正文限制为 256 KiB，把单个 tool 事件限制为 4 MiB（daemon 请求上限为 8 MiB）；超限时发送版本化 `scry_capture` 元数据。启用完整工具采集时，recorder 仍把可达的完整正文写入 CAS，并在 record 内保留有界 preview 与 `partial` provenance；不可序列化正文标为 `unavailable`。OpenCode 未观测到 usage 时不再写 exact zero；升级后需运行 `scry integrations repair --yes` 更新存量插件。
- Codex 无服务端精确 latency,`response_intervals` 是观测区间,可能包含请求构造、调度、传输与重试。
- `modelTiming.cumulativeMs` 累计并行子 Agent 时间,`occupiedMs` 是所有模型区间的并集(用于与整轮墙钟比较)。旧记录缺该字段时保持 `unavailable`。
- `modelSegments` 与 `compactions` 在旧记录缺失时标 `unavailable`,不会误算成 0。
- 人工介入（`interventions`）只从 transcript 里「提问/拒绝请求 + 对应结果」这一对结构还原：问题正文取提问工具入参，答案取 `tool_result` 的 answers；Provider 明写的 denial 字段区分用户中断与宿主取消。已观测到请求但没观测到答案或取消时标 `partial` 并写 `omissionReason`，不发布「精确的零次介入」。等候时间记在介入上，对应调用的 `humanInterventionId` 指向同一介入，工具执行时间不得重复计入。
- 文件足迹按操作区分 `succeeded` / `failed` / `rejected` / `unknown`：被拒的读取不算已读，同一路径一次失败不抹掉另一次成功。旧记录没有这个字段，只代表 legacy。
- Hook 的非阻塞失败（`hook_non_blocking_error`）与非零退出码是失败运行，逐次保留关联 ID、原始退出码、耗时与错误正文；只有成功运行才合并计数。记录里没有 `timedOut` 字段就不推断超时，命令里的 `|| true` 也不能把失败运行改成成功。
- Skill 的宿主激活通知与注入正文是同一次事实的两次观测，合成一条技能证据；真实 Skill 调用仍然优先，调用总数不受注入影响。
- 强制收尾（`recover --expire-open`）只认进程证据：静默满 30 分钟 + 记录过的宿主进程链全部确认不存在，才把轮次收成 `interrupted` 并标 `estimated`，原因写明按恢复收尾。宿主仍在跑、或根本没有进程证据（旧轮次、旧钩子脚本、进程表读不到）一律保持 open，静默不算「已结束」的证据。`--session <id>` 可重复，只对指定会话强制收尾。
- 记录 `startedAt` 取 transcript 里本轮提问行的时间，不取开启采集的时间；接续段取自己的 wake 时间。开启采集时间与 diff 基线时间各自保留，不能互相顶替。
- Recorder 只保证**新生成**记录使用当前口径,不会重写历史记录。

## Diff 快照的仓库位置

Recorder 合同在 `diff.value[].repositoryLocation` 增加可选对象。内部字段也都可选；缺失表示未观测，不影响原 diff 的状态。schema 版本不变。

| 字段 | 含义 | 上限 |
| --- | --- | --- |
| `remote` | 本地 Git config 中首个 `origin` URL 的规范仓库标识：`host[:port]/path`。主机小写，去掉协议、默认端口、用户信息、查询、片段和末尾 `.git`。本地路径或无法安全解析的 URL 不写。 | 1024 UTF-8 字节 |
| `branch` | 采集开始时的分支名，不带 `refs/heads/`；游离 HEAD 写 `null`，读不到不写。 | 255 UTF-8 字节 |
| `branchAfter` | 采集结束时的分支名；格式、`null` 和缺失语义与 `branch` 相同。即使与开头相同也可写。 | 255 UTF-8 字节 |
| `commitBefore` | 采集开始时的完整提交号。不把基线树或事后重建的基线当成当时的 HEAD。 | 40 或 64 个小写十六进制字符 |
| `commitAfter` | 采集结束时的完整提交号，即使与开始相同也可写。 | 40 或 64 个小写十六进制字符 |
| `remoteStatus` | `observed`（有 `remote`）/ `absent`（config 读到了但没有 origin）/ `unsupported`（有 origin 但不是可识别的身份：本地路径、token-only URL、本解析器不支持的续行写法）/ `unavailable`（没读到）。0.2.88 起。 | 封闭枚举 |
| `branchStatus` | `observed`（`branch` 是分支名）/ `detached`（HEAD 是提交，`branch` 为 `null`）/ `unavailable`（HEAD 没读到）。0.2.88 起。 | 封闭枚举 |
| `commitStatus` | `observed`（有 `commitBefore`）/ `unavailable`（开始时的 HEAD 没读到）。0.2.88 起。 | 封闭枚举 |

起始位置独立于 diff 基线：接续轮在该段采集开始时重新读 Git；`baseline_after_turn_start` 表示迟启采集，起始字段只代表采集开启时，不能还原原始提问时的位置。

三个状态键是“事实”和“没取到”的分界：`absent`（没有配置远端）、`unsupported`（有远端但不是可识别身份，路径本身不记录）、`detached`（分离头指针所以没有分支名）都是关于这个仓库的事实，不算数据缺失；`unavailable` 才是没取到。没有这三个键的旧记录按“未观测”读：值的缺失可以解释为没取到，不能当成仓库没有远端或分离头指针。

0.2.88 起，收尾只对**这一轮真正改动过**的仓库补读一次远端（专用池 8 并发，单仓库 250 ms、整轮 500 ms 封顶），`commitBefore`/`branch` 直接取开始时那次 `git status` 的结果，因此不再依赖那个 50 毫秒的启动采样。没有改动的仓库只保留状态，不花第二次读。读取方对该对象的处理是宽容的：值不在已知集合里就投影掉，不让整条记录失效；写入侧 `commitRecord` 拒绝未定义取值。

每条记录最多给 32 个不同的仓库根各附一次位置；重复快照和超过上限的仓库仍保留原 diff。读取不启进程、不等待额外 I/O；只读已知 Git 文件布局。支持 loose ref、`packed-refs` 和 worktree/gitdir 指针，不追踪 Git config include、不应用 URL 重写规则、不读取其他 ref 后端。超过读取预算、读失败或无法确认的字段留空。
- 会话捕获记录里的 `source` 与 `client` 是两件事：`source` 是谁要求采集，`client` 是这轮发生在哪个客户端里（例如 `source=friday` + `client=3eye`）。`client` 缺失只表示没观测到，不能读成“不在任何客户端里”；它只能是 `[a-z0-9][a-z0-9-]{0,31}` 形式的标识，不是自由文案。
- `diff` 为 `partial` 时，`omissionReason` 是给人读的句子，`omissionCodes` 是同一批原因的封闭枚举（`baseline_after_turn_start` / `continuation_no_baseline` / `diff_exclude` / `untracked_limit` / `patch_policy` / `patch_budget` / `patch_deadline` / `patch_git_error` / `patch_truncated` / `patch_unavailable`）。平台与测试按码判断，不从句子解析；旧记录没有该字段表示只有文案。
- `usage` 为 `unavailable` 时也可能带 `omissionReason`（暂时不带 `omissionCodes`）。Codex 上报累计用量，一轮的用量是相邻帧的差；拿不到“这一轮开始前的累计”时，这一轮标 `unavailable`，句子固定为 `USAGE_BASELINE_MISSING_REASON`（详见 `storage-and-performance.md` 的 0.2.87 一节）。这与“会话从 0 开始”是两件事。
- `omissionCodes` 的读取是宽容的：只要是非空、不重复、不超过 16 个的非空字符串，未知的码照原样保留，**不因此判整条记录非法**；否则一条新版本写的记录会被旧读取方和服务端整条拒掉。写入侧比读取更窄：`WRITABLE_OMISSION_CODES` 目前只有 diff 的码，`commitRecord` 按 `EVIDENCE_SECTIONS` 逐段检查 `omissionCodes`，出现不在该集合里的码就拒绝提交（没有节点数或深度预算可提前收摊）。
- 0.2.87 起 `usage` 为 `unavailable` 时只写 `USAGE_BASELINE_MISSING_REASON` 这句固定文案，暂不写码。原因不是服务端（已确认原样入库、不做校验），而是同一个存储上仍有严格白名单的旧读取方：桌面端自带 CLI 与 CodeLens 运行时内置的 0.2.84 都把带未知码的记录判成 `invalid turn record`，而 0.2.84 的 hook 路径用 `listRecords` 全量解析，一条坏记录会让该工作区之后每个 hook 都失败。等这两个读取方换成宽容版本后，再在后续版本写码。
