# Scry Turn Recorder CLI

## 1. 背景与目标

Scry 当前在 Electron 主进程内通过四个 Provider adapter 收集会话、工具、Skill、MCP、Hook、Usage、文件和 Diff。sample-workspace 需要在保持原生 Agent 使用方式的前提下获得相同口径的“顶层用户轮次”本地数据，但现有 sample-workspace 埋点以业务阶段为中心，两套数据必须完全独立。

本方案把轮次合同、事件归一、Git 基线和正式记录提交抽成无 Electron 的共享 Core，并提供本地 CLI。CLI 不联网、不上传、不理解 sample-workspace Phase，不读写 `.claude/traces*.jsonl`。运行中事件仅进入 pending；Provider 确认轮次结束时才生成一条 `AgentTurnRecord`。

## 2. 整体流程

```text
Provider lifecycle
  UserPromptSubmit ──► session lock ──► open generation + Git baseline
  Pre/Post/Failure ──► session lock ──► current generation event file
  Stop/completed  ──► session lock ──► closing fence ──► normalize/diff
                                                    │
                                                    ▼
                    global commit lock ──► records/<sequence>-<recordId>.json
                                                    │
                                                    └─► cursor export
```

Agent 不在提示词或工具调用中主动执行 CLI。Claude/Qoder/Codex 的 command hook 与 OpenCode plugin 自动把原始 payload 通过 stdin 传入。sample-workspace 后续上传器只消费只读 export，并持有自己的上传 Cursor。

## 3. 改动清单

### 3.1 Scry

- 新增 `src/shared/turn-record.ts`：版本化 `AgentTurnRecord` 公共合同。
- 新增 `src/core/turn-recorder/`：配置、open-turn 状态机、payload 归一、pending store、聚合、commit、export、health、恢复和嵌套 Git Diff。
- 新增 `src/cli/scry.ts` 及 recorder/turns/doctor 命令。
- 修改 `package.json`、新增独立 CLI tsconfig 和 `packages/turn-recorder-cli`，生成无 Electron、无原生 SQLite、零运行时依赖的 `@ali/scry-turn-recorder` 包；现有 `mcpguard` 不迁移、不回归。
- Electron 完成一轮时调用同一 Core 的纯聚合 API，把 `TurnEvidence` 随既有 archive 保存；正式 `.scry/records` 提交只由外部生命周期 Recorder 执行，renderer/IPC 与既有 archive/SQLite 保持不变。

### 3.2 sample-workspace

- 新增 `scry.config.json`，声明 workspace、nested Git 发现规则和本地记录选项；不含上传配置或密钥。
- `.gitignore` 忽略 `.scry/`，并支持根目录 `.scry-disabled` 无发布止损。
- 在 `.claude/settings.json` 增加独立 Recorder handler；原有 trace/flush handler原样保留。
- `agent-adapters` 生成 Qoder、Codex、OpenCode 对应 Provider 参数与事件映射。
- 增加静态校验和 runtime smoke，证明关闭开关后行为不变、开启后只新增 `.scry/**`。

### 3.3 明确不改

- sample-workspace `.claude/hooks/trace_*.py`、`flush.py`、`traces*.jsonl`、MCP、DB、仪表盘。
- sample-workspace 的业务工作流、Skill 和所有嵌套业务仓。
- Scry renderer 视觉、IPC 公共 API、Provider 启动与权限策略。
- 上传 endpoint/table、鉴权、重试、上传 Cursor 持久化；这些属于 sample-workspace 后续任务。

## 4. 公共合同

### 4.1 证据语义

所有可缺失 section 都使用显式证据包，不能以空数组或零冒充不可观测：

```ts
type EvidenceQuality = 'exact' | 'estimated' | 'inferred' | 'unavailable'
type EvidenceStatus = 'available' | 'partial' | 'disabled' | 'unavailable'

interface Evidence<T> {
  status: EvidenceStatus
  quality: EvidenceQuality
  source: string[]
  value?: T
  omissionReason?: string
}
```

