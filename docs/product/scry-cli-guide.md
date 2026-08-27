# Scry CLI 说明

## 它是干什么的

Scry CLI 是给 Claude Code、Codex、Qoder、OpenCode、Pi 这类命令行 Agent 用的本地记录器。不同 Provider 需要接入各自的生命周期事件；只安装 CLI，不会凭空拿到 Agent 的运行过程。

用户发出一条指令后，Agent 可能会思考、调用工具、修改文件、启动子 Agent，最后给出回复。Scry CLI 把这一整段过程记成一条 `AgentTurnRecord`。可以把它理解成 Agent 的行车记录仪。

它只负责采集、整理和保存本地记录，本身不上传数据。要不要上传、上传到哪里，由接入它的项目决定。

## 工作原理

```text
Provider 生命周期事件
        ↓
Scry recorder / workspace daemon
        ↓
合并 Hook、Provider 会话文件和 Git 前后快照
        ↓
.scry/records/*.json
        ↓
scry turns list / show / timeline / summary / export
```

一次记录大致分四步：

1. 用户发出指令时，Provider Hook 通知 Scry：一轮开始了。
2. 执行过程中，工具调用、模型回复、用量、Hook 等事件继续交给 Scry。每个工作区有一个后台 recorder，事件优先通过本地 Unix socket 发给它；后台进程不在时，CLI 会先直接处理事件，再拉起后台进程。
3. 这一轮结束后，Scry 合并生命周期事件和 Provider 自己的会话文件，并计算这一轮前后的 Git 变化。
4. Scry 生成一条正式记录，按递增序号原子写入 `.scry/records/`。同一条记录重复到达时不会重复落盘。

Scry App 管理的会话会直接提交 App 已经整理好的标准证据。独立运行 Agent 时，CLI 只能根据 Hook 和 Provider 会话文件还原，因此不同 Provider 能拿到的信息可能不完全一样。

记录失败时默认不阻断 Agent。能确认的信息照常保存，拿不到的信息会标成 `unavailable` 或 `partial`，不会用 `0` 冒充。

## 会采集什么

一条记录主要包含这些信息：

| 类型 | 具体内容 |
| --- | --- |
| 轮次身份 | 工作区、Provider、模型、会话 ID、轮次序号、开始和结束时间、耗时、完成状态 |
| 对话 | 用户指令、Agent 最终回复；Provider 明文提供时，也会保存中间的文本和 thinking 片段 |
| 调用 | 普通工具、Skill、MCP、子 Agent 的名称、顺序、状态、耗时、输入、输出摘要和错误 |
| 用量 | 输入/输出 Token、缓存 Token、推理 Token、费用、上下文大小、模型调用耗时 |
| 文件 | 读、写、编辑过的文件，以及这一轮前后的 Git diff |
| 运行过程 | Hook、上下文压缩、危险操作、报错、人工介入和等待时间 |
| 证据说明 | 每一类数据的来源、完整度和缺失原因 |

这里有两个容易误解的地方：

- Scry 记录的是“一个顶层用户轮次”，不是每执行一个 Hook 就写一条记录。Codex 子 Agent 的过程会尽量并回父轮次。
- 本地记录可能包含完整提示词、工具输入和代码 diff，不能把 `.scry/` 当普通日志随便分享。是否记录提示词、回复、工具输出、diff 和 Hook，可以在 `scry.config.json` 里关闭。

为避免记录无限变大，工具详情和 diff 有大小上限。超出后仍保留调用骨架、文件名和增删统计，但正文会被省略，并明确标为 `partial`。

## 会输出什么

Scry CLI 的命令统一输出 JSON，方便人查看，也方便脚本继续处理。

| 命令 | 输出 |
| --- | --- |
| `scry doctor --workspace "$PWD"` | CLI 版本、Node/平台、数据目录、pending/orphan/dropped 数量、记录文件是否完整 |
| `scry recorder status --workspace "$PWD"` | 当前工作区 recorder 是否运行、socket 和进程状态 |
| `scry turns list --workspace "$PWD"` | 每轮的序号、Provider、会话、状态、耗时、压缩次数和模型耗时摘要 |
| `scry turns show <序号或 recordId> --workspace "$PWD"` | 一条完整的 `AgentTurnRecord` |
| `scry turns timeline <序号或 recordId> --workspace "$PWD"` | 按发生顺序排列的模型文本、thinking、工具、Skill、MCP 和子 Agent 事件 |
| `scry turns summary --workspace "$PWD"` | 最新会话的轮次、调用、文件、Token、错误、diff 和耗时汇总 |
| `scry turns summary --all --workspace "$PWD"` | 整个工作区的汇总 |
| `scry turns export --workspace "$PWD" --after 0 --limit 100` | 可分页上传的记录，以及 `nextCursor`、`hasMore`、`snapshotMaxSequence` |
| `scry turns verify --workspace "$PWD"` | 本地记录是否能解析、序号和文件内容是否一致 |

