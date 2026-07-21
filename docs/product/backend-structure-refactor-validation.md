# Backend Structure Refactor Validation

更新日期：2026-07-04

## 范围

本轮在已完成的 renderer AppShell / R0-R4 重构基础上，继续整理 `src/main` 后端结构。目标是降低主进程胶水层复杂度，保持现有 Claude SDK 执行、session、trace、billing、MCP、SQLite 和 preload IPC 契约不变。

## R0 Baseline

当前后端边界：

- `src/main/index.ts`：819 行，同时承担窗口创建、recent folders、app sessions、skill 开关、MCP 配置和握手测试、历史会话、active run、trace IPC batching、Claude binary 缓存、billing/stats/diagnostics/git/usage IPC。
- `src/main/span-ledger.ts`：schema DDL、span/model_usage/file_ops 行映射和跨会话 SQL，纯函数模块，有 `span-ledger.test.ts`。
- `src/main/billing-ledger.ts`：SDK result / Admin / gateway payload 到 `usage_ledger` / `provider_raw_usage` 的行映射和 reconciliation，纯函数模块，有 `billing-ledger.test.ts`。
- `src/main/db.ts`：Electron `app.getPath('userData')`、better-sqlite3 初始化、迁移执行、预编译 SQL、billing state 查询和 fixture/admin 导入。
- `src/main/agent-runner.ts`：Claude Agent SDK query / captureInit / interrupt / supportedCommands。
- `src/main/normalize.ts`：SDK/transcript 到 `TraceEvent` 的纯归一化逻辑，有 `normalize.test.ts`。
- `src/main/transcript-archive.ts`：transcript mirror / resolve / delete，有 `transcript-archive.test.ts`。
- `src/preload/index.ts`：`window.scry` IPC contract。

## Schema / Ledger 判断

本轮允许“schema/ledger 深层整理”，但 R0 证据显示当前 schema/ledger 的核心纯逻辑已经在 `span-ledger.ts` 和 `billing-ledger.ts` 中，并已有 DDL 幂等、SDK result、gateway/admin payload、脱敏、reconciliation 等测试。

因此本轮不做破坏性 schema 迁移，也不改 `usage_ledger` / `provider_raw_usage` / `spans` / `model_usage` / `file_ops` 字段语义。更高收益、低风险的优化方向是：

1. 将 `src/main/index.ts` 中的 app-local JSON store、skill config、MCP config/test、usage.jsonl 聚合抽出。
2. 保持所有 IPC channel 名称和 payload 不变。
3. 用新增小模块测试覆盖被抽取的纯解析/文件聚合逻辑。
4. 继续让 `db.ts` 作为 SQLite 胶水层，避免把 electron app path / better-sqlite3 引入纯模块。

## 结构变更

| 模块 | 结果 | 保持不变的契约 |
| --- | --- | --- |
| `src/main/app-store.ts` | 抽出 recent folders、app-only sessions、projects 分组和只读文件头工具。 | `agent:recentFolders`、`agent:listSessions`、`agent:listProjects` 返回结构不变；仍只列 app 自己起过的会话。 |
| `src/main/usage-jsonl.ts` | 抽出 `usage.jsonl` 追加和聚合。 | `agent:usageStats` 返回 `{ cost, tin, tout, turns }` 不变；仍为 SDK result 估算累计，不是官方账单。 |
| `src/main/skill-config.ts` | 抽出 user/project skills 枚举、`skillOverrides` replace 语义和 SDK allowlist 计算。 | `agent:listSkills` / `agent:toggleSkill` 行为不变；项目级 `skillOverrides` 存在时整体替代用户级。 |
| `src/main/mcp-config.ts` | 抽出 MCP config 读取、启停写 `.claude.json`、stdio/http MCP `tools/list` 测试和 SSE 解析。 | `agent:listMcp` / `agent:testMcp` / `agent:toggleMcp` 行为不变；显式 enabled 仍覆盖 disabled；写 `.claude.json` 仍使用临时文件原子替换。 |
| `src/main/index.ts` | 从 819 行降到约 332 行，保留 Electron 窗口、IPC wiring、active run orchestration、runtime cache。 | IPC channel 名称、payload、Claude SDK start/stop/resume、MCP live cache、slash command cache、diagnostics/billing/git/stats 调用不变。 |

## 新增测试