`capture.prompt=false` 为 `disabled`；真实无工具为 `available + []`；Provider 不提供工具证据为 `unavailable`。Diff 保留现有 Scry 的 `status/reason/files/repoRoot/scope/binary`，不压扁成三个无法区分语义的数字。

同一 `hookId` 的 started/progress/response 聚合为一个 `TurnHookCall`，不能把生命周期原始事件数冒充处理器调用数。Usage 按整轮权威 result 求和；若同时存在原生聚合 result 与 transcript 影子 usage，优先原生结果，避免双计。

### 4.2 `AgentTurnRecord v1`

```ts
interface TurnCall {
  id?: string
  parentId?: string
  name: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  status: 'started' | 'success' | 'failed' | 'cancelled' | 'unknown'
  input?: unknown
  outputSummary?: string
  error?: string
  file?: { operation: 'read' | 'write' | 'edit'; path: string }
  mcp?: { server?: string; action?: string; tool?: string }
}

interface TurnHookCall {
  id?: string
  event: string
  name?: string
  command?: string
  startedAt?: string
  completedAt?: string
  status: 'started' | 'success' | 'failed' | 'cancelled' | 'unknown'
  exitCode?: number
}

interface TurnUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
  costUsd?: number
  model?: string
}

interface AgentTurnRecord {
  schemaVersion: 1
  recordKind: 'agent_turn'
  sequence: number
  recordId: string
  recorderVersion: string
  workspace: { id: string; root: string }
  provider: { id: ProviderId; version?: string; model?: string }
  sessionId: string
  providerTurnId?: string
  generation: number
  turnIndex: number
  startedAt: string
  completedAt: string
  durationMs: number
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  user: Evidence<{ text?: string; textHash?: string }>
  assistant: Evidence<{ text?: string; textHash?: string }>
  tools: Evidence<TurnCall[]>
  skills: Evidence<TurnCall[]>
  mcps: Evidence<TurnCall[]>
  hooks: Evidence<TurnHookCall[]>
  usage: Evidence<TurnUsage>
  files: Evidence<Array<{ path: string; operation: 'read' | 'write' | 'edit' }>>
  diff: Evidence<TurnDiffSnapshot[]>
  dangerousOperations: Evidence<TurnDanger[]>
  errors: Evidence<TurnError[]>
}
```

类型守卫/normalizer 与 fixture 是 JSON 合同的可执行规范。老的 Scry archive/SQLite 不迁移；Electron 只通过 adapter 把现有 `TraceEvent[]` 转成同一 Record。

## 5. Open-turn 状态机

每个 `{provider, sessionId}` 只有一个带 fencing token 的 open turn：

```text
idle -> open(generation=N) -> closing(N) -> committed(N) -> idle
```

- `UserPromptSubmit` 在 session lock 内递增 generation，写 `open.json`，并捕获 Git baseline。
- 全局/项目重复 handler 在 active generation 内按 `session + event + payload fingerprint` 去重；相同 prompt 的下一轮发生在上轮 committed 后，仍会获得新 generation。
- Pre/Post/Failure 按 `open.json` 路由；无 open turn 的事件进入 `orphans/`，增加 health 计数，不猜测归属。
- 新 prompt 到来但旧轮仍 open 时，旧轮以 `interrupted` 提交，再创建新 generation。
- Stop 在 session lock 内把 generation 标为 `closing`；重复 Stop 找不到 open turn时返回 duplicate，不新增轮次。
- Resume 沿用 session，但 generation/turnIndex 从已提交记录恢复；AskUserQuestion、通知、compact、synthetic/meta prompt 只有在 Provider 明确标成真实顶层 user message 时才建轮。
- 所有 Recorder handler 同步执行并由 Provider 等待；CLI 在返回前完成事件原子落盘，因此 Stop 是完成 fence。首版不支持 async handler。

## 6. 正式 Store、原子性与 Cursor

### 6.1 路径

