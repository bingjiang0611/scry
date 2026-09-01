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

### 一条完整记录长什么样

下面是一条结构完整的示例记录。里面的路径、时间、Token 和内容都是演示值，实际以 `scry turns show <序号或 recordId> --workspace "$PWD"` 的输出为准。

```json
{
  "schemaVersion": 1,
  "recordKind": "agent_turn",
  "sequence": 12,
  "recordId": "8b46136ac7a949418ddf362f9fdcbec1",
  "recorderVersion": "0.2.27",
  "workspace": {
    "id": "demo-project",
    "root": "/Users/zhangsan/projects/demo-project"
  },
  "provider": {
    "id": "codex",
    "model": "gpt-5.4"
  },
  "sessionId": "019d2d73-852c-7ae0-bb25-a88122a9dc90",
  "providerTurnId": "turn-38",
  "generation": 3,
  "turnIndex": 3,
  "startedAt": "2026-08-27T08:31:12.105Z",
  "completedAt": "2026-08-27T08:31:25.482Z",
  "durationMs": 13377,
  "status": "completed",
  "user": {
    "status": "available",
    "quality": "exact",
    "source": [
      "provider_transcript"
    ],
    "value": {
      "text": "修复文章标题为空时页面报错的问题",
      "textHash": "sha256:fb739b2062f4b3cd1a7255f953540db7f6ba9aa1fb14d715ca78cd04c556af74"
    }
  },
  "assistant": {
    "status": "available",
    "quality": "exact",
    "source": [
      "provider_transcript"
    ],
    "value": {
      "text": "已修复标题为空时的报错，并补充了对应测试。",
      "textHash": "sha256:5c0d3350aa2457af0ea76cd7654ab568438a0464e5f84649504da22911158ad8"
    }
  },
  "tools": {
    "status": "available",
    "quality": "exact",
    "source": [
      "provider_transcript",
      "lifecycle_hooks"
    ],
    "value": [
      {
        "id": "call-01",
        "category": "tool",
        "order": 2,
        "completedOrder": 3,
        "name": "Read",
        "startedAt": "2026-08-27T08:31:14.011Z",
        "completedAt": "2026-08-27T08:31:14.052Z",
        "durationMs": 41,
        "status": "success",
        "input": {
          "file_path": "src/article/title.ts"
        },
        "file": {
          "operation": "read",
          "path": "src/article/title.ts"
        }
      },
      {
        "id": "call-02",
        "category": "tool",
        "order": 4,
        "completedOrder": 5,
        "name": "Edit",
        "startedAt": "2026-08-27T08:31:16.302Z",
        "completedAt": "2026-08-27T08:31:16.355Z",
        "durationMs": 53,
        "status": "success",
        "input": {
          "file_path": "src/article/title.ts"
        },
        "file": {
          "operation": "edit",
          "path": "src/article/title.ts"
        }
      },
      {
        "id": "call-03",
        "category": "tool",
        "order": 6,
        "completedOrder": 7,
        "name": "Bash",
        "startedAt": "2026-08-27T08:31:18.104Z",
        "completedAt": "2026-08-27T08:31:22.682Z",
        "durationMs": 4578,
        "status": "success",
        "input": {
          "command": "npm test -- title.test.ts"
        },
        "outputSummary": "3 tests passed"
      }
    ]
  },
  "skills": {
    "status": "available",
    "quality": "exact",
    "source": [
      "provider_transcript"
    ],
    "value": [
      {
        "id": "skill-01",
        "category": "skill",
        "order": 1,
        "name": "ponytail",
        "startedAt": "2026-08-27T08:31:12.802Z",
        "status": "success",
        "input": {
          "source": "skill_injection"
        }
      }
    ]
  },
  "mcps": {
    "status": "available",
    "quality": "exact",
    "source": [
      "provider_transcript"
    ],
    "value": []
  },
  "hooks": {
    "status": "available",
    "quality": "exact",
    "source": [
      "provider_transcript",
      "lifecycle_hooks"
    ],
    "value": [
      {
        "order": 0,
        "lifecycleEvents": 2,
        "runs": 1,
        "event": "UserPromptSubmit",
        "name": "requirement-check.sh",
        "command": ".claude/hooks/requirement-check.sh",
        "startedAt": "2026-08-27T08:31:12.110Z",
        "completedAt": "2026-08-27T08:31:12.143Z",
        "durationMs": 33,
        "status": "success"
      },
      {
        "order": 2,
        "lifecycleEvents": 6,
        "runs": 3,
        "event": "PreToolUse",
        "name": "security-check.sh",
        "command": ".claude/hooks/security-check.sh",
        "startedAt": "2026-08-27T08:31:14.002Z",
        "completedAt": "2026-08-27T08:31:18.095Z",
        "durationMs": 47,
        "status": "success"
      },
      {
        "order": 3,
        "lifecycleEvents": 6,
        "runs": 3,
        "event": "PostToolUse",
        "name": "audit-log.py",
        "command": "python3 .claude/hooks/audit-log.py",
        "startedAt": "2026-08-27T08:31:14.053Z",
        "completedAt": "2026-08-27T08:31:22.690Z",
        "durationMs": 61,
        "status": "success"
      },
      {
        "order": 8,
        "lifecycleEvents": 2,
        "runs": 1,
        "event": "Stop",
        "name": "trace-flush.py",
        "command": "python3 .claude/hooks/trace-flush.py",
        "startedAt": "2026-08-27T08:31:25.401Z",
        "completedAt": "2026-08-27T08:31:25.462Z",
        "durationMs": 61,
        "status": "success"
      }
    ]
  },
  "usage": {
    "status": "available",
    "quality": "exact",
    "source": [
      "provider_transcript"
    ],
    "value": {
      "inputTokens": 8432,
      "outputTokens": 926,
      "cacheReadTokens": 5140,
      "cacheCreationTokens": 0,
      "reasoningTokens": 418,
      "costUsd": 0.0438125,
      "apiDurationMs": 6200,
      "contextTokens": 13572,
      "contextWindow": 200000,
      "model": "gpt-5.4"
    }
  },
  "compactions": {
    "status": "available",
    "quality": "exact",
    "source": [
      "provider_transcript"
    ],
    "value": []
  },
  "modelSegments": {
    "status": "available",
    "quality": "exact",
    "source": [
      "provider_transcript"
    ],
    "value": [
      {
        "order": 1,
        "at": "2026-08-27T08:31:13.001Z",
        "kind": "text",
        "text": "我先检查标题处理逻辑。",
        "messageId": "msg-01"
      },
      {
        "order": 8,
        "at": "2026-08-27T08:31:24.910Z",
        "kind": "text",
        "text": "已修复标题为空时的报错，并补充了对应测试。",
        "messageId": "msg-02"
      }
    ]
  },
  "modelTiming": {
    "status": "available",
    "quality": "estimated",
    "source": [
      "response_intervals"
    ],
    "value": {
      "method": "response_intervals",
      "cumulativeMs": 6200,
      "occupiedMs": 6200,
      "overlapMs": 0,
      "totalCalls": 2,
      "timedCalls": 2,
      "root": {
        "totalCalls": 2,
        "timedCalls": 2,
        "cumulativeMs": 6200
      },
      "subagents": {
        "totalCalls": 0,
        "timedCalls": 0,
        "cumulativeMs": 0
      },
      "calls": [
        {
          "responseId": "msg-01",
          "scope": "root",
          "completedAt": "2026-08-27T08:31:14.000Z",
          "durationMs": 1800,
          "source": "observed",
          "boundary": "turn_or_activity_end"
        },
        {
          "responseId": "msg-02",
          "scope": "root",
          "completedAt": "2026-08-27T08:31:25.000Z",
          "durationMs": 4400,
          "source": "observed",
          "boundary": "turn_or_activity_end"
        }
      ],
      "activityCoverage": {
        "timedCalls": 2,
        "totalCalls": 2
      }
    }
  },
  "files": {
    "status": "available",
    "quality": "exact",
    "source": [
      "provider_transcript",
      "git_diff"
    ],
    "value": [
      {
        "path": "src/article/title.ts",
        "operation": "read"
      },
      {
        "path": "src/article/title.ts",
        "operation": "edit"
      }
    ]
  },
  "diff": {
    "status": "available",
    "quality": "exact",
    "source": [
      "git_before_after"
    ],
    "value": [
      {
        "status": "captured",
        "files": [
          {
            "path": "src/article/title.ts",
            "added": 4,
            "deleted": 1,
            "patch": "@@ -12,1 +12,4 @@\\n- return article.title.trim()\\n+ const title = article.title?.trim()\\n+ if (!title) return \"未命名文章\"\\n+ return title",
            "patchStatus": "captured"
          }
        ],
        "repoRoot": "/Users/zhangsan/projects/demo-project",
        "scope": "workspace",
        "beforeAt": "2026-08-27T08:31:12.180Z",
        "afterAt": "2026-08-27T08:31:25.201Z",
        "captureMs": 92,
        "cleanup": "ok",
        "collection": {
          "strategy": "targeted",
          "evidence": "git_status+structured",
          "candidatePathCount": 1,
          "discoveryMs": 12,
          "targetedMs": 71
        }
      }
    ]
  },
  "dangerousOperations": {
    "status": "available",
    "quality": "exact",
    "source": [
      "scry_classifier"
    ],
    "value": []
  },
  "errors": {
    "status": "available",
    "quality": "exact",
    "source": [
      "provider_transcript"
    ],
    "value": []
  },
  "interventions": {
    "status": "available",
    "quality": "exact",
    "source": [
      "provider_transcript"
    ],
    "value": []
  }
}
```

