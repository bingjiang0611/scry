# Scry CLI / App 观测对齐差距方案

## 1. 现状描述

Scry App 与 turn-recorder CLI 已共享 `TraceEvent`、`logicalCallEventsForTurn()` 和
`aggregateTurnEvidence()`，但两条数据采集路径不同：

- App 由 Codex app-server adapter 直接产生原生 `items`，纵览从这些事件聚合
  （`src/main/providers/codex.ts`、`src/renderer/format.ts`）。
- CLI 同时采集 lifecycle hook 与 Codex rollout，再由
  `mergeTurnTraceEvents()` 合并后落 `AgentTurnRecord`
  （`src/core/turn-recorder/recorder.ts`、`aggregate.ts`）。
- Scry Provider 启动时已由 `runtimeCliEnv()` 固定 `SCRY_CLI_PATH`
  （`src/main/claude-locate.ts`）；rate-native 的直接 bridge 遵守该变量，但观察队列
  和 uploader 仍调用 `shutil.which("scry")`。

真实会话 `019fad2e-0aeb-7a20-9c3e-cbeb0a49dde8` 证明：App 记录 162 次逻辑调用，
CLI 记录 296 次；App 有 8 次工具错误和完整 usage，CLI 为 0 / unavailable；daemon
为 0.2.0，而直连记录由 0.2.4 生成。

## 2. 用户需求复述

用户要求修复已经核查出的 Scry CLI 记录问题，使新产生的 Codex turn record 在
可观测字段上与 Scry App 使用同一逻辑口径，并消除同一会话混用多份 CLI 的情况。

CLI 无法观测的 Codex 原生 hook runtime 继续明确标记 `unavailable`，不伪造为 0。

## 3. Delta 识别

1. lifecycle 与 rollout 的同一调用使用不同 ID；现有合并仅按 ID 去重，整轮重复。
2. rollout 在真实 `Stop` 时尚未写入 `task_complete`；usage 只在该事件出现时落盘。
3. code-mode 一次外层调用会展开多个逻辑调用；结构化输出的逐项 `exit_code`
   未映射回对应调用。
4. 异步 code-mode 先返回 `Script running with cell ID`，真实逐项结果随后由
   `wait` / `write_stdin` 返回；把首次返回当完成会漏掉尾部错误。
5. rollout `function_call` 已带 `namespace=mcp__node_repl`，解析器只读 `name=js`。
6. 绝对插件 skill 路径不匹配仅覆盖 `.claude/.codex/.agents` 的识别规则。
7. rate-native 队列和 uploader 绕过 `SCRY_CLI_PATH`，可能命中另一份全局 CLI；
   队列 job 还必须在入队时快照该变量，否则 worker 的环境会再次漂移。
8. CLI 版本不变时旧 daemon 无法识别代码已更新，需要发布新的 recorder patch 版本。

## 4. 闭合选项

### Delta 1：双来源重复

- 方案 A（推荐）：当 rollout 快照稳定且已解析调用全部有结果时，把其调用
  start/result 作为权威来源；条件不满足时退回现有逐 ID 合并。lifecycle 仍补
  assistant/usage/hook 等 rollout 未提供的类别。改 1 个合并函数、1 个内部完整性
  标记和回归测试，不改 schema。
- 方案 B：按名称、输入和时间窗口逐个模糊匹配。需要引入容差、并发排序和空输入
  规则，误合并风险高，约改 3–4 处。
- 方案 C：要求上游统一 call ID。跨 Codex app-server、hook adapter 与 rollout 格式，
  本仓无法保证，且不能修复既有 Provider。

### Delta 2–6：rollout 解析缺口

- 方案 A（推荐）：在现有解析器内补齐 EOF usage、namespace、静态 tuple-map 展开、
  逐项结构化结果、异步 cell 关联和绝对 skill 路径，沿用 aggregate。EOF usage 优先使用
  `total_token_usage - turn baseline`；只有没有累计值时才累加 `last_token_usage`。
  改 1 个实现文件和 1 个测试文件。
- 方案 B：把 App archive 反灌 CLI。会形成跨进程、跨存储耦合并破坏独立 CLI 契约。

### Delta 7：CLI 路径漂移

- 方案 A（推荐）：rate-native 队列与 uploader 复用同一语义——变量存在时只接受
  该绝对可执行文件；失效则 fail-open，不回退 PATH；变量缺失才 `which`。异步队列
  在 job 入队时连同身份变量一起快照 `SCRY_CLI_PATH`，worker 只执行 job 固定的路径。
  改 2 个源 hook 和 2 个 smoke。
- 方案 B：Scry 从 PATH 中挑最高版本。会偏离 shell 命令解析和显式路径契约，且不能
  阻止下游再次绕过。

### Delta 8：daemon 代码身份

- 方案 A（推荐）：recorder 从 0.2.4 升到 0.2.5；全部验证通过后只更新故障现场已经
  存在的两处 npm prefix，不新增全局路径或配置。随后停止旧 daemon，由固定路径按需
  启动 0.2.5。
- 方案 B：版本不变，仅重启 daemon。状态与记录无法区分修复前后代码，不利于验收。

## 5. 推荐方案 + 回问清单

采用各 Delta 的方案 A：

1. Scry 仅修改 recorder 归一/合并逻辑和 patch 版本，不改
   `AgentTurnRecord v1`、App 总览、SQLite 或上传协议。
2. 新记录的 Tool / Skill / MCP、error、usage 与 App 使用同一逻辑口径；Codex hook
   继续 `unavailable`。旧 0.2.4 记录保持可读且不做破坏性重写。
3. rate-native canonical repo 已确认是 `/Users/baobingjiang/IdeaProjects/rate-native`
   的 `main@a292fa6`。只改 canonical `.claude/hooks/` 源文件，再运行适配同步；不手改
   四端生成物，也不修改会被 treehouse 回收的临时 worktree。
4. 验证包含 Scry L1、真实 CLI/daemon smoke、真实会话 fixture 对账；rate-native
   运行 `four-agent-validation quick`，因涉及异步队列再运行 `runtime`。不执行业务
   workflow、构建、部署或线上写操作。

开放问题：无。用户“修复”已覆盖上述局部、可逆、无 schema 迁移的实现范围；现有
错误记录不原地改写。若 rollout 快照尚有未完成调用，CLI 保留 lifecycle 证据并把
可用性按既有 partial 语义处理，不用“去重”换取漏计。