- `.scry/runtime/<provider>/<session>/open.json`
- `.scry/runtime/<provider>/<session>/turns/<generation>/events/<event-id>.json`
- `.scry/runtime/<provider>/<session>/orphans/<event-id>.json`
- `.scry/records/<20位sequence>-<recordId>.json`：唯一正式事实源，一轮一文件。
- `.scry/state/next-sequence.json`：性能缓存，可从 records 最大 sequence 重建，不是事实源。
- `.scry/health.json`、`.scry/logs/recorder.log`。

正式提交持有全局 commit lock：扫描/校验相同 `recordId`，从 records 最大 sequence 分配下一号，先把完整 Record 写临时文件并 `fsync`，再原子 rename。进程在 rename 前崩溃不会产生正式记录；rename 后崩溃，recover 通过 records 重建 sequence cache，不会重复 append。

锁使用 `mkdir` + owner metadata；owner PID 已不存活且锁超过 TTL 才回收 stale lock。session lock 与 global lock 都有有限等待，超时不阻塞 Agent：保留 pending 并由 recover 重试。

### 6.2 Export Cursor

```text
scry turns export --workspace <root> --after <sequence> --limit <n>
```

输出 `{ records, nextCursor, hasMore, snapshotMaxSequence }`。同一分页链固定 `snapshotMaxSequence`；记录按 sequence 严格升序。恢复中的旧 session 只会在完成提交时获得新 sequence，因此不会落到已消费 Cursor 之前。记录损坏时 export 非零退出并指出文件；不会静默跳过。文件名/内容 sequence 不一致视为损坏。

## 7. CLI

```text
scry recorder hook --provider <id> --event <event> --workspace <root> --stdin --quiet
scry recorder recover --workspace <root>
scry turns list|show|export|verify --workspace <root>
scry doctor --workspace <root> [--json]
```

Hook 模式默认静默；可恢复错误写 health/log 并以 0 返回，不改变 Agent 权限、提示词或工具结果。配置/Store 检查命令使用稳定退出码：`0=healthy`、`2=disabled`、`3=config`、`4=store-corrupt`、`5=degraded`。

Recorder handler 由 sample-workspace 生成器在 Provider 可见的 command 上注入结构化 `SCRY_HANDLER_ID=turn-recorder-v1`；Core 同时识别 marker 与 `scry-recorder.sh` 命令，确保 Recorder 自身不进入 Hook 统计。

## 8. 配置、范围与无发布止损