`summary` 和时间指标要结合证据完整度看。比如 Codex 没有提供服务端精确延迟时，Scry 输出的是本地观测区间，里面可能还包含调度、传输和重试时间。

## rate-native 中怎么用

rate-native 把“本地记录”和“远端上传”拆成了两段：

```text
Claude / Codex / Qoder / OpenCode
        ↓ 项目 Hook
Scry CLI
        ↓
.scry/records
        ↓ record-committed
rate-native 异步 uploader
        ↓ 脱敏、gzip-base64 压缩
.scry/upload/outbox
        ↓
ai_native_trace_report.reportAgentTurns
```

### 通用目录初始化

仓库提供了一个通用脚本。进入想采集的目录后执行：

```bash
cd /path/to/workspace
bash /path/to/scry/scripts/setup-scry-workspace.sh
```

脚本会安装或定位 Scry CLI、生成最小 `scry.config.json`、把本地运行数据加入当前 Git 仓库的 exclude，最后执行 `scry doctor`。重复执行不会覆盖已有配置。

完成后，从 Scry App 打开这个目录即可采集。后台 recorder 不需要提前常驻，第一条 Provider 事件到来时会自动启动。直接在终端运行 Claude、Codex、Qoder 或 OpenCode 时，还需要接入对应 Provider Hook；只安装 CLI 无法拿到它们的运行过程。

### rate-native 的安装和启动

新同事在 rate-native 根目录运行 `bash init.sh`。脚本会：

1. 从内网 npm registry 安装或升级 `@ali/scry-turn-recorder@latest`。
2. 把解析到的 CLI 绝对路径写入四端本地配置的 `SCRY_CLI_PATH`，避免 Provider 改写 `PATH` 后调用到另一份 CLI。
3. 执行 `scry doctor` 检查配置和本地记录状态。

正常使用不需要手动运行 `scry recorder start`，也不需要让 Agent 或 Skill 主动执行 Scry 命令。Provider Hook 会自动完成记录。

### 本地记录

rate-native 的 `scry.config.json` 当前会记录提示词、回复、工具输出摘要、diff 和 Hook，并发现根仓库下两层以内的子 Git 仓库。记录写在 `.scry/records/`，不进入 Git。

这条链路独立于 rate-native 原有的阶段埋点：它不读写 `.claude/traces*.jsonl`，也不调用或复用 `reportTraces` 的游标。

### 远端上传

正式记录落盘后，Scry 只给 rate-native 的 commit hook 发送工作区、Provider、会话 ID、record ID 和序号。commit hook 再唤醒持久异步任务，不把整条记录塞进任务参数。

上传器会：

1. 用固定 snapshot 调用 `scry turns export`，避免分页过程中混入新记录。
2. 把工作区路径和用户目录替换成 `$WORKSPACE`、`$HOME`，并遮掉常见 token、密码、Cookie、Authorization 和 JWT。
3. 先把脱敏后的记录原子写进 `.scry/upload/outbox/`，再推进本地游标。
4. 用 `gzip-base64` 压缩记录，通过 Aone MCP 的 `reportAgentTurns` 上传。
5. 服务端返回 `inserted` 或 `duplicated` 才删除 outbox；网络失败继续保留，明确拒绝或冲突的记录移到 `.scry/upload/dead-letter/`。

上传状态在 `.scry/upload/health.json`。因此“本地已经记录”不等于“远端已经收到”，排查时要分别看 records、outbox、health 和远端 ACK。

### 开关

- `SCRY_TURN_UPLOAD_ENABLED=0`：只停远端上传，本地继续记录。
- `SCRY_RECORDER_ENABLED=0`：停止新增本地记录。
- 仓库根目录创建 `.scry-disabled`：停止新增本地记录。

已有记录仍可用 `turns list/show/summary/export/verify` 查看。停掉 recorder 不会删除历史数据。

## 一句话记住

Scry CLI 负责把 Agent 的一次完整工作过程记清楚；rate-native 负责把已经落盘的记录可靠地送到远端。日常采集和上传失败不会中断正在执行的 Agent，上传失败的记录也不会直接丢掉。受管会话启动前仍会严格检查 CLI 路径和版本；检查不过就拒绝启动，避免出现一段看似受管、实际没有记录的会话。
