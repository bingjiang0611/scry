# CLAUDE.md

# Scry

Scry 是一个 local-first 的 AI coding agent 观测与治理桌面 App。它在应用内驱动本机 Provider CLI/SDK，把会话、工具调用、文件足迹、用量、诊断和干预呈现为可检查证据。

Scry **不是安全沙箱**。它能做授权、指纹校验、观测和治理，但 Provider 与获批工具最终仍以本机用户权限运行；文件足迹也不是完整审计日志。

本文是仓库内 Agent 与维护者的默认工作约定。用户的明确要求可以覆盖一般偏好，但不能静默弱化权限语义、证据诚实性、renderer 隔离、仓库配置 trust gate 或发布验证。

## 我们绝不妥协的事情

### 1. 证据不能说谎

Scry 的核心价值是让用户知道“发生了什么”和“我们能证明什么”。`exact`、`estimated`、`inferred`、`partial`、`disabled`、`unavailable` 不是样式差异，而是产品语义。

- 真实没有工具调用可以是 `available + []`；Provider 不提供工具证据必须是 `unavailable`，不能也显示为空数组。
- 缺失 token、cost、duration、MCP、Hook、文件或风险证据时，不显示成 `0`、绿色或“无风险”。
- 原始 transcript、Provider result、hook lifecycle、trace archive、SQLite 聚合和 `.scry` turn record 有不同权威性；合并时保留 provenance 并避免双计。
- 一次逻辑调用的 started/progress/response 是生命周期，不是多次调用。
- Provider 明确给出的 canonical usage 优先于 transcript shadow；reasoning token 不得在 total 中重复相加。

### 2. Provider 差异必须显式存在

Claude 是主要路径；Codex、Qoder、OpenCode、Pi 仍是实验性路径。不要为统一 UI 假装 capability parity。

- adapter 不支持的能力返回明确的 degraded/unavailable envelope。
- run controls、审批、session、fork、model、MCP、Hook、Skill、usage 和 resume 语义逐 Provider 决定。
- Pi 没有 MCP 状态 API，就不要探测或推断。
- OpenCode 不支持某种审批模式时，不要把另一个 Provider 的选项硬塞进去。
- 切换 Provider、模型、权限模式或恢复 session 后，不能沿用不属于当前 runtime 的陈旧能力/审批状态。

### 3. 权限与 trust 不是一回事

`full_access` 表示用户明确选择让 Provider 以本机权限运行；它不是 Scry 提供了更强隔离。仓库控制的 MCP、Hook、plugin、executable 仍必须经过独立 trust/fingerprint 检查。

- 默认模式保留 Provider 原生/映射后的审批语义。
- `full_access` 必须在 UI 和 adapter 中用 Provider-specific 文案说明真实效果。
- 项目配置第一次执行或指纹变化时重新确认；批准的是 canonical cwd + 内容/executable fingerprint，不是名字。
- 同一 macOS 用户下的并发攻击者不在此信任模型保证范围内，不要作更强承诺。
- 观测 hook 可以 fail open，避免阻断用户 Agent；执行 trust gate 必须 fail closed，不能为“记录完整”而执行未授权代码。

### 4. Renderer 保持不可信且无特权

保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。Renderer 只能通过 typed `window.scry` preload API 调用经过校验的 main handler。

- 禁止任意命令、任意路径、任意 URL IPC。
- 主进程验证 sender/frame/origin，并对 payload 再做 schema、cwd、path 和 operation authorization。
- 阻止 webview、任意 navigation/window open 和非 allowlist 网络请求；敏感 localhost/private URL 要求用户确认。
- 不为恢复 React HMR 或开发便利而放宽 CSP/sandbox。当前 dev 配置刻意牺牲 HMR 以保持生产安全边界一致。

### 5. Recorder Core 必须独立

`src/core/turn-recorder/` 与 `scry-turn-recorder` 必须保持无 Electron、无 SQLite、无 Provider SDK、无原生依赖。CLI 在 macOS/Linux Node 20/22/24 上独立运行，并只写工作区 `.scry/`。

- `.scry/records` 是 recorder 的 canonical 一轮一文件事实源；runtime/state/health 是恢复或观测状态。
- managed recorder 两阶段提交需要等待 Provider result、hook、diff 等证据收敛，不能悄悄降级为 rollout 近似。
- Hook 通过明确的 private CLI 绝对路径运行；App 私有 CLI 与全局 npm CLI 是两个分发面。

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

## 最容易伤到自己的做法

