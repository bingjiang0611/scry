# scry · architecture

按任务读取相关小节，不要求每次全文读取。代码块与行内路径均相对仓库根；命令执行前核对实际文件和 package scripts。当前根指南见 [CLAUDE.md](../../CLAUDE.md)。

## 术语

- **Provider**：Claude、Codex、Qoder、OpenCode 或 Pi 的产品适配层。
- **runtime provider**：实际 transport：`claude_sdk`、`codex_cli`、`qoder_cli`、`opencode_server`、`pi_rpc`。
- **Provider adapter**：实现 run，并可选实现 fork、Skill、MCP、command、trust、run-control 等 facet 的边界对象。
- **CapabilityEnvelope**：显式表达 ready、degraded、unavailable 的能力结果。
- **run / turn / session**：一次活动执行、一次顶层用户轮次、可恢复的 Provider 对话身份；三者不可混用。
- **trace event**：归一化后的模型、工具、Hook、usage、错误或 lifecycle 观测事件。
- **logical call**：聚合 lifecycle 事件后的单次工具/Skill/MCP/agent 调用。
- **turn record**：带 evidence status/quality/provenance 的版本化顶层轮次事实。
- **managed recorder**：由 App 管理、在证据收敛后提交 canonical turn record 的路径。
- **trace archive**：Scry App 为历史 UI 保存的轮次/事件档案，不等于 `.scry` record。
- **SQLite ledger**：面向分析、用量、账单和聚合的本机数据库；可以降级，不是 Provider transcript。
- **commit hook bundle**：经指纹批准后冻结到 userData、用于 commit notification 的 workspace hook 副本。
- **permission mode**：default、auto-review（仅支持的 Provider）或 full access；不是统一 sandbox 等级。

## 架构与数据流

```text
React renderer
  -> typed window.scry preload API
  -> trusted IPC handler / main orchestration
  -> ProviderRegistry
  -> provider-specific adapter
  -> local CLI / SDK / server / JSONL RPC
  -> normalized TraceEvent / logical calls / canonical evidence
  -> live UI
  -> trace archive + SQLite ledger + optional workspace .scry records
```

持久面彼此独立：

- `app.getPath('userData')/scry.db`：SQLite analytics/usage/billing ledger，WAL + migrations；native module 失败时 App 降级运行。
- `app-sessions.json`：Scry 自己启动过的项目/会话 catalog；不扫描并收编所有终端会话。
- `trace-archive-*`、`transcripts/`：App-owned historical evidence/mirror。
- `db-turn-outbox/`：数据库暂时不可写时的 durable turn replay queue。
- `<workspace>/.scry/`：独立 recorder 的 canonical records/runtime/health；不是 App DB 的备份。
- Provider 原生 transcript/history：由各 Provider 拥有，删除 Scry 副本不等于删除 Provider 原件。

不要用一个 store 的成功去推断另一个 store 已提交；跨 store 操作需要明确顺序、partial failure 和 retry handle。

手机运行的历史恢复：
- `remote-run-binding` 每秒合并一次运行中 checkpoint，同一轮只允许一个写入在途；终态等待该写入，再写 terminal progress 与 archive。Provider promise 拒绝也保存已产生的内容。硬退出可能丢失最近一个刷新间隔及在途写入，不能承诺逐事件无损。
- `trace-turn-progress` 显式区分 running 与不可变 terminal。仅没有活动 owner 时，重启恢复才把 running 标为 interrupted，并注明内容可能不完整。
- 旧 Pi 手机会话缺少归档时，Mac 可只读恢复默认 `~/.pi/agent/sessions` 下经会话 ID/cwd 校验的 v3 原生记录；按 parent ancestry 读取当前分支。与后续 Scry 归档只按 Provider 原生 turn ID 关联，不按提示词去重。无法关联的归档轮次单独保留并提示可能重叠，不隐藏失败请求，原件不变。
- 原生恢复不启动 Provider，不补造用量、审批、文件变更、图片或终态，不写 `.scry`。当前只支持默认目录及不超过 64 MiB 的文件，恢复时先读完整当前分支并关联归档，再分页展示；自定义目录需先增加 profile 到根目录的明确绑定，大文件或读取耗时明显时需改为流式读取/原生 ID 索引。`--dev-pi-history-only` Electron fixture 覆盖实际点击、分页和续聊后重新打开。

## 代码地图

- `src/main/index.ts`：Electron composition root、IPC 与生命周期热点；优先提取 focused module，不继续堆叠无关 policy。
- `src/main/providers/types.ts`、`registry.ts`：Provider adapter/facet/capability 主接缝。
- `src/main/providers/{claude,codex,qoder,opencode,pi}.ts`：transport-specific adapter。
- `src/shared/{provider,runtime,trace,turn-record,workspace,terminal}.ts`：跨进程与持久合同。
- `src/main/{agent-runner,run-registry,run-outcome}.ts`：执行、活动 run 与结局。
- `src/main/{renderer-security,workspace-authorization}.ts`：renderer 与 workspace 文件信任边界。
- `src/main/{mcp-execution-trust,commit-hook-trust,codex-hook-trust,opencode-plugin-trust}.ts`：仓库控制执行的指纹授权。
- `src/main/{db,db-migrations,db-outbox,span-ledger,billing-ledger}.ts`：SQLite、分析与账单。
- `src/main/{transcript-archive,managed-turn-commit,trace-turn-progress,session-history}.ts`：证据归档、恢复和合并。
- `src/core/turn-recorder/`：Electron-free recorder state machine、store、daemon、aggregate、export、health。
- `src/cli/`：独立 CLI、workspace init、integration、update、MCP guard。
- `src/preload/index.ts`：Renderer 唯一 privileged API。
- `src/renderer/components/`、`hooks/`：聊天、会话、分析、诊断、MCP trust、workspace、terminal 等 UI。
- `packages/turn-recorder-cli/`：独立 npm 包、README 与 Pi integration。
- `scripts/`：package allowlist、Electron security smoke、release policy、atomic installer、CLI tarball smoke。
- `src/shared/turn-record.ts`、`src/core/turn-recorder/`、`packages/turn-recorder-cli/README.md`：turn record 与 evidence 语义权威实现。