每个数据区都有一层证据说明：

| 字段 | 含义 |
| --- | --- |
| `status` | `available` 表示拿到了；`partial` 表示只拿到一部分；`unavailable` 表示 Provider 没提供；`disabled` 表示配置主动关闭 |
| `quality` | `exact` 是原始证据；`estimated` 是观测区间；`inferred` 是根据有限信息推断；`unavailable` 是无法判断 |
| `source` | 这项数据来自 Provider Transcript、生命周期 Hook、Git diff，还是 Scry 自己的分类器 |
| `value` | 真正的数据 |
| `omissionReason` | 数据不完整、不可用或被关闭时，说明原因 |

各部分可以这样理解：

| 部分 | 用户能看到什么 |
| --- | --- |
| 轮次身份 | 工作区、Agent、模型、会话、轮次、开始结束时间、耗时和最终状态 |
| `user` / `assistant` | 用户说了什么，Agent 最后回答了什么 |
| `tools` | 读文件、改代码、执行命令和子 Agent 等调用 |
| `skills` | 这一轮真正使用过的 Skill；没有使用时是 `available + []` |
| `mcps` | 调用了哪个 MCP server 和工具；没有调用时是 `available + []` |
| `hooks` | 执行了哪些 Hook、执行次数、命令、耗时和结果。Recorder 自己的 Hook 会被过滤，避免把自己算进去 |
| `usage` | Token、缓存、费用、上下文大小和 Provider 上报的 API 耗时 |
| `compactions` | 这一轮是否发生过上下文压缩 |
| `modelSegments` | Provider 明文提供的中间文字、thinking 和最终回复片段 |
| `modelTiming` | 模型调用耗时。`estimated` 表示本地观测，不等于服务端精确延迟 |
| `files` | 读、写、编辑过哪些文件 |
| `diff` | 这一轮真正产生的代码变化、增删行数和 patch |
| `dangerousOperations` | Scry 识别到的危险操作 |
| `errors` | 工具或运行过程中的错误 |
| `interventions` | Agent 是否向用户提问、用户是否回答或取消 |