1. **把 Scry 描述成沙箱。** 即使有审批、workspace 选择和 trust gate，Agent 仍可能在获批后访问 cwd 外文件或执行任意命令。
2. **把 unavailable 显示成空/零。** 这会让观测 UI 给出错误安全感和错误账单结论。
3. **强行统一 Provider。** 可选 facet 与 capability unavailable 是架构设计，不是待删除的重复代码。
4. **信任仓库里的命令字符串。** MCP、Hook、plugin 和 executable 必须 canonicalize、snapshot、hash，并在执行前重验。
5. **复用变更前的授权。** cwd、配置内容、声明顺序、executable inode/size/hash 变化都可能使旧 grant 失效。
6. **删除启动环境清洗。** 主进程会移除继承的 `CLAUDECODE`、`AI_AGENT`、`CLAUDE_EFFORT`、`CLAUDE_CODE_*`，避免嵌套 Agent 会话污染授权和 runtime；不要随意恢复。
7. **让 packaged App 回退到 PATH 中的 CLI。** App 私有 recorder CLI 必须通过 Resources 绝对路径驱动；缺失时 fail open 并报告，不要执行未知全局版本。
8. **恢复 electron-builder 默认 files。** checkout 中被 Git ignore 的 `.claude`、`.local`、日志或会话元数据可能被打进 App；显式 allowlist 是隐私边界。
9. **忘记 native/ESM 打包约束。** sandbox preload 必须是单一 CJS；`better-sqlite3`、`node-pty` 和需要真实文件的 SDK 资源必须正确 unpack。
10. **同时做 auth 与普通 Provider operation。** 遵守 `ProviderOperationGate`；同一 provider/profile 的认证与运行操作不能交叉污染。
11. **按名称批量杀进程。** 只停止 Scry 自己登记并能证明 identity 的 run/terminal/server；不要使用模糊 `pkill -f` 或目录名匹配。
12. **写入真实 `.scry` fixture。** 自动化测试使用临时 workspace/userData，不修改用户项目的 canonical records、Provider transcript 或真实 Scry DB。
13. **把 release 产物混进源码。** `dist`、generated CLI `dist` 和本机审计/会话文件不是实现真相；构建前从源码生成并由脚本验收。

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

## 跨表面检查清单

### Provider 或 run-control 改动

- Claude、Codex、Qoder、OpenCode、Pi 分别支持什么？不支持时 UI/Envelope 如何表示？
- new/resume/fork/stop/permission/question/error 是否保持 provider-specific identity？
- model、effort、permission mode 是否在恢复后显式重设，避免沿用旧 session 状态？
- CLI/SDK wire fixture 是否覆盖重复、乱序、partial、cancelled 和 unknown 事件？

### Trace / usage / evidence 改动

- logical call 是否按稳定 ID 聚合，而不是按原始事件数计数？
- canonical result 与 transcript shadow 是否去重？
- exact/estimated/inferred/unavailable 是否从 main 一直保留到 renderer？
- 真实空值与不可观测是否区分？
- live trace、history archive、turn record、SQLite projection 是否不会互相冒充权威？

### MCP / Hook / plugin / Skill 改动

- canonical cwd、配置内容、声明顺序、executable identity 和 hash 是否进入 fingerprint？
- 首次/变化后是否重新确认？
- auth 是否与运行 operation 互斥？
- Hook 记录失败是否 fail open，而执行授权失败是否 fail closed？
- Pi/OpenCode/Codex/Claude 的配置格式差异是否由 adapter 吸收？

### IPC / Workspace / Terminal 改动

- preload 类型、main handler、renderer 调用和测试是否一起更新？
- sender/frame/origin、cwd、relative path、symlink、protected name 是否都重验？
- terminal backpressure/ack、resize、close、window crash/navigation 清理是否保持？
- Renderer 是否仍不能直接访问 Node、任意 fs 或 spawn？

### Recorder / CLI 改动

- Core 是否仍可在无 Electron/native module 环境构建？
- Node 20/22/24、macOS/Linux 是否都在支持范围？
- open -> closing -> committed fencing、duplicate Stop、recovery、global sequence 和 corrupt record 是否有测试？
- `.scry` 无配置时 fail closed，不自动初始化/执行仓库 Hook？
- App 私有 CLI、全局 CLI、Pi integration 和 versioned docs 是否同步？

### UI 改动

- 对话、右侧 Overview、Analytics、Diagnostics、MCP Trust、workspace/terminal 表面是否使用同一证据语义？
- unavailable/partial/unknown 是否有明确视觉和说明，而不是被隐藏？
- dev preload/main/renderer 版本短暂不一致时是否可恢复而非黑屏？
- 高频 stream 是否有界，避免每 token 导致全树重绘或同步 Markdown 重算？

## 测试约定

- 测试与实现 colocate 为 `*.test.ts` / `*.test.tsx`；Provider wire 差异使用 fixture/contract test，不用 shared mock 抹平。
- Provider 发现链路同时覆盖 fast/full 两阶段探测、版本探测超时收敛和已保存的自定义 Profile；扫描中不展示中间卡片，完整结果一次展示。
- trust、permission、path、IPC 和 deletion 逻辑同时测试 allow 与 deny/mismatch/stale 路径。
- evidence 测试要覆盖真实空值、不可观测、partial、重复和乱序，不只测完整 happy path。
- Recorder 测试覆盖 crash fence、原子写、lock recovery、duplicate event/Stop、cursor 与 corrupt record。
- 不用固定 sleep 掩盖竞态；等待 receipt、事件、进程退出、文件原子出现或 queue drain。
- 当前仓库没有 ESLint/Prettier 命令，不要发明不存在的门禁或做大范围无关格式化。