| 测试 | 覆盖点 |
| --- | --- |
| `src/main/app-store.test.ts` | recent folders 去重/截断；app sessions 分组、resume 更新时间但保留首条 preview、remove。 |
| `src/main/usage-jsonl.test.ts` | 追加 usage result、聚合 cost/tokens/turns、跳过损坏 JSON 行、不存在文件返回零值。 |
| `src/main/mcp-config.test.ts` | direct JSON / SSE `tools/list` 解析；`enabledMcpjsonServers` 覆盖 disabled；listMcp enabled 状态。 |
| `src/main/skill-config.test.ts` | 项目级 `skillOverrides` replace 用户级 overrides；`computeEnabledSkills` allowlist。 |

## 命令验证

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 通过，22 files；217 passed，3 skipped |
| `npm run build` | 通过 |
| `git diff --check` | 通过 |
| `npm test -- src/main/app-store.test.ts src/main/usage-jsonl.test.ts src/main/mcp-config.test.ts src/main/skill-config.test.ts` | 通过，4 files；7 tests |

## Electron CDP Runtime 验收

启动命令：

```bash
npm run dev -- --remoteDebuggingPort 9444
```

CDP 目标确认：`title=scry`，`url=http://localhost:5173/`，preload 暴露 `window.scry`，包含 `start` / `stop` / `activeRun` / `usageStats` / `stats` / `billingState` / `listSessions` / `listProjects` / `listMcp` / `listSkills` 等 IPC API。

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| IPC preload contract | 通过；`window.scry` key 集合完整，`activeRun()` 初始为空。 | CDP `Runtime.evaluate` |
| Claude CLI detection | 通过；检测到 `/Users/example/.nvm/versions/node/v22.22.1/bin/claude`，版本 `2.1.197 (Claude Code)`。 | `window.scry.detect()` |
| Billing / stats read path | 通过；`billingState()` 返回 gateway fixture、ledger rows、official bill unavailable；`stats()` 正常读取 SQLite。 | CDP `billingState()` / `stats()` |
| 项目 cwd 写入 | 通过；`setCwd('/Users/example/IdeaProjects/vibecoding/scry')` 后 `recentFolders()` 包含当前项目。 | CDP IPC |
| 真实 start 路径 | 通过到 SDK runner；低成本 prompt `只回复 OK，不读文件、不调用工具` 产生真实 `SessionStart` / `UserPromptSubmit` hook trace，并拿到 SDK sessionId `507c53f8-069e-4d11-812e-018db216b433`。 | `/tmp/scry-stop-path.png` |
| Stop 路径 | 通过；`stop()` 返回 `true`，约 602ms 收到 `agent:turnDone`：`{ runId, sessionId, stopped: true }`。 | CDP event probe |
| usage.jsonl | 通过；stop 后 `usageStats().turns` 从 6 增至 7，说明 `harness result` 继续追加到 `usage.jsonl`。 | CDP `usageStats()` |
| SQLite stats / session history | 通过；`stats().totals.turns` 从 4 增至 5，`byCwd` 增加当前项目；`listSessions(cwd)` 出现新 session，`listProjects()` 出现 `scry`。 | CDP `stats()` / `listSessions()` / `listProjects()` |

边界说明：第一次应用内真实 start 在 253ms 收到 `Claude Code process terminated by signal SIGKILL`，未产生 trace。随后命令行 SDK 对照能进入 `system:init`，应用内第二次 start 也能进入 hook/init；因此记录为外部 Claude/API 链路瞬态问题，而不是本轮后端拆分的稳定复现回归。第二次真实 run 因外部 API retry/中断只落到 `error_during_execution`、cost 为 0，本轮不伪造成“模型已成功回复 OK”。

## 子 Agent 审查

本轮安排只读子 agent 审查当前 diff，关注 IPC/SDK/session/billing/MCP 语义、renderer shell 交互和测试覆盖。

审查处理：

- “拓扑 turn 箭头不再折叠”是用户明确要求的产品行为：`TurnBlock` 箭头为视觉提示，不作为 regression 修回。
- `useAgentSession` 状态机测试缺口已补：新增 `src/renderer/hooks/useAgentSession.test.ts`，覆盖 activeRun 恢复、trace batch 后 turnDone、error hint、clearTurns 丢弃旧 run 残余事件、stopRun 标 done、历史会话替换。