完整记录可能包含提示词、命令参数和代码 patch，分享前要先脱敏。

## 怎么用

最快的用法只有三步：初始化目录、重启 Agent、执行一轮任务后查看记录。

### 第一步：在项目根目录初始化

先安装 Scry CLI：

```bash
npm install -g @ali/scry-turn-recorder@0.2.29 \
  --registry=https://registry.anpm.alibaba-inc.com
```

然后进入要采集的 Git 项目根目录执行：

```bash
cd /path/to/project
scry init
```

默认会检测 Claude Code、Codex、Qoder 和 OpenCode。也可以明确指定：

```bash
scry init --providers claude,codex,qoder,opencode
```

必须在 Git 项目的根目录执行。比如 Git 根目录是 `/repo`，在 `/repo/packages/app` 中执行会直接报错并告诉你正确目录。Scry 不会偷偷执行 `git init`。

`scry init` 只提取 rate-native 中与 Scry Recorder 直接相关的通用逻辑，会做这些事：

1. 创建 `scry.config.json`，默认采集提示词、回复、工具摘要、Hook 和 Git diff。
2. 创建 `.scry/provider-hook.sh`，把不同 Agent 的事件统一交给 Scry CLI。
3. 合并 Provider 项目配置，保留用户已有 Hook，重复执行不会重复添加。
4. 把 `.scry/` 和 `.scry-disabled` 写入当前 Git 仓库的本地 exclude。
5. 检查配置和本地 Store 是否可用。

它不会安装 rate-native 的上传器、审计 Hook、Aone 上报或其他业务逻辑，也不会上传数据。

Hook 配置位置如下：

| Agent | Scry 写入的位置 |
| --- | --- |
| Claude Code | `.claude/settings.local.json` |
| Codex | `.codex/hooks.json` |
| Qoder | `.qoder/settings.json` |
| OpenCode | `.opencode/plugins/scry-recorder.js` |

Pi 的 lifecycle 扩展是用户级配置，不属于项目 Hook 初始化，单独执行：

```bash
scry integrations install-pi
```