迭代时运行最小相关检查：

```bash
npx vitest run src/main/providers/codex.test.ts
npm run typecheck
npm run build
```

## 验证与交付

默认选择能证明本次改动的最小验证，不把 CLI 多版本兼容、Electron 打包和 security smoke 作为每次小改动的前置条件。完成改动并通过对应验证后，默认启动开发版本供用户检查；用户明确要求不启动时除外。为用户检查而启动开发版本时，默认直接使用正常用户数据和工作区，不注入临时 `HOME`、`userData`、Application Support 或其他隔离数据目录；只有自动化测试、破坏性验证或用户明确要求时才使用隔离数据。

### 纯文档或 Agent 配置

```bash
git diff --check
```

同时核对 Markdown、引用路径、命令、Provider/安全边界与版本示例。纯文档不构建 App/CLI、不升版本。

### 普通代码改动

开发中运行受影响测试；普通 App 代码交付前至少运行：

```bash
npx vitest run <affected-test-files>
npm run typecheck
npm run build
git diff --check
```

- 修改 workspace Hook 时追加 `npm run test:shell`。
- 修改 recorder Core、CLI、integration 或 npm 包时追加 `npm run check:cli-release`。
- 修改 packaging、preload、native dependency、resource allowlist 或 Electron security 时追加 `npm run pack:artifact`。
- 本机 ignored 的 `.claude/`、`.agents/` 等 Agent 目录可能污染 Vitest 自动发现；应限定到项目自有 `src/`、`scripts/` 测试或在 clean checkout 运行，不要删除用户配置来让测试通过。

### 完整 CI / 发布门禁

以下情况才运行完整套件：用户明确要求；改动跨越 Provider/trust/persistence/recorder/IPC/packaging 多个核心边界；准备高风险合入；或构建可安装/正式发布版本。

```bash
npm run typecheck
npm test
npm run build
npm run check:cli-release
npm run pack:artifact
git diff --check
```

完整 gate 对应 Node 22 App、Node 20/22/24 CLI compatibility 和 macOS packaged Electron security smoke。涉及真实 Provider、OAuth、账号、MCP server 或平台行为时另做 L3，并明确哪些未执行。

## 版本、打包、安装与发布

App 与独立 CLI **分别版本化**；不要默认每次 App 修改都升 CLI，也不要漏升实际改变的分发面。

- 纯文档/Agent 配置不产生新 App/CLI 产物，不为此单独升版本。
- 普通 App 源码提交不自动升版本；准备新的可安装版本或正式发布时，源码冻结后才升一次根 `package.json` version，并重新跑完整验证与打包。
- 影响独立 recorder CLI 合同、命令、integration 或 npm 包内容：升 `packages/turn-recorder-cli/package.json` version，并同步 README/安装示例。
- 如果同一改动同时影响两个分发面，分别判断并分别升版本；两者无需强行相同。
- README 中的 CLI 安装版本必须与 CLI package 当前版本一致，避免复制陈旧命令。

开发目录包：

```bash
npm run pack:artifact
```

准备桌面 App 可安装版本或正式发布时，必须安装并检查同一产物：

```bash
npm run install:mac:dev
```

正式签名/公证安装：

```bash
npm run install:mac
```

正式路径要求 Developer ID Application/`CSC_LINK`、Team ID 与 Apple notarization credentials；安装器会验证 bundle id、App/CLI version、签名、Gatekeeper、staple 和 Team ID 后再原子替换 `/Applications/Scry.app`。不要手工覆盖 App。

独立 CLI 发布只使用：

```bash
npm run publish:cli
```

package lifecycle 会强制执行 `check:cli-release`，registry 固定为内网地址；不要从陈旧 `dist` 手工 `npm publish`。

提交前检查 `git diff`，只提交本任务改动；除非用户明确要求，不推送。

## 代码风格与品味

- 使用 strict TypeScript、discriminated union、typed envelope 和明确 domain state；避免 `any` 与字符串猜测。
- 保持 semicolonless、single quote、两空格的既有风格，不做无关格式清洗。
- 复杂度留在 adapter/trust/persistence 边界；renderer 保持展示导向，recorder core 保持纯净。
- 优先扩展现有 contract、registry、store 和 projection，不建立第二套同义状态。
- 注释解释证据来源、信任边界、失败模式和为何必须如此，不逐行翻译代码。
- fail-open 只用于不应阻断用户 Agent 的观测附加路径；权限、信任、路径和发布完整性必须 fail closed。
- 先做最小真实修复，再考虑抽象；不要保留复杂度只因为它已经存在。
- 如果某条规则与任务真实需求冲突，先指出冲突并取得维护者明确同意，不要静默绕过。