sample-workspace 根目录新增：

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "workspaceId": "sample-workspace",
  "dataDir": ".scry",
  "repositories": {
    "mode": "discover-nested-git",
    "maxDepth": 2,
    "exclude": [".treehouse", "node_modules", "target", "dist", "build"]
  },
  "capture": {
    "prompt": true,
    "assistant": true,
    "toolOutput": "summary",
    "diff": true,
    "hooks": true
  }
}
```

- `dataDir` 必须是 config 所在 workspace root 下的专用相对子目录，不得指向 workspace 根、绝对路径或经过符号链接；它不相对 hook cwd。
- Core 拒绝逃逸路径和符号链接路径；Git snapshot 无论接入方是否配置 `.gitignore` 都硬排除 Recorder 自身 dataDir。
- sample-workspace 集成模式缺少 config 时 fail closed，不创建 `.scry`。
- nested Git 默认发现 workspace 下完整仓库集合，再套 exclude；不维护容易漏仓的四仓 allowlist。
- 禁用优先级固定为：`.scry-disabled` > `SCRY_RECORDER_ENABLED=0` > `config.enabled=false` > enabled。
- Hook/Plugin launcher 在启动 `scry` 二进制之前执行 sentinel/env 检查；disabled 时不启动二进制、不创建目录、不写日志。
- CLI 缺失、坏二进制或超时均不得影响原 Handler；sample-workspace init 只给可操作 warning，不联网安装。
- kill switch 只停止新增记录；`turns list/show/export/verify` 仍可只读已有正式记录。

## 9. 时序与健康预算

- 所有四 Provider 首版统一使用同步 Recorder handler；OpenCode plugin 也 `await` recorder command。
- 非结束事件只做 stdin 解析、session lock 和单文件原子写，目标本机 p95 `<100ms`。
- UserPromptSubmit 含 nested Git baseline，目标 p95 `<2s`；Stop 含 diff/commit，目标 p95 `<3s`。Provider handler timeout 统一 5s。
- 若基线或 Diff 超时，Record 仍提交，但 diff 标为 `partial/unavailable`，不补零；待 recover 的 lock/transcript 情况保留 pending。
- `health.json` 原子更新：`lastSuccessAt`、`lastError`、`droppedEvents`、`orphanEvents`、`pendingCount`、`oldestPendingAgeMs`、`recoveredRecords`。
- recorder.log 做 1 MiB 单备份轮转；主目录不可写时，仅在非 quiet/doctor 模式 rate-limit 输出 stderr。

## 10. 决策记录

- 正式记录按顶层用户轮次；AskUserQuestion、子 Agent、compact 和通知不制造顶层轮次。
- 过程事件可暂存，但只有结束事件写正式 Store。
- 正式事实源是一轮一 JSON 文件；sequence cache/health/index 全部可重建或非权威。
- 本地 Recorder 与上传消费者完全分离；export 为只读操作。
- sample-workspace 壳仓与自动发现的嵌套子仓分别建模，Diff 按真实子仓归属。
- 首版不做 daemon；用明确 p95 预算决定是否需要后续常驻进程。
- 首版不承诺四 Provider 的所有 section 均 exact；原生 runtime/transcript frame 才标 exact，配置反查标 inferred，不可见标 unavailable。

### 已否决

- CLI 直传 TMCP：破坏通用性并污染阶段统计。
- 复用 sample-workspace trace 文件：数据源和 Cursor 会耦合。
- Stop-only 首次采集：四 Provider 证据不完整且无法获得每轮 Git 基线。
- JSONL + 全局权威 index：跨文件 Cursor 和崩溃原子性无法成立。
- async 高频 handler：Stop 无可靠完成 fence。
- 当前 Scry 脏工作树直接开发：与未提交用户改动重叠，使用独立 worktree。

## 11. 验收标准

- 一次顶层用户轮次只生成一条正式记录；重复 prompt handler/Stop 不重复；相同文本的下一轮不误去重。
- 四 Provider 能记录正常、失败、取消和中断轮次；orphan/部分证据明确可诊断。
- Tool、Skill、MCP、Usage、文件、Hook 和嵌套 Git Diff 与 Scry App 使用同一合同；不可观测与真实零值可区分。
- Recorder 自身不出现在 Hook 统计中。
- export Cursor 在跨 session 交错、恢复晚提交和分页期间不漏不重。
- 对每一个关键崩溃点（记录 rename 前后、sequence cache 更新前后、stale lock）都有恢复测试。
- `.scry-disabled` 或 `SCRY_RECORDER_ENABLED=0` 时不启动二进制且不产生任何 `.scry` 文件。
- CLI 完全离线运行，源码与包产物不包含 TMCP URL/Token/上传逻辑。
- 固定 Hook payload 在 Recorder 开/关两种情况下，现有 `.claude/traces*.jsonl` 行数、字段与 flush 输入相同；`.scry/**` 是唯一新增写入面。
- 本机 benchmark 满足 p95 预算；坏二进制/timeout 对四 Provider 不阻塞。
- Scry typecheck/tests/build/build:cli/diff check 通过；sample-workspace adapter validate/runtime smoke 和四 Provider 多轮回归通过。

## 12. 开放问题

- CLI 发布到哪一个内部制品源不影响代码合同；首版以 `npm pack` 产物验证，sample-workspace 只依赖 `scry` 可执行文件和最低版本。
- sample-workspace 如何上传 TurnRecord、使用哪个 endpoint/table 属于后续独立任务，本 RFC 不定义。