#### 兼容脚本

如果希望把“没有就先安装 CLI”和“初始化项目”合成一个脚本，可以直接复制下面的完整代码。脚本最后仍然调用 `scry init`，不会维护第二套 Hook 逻辑。

```sh
#!/bin/sh
set -eu

fail() {
  printf 'Scry 初始化失败：%s\n' "$1" >&2
  exit 1
}

absolute_executable() {
  candidate="$1"
  [ -f "$candidate" ] && [ -x "$candidate" ] || return 1
  directory="$(cd "$(dirname "$candidate")" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s\n' "$directory" "$(basename "$candidate")"
}

workspace="${1:-$PWD}"
[ -d "$workspace" ] || fail "目录不存在：$workspace"
workspace="$(cd "$workspace" && pwd -P)"

command -v node >/dev/null 2>&1 || fail "缺少 Node.js 20 或更高版本"
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
case "$node_major" in
  ''|*[!0-9]*) fail "无法读取 Node.js 版本" ;;
esac
[ "$node_major" -ge 20 ] || fail "Node.js 版本过低，需要 20 或更高版本"

if [ -n "${SCRY_CLI_PATH:-}" ]; then
  scry_bin="$SCRY_CLI_PATH"
elif command -v scry >/dev/null 2>&1; then
  scry_bin="$(command -v scry)"
elif [ -x "$HOME/.local/bin/scry" ]; then
  scry_bin="$HOME/.local/bin/scry"
else
  command -v npm >/dev/null 2>&1 || fail "缺少 npm，无法安装 Scry CLI"
  registry="${SCRY_NPM_REGISTRY:-https://registry.anpm.alibaba-inc.com}"
  printf '安装 Scry CLI 到 %s/.local ...\n' "$HOME"
  npm install -g --prefix "$HOME/.local" @ali/scry-turn-recorder@latest \
    --registry="$registry" >/dev/null
  scry_bin="$HOME/.local/bin/scry"
fi
scry_bin="$(absolute_executable "$scry_bin")" || fail "Scry CLI 不可执行：$scry_bin"

if [ -n "${SCRY_PROVIDERS:-}" ]; then
  exec "$scry_bin" init --workspace "$workspace" --providers "$SCRY_PROVIDERS"
fi
exec "$scry_bin" init --workspace "$workspace"
```

保存为 `setup-scry-workspace.sh` 后执行：

```bash
chmod +x setup-scry-workspace.sh
./setup-scry-workspace.sh

# 或明确指定 Provider
SCRY_PROVIDERS="claude codex qoder opencode" ./setup-scry-workspace.sh
```

脚本执行完后，不需要手动运行 `scry recorder start`。第一个 Hook 事件会直接落盘并启动当前 workspace 的 recorder daemon，后面的事件优先走 Unix socket。daemon 不可用时会自动退回直接调用，Recorder 失败也不会阻断 Agent。

### 第二步：重启 Agent，执行一轮任务

初始化完成后，重启 Claude Code、Codex、Qoder 或 OpenCode，让它重新加载项目 Hook。Codex 还要在项目中执行一次 `/hooks`，确认并信任项目 Hook；这是 Codex 的安全边界，`scry init` 不能替用户自动确认。然后像平时一样给 Agent 一条指令，不需要额外执行 Scry 命令。

如果想先检查安装是否正常，可以运行：

```bash
scry doctor --workspace "$PWD"
```

`scry init` 和 `doctor` 通过，只说明 CLI、配置和本地目录可用，不代表 Provider 已经加载 Hook。真正执行一轮 Agent 任务后，再运行下面的命令，能看到新记录才算接入成功：

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

## rate-native 中怎么用

rate-native 已经带了自己的四端 Hook 和上传器，覆盖 Claude Code、Codex、Qoder 和 OpenCode。不要再执行前面的通用初始化脚本，否则可能重复添加 Hook。新同事只需要在 rate-native 根目录运行：

```bash
bash init.sh
```

### 初始化做了什么

`init.sh` 中和 Scry 有关的动作只有三类：

1. 通过项目内安装器安装或升级 `@ali/scry-turn-recorder@latest`。找不到系统级安装目录权限时，安装器会使用用户目录。
2. 把实际找到的 CLI 绝对路径写入 Claude、Codex、Qoder 和 OpenCode 的 `settings.local.json`，统一使用 `SCRY_CLI_PATH`。这样 Agent 改写 `PATH` 后也不会调用到另一份 CLI。
3. 执行 `scry doctor --workspace <rate-native根目录>`。返回 0 表示正常；返回 5 表示 CLI 可用，但已有 pending、orphan 或 dropped 数据需要排查。

