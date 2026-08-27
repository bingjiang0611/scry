# Scry CLI 说明

## 它是干什么的

Scry CLI 是给 Claude Code、Codex、Qoder、OpenCode、Pi 这类命令行 Agent 用的本地记录器。不同 Provider 需要接入各自的生命周期事件；只安装 CLI，不会凭空拿到 Agent 的运行过程。

用户发出一条指令后，Agent 可能会思考、调用工具、修改文件、启动子 Agent，最后给出回复。Scry CLI 把这一整段过程记成一条 `AgentTurnRecord`。可以把它理解成 Agent 的行车记录仪。

它负责采集、整理和保存本地记录。数据默认放在当前工作目录的 `.scry/` 下。

## Scry CLI 是必须的吗

从原理上说，不是。记录 Agent 数据只需要两部分：

- Hook 在提问开始、工具调用和回答结束等节点发出事件。
- Recorder 接收这些事件，把同一轮的数据拼起来并写入文件。

Recorder 可以自己用 Python、Node.js 或 Shell 实现，不一定非要叫 Scry CLI。Scry CLI 的作用，是把接收事件、关联轮次、读取 Provider 会话文件、计算 Git diff、去重、异常恢复和查询记录这些通用能力封装好。项目已经有自己的 Recorder，并且输出满足使用方要求时，可以不安装 Scry CLI。

如果项目的 Hook 调用的是 `scry recorder hook`，就需要先安装 Scry CLI。只安装 CLI、没有配置 Hook，Scry 不知道 Agent 什么时候开始和结束，也就不会产生记录。

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
scry turns list / show / timeline / summary
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
| `scry turns verify --workspace "$PWD"` | 本地记录是否能解析、序号和文件内容是否一致 |

`summary` 和时间指标要结合证据完整度看。比如 Codex 没有提供服务端精确延迟时，Scry 输出的是本地观测区间，里面可能还包含调度、传输和重试时间。

## 怎么用

最快的用法只有三步：初始化目录、重启 Agent、执行一轮任务后查看记录。

### 第一步：初始化工作目录

进入想采集数据的目录，执行 Scry 仓库提供的 [`scripts/setup-scry-workspace.sh`](../../scripts/setup-scry-workspace.sh)：

```bash
cd /path/to/workspace
bash /path/to/scry/scripts/setup-scry-workspace.sh
```

脚本支持 Claude Code、Codex 和 Qoder，并会自动检测本机已经安装的工具。也可以明确指定：

```bash
SCRY_PROVIDERS="claude codex qoder" \
  bash /path/to/scry/scripts/setup-scry-workspace.sh
```

这一个脚本会完成三件事：

1. 安装或找到 Scry CLI。默认安装到 `~/.local`，不需要系统目录权限。
2. 在当前目录创建 `scry.config.json`，并让 Git 忽略本地记录目录 `.scry/`。
3. 为检测到的 Agent 安装项目 Hook。已有 Hook 不会被删除，重复执行也不会重复添加。

脚本执行完后，不需要再手动运行 `scry recorder start`。Hook 收到事件时会自动调用 Scry。

Hook 配置位置如下：

| Agent | Hook 配置文件 |
| --- | --- |
| Claude Code | `.claude/settings.local.json` |
| Codex | `.codex/hooks.json` |
| Qoder | `.qoder/settings.json` |

OpenCode 暂不支持这个初始化脚本，需要单独安装项目插件。

### 第二步：重启 Agent，执行一轮任务

初始化完成后，重启 Claude Code、Codex 或 Qoder，让它重新加载项目 Hook。然后像平时一样给 Agent 一条指令，不需要额外执行 Scry 命令。

如果想先检查安装是否正常，可以运行：

```bash
scry doctor --workspace "$PWD"
```

`doctor` 通过只说明 CLI、配置和本地目录可用。真正执行一轮 Agent 任务后，再运行下面的命令，能看到新记录才算接入成功：

```bash
scry turns list --workspace "$PWD"
```

### 第三步：查看记录

常用命令：

```bash
# 看有哪些记录
scry turns list --workspace "$PWD"

# 看最近一次会话的汇总
scry turns summary --workspace "$PWD"

# 看某一轮的完整内容
scry turns show <序号或 recordId> --workspace "$PWD"

# 按时间顺序查看某一轮发生了什么
scry turns timeline <序号或 recordId> --workspace "$PWD"
```

记录保存在当前工作目录的 `.scry/records/` 下，不会提交到 Git。记录里可能包含提示词、回复、工具输入输出和代码 diff，不要随意分享整个 `.scry/` 目录。

### 暂停和恢复

临时停止记录，任选一种方式：

```bash
# 只对当前这次命令生效
SCRY_RECORDER_ENABLED=0 <你的 Agent 命令>

# 停止当前工作目录继续产生记录
touch .scry-disabled
```

删除 `.scry-disabled` 后就会恢复记录：

```bash
rm .scry-disabled
```

暂停记录不会删除已有数据，之前的记录仍然可以用 `turns list`、`show`、`summary` 和 `verify` 查看。

## 一句话记住

在目标目录执行一次初始化脚本，重启 Agent，然后照常使用。执行完一轮任务后，运行 `scry turns list --workspace "$PWD"`，能看到新记录就说明 Scry 已经正常工作。