rate-native 的 `scry.config.json` 会采集提示词、回复、工具输出摘要、Hook 和 Git diff，并发现根目录下两层以内的嵌套 Git 仓库。`.treehouse`、`node_modules`、`target`、`dist` 和 `build` 不参与仓库发现，`.factorypath` 不保存 patch 正文。

### 本地记录链路

```text
Claude / Codex / Qoder / OpenCode
        ↓ 项目 Hook
.claude/hooks/scry-recorder.sh
        ↓
workspace recorder daemon
        ↓ daemon 不可用时直接调用 CLI，并拉起 daemon
.scry/records/*.json
```

四端的事件名和载荷不同，`agent-adapters` 负责转换，最后都进入同一个 `scry-recorder.sh`。这个脚本优先把事件发给当前工作区的 Unix socket；socket 不可用时，当前事件由 CLI 直接处理，并用 `--start-daemon` 拉起后台 recorder。

通过 Scry App 启动 Agent 时，环境里会有 `SCRY_RECORDER_MANAGED=1`。这时 Hook 只建立轮次身份，最终记录使用 App 已经整理好的标准证据，不再从会话文件近似还原。受管模式会检查 CLI 绝对路径和版本，检查失败就拒绝建立受管记录。

### 远端上传链路

Scry CLI 只负责生成本地记录。rate-native 在它后面增加了上传链路：

```text
.scry/records/*.json
        ↓ record-committed
.claude/hooks/scry-record-committed.py
        ↓ 只传 provider、sessionId、recordId、sequence
持久异步任务
        ↓
.claude/hooks/scry_turn_uploader.py
        ↓ export、脱敏、写 outbox、gzip-base64
ai_native_trace_report.reportAgentTurns
```

具体处理顺序如下：

1. 正式 record 原子落盘后，commit hook 只接收工作区、Provider、会话 ID、record ID 和 sequence，不把整条大 JSON 塞进任务参数。
2. 异步 uploader 调用 `scry turns export`，固定 `snapshotMaxSequence` 分页读取，避免上传过程中混入新记录。
3. 上传前把工作区路径和用户目录替换成占位符，并遮掉常见 Token、密码、Cookie、Authorization 和 JWT。脱敏只作用于上传副本，本地原始记录不会被改写。
4. 脱敏后的记录先原子写入 `.scry/upload/outbox/`，落盘成功后才推进本地游标。
5. 记录压缩后更小时，使用 `gzip-base64` 信封；小记录或压缩无收益时保留明文 JSON。
6. uploader 通过 Aone MCP 调用 `reportAgentTurns`。服务端返回 `inserted` 或 `duplicated` 后才删除 outbox；`rejected` 或 `conflicted` 会移入 `.scry/upload/dead-letter/`；网络超时会保留并重试。

这条链路与 rate-native 原有的阶段埋点分开。Scry uploader 不读写 `.claude/traces*.jsonl`，也不复用 `reportTraces` 的上传游标。

### 怎么确认正常

初始化后重启 Agent，执行一轮真实任务，再检查：

```bash
# CLI、配置和本地 Store
scry doctor --workspace "$PWD"

# 是否生成了新轮次
scry turns list --workspace "$PWD"

# 查看某一轮完整记录
scry turns show <序号或 recordId> --workspace "$PWD"

# 查看上传状态
python3 -m json.tool .scry/upload/health.json

# outbox 有文件，说明还在等待上传或重试
ls .scry/upload/outbox

# dead-letter 有文件，说明远端明确拒绝、冲突或多次超时
ls .scry/upload/dead-letter
```

“本地有记录”和“远端已收到”是两件事。`turns list` 只能证明本地记录成功；远端是否完成，要结合 `health.json`、outbox、dead-letter 和服务端 ACK 判断。

### 开关

| 开关 | 作用 |
| --- | --- |
| `SCRY_TURN_UPLOAD_ENABLED=0` | 停止远端上传，本地继续记录 |
| `SCRY_RECORDER_ENABLED=0` | 停止新增本地记录，rate-native uploader 也直接退出 |
| 根目录创建 `.scry-disabled` | 停止新增本地记录，上传器也直接退出 |
| `SCRY_RECORDER_TRANSPORT=direct` | 不走 daemon，每次 Hook 直接调用 CLI，主要用于排查 socket 问题 |

这些开关不会删除历史记录。

## 一句话记住

普通项目把文档中的脚本保存到目标目录并执行一次；rate-native 只运行 `bash init.sh`。重启 Agent 并完成一轮真实任务后，`scry turns list --workspace "$PWD"` 出现新记录，才能证明本地采集已经接通。
