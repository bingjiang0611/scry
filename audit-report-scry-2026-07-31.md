# Fuck My Shit Mountain Audit Report

**Project:** Scry
**Audit mode:** full
**Date:** 2026-07-31
**Reviewer:** OpenAI Codex / GPT-5

---

## 1. Executive Summary

Scry 是一个本地 Electron + React + TypeScript 桌面工作台，通过 Claude、Codex、Qoder、OpenCode 四类 Provider 驱动 coding agent，并把会话、工具调用、文件变更、计费和 canonical recorder 证据写入本地多套存储。代码库不是“不可维护的垃圾堆”：共享 Provider 契约、workspace 路径防护、Git 采样隔离、canonical record 原子写入、类型检查和大量快速测试都做得认真；Node 22 下 typecheck、完整启用测试、生产构建、macOS 目录打包和 CLI dry-run 均通过。

但它目前不具备稳定公开发布的安全边界。最严重的问题是模型或工作区 Markdown 的普通外链可把同一个 BrowserWindow 导航到不可信页面，而 preload 仍向该页面暴露完整 window.scry。Electron 实机探针已确认：导航到无网络 data 页面后，工作区读写、移入废纸篓、会话枚举与 agent:start 等 50 个 preload 方法仍然存在。再叠加远端图片零点击请求、Billing Admin 凭据传入 Provider 子进程（终端继承时也进入 MCP probe）、MCP 状态刷新执行仓库命令、权限控制失败时回退 full_access，这构成了系统性的信任边界错误。

稳定性和数据治理同样有发布阻断项：recorder 陈旧锁回收存在 TOCTOU，SQLite migration 非事务且不可重入，Codex JSON-RPC 超时可能留下失联运行，会话目录写入非原子，删除会话不清理附件、SQLite、usage JSONL 和可选 workspace 记录。测试数量可观，但绝大多数 renderer 测试是 Node SSR 或纯函数测试，缺少真实交互、Electron 导航、IPC origin、焦点与时序覆盖，也没有 CI。总评 4.5 / 10（C）：基础工程能力不差，但安全、迁移、并发和发布闸门必须先修，不能把当前本地 MVP 当成可安全分发的稳定桌面应用。

### Score Dashboard

    Security        ███░░░░░░░  2.8  D   已确认 1 个可到本地文件/Agent 权限的 Critical 边界突破及 4 个 High 安全链
    Stability       ████░░░░░░  4.2  C   锁回收、迁移和 Provider 超时均可能破坏数据或留下失联任务
    Performance     ██████░░░░  6.2  B   主路径可用，但归档 O(n²) 重写、附件复制和 423 MB 包体会持续放大成本
    Testing         █████░░░░░  4.6  C   63 个测试文件提供大量快速回归，但交互/Electron/安全边界与 CI 基本缺席
    Maintainability █████░░░░░  5.4  B   类型与领域模块较好，多个 1000+ 行核心文件和全局 CSS 补丁栈拖累演进
    Design          █████░░░░░  4.9  C   最小权限、fail-fast、显式副作用和 SRP 在关键边界上被违反
    Release         ████░░░░░░  3.5  C   无签名、公证、CI、回滚和安全迁移，安装替换也非原子
    ─────────────────────────────────────
    Overall         █████░░░░░  4.5  C

每个维度按 0.0–10.0 评分，分数越高越好。结论基于本报告覆盖范围，不是机械扣分。

### Finding Statistics

| Severity | Count | Confirmed | Suspected |
|----------|-------|-----------|-----------|
| Critical | 1 | 1 | 0 |
| High | 9 | 9 | 0 |
| Medium | 9 | 9 | 0 |
| Low | 0 | 0 | 0 |
| Info | 0 | 0 | 0 |
| **Total** | **19** | **19** | **0** |

## 2. Project Map

- Renderer：src/renderer/App.tsx 负责顶层工作台状态，components/ 承担会话、分析、诊断、workspace、Skills/MCP 与 Markdown 展示，hooks/ 管理 Provider、会话和异步 IPC 状态。
- Preload：src/preload/index.ts 通过 contextBridge 暴露统一 window.scry API；共 50 个方法，覆盖 Provider 探测、工作区文件操作、会话、MCP、计费、诊断和运行控制。
- Main：src/main/index.ts 注册 43 个 ipcMain.handle，承担窗口、安全边界、会话编排、附件、归档、SQLite、Provider 生命周期与 UI 事件分发。
- Provider：src/main/providers/ 下分别适配 Claude SDK、Codex app-server、Qoder SDK/CLI、OpenCode server 和 legacy CLI；shared/provider.ts 与 shared/runtime.ts 定义跨层 DTO。
- Persistence：app-sessions.json 维护侧栏目录；trace-archives-v2 保存会话归档；attachments 保存图片；scry.db 保存统计、账单、span 和文件证据；usage.jsonl 追加使用记录；可选 .scry 目录保存 canonical turn records。
- Recorder/CLI：src/core/turn-recorder 与 packages/turn-recorder-cli 提供 daemon、锁、Git diff、记录提交和校验。
- 关键数据流：用户输入 → renderer → preload IPC → main agent:start → Provider 子进程/SDK → trace events → renderer + archive + SQLite + recorder。
- 主要信任边界：Markdown/模型输出到 Chromium、renderer 到 privileged IPC、仓库配置到 MCP/Hook 子进程、登录 shell 环境到 Agent、Provider 回调到本地持久化。

### Coverage Matrix

| Dimension | Coverage | Evidence inspected | Exclusions / limits |
|-----------|----------|--------------------|---------------------|
| Architecture | High | 319 个文件清单、163 个 TS/TSX、入口/依赖/数据流、43 个 IPC、50 个 preload 方法、主要 1000+ 行模块 | 未做历史 churn 与 ownership 访谈 |
| Security | High | BrowserWindow/preload/IPC/workspace、Markdown、MCP、child env、权限模型；Electron data-origin 动态探针 | 未连接真实恶意站点，未外传任何真实数据 |
| Stability | High | main/provider/recorder/DB/archive/catalog、故障分支和对应测试 | 未注入真实掉电、磁盘满和外部 Provider 故障 |
| Performance | Medium | 构建/打包体积、同步 I/O、归档复杂度、依赖大小 | 未做 CPU/RSS/event-loop profiler 或长会话压力测试 |
| Testing | High | Vitest 配置、63 个测试文件、renderer 231 项、真实/跳过集成入口、完整测试运行 | 无覆盖率报告；3 个 opt-in real integration 文件未启用 |
| Maintainability | High | LOC、文件/函数规模、imports、CSS 重复、状态与模块边界 | 未做长期变更频率分析 |
| Design | High | 按 principles rubric 检查边界、默认值、副作用、同步、文件/函数规模 | 原则评分含工程判断 |
| Release | High | package scripts、builder、installer、README、build/pack/CLI dry-run | 未执行签名、公证、DMG、升级或回滚 |
| Documentation | Medium | README、CLAUDE.md、package metadata、产品/迁移文档抽样 | 42 个 Markdown 文件未逐句校对 |
| Configuration | High | package/electron-builder、env、Provider/MCP/recorder 配置与默认值 | 未检查用户真实 secret store 内容 |
| Observability | High | trace、archive、SQLite spans、diagnostics、billing、failure terminal events | 未验证真实外部 API 事故 |
| Data Integrity | High | locks、atomic writes、migrations、catalog、archive、workspace revision | 未执行 kill -9/掉电级破坏测试 |
| Privacy | High | prompt、图片、路径、usage、SQLite、workspace records 的存储与删除链 | 未检查操作系统备份/磁盘加密 |
| Accessibility | Medium | 组件语义、焦点/键盘源代码；Electron 初始页 AX tree | 未用 VoiceOver/axe，未遍历所有弹窗和运行中状态 |
| Supply Chain | Medium | package-lock、离线 npm audit、install scripts、builder、包体 | 在线 advisory 查询因外发依赖元数据未获授权；无 provenance 服务 |
| Cost | Medium | 附件/归档写放大、包体、Provider 生命周期和 timeout | 未跑真实模型账单或长期磁盘增长实验 |
| AI Safety | High | prompt/Markdown、tool authorization、MCP、full_access fallback、输出边界 | 未对真实模型做 adversarial eval |
| Fallback | High | permission fallback、DB/catalog catches、Provider terminal/error paths | 外部服务恢复策略未做实机故障注入 |
| Testing Authenticity | High | Node SSR、纯函数、真实 Git/socket/integration 测试分层 | 真实 Provider/Admin API 测试默认跳过 |
| Type Safety | High | strict TS 配置、shared DTO、unknown 边界、renderer 重定义类型 | 未做全量 any/unsafe cast 形式化统计 |
| Frontend State | High | App/useIntegrations/useAgentSession、cwd/provider/session 切换 | 未以自动化 UI 重放全部 race |
| Backend API | High | preload 50 方法、43 IPC handlers、Provider ports、workspace API | 项目无远程 HTTP backend；此维度按本地 IPC/backend 边界审计 |
| Dependency Weight | Medium | 直接依赖大小、asar/unpacked、423 MB app、CLI npm dry-run | 未逐包做可替换性 benchmark |
| Code Consistency | High | 命名、重复 CSS、共享/本地 DTO、版本展示与错误语义抽样 | 未运行专用 stylelint/eslint，仓库无对应配置 |
| Comment Coverage | Medium | 关键安全、迁移、Provider、recorder 注释和 TODO 抽样 | 不以注释数量代替可读性，未逐函数计数 |

## 3. Top Risks

| # | Finding | Severity | Summary |
|---|---------|----------|---------|
| 1 | F-01 不可信导航继承完整 preload | Critical | 一次普通 Markdown 链接点击可把远端页面升级为本地工作区与 Agent 控制者 |
| 2 | F-02 Markdown 远端图片零点击外传 | High | 模型输出可让 Chromium 自动向任意域发送编码后的上下文 |
| 3 | F-03 Billing Admin 凭据进入 Provider 环境 | High | 组织级账单密钥被传给 Agent Provider；终端继承时也会进入 MCP probe |
| 4 | F-04 MCP 状态操作直接执行仓库命令 | High | 打开/刷新/测试/启用 MCP 可在 Guard 之前 spawn .mcp.json 命令 |
| 5 | F-05 运行控制失败时回退 full_access | High | 控制面故障反而降低权限，映射到 bypass/danger-full-access |
| 6 | F-06 缺失证据被渲染为绿色或零 | High | MCP Trust partial payload 可显示 policy-pass，Diagnostics unknown 可显示 0 |
| 7 | F-07 陈旧目录锁回收存在 TOCTOU | High | 两个恢复者可同时进入 canonical record 临界区并覆盖 sequence |
| 8 | F-08 SQLite migration 非事务且不可重入 | High | 一次中断可让重复 ALTER 永久关闭分析数据库 |
| 9 | F-09 Codex RPC 超时可能留下失联运行 | High | 本地已报失败时 Provider 仍可能继续改文件和消耗 token |
| 10 | F-10 绿色测试缺少真实交互/Electron/CI 闸门 | High | Critical 导航、焦点、IPC 和时序问题都能在 63 个测试文件全绿时逃逸 |
| 11 | F-11 会话目录写入非原子且损坏后静默清空 | Medium | app-sessions.json 半写会让所有会话入口消失 |
| 12 | F-12 附件与归档无界复制且删除不完整 | Medium | base64、原始 blob、O(n²) 重写和多套残留同时放大隐私与 I/O |
| 13 | F-13 普通 Provider 异常不生成 terminal result span | Medium | 失败率和 turn 总量系统性漏记最关键的故障 |
| 14 | F-14 前端上下文切换存在迟到响应覆盖 | Medium | 旧 provider/cwd/session 请求可污染最后一次用户选择 |
| 15 | F-15 BYOK 假能力在必然失败后丢弃草稿 | Medium | UI 提供未实现 backend，并在主进程拒绝前清空文字与附件 |

## 4. Detailed Findings

### Finding: F-01 不可信导航继承完整 preload，形成远端到本地文件/Agent 的权限跃迁

- Severity: Critical
- Confidence: High
- Category: Security
- Status: Confirmed
- Affected area: BrowserWindow、Markdown、preload、IPC 与 workspace API
- Evidence:
  - File: src/main/index.ts:393-425,489-520；src/preload/index.ts:56-145；src/renderer/components/MarkdownImpl.tsx:1-5
  - Function / Module: createWindow、assertWorkspaceSender、MarkdownImpl、window.scry
  - Relevant behavior: 窗口 sandbox:false 且无 will-navigate/setWindowOpenHandler；preload 向每次导航暴露 50 个方法；workspace 只比较不随导航变化的 webContents.id。
  - Runtime evidence: Electron/CDP 将窗口导航到无网络 data 页面后，页面仍获得 workspaceRead/workspaceWrite/workspaceTrash/start 等完整 API。
- Problem: 不可信 Markdown 被渲染成普通同窗链接，导航后远端脚本继承本地高权限桥。任意 cwd 又由调用方提供，sender id 校验无法区分可信 renderer 与已导航的远端页面。违反原则 4.6 Principle of Least Privilege。
- Why it matters: 攻击者可读取、修改或移入废纸篓任意用户可访问文件，并可要求 Scry 启动 full_access Agent，影响范围达到本地代码执行与持久化。
- Realistic failure scenario: 恶意 README 或模型回复给出“查看结果”链接；用户点击；远端 JS 读取配置/密钥、修改 shell 配置，或启动 Agent 执行命令。
- Minimal fix: 默认阻止主窗口所有非可信导航；HTTP(S) 只经严格 scheme 校验后交给 shell.openExternal；deny window.open；所有 privileged IPC 验证 main frame 与精确 renderer origin；workspace root 改为 main 签发 token。
- Better long-term fix: 恢复 sandbox:true，显式声明 contextIsolation/nodeIntegration，按最小能力拆分 preload，并建立统一 IPC authorization middleware。
- Regression test suggestion: Electron 测试点击模型外链，断言主窗口 URL 不变且仅 openExternal；非可信 URL 调每个 privileged IPC 全部拒绝；错误 cwd token 拒绝。
- Estimated effort: 1–2 days

### Finding: F-02 Markdown 远端图片构成零点击数据外传通道

- Severity: High
- Confidence: High
- Category: Security
- Status: Confirmed
- Affected area: 所有模型、工作区和问答 Markdown 渲染
- Evidence:
  - File: src/renderer/components/MarkdownImpl.tsx:1-5；src/renderer/index.html:1-23；src/renderer/components/ChatTurn.tsx:819,843
  - Function / Module: MarkdownImpl 与 ReactMarkdown 默认 img renderer
  - Relevant behavior: 无自定义图片策略和 CSP；SSR 动态验证把远端 Markdown 图片直接渲染为 https img。
- Problem: 模型输出中的远端图片会被 Chromium 自动请求，不需用户点击，也不经过 Agent 工具审批。
- Why it matters: prompt injection 可让模型把已知路径、代码、提示词或会话片段编码进 URL；即便没有 payload，也泄露 IP、时间和跟踪标识。
- Realistic failure scenario: 恶意仓库指示模型返回指向攻击者域且 query 携带文件内容的图片；聊天一渲染即发出 GET。
- Minimal fix: Markdown img 默认只允许受控 data/blob/local 资源，远端图片改为需显式加载的占位符；生产 CSP 限制 default-src 和 img-src。
- Better long-term fix: 建立 renderer 网络 allowlist/webRequest 拦截和统一安全 Markdown 组件，所有预览面只使用该组件。
- Regression test suggestion: 对模型、workspace、问答预览注入远端图片，Electron 网络监听应为零；本地附件仍能显示。
- Estimated effort: 0.5–1 day

### Finding: F-03 Billing Admin 凭据被传给 Provider 子进程，终端继承时也进入 MCP probe

- Severity: High
- Confidence: High
- Category: Security
- Status: Confirmed
- Affected area: login-shell 环境、billing connector、Provider spawn 与 MCP probe
- Evidence:
  - File: src/main/index.ts:95；src/main/claude-locate.ts:41-95,458-495；src/main/providers/claude.ts:142-154；src/main/providers/codex.ts:493-511；src/main/providers/qoder.ts:50-80；src/main/providers/opencode-server.ts:120-126；src/main/mcp-config.ts:132-135
  - Function / Module: shellEnv、runtimeCliEnv 与各 Provider spawn
  - Relevant behavior: billing 和 Agent 共用完整登录 shell 环境，sanitize 只删除嵌套 Agent 标志，不删除 OPENAI/ANTHROPIC/QODER Admin 变量。
- Problem: 为账单同步配置的组织级 secret 被扩大到各 coding-agent Provider 的环境；当 Scry 从已导出这些变量的终端启动时，MCP probe 的 process.env 路径也会继承。违反原则 4.6 Principle of Least Privilege 与 7.3 Explicit Dependencies Over Implicit/Global。
- Why it matters: 恶意仓库或间接 prompt injection 只需读取环境即可获得影响整个组织账单面的凭据。
- Realistic failure scenario: 用户启用 Admin billing；项目中的 MCP command 或获批 shell 命令读取 env 并外传 Admin key。
- Minimal fix: billing secret source 与 runtime env 完全分离；所有 Provider child env 明确剥离 Admin key、organization/member 标识；MCP probe 无条件使用 allowlist 环境。
- Better long-term fix: secret 进入 Keychain/main-only service，仅在固定官方 HTTPS 请求构造时短暂注入。
- Regression test suggestion: 注入 sentinel billing secret，断言 billing fetch 可见，而 Claude/Codex/Qoder/OpenCode/legacy/MCP 的 spawn env 全部不可见。
- Estimated effort: 1 day；Keychain 方案 3–5 days

### Finding: F-04 MCP “状态”操作直接执行仓库控制的命令或任意 URL

- Severity: High
- Confidence: High
- Category: Security
- Status: Confirmed
- Affected area: .mcp.json、MCP modal/trust panel、main MCP probe
- Evidence:
  - File: src/main/mcp-config.ts:48-90,117-231；src/main/providers/claude.ts:174-208；src/renderer/hooks/useIntegrations.ts:233-277；src/renderer/App.tsx:832-848
  - Function / Module: testStdioMcp、testHttpMcp、snapshot(refresh=true)、openMcp
  - Relevant behavior: 打开 MCP 面板在没有 runtime 状态时会 pull live，直接 spawn enabled command；启用和测试也执行；HTTP 配置向任意 URL POST；MCP Guard 是并列按钮而非 gate。
- Problem: 一个看似查询状态的 UI 动作会执行仓库配置，副作用没有 trust fingerprint 或逐次确认。违反原则 5.3 No Hidden Side Effects 与 3.1 Principle of Least Surprise。
- Why it matters: 恶意 .mcp.json 可在用户只想查看 MCP 状态时以用户权限运行本地代码、读取完整环境或探测内网。
- Realistic failure scenario: 用户打开陌生仓库后点击 MCP；配置中的 command 立即创建持久化文件或外传环境。
- Minimal fix: 在任何 spawn/fetch 前要求 canonical cwd + config fingerprint 授权，展示精确 command/args/env key/source；配置变化撤销信任；Guard 成为执行前 gate。
- Better long-term fix: MCP probe 使用最小 env、资源沙箱和网络策略；将“静态配置”“安全扫描”“实际执行”分成三个不可混淆的状态。
- Regression test suggestion: 未授权配置指向 sentinel 脚本时，打开/刷新/测试/启用均不得 spawn；授权精确 fingerprint 后才运行，修改任一字段即失效。
- Estimated effort: 2–4 days

### Finding: F-05 运行控制不可用时 fail-open 到 full_access

- Severity: High
- Confidence: High
- Category: Security
- Status: Confirmed
- Affected area: renderer run controls、shared normalization、Provider adapters
- Evidence:
  - File: src/renderer/hooks/useIntegrations.ts:416-451；src/shared/runtime.ts:216-246；src/main/providers/registry.ts:51-59；src/main/agent-runner.ts:90-105；src/main/providers/qoder.ts:50-68
  - Function / Module: fallbackRunControlCatalog、normalizeAgentStartRequest、runControls
  - Relevant behavior: preload 缺失、IPC reject、capability 无 data 或 permissionMode 缺字段时回退 full_access，并映射到 bypassPermissions/dangerously-skip-permissions。
- Problem: 控制面故障会自动扩大执行权限。违反原则 4.4 Fail-Fast 和 4.6 Principle of Least Privilege。
- Why it matters: 最不可信的版本漂移和异常状态恰好进入最危险模式，且用户无需重新确认。
- Realistic failure scenario: Provider 升级后 runControls 协议暂时不兼容；UI 自动选择完全访问；下一轮 prompt injection 直接使用文件/命令工具。
- Minimal fix: 所有缺省改为 default；无法确认权限时禁用发送并显示错误；legacy bypass 必须显式确认。
- Better long-term fix: 把 permission capability 与 selection 建成版本化状态机，权限只能经用户动作单调升级，故障只能保持或降级。
- Regression test suggestion: reject/no-data/旧 preload/缺字段四种路径均不得产生 full_access；只有用户主动选择时才出现 bypass 参数。
- Estimated effort: 0.5–1.5 days

### Finding: F-06 Renderer 把缺失证据渲染成绿色安全或真实零

- Severity: High
- Confidence: High
- Category: Security
- Status: Confirmed
- Affected area: MCP Trust 与 Diagnostics
- Evidence:
  - File: src/renderer/components/McpTrustPanel.tsx:43-63,100-122,183-198,479-505；src/preload/index.ts:81；src/renderer/components/DiagnosticsView.tsx:217,258-270
  - Function / Module: MCP report validator/status mapping、diagnostic KPI fallback
  - Relevant behavior: 宽松 optional DTO 接受 partial unknown，缺 status/severity/offline 时显示 policy-pass/online/0；usage/stats 缺失时显示 0 轮/0 token。
- Problem: 边界契约缺失被当作安全事实和真实零，而不是 unknown/error；这违背仓库自己“未知不得伪装成 0”的语义约定。
- Why it matters: 安全仪表盘的假阳性会诱导用户运行不可信 MCP；诊断零值会掩盖数据加载或存储故障。
- Realistic failure scenario: CLI/renderer 版本漂移只返回部分报告；面板显示“未发现阻断项、online、0 风险”，用户据此启用恶意配置。
- Minimal fix: 将严格 ScanReport schema 放进 shared 并在 main/preload/renderer 同时验证；缺必填字段显示 unknown/error；Diagnostics 区分 loading/absent/error/true-zero。
- Better long-term fix: 所有观测 DTO 使用带 freshness/completeness 的 discriminated envelope，禁止 renderer 自行猜默认事实。
- Regression test suggestion: partial MCP payload 必须拒绝或显示未知，绝不能绿色；null stats 不得出现零，明确 true-zero 才显示 0。
- Estimated effort: 0.5–1 day

### Finding: F-07 陈旧目录锁回收 TOCTOU 可让两个 recorder 同时提交

- Severity: High
- Confidence: High
- Category: Stability
- Status: Confirmed
- Affected area: canonical turn recorder lock 与 sequence
- Evidence:
  - File: src/core/turn-recorder/io.ts:60-113；src/core/turn-recorder/store.ts:68-126；src/core/turn-recorder/recorder.test.ts:1254-1286
  - Function / Module: withDirectoryLock、commitRecord
  - Relevant behavior: 恢复者先异步判断 owner stale，再无条件 rm lockDir；检查和删除间没有 owner token CAS；现有测试只有单恢复者。
- Problem: A 删除旧锁并获得新锁后，B 可依据旧判断删除 A 的新锁并再次获得锁，双方并发计算相同 sequence。违反原则 5.4 No Shared Mutable State Without Synchronization。
- Why it matters: canonical evidence store 可能出现 sequence 冲突、覆盖或永久丢轮。
- Realistic failure scenario: 前一进程崩溃留锁，两个并行 agent 同时完成 turn 并回收，max critical-section concurrency 变成 2。
- Minimal fix: 使用可靠跨进程文件锁；若保留目录锁，增加 recovery mutex 与不可变 owner token，在删除前重新校验。
- Better long-term fix: sequence/recordId 再由 SQLite unique constraint 或原子索引约束，锁不是唯一完整性防线。
- Regression test suggestion: 两个独立进程以 barrier 同时判 stale，断言 maxActive=1、sequence 唯一且 verifyStore 通过。
- Estimated effort: 1–2 days

### Finding: F-08 SQLite v2/v3 migration 非事务、非重入，中断一次可永久降级

- Severity: High
- Confidence: High
- Category: Stability
- Status: Confirmed
- Affected area: scry.db schema migration
- Evidence:
  - File: src/main/db.ts:86-134；src/main/span-ledger.ts:16-65；docs/product/billing-guardian-issues.md:141
  - Function / Module: initDb、migrate、DDL_V2、DDL_V3
  - Relevant behavior: DDL 逐条执行后才更新 user_version，无 transaction；未 guard 的 ALTER TABLE ADD COLUMN 重跑会 duplicate-column；异常后 db=null。
- Problem: 某条 ALTER 成功而 version 未更新时，重启再次执行同一 ALTER，并在每次启动永久失败。
- Why it matters: 正常崩溃、掉电或磁盘故障可让全部分析、账单和 span 数据库需人工修复。
- Realistic failure scenario: v1→v2 添加 project_id 后退出；下次重复添加列；initDb 捕获后静默关闭 SQLite。
- Minimal fix: 每个 schema version 在一个 transaction 中执行 DDL 与 version 更新；ADD COLUMN 前检查 table_info。
- Better long-term fix: migration journal、升级前备份、启动 integrity check 和自动恢复演练。
- Regression test suggestion: 在每条 DDL 后注入中断并反复重开同一 DB，所有中断点最终收敛到 v7。
- Estimated effort: 0.5–1 day

### Finding: F-09 Codex JSON-RPC 超时只 reject，可能留下无人追踪的真实 turn

- Severity: High
- Confidence: High
- Category: Stability
- Status: Confirmed
- Affected area: Codex app-server lifecycle
- Evidence:
  - File: src/main/providers/codex-app-server.ts:53-124；src/main/providers/codex.ts:1083-1160
  - Function / Module: start、spawnAndInitialize、request、Codex run
  - Relevant behavior: initialize 前即设置 this.process；30 秒 timeout 只删除 pending/reject，不 cancel/close/quarantine；turnId 只在成功响应后取得，finally 移除 listener。
- Problem: 非幂等 turn/start 可能已被服务端接受，但 Scry 超时后既没有 turnId 也没有监听器，UI 和 archive 已报失败，Provider 仍继续。
- Why it matters: 文件修改、工具调用和 token 成本可在用户以为任务结束后继续，审计链同时断裂。
- Realistic failure scenario: app-server stdout 阻塞超过 30 秒；Scry 报错；迟到响应对应的 turn 继续改项目且无法 Stop。
- Minimal fix: initialize 失败立即 close/reset；turn/start timeout 关闭/隔离连接并标 termination_unconfirmed，重连后先查询和中断遗留 turn。
- Better long-term fix: 为非幂等 RPC 引入 client request id、恢复查询、显式 cancel 与 spawned/initialized/degraded 状态。
- Regression test suggestion: fake app-server 延迟 initialize 和 turn/start，断言 child 清理、完整重初始化，且迟到 turn 不会成为无人监听运行。
- Estimated effort: 1–2 days

### Finding: F-10 测试全绿仍缺少真实交互、Electron 安全边界与 CI

- Severity: High
- Confidence: High
- Category: Testing
- Status: Confirmed
- Affected area: renderer tests、Electron integration、release gates
- Evidence:
  - File: vitest.config.ts:5-12；package.json:18-34；src/renderer/components/render.test.tsx:1-4；src/renderer/hooks/useAgentSession.test.ts:1-217
  - Function / Module: Vitest suite 与 npm scripts
  - Relevant behavior: renderer 约 231 项主要是 renderToStaticMarkup/纯 reducer；无 jsdom/browser/Playwright/Electron E2E、无 coverage threshold、无 .github CI；3 个 real integration 文件默认 skipped。
- Problem: 测试真实性与产品风险不匹配：effect、事件订阅、IPC origin、导航、焦点、键盘和异步 race 基本不执行。
- Why it matters: F-01、F-06、F-14、F-15、F-16 都能在完整启用测试全绿时存在，绿色不能作为稳定发布证据。
- Realistic failure scenario: 修改 Markdown 或 preload 后所有 Node/SSR 测试通过，打包应用却可被外链接管，CI 也不会阻止合并或发布。
- Minimal fix: 保留快速测试，补 React Testing Library 交互层和少量 Electron/CDP 安全 smoke；建立 Node 22 CI 跑 typecheck/test/build。
- Better long-term fix: 风险分层 release gate：真实 Provider contract、恶意 Markdown、IPC origin、migration crash matrix、keyboard/focus、installer rollback。
- Regression test suggestion: 把本报告 Critical/High 复现转成必须通过的 Electron 与多进程测试，并在 CI 阻断。
- Estimated effort: 3–5 days initial

### Finding: F-11 app-sessions.json 非原子写入，损坏后静默变成空目录

- Severity: Medium
- Confidence: High
- Category: Stability
- Status: Confirmed
- Affected area: 项目/会话侧栏索引
- Evidence:
  - File: src/main/app-store.ts:59-76；src/main/index.ts:390,564-570
  - Function / Module: readJson、writeJson、listSessions、listProjects
  - Relevant behavior: 直接 writeFileSync 原文件；读写错误都吞掉并返回 fallback []；不再扫描 Provider transcript，且无 archive 重建。
- Problem: truncate 与完整写入间崩溃会留下 partial JSON；下次启动静默解释为从未有过会话。违反原则 6.1 Don't Swallow Errors 与 3.1 Principle of Least Surprise。
- Why it matters: 底层 archive 仍在，但用户一次性失去全部项目/会话入口，表现与数据丢失相同。
- Realistic failure scenario: turn 完成更新目录时进程退出；重启侧栏全空，用户不知道是索引损坏。
- Minimal fix: temp + fsync + atomic rename，保留 last-known-good backup；解析失败显示 degraded。
- Better long-term fix: catalog 成为可从 trace archives 对账重建的索引，或迁移到 SQLite transaction。
- Regression test suggestion: 注入半写/rename 失败时旧目录仍可读；损坏 index + 完整 archives 能恢复并记录事件。
- Estimated effort: 1 day

### Finding: F-12 附件无大小上限、重复持久化并在删除后残留

- Severity: Medium
- Confidence: High
- Category: Performance
- Status: Confirmed
- Affected area: attachment、trace archive、privacy deletion
- Evidence:
  - File: src/shared/runtime.ts:295-319；src/main/index.ts:116-126,293-315；src/main/transcript-archive.ts:73-164,213-235；src/main/index.ts:618-634
  - Function / Module: normalizeAgentAttachments、prepareRunAttachments、upsertTraceArchiveTurn、deleteTranscriptCopies
  - Relevant behavior: 只限制 8 张、不限制 base64 字节；同步写原始文件后 archive 继续保存 base64；每轮全量读写 session JSON，累计 O(n²)；删除不清 attachments/SQLite/usage/.scry。
- Problem: 同一图片以 blob 与约 4/3 大小 base64 双份存储，历史每轮重复重写；“删除会话”只移除部分副本。
- Why it matters: 大图/长会话会阻塞 Electron main、制造 RSS/磁盘峰值；敏感图片和文本在用户以为删除后仍可恢复。
- Realistic failure scenario: 多个 10 MB 图片持续几十轮；每轮重写全部历史；删除会话后 attachments/runId 与分析索引继续存在。
- Minimal fix: 为单图/总请求设字节上限；archive 只存 metadata + blob reference；删除前收集引用并清理所有 Scry-owned store，明确 .scry 保留选项。
- Better long-term fix: append-only/SQLite turn store + content-addressed blob/refcount + retention/GC，将重 I/O 移出 main thread。
- Regression test suggestion: 压力测试 event-loop lag/RSS/写入字节；删除带唯一 marker/图片的会话后递归扫描所有 store 不得残留。
- Estimated effort: 2–6 days

### Finding: F-13 普通 Provider 异常不产生 canonical terminal result span

- Severity: Medium
- Confidence: High
- Category: Stability
- Status: Confirmed
- Affected area: Provider failure recording 与 analytics
- Evidence:
  - File: src/main/index.ts:1065-1145；src/main/span-ledger.ts:173-205,457-500；src/main/providers/opencode.ts:110-140
  - Function / Module: Provider promise catch、recordTurn、spanRowsFromItems
  - Relevant behavior: 仅 AgentRuntimeError 补 harness/result；普通 Error 只写 runState.error；SQLite totals/failure 以 result span 为母集。
- Problem: UI/archive 能看到错误，但跨会话 span ledger 不创建 terminal fact，失败 turn 从分母和分子同时消失。
- Why it matters: 可靠性指标产生选择偏差，最需要观测的网络/SDK/初始化故障恰好不可见。
- Realistic failure scenario: OpenCode session.create 抛普通 Error；界面报错，SQLite 总轮次与失败数都不增加。
- Minimal fix: 所有非主动停止异常保证恰好一个带 provider/category/unknown usage 的 harness/result。
- Better long-term fix: Provider adapter 返回 discriminated outcome，禁止裸 reject 结束却没有 terminal event。
- Regression test suggestion: adapter 在零事件和工具事件后分别 reject 普通 Error，断言各一个失败 result 且 totals 计入；已有 result 不重复。
- Estimated effort: 0.5–1 day

### Finding: F-14 provider/cwd/session 的迟到异步响应可覆盖最后一次用户选择

- Severity: Medium
- Confidence: High
- Category: Maintainability / Frontend-State
- Status: Confirmed
- Affected area: frontend state 与 context switching
- Evidence:
  - File: src/renderer/App.tsx:655-677,767-813；src/renderer/hooks/useIntegrations.ts:270-277,357-393
  - Function / Module: slash command load、pickSession、MCP test、usage refresh
  - Relevant behavior: 多个 await/promise 没有统一 context key/request sequence；旧结果可在新上下文清空后写回；已有 guarded 路径说明策略不一致。
- Problem: 同一类 context-scoped 状态有的防 stale、有的没有，旧请求可污染新 provider/cwd/session。
- Why it matters: UI 可能显示错误 transcript、命令、MCP 状态或 usage，后续输入可能发往错误上下文。
- Realistic failure scenario: 快速点 A 再 B，A 的 loadSession 较慢，最终覆盖 B 的 transcript 与 cwd。
- Minimal fix: 建立统一 contextKey + monotonic request token helper，每个 await 后核对；切换时清 context-scoped 状态。
- Better long-term fix: 用显式 workspace/session state machine 或 query cache，以 key 管理结果、取消和 freshness。
- Regression test suggestion: deferred promise 强制 A 在 B 后返回，最终所有 UI/发送目标必须仍是 B。
- Estimated effort: 1–2 days

### Finding: F-15 未实现的 BYOK backend 可选，失败前已清空草稿和附件

- Severity: Medium
- Confidence: High
- Category: Maintainability / Frontend-State
- Status: Confirmed
- Affected area: composer backend picker 与 agent:start
- Evidence:
  - File: src/renderer/components/Pickers.tsx:106-110；src/renderer/App.tsx:601-619,704-719；src/main/index.ts:692-705；CLAUDE.md:122
  - Function / Module: backend picker、session.send、agent:start
  - Relevant behavior: UI 正常提供 API/BYOK；main 对非 local 必然拒绝；renderer 在 start 成功前清空 prompt/attachments。
- Problem: 产品能力声明与实现矛盾，错误路径还破坏用户未提交数据。违反原则 3.1 Principle of Least Surprise 与 4.2 YAGNI。
- Why it matters: 用户会丢失长 prompt 和图片，且把可预知的未实现状态误认成偶发 Provider 故障。
- Realistic failure scenario: 选择 BYOK、输入并附图、发送；main 拒绝 backend，composer 已清空。
- Minimal fix: 功能落地前禁用并标“未实现”；只有获得 runId 后清空，reject 时保留全部草稿。
- Better long-term fix: backend capability 由 main descriptor 单一来源驱动，composer 提交使用 pending/commit/rollback 事务语义。
- Regression test suggestion: mock start reject，断言 prompt/attachment 保留且错误可见；unsupported backend 不可选择。
- Estimated effort: 0.5–1 day

### Finding: F-16 核心交互和模态框缺少完整键盘/焦点语义

- Severity: Medium
- Confidence: High
- Category: Maintainability / Accessibility
- Status: Confirmed
- Affected area: ChatTurn、ExecutionGraph、Pickers、OverviewPanel、Sidebar、Modals
- Evidence:
  - File: src/renderer/components/ChatTurn.tsx:54-65,106-114,195-228；ExecutionGraph.tsx:50-93；Pickers.tsx:29-37,106-134；OverviewPanel.tsx:1092-1143,1368-1510；Modals.tsx:33-77,130-242
  - Function / Module: 展开、选择、证据跳转、删除、Skills/MCP dialogs
  - Relevant behavior: 多处 div onClick 无 tabIndex/Enter/Space/aria-expanded；modal 无 dialog/aria-modal/focus trap/restore/Escape；关闭与开关缺关联名称。
- Problem: 鼠标点击被当作唯一输入方式，弹窗也没有管理焦点和背景交互。
- Why it matters: 键盘和读屏用户无法完成查看工具结果、切换 Provider、操作文件或安全退出弹窗；同时增加普通用户误操作风险。
- Realistic failure scenario: 用户仅键盘打开 MCP 后焦点仍在底层，Tab 穿透，无法聚焦无名开关或按 Escape 退出。
- Minimal fix: 优先原生 button/details/dialog/label；补 aria-expanded/controls、focus trap/restore 与 Escape。
- Better long-term fix: 建立统一可访问 interaction primitives，并用 Testing Library user-event + Electron AX smoke 验证。
- Regression test suggestion: 覆盖 Tab 顺序、Enter/Space、焦点圈定/恢复、Escape、读屏名称；初始 Electron AX tree继续保持无 unnamed controls。
- Estimated effort: 2–4 days

### Finding: F-17 当前分发与安装链不可验证且不可回滚

- Severity: Medium
- Confidence: High
- Category: Release
- Status: Confirmed
- Affected area: electron-builder、install:mac、发布流程
- Evidence:
  - File: electron-builder.yml:24-30；scripts/install-macos.mjs:9-29；package.json:18-34
  - Function / Module: mac target 与本地安装脚本
  - Relevant behavior: 仅 dir target、identity:null、无 notarization/checksum/SBOM/provenance；installer 先 rm 现有 App 再 ditto，无 staging/backup/rollback；无 CI。
- Problem: 构建物身份和来源不可验证，安装失败会先删掉可用版本，数据库 migration 又缺回滚。
- Why it matters: 对公开稳定发布而言，用户既无法验证包，也无法在复制/注册失败或 schema 失败后快速恢复。
- Realistic failure scenario: ditto 因磁盘满失败；旧 Scry.app 已删除，新版本不完整；启动又触发不可重入 migration。
- Minimal fix: 先复制到 staging、验证后原子替换并保留 backup；CI 跑 Node22 gates；公开包启用 Developer ID/notarization/checksum。
- Better long-term fix: 可复现 release pipeline、SBOM/provenance、升级前 DB backup、自动 rollback 和 smoke。
- Regression test suggestion: 注入 copy/register 失败，旧 App 保持可启动；CI 对签名、公证、checksum、升级/降级 smoke 做 gate。
- Estimated effort: 3–7 days

### Finding: F-18 Qoder SDK 让 macOS 包多带约 95 MB 未使用 CLI

- Severity: Medium
- Confidence: High
- Category: Performance
- Status: Confirmed
- Affected area: production dependency 与 Electron artifact
- Evidence:
  - File: package.json:36-43；electron-builder.yml:7-22；src/main/providers/qoder.ts:50-69
  - Function / Module: Qoder dependency packaging 与 executable resolution
  - Relevant behavior: 打包产物约 423 MB；app.asar.unpacked 含约 95 MB qodercli；adapter 实际总是解析本机 qoder executable 并传 pathToQoderCLIExecutable。
- Problem: builder 只排除 Anthropic 平台二进制，没有排除 Qoder SDK postinstall 下载的二级可执行文件；lock integrity 也不覆盖该下载物。
- Why it matters: 安装/更新成本增加约 95 MB，并扩大供应链和签名面，却没有被运行时使用。
- Realistic failure scenario: 每次构建/分发携带多余 CLI；二级下载源或 checksum 同源遭破坏时，artifact 被无意义污染。
- Minimal fix: 可复现构建设置 QODER_SKIP_DOWNLOAD=1 或 builder 精确排除 bundled qodercli，并验证四 Provider smoke。
- Better long-term fix: 把可选 Provider adapter/SDK 做成按需模块，记录每个 artifact component 的来源和 hash。
- Regression test suggestion: artifact budget 断言 Qoder CLI 不存在、包体阈值通过，连接本机 qoder 的 smoke 仍成功。
- Estimated effort: 0.5–1 day

### Finding: F-19 核心编排模块与全局 CSS 已超过可安全演进的责任边界

- Severity: Medium
- Confidence: High
- Category: Maintainability
- Status: Confirmed
- Affected area: main orchestration、renderer formatting/state、MCP guard、recorder、styles
- Evidence:
  - File: src/main/index.ts 1265 行；src/renderer/App.tsx 1294 行；src/renderer/format.ts 1619 行；src/renderer/components/OverviewPanel.tsx 1566 行；src/cli/mcpguard-core.ts 1852 行；src/core/turn-recorder/recorder.ts 1754 行；src/renderer/styles.css 8617 行
  - Function / Module: agent:start 约 460 行；全局 CSS 多层 override
  - Relevant behavior: 单文件混合验证、Provider 生命周期、归档、DB、UI 事件或多个显示领域；.composer/.modal/.panel/.sidebar/.topbar 等 selector 多次定义并依赖源码顺序。
- Problem: 多个关键文件超过 1000 行且拥有多种变更原因，agent:start 远超 100 行，CSS 成为补丁栈。违反原则 1.1 SRP、1.2 File Size Limit、1.3 Function Size、1.6 Cyclomatic Complexity 与 2.2 High Cohesion。
- Why it matters: 安全和时序修复必须同时触碰巨大编排面，回归定位困难；样式改动看似无效或在断点下互相覆盖。
- Realistic failure scenario: 为一种 Provider 增加终止语义时误改公共 archive/cleanup 分支；修 composer 样式被文件末尾 override 覆盖。
- Minimal fix: 先提取 agent run coordinator 的验证/生命周期/持久化三个单元；format 按领域拆分；合并重复核心 selector 并建立 CSS layer。
- Better long-term fix: main 使用显式 application service + ports，renderer 按 feature/state owner 分包；为主要视口加视觉回归。
- Regression test suggestion: 保留现有纯函数测试，新增 coordinator outcome contract、每 Provider terminal matrix 和 1024/1180/1420 computed-style snapshot。
- Estimated effort: 5–10 days staged

## 5.1 Architecture Concerns

- Coverage: High
- Inspected evidence: main/preload/renderer/provider/recorder 边界、43 个 IPC、50 个 preload 方法、持久化数据流、文件与 import 规模。
- Exclusions / limits: 未进行团队 ownership 访谈或历史依赖演化分析。

| Relevant findings | Concern | Recommended action |
|-------------------|---------|--------------------|
| F-01, F-03, F-19 | 特权边界集中在巨大 main/preload surface，依赖通过全局环境隐式传播 | 先封可信 origin/IPC，再提取 run coordinator 与最小 env port |
| F-14 | frontend context ownership 分散 | 引入 keyed state/query lifecycle |

Verified: shared/provider.ts、shared/runtime.ts 和 trace DTO 提供了较清晰的跨 Provider 核心语言；Provider registry 已形成适配边界。

## 5.2 Security Concerns

- Coverage: High
- Inspected evidence: BrowserWindow、preload、IPC、workspace、Markdown、MCP、child env、permissions；Electron data-origin 动态探针。
- Exclusions / limits: 未访问恶意公网域，未读取或外传真实 secret。

| Relevant findings | Risk |
|-------------------|------|
| F-01 | 远端页面获得本地 privileged API |
| F-02 | Markdown 零点击网络外传 |
| F-03 | Admin secret 扩散到子进程 |
| F-04 | 仓库配置触发任意命令/URL |
| F-05, F-06 | 权限 fail-open 与安全 UI 假阳性 |

Verified: workspace-files.ts 防绝对路径、..、symlink traversal、受保护目录、二进制和 revision 冲突；Codex Hook trust 以 cwd+fingerprint 失效授权；未发现 shell:true、eval 或 new Function。

## 5.3 Stability Concerns

- Coverage: High
- Inspected evidence: Provider lifecycle、locks、archive/catalog、DB migration、terminal outcome 和相关测试。
- Exclusions / limits: 未真实注入掉电、磁盘满和 Provider 网络故障。

| Relevant findings | Failure mode |
|-------------------|--------------|
| F-07 | stale lock 双重持有 |
| F-08 | migration 永久降级 |
| F-09 | 超时后 orphan turn |
| F-11, F-12, F-13 | catalog/存储/指标不收敛 |

Verified: Git diff 有 timeout、SIGKILL、16 MiB buffer、文件/patch 上限和真实仓库测试；Qoder 控制会话有 refcount 与 idle cleanup。

## 5.4 Performance Concerns

- Coverage: Medium
- Inspected evidence: build/pack 尺寸、同步文件 I/O、archive 算法、依赖目录与 artifact 内容。
- Exclusions / limits: 无 profiler、RSS/event-loop 或长会话 benchmark。

| Relevant findings | Cost driver |
|-------------------|-------------|
| F-12 | base64/blob 双写与 O(n²) archive 重写 |
| F-18 | 约 95 MB 未使用 bundled qodercli |
| F-19 | 1.1 MB renderer JS 与巨大 CSS 增加加载/维护成本 |

Verified: build 会分离 main/preload/renderer；Git 采样和 recorder 请求存在资源上限。

## 5.5 Testing Gaps

- Coverage: High
- Inspected evidence: Vitest 配置、完整 suite、renderer/recorder/provider 测试、跳过条件与 scripts。
- Exclusions / limits: 未启用真实 Provider/Admin API tests。

| Relevant findings | Missing confidence |
|-------------------|--------------------|
| F-10 | Electron 导航/IPC origin/交互/CI |
| F-07, F-08, F-09 | 多进程 stale recovery、crash matrix、迟到 RPC |
| F-14, F-16 | UI race 与键盘/focus |

Verified: Node 22 下 typecheck 和全部启用测试通过；renderer 10 文件 231 项通过；recorder/Git/provider 有大量真实文件系统与进程测试。

## 5.6 Maintainability Concerns

- Coverage: High
- Inspected evidence: LOC/imports、职责、状态 owners、CSS 重复、错误路径与文档。
- Exclusions / limits: 未以 commit history 量化热点。

| Relevant findings | Debt |
|-------------------|------|
| F-14, F-15, F-16 | 状态、能力和 interaction contract 不一致 |
| F-19 | 多个 1000+ 行模块与 8617 行 CSS |

Verified: 共享 DTO、provider registry、workspace sequence guard、session hydration delta replay 和 PaneSplitter primitive 是可复用的良好基础。

## 5.7 Design / Principles Concerns

- Coverage: High
- Inspected evidence: principles rubric 对所有 Critical/High 与结构发现逐项映射。
- Exclusions / limits: 原则严重度包含工程判断。

| Principle IDs | Relevant findings |
|---------------|--------------------|
| 4.6 Least Privilege | F-01, F-03, F-05 |
| 4.4 Fail-Fast | F-05, F-06, F-08 |
| 5.3 No Hidden Side Effects | F-04 |
| 5.4 Shared Mutable State Synchronization | F-07 |
| 1.1/1.2/1.3/1.6 | F-19 |

Verified: 核心 record 正常提交采用 temp、fsync、rename 和 hash verify；workspace API 在 root 内遵循明确 invariant。

## 5.8 Release Concerns

- Coverage: High
- Inspected evidence: package scripts、electron-builder、installer、build/pack、CLI package dry-run、README。
- Exclusions / limits: 未执行签名、公证、DMG、自动更新或 rollback。

| Relevant findings | Release blocker |
|-------------------|-----------------|
| F-01, F-08, F-10 | 安全、migration、CI |
| F-17 | unsigned/unnotarized、非原子安装 |
| F-18 | artifact 体积与二级下载物 |

Verified: npm run build、npm run pack 成功；CLI dry-run 为 24 个文件、约 59 KB tarball；README 诚实声明 MVP 与未签名状态。

## 5.9 Documentation Analysis

- Coverage: Medium
- Inspected evidence: README、CLAUDE.md、package metadata、billing/migration 文档抽样。
- Exclusions / limits: 未逐句校对全部 42 个 Markdown 文件。

| Relevant findings | Documentation gap |
|-------------------|-------------------|
| F-12 | “删除会话”没有说明 retained stores |
| F-15 | UI 能力与 CLAUDE TODO 冲突 |
| F-17 | 本地开发分发说明存在，但无公开 release/rollback runbook |

Verified: README 对 local-only、MVP、权限模式、数据来源和未签名安装披露总体准确。

## 5.10 Configuration Safety Analysis

- Coverage: High
- Inspected evidence: env loading、permission defaults、MCP/provider config、builder 与 recorder config。
- Exclusions / limits: 未读取用户真实 secret 值。

| Relevant findings | Unsafe configuration behavior |
|-------------------|-------------------------------|
| F-03 | login shell env 充当共享 secret/config bus |
| F-04 | repo MCP config 可执行 |
| F-05 | missing/degraded 配置默认 full_access |
| F-17 | builder 明确 identity:null |

Verified: disabled Provider、Hook trust、workspace root 和 recorder config 均有显式解析与多处测试。

## 5.11 Observability / Operability Analysis

- Coverage: High
- Inspected evidence: trace events、archives、span ledger、diagnostics、billing guardian、terminal outcomes。
- Exclusions / limits: 未连接真实外部服务模拟事故。

| Relevant findings | Signal distortion |
|-------------------|-------------------|
| F-06 | unknown 显示为 zero/green |
| F-09 | orphan turn 失去监听 |
| F-13 | 普通 Error 不进入 terminal span |

Verified: statsQuery 能区分 ready/unavailable/query_error；trace 带 run/session/provider 关联，诊断面覆盖本地 Agent 和持久化。

## 5.12 Data Integrity Analysis

- Coverage: High
- Inspected evidence: directory lock、record sequence/hash、SQLite migration、catalog、archive、workspace revision。
- Exclusions / limits: 未做真实掉电/文件系统故障注入。

| Relevant findings | Invariant at risk |
|-------------------|-------------------|
| F-07 | canonical sequence 唯一性 |
| F-08 | schema/version 原子性 |
| F-11 | session catalog 可恢复性 |
| F-12 | blob/reference 一致性 |

Verified: canonical record 正常路径使用原子 rename 与校验；workspace write 使用 optimistic revision 并限制 root。

## 5.13 Privacy / Data Governance Analysis

- Coverage: High
- Inspected evidence: prompt、tool payload、图片、path、usage、SQLite、archive、.scry 写入与 delete。
- Exclusions / limits: 不含 OS backup、Spotlight 或磁盘加密策略。

| Relevant findings | Retained data |
|-------------------|---------------|
| F-01, F-02, F-03 | 远端/子进程访问与外传 |
| F-12 | attachments、SQLite、usage JSONL、可选 .scry |

Verified: 多数本地数据文件/目录采用 0600/0700；README 明确 local-only，但删除契约仍需补齐。

## 5.14 Accessibility / UX Correctness Analysis

- Coverage: Medium
- Inspected evidence: 组件源代码、键盘/ARIA 模式、Electron 初始页 AX tree。
- Exclusions / limits: 未跑 VoiceOver/axe，未遍历所有运行中和 modal 状态。

| Relevant findings | Workflow impact |
|-------------------|-----------------|
| F-06 | error/loading/unknown 状态不真实 |
| F-14, F-15 | stale state 与草稿丢失 |
| F-16 | mouse-only 与 dialog focus |

Verified: 初始页 AX tree 29 个 interactive 均有名称；AskUserQuestionDialog、PaneSplitter、reduced-motion 和 hover gating 做得较好。

## 5.15 Supply Chain / Reproducibility Analysis

- Coverage: Medium
- Inspected evidence: package-lock、离线 npm audit、install scripts、builder unpack、artifact/CLI package。
- Exclusions / limits: 在线 advisory 因外发依赖元数据未获授权；未验证第三方签名/provenance。

| Relevant findings | Supply-chain gap |
|-------------------|------------------|
| F-17 | artifact 无签名、公证、checksum/provenance |
| F-18 | Qoder postinstall 二级下载不受 npm lock integrity 覆盖 |

Verified: package-lock 已跟踪；离线缓存审计报告 746 总依赖、236 prod、0 已知漏洞；主要 npm tarball 有 integrity。

## 5.16 Cost / Resource Economics Analysis

- Coverage: Medium
- Inspected evidence: disk write amplification、attachment size、artifact size、timeout lifecycle。
- Exclusions / limits: 无真实模型账单、并发峰值或长期 retention 数据。

| Relevant findings | Cost driver |
|-------------------|-------------|
| F-09 | timeout 后潜在 token/工具继续消耗 |
| F-12 | 无界图片与 archive O(n²) |
| F-18 | 约 95 MB 无用分发体积 |

Verified: billing ledger 区分 provider/source，Git/HTTP/MCP/CLI 多数路径有 timeout。

## 5.17 AI / LLM Safety Analysis

- Coverage: High
- Inspected evidence: 模型 Markdown、prompt/tool trust、permissions、MCP、Provider env 与 output validation。
- Exclusions / limits: 未对真实模型执行 adversarial prompt suite。

| Relevant findings | Boundary crossed |
|-------------------|------------------|
| F-01, F-02 | untrusted model output → browser/local privilege/network |
| F-03, F-04 | repo/prompt influence → secrets/command execution |
| F-05 | control failure → tool authorization bypass |

Verified: Provider 事件被归一为共享 trace，AskUserQuestion 有结构化答案校验，Codex Hook trust 默认 fail-closed。

## 5.18 Fallback / Defensive Code Analysis

- Coverage: High
- Inspected evidence: catches、default catalogs、DB/catalog initialization、terminal errors、compatibility branches。
- Exclusions / limits: 未做外部服务恢复时序实测。

| Relevant findings | Fallback decision |
|-------------------|-------------------|
| F-05 | Remove：full_access silent fallback |
| F-06 | Fail fast：partial evidence 不能 green/zero |
| F-08, F-11 | Fail fast + recover：不能静默永久降级 |
| F-13 | Keep with alert：合成 terminal failure |

Verified: workspace validation、Hook trust、managed recorder version mismatch 和多种 Provider capability 会显式拒绝。

## 5.19 Testing Authenticity Analysis

- Coverage: High
- Inspected evidence: 测试运行、environment、mock/SSR 模式、真实 Git/socket/provider opt-in。
- Exclusions / limits: 真实 external Provider/Admin tests 未启用。

| Test area | Real confidence | Risk | Action |
|-----------|-----------------|------|--------|
| shared pure transforms | High | 业务映射回归 | Keep |
| recorder/Git filesystem | High | 并发 stale recovery 仍缺 | Extend |
| renderer SSR | Medium | 不执行 effects/events/focus | Keep + add interaction |
| Electron/IPC security | None | F-01/F-02 逃逸 | Add gate |
| real Provider/Admin | Low | 默认 skipped | Scheduled nightly/manual |

Verified valuable tests: workspace traversal/revision、恶意 Git filter/hook、provider normalization、archive/recorder 正常路径和大量 renderer output contract。

## 5.20 Type Safety Analysis

- Coverage: High
- Inspected evidence: strict tsconfig、shared provider/runtime/trace DTO、unknown IPC 与本地重复类型。
- Exclusions / limits: 未生成全仓 any/unsafe cast 指标。

| Relevant findings | Type boundary issue |
|-------------------|---------------------|
| F-06 | preload 返回 CapabilityEnvelope<unknown>，renderer 自建宽松 DTO |
| F-05 | optional permission 字段被危险默认值吞掉 |

Verified: npm run typecheck 全部通过；核心 Provider/trace/runtime 使用 discriminated types，workspace DTO 有明确 request/result。

## 5.21 Frontend State Analysis

- Coverage: High
- Inspected evidence: App、useIntegrations、useAgentSession、workspace sequence、modal/panel state。
- Exclusions / limits: 未以浏览器自动化重放全部 race。

| Relevant findings | State problem |
|-------------------|---------------|
| F-14 | stale async response |
| F-15 | submit 非事务导致草稿丢失 |
| F-06 | absent/unknown/true-zero 混合 |

Verified: WorkspacePanel 已使用 sequence guard 和 revision 冲突；useAgentSession 会缓存 hydration 期间 lifecycle/question delta。

## 5.22 Backend API Analysis

- Coverage: High
- Inspected evidence: 50 preload 方法、43 IPC handlers、workspace operations、Provider adapter contracts。
- Exclusions / limits: 无远程 HTTP backend，此节审计 Electron local backend/IPC。

| Relevant findings | API issue |
|-------------------|-----------|
| F-01 | 无统一 sender origin authorization |
| F-04 | query-like MCP API 有执行副作用 |
| F-05, F-06 | capability contract 缺失被危险归一化 |
| F-13 | terminal outcome 契约不完整 |

Verified: workspace API 有 size、encoding、root、revision 和 conflict 约束；Provider registry 统一 capability envelope。

## 5.23 Dependency Weight Analysis

- Coverage: Medium
- Inspected evidence: direct dependency sizes、asar/unpacked、pack artifact 与 CLI tarball。
- Exclusions / limits: 未逐个 transitive package 做替代方案 benchmark。

| Relevant findings | Weight |
|-------------------|--------|
| F-18 | bundled qodercli 约 95 MB |
| F-19 | renderer JS 约 1.10 MB，CSS 173 KB |

Verified: Anthropic 平台原生二进制已显式排除，CLI 包 dry-run 仅约 59 KB。

## 5.24 Code Consistency Analysis

- Coverage: High
- Inspected evidence: guard patterns、共享/重复 DTO、selector 重复、错误与版本语义抽样。
- Exclusions / limits: 无 ESLint/stylelint 配置可作为额外 oracle。

| Relevant findings | Inconsistency |
|-------------------|---------------|
| F-06 | shared unknown 与 renderer 宽松安全 DTO |
| F-14 | 同类异步请求部分有 sequence guard、部分没有 |
| F-19 | CSS 同 selector 多层覆盖 |

Verified: 命名和 Provider ID/runtimeProvider 映射总体稳定，format/shared 层有丰富单元测试。

## 5.25 Comment Coverage Analysis

- Coverage: Medium
- Inspected evidence: main、Provider、recorder、DB、workspace 与 renderer 关键注释/TODO。
- Exclusions / limits: 未按函数做数量指标；本节关注“解释 why 与约束”而非注释率。

No distinct finding. 关键复杂路径普遍有中文注释解释历史原因、真实态/降级语义和外部 CLI 怪癖；问题在于部分注释描述了意图，却没有形成可执行 gate，例如 MCP refresh 与 migration 可重入。

Verified: Git filter/hook 隔离、shell env、window show、managed recorder、MCP live state 等高认知负担处均有原因注释。

---

## 6. Principles Compliance

### Principles Violated

| Principle | Violations | Severity | Affected Areas |
|-----------|------------|----------|----------------|
| 4.6 Principle of Least Privilege | 3 | Critical | preload/IPC、child env、permission fallback |
| 4.4 Fail-Fast | 3 | High | run controls、partial evidence、migration |
| 5.3 No Hidden Side Effects | 1 | High | MCP status/query actions |
| 5.4 No Shared Mutable State Without Synchronization | 1 | High | recorder stale-lock recovery |
| 6.1 Do Not Swallow Errors | 2 | Medium | app catalog、terminal result |
| 3.1 Principle of Least Surprise | 4 | Medium | MCP、delete、BYOK、unknown-as-zero |
| 1.1 / 1.2 / 1.3 / 1.6 Structure & Complexity | 1 systemic | Medium | main/App/format/Overview/MCP guard/recorder/CSS |
| 7.3 Explicit Dependencies Over Implicit/Global | 1 | High | shellEnv as secret/config bus |

### Principles Respected

- workspace path、revision、encoding 和 size invariants 在 API 边界显式验证。
- canonical record 正常写入使用 temp、fsync、rename、hash 与 verifyStore。
- Provider registry/shared DTO 提供明确 port，避免 UI 直接依赖各 SDK 类型。
- Git evidence 采集明确关闭 hooks/filters 并设置 timeout/buffer/patch limits。
- 多数能力以 CapabilityEnvelope 表达 ready/degraded/unavailable，而不是单纯 boolean。

---

## 7. Architecture Analysis

| Subtype | Count | Affected Areas | Recommended Action |
|---------|-------|----------------|-------------------|
| ModuleBoundary | 2 | main/index、renderer/format/App | 提取 run coordinator 和 feature modules |
| DependencyDirection | 1 | billing secret → shared shell env → Provider | 建 main-only secret port |
| StateOwnership | 2 | frontend context、session catalog | keyed state 与可重建 catalog |
| BoundaryContract | 5 | navigation/IPC、MCP、permissions、terminal result、MCP report | schema + authorization middleware |
| EvolutionRisk | 2 | 1000+ 行核心文件、全局 CSS | 分阶段拆分与 contract tests |

## 8. Documentation Analysis

| Subtype | Count | Affected Docs | Recommended Action |
|---------|-------|---------------|-------------------|
| UserDocs | 2 | delete scope、MCP execute semantics | 在 UI/README 明示 |
| OperatorDocs | 2 | release/rollback、migration recovery | 新增 runbook |
| DeveloperDocs | 1 | Electron security test flow | 新增本地/CI 指引 |
| ApiDocs | 2 | IPC origin、MCP report schema | 生成共享契约 |
| DecisionRecord | 2 | preload privilege、data retention | 建 ADR |
| StaleDocs | 1 | CLAUDE 对组件拆分描述 | 更新路径 |

## 9. Privacy / Data Governance Analysis

| Subtype | Count | Affected Data | Recommended Action |
|---------|-------|---------------|-------------------|
| DataInventory | 1 | prompt/tool/path/image/usage/spans | 文档化 owner/store |
| Minimization | 2 | login env、attachment base64 | allowlist env，单份 blob |
| AccessBoundary | 3 | preload、MCP、child env | origin/token/trust gate |
| Retention | 2 | attachments、usage/.scry | TTL/策略 |
| Deletion | 1 | session delete | 全 store 删除或列明 retained |
| Export | 0 | 本地报告/归档 | 保持 scope 标注 |
| TelemetryPrivacy | 1 | URL image request | 禁远端自动加载 |

## 10. Accessibility / UX Correctness Analysis

| Subtype | Count | Affected Workflows | Recommended Action |
|---------|-------|-------------------|-------------------|
| SemanticStructure | 1 | click div/toggle | 原生 control |
| KeyboardFocus | 1 | Skills/MCP modal | dialog primitive |
| ResponsiveVisual | 0 | 初始页 | 保持多断点检查 |
| ErrorState | 2 | BYOK、diagnostics | 保留草稿并区分 unknown |
| LoadingState | 1 | context switching | request token/cancel |
| UXStateCorrectness | 2 | MCP Trust、session race | schema + keyed state |

## 11. Supply Chain / Reproducibility Analysis

| Subtype | Count | Affected Surface | Recommended Action |
|---------|-------|------------------|-------------------|
| DependencyProvenance | 1 | Qoder secondary CLI | skip download + pinned hash/signature |
| Reproducibility | 1 | Node 22 仅文档约定 | 加 engines/.nvmrc/CI |
| CIIntegrity | 1 | 无 CI | 建最小权限 workflow |
| ArtifactProvenance | 1 | macOS app | sign/notarize/checksum/SBOM |
| RegistryHygiene | 0 | CLI package | dry-run 内容简洁，继续 gate |

## 12. Cost / Resource Economics Analysis

| Subtype | Count | Cost Driver | Recommended Action |
|---------|-------|-------------|-------------------|
| UnboundedWork | 2 | attachment bytes、archive rewrite | caps + append/blob |
| ExternalApiCost | 1 | orphan Provider turn | cancel/reconcile |
| LLMCost | 1 | timeout 后未知继续运行 | budget + termination state |
| InfrastructureSizing | 1 | 423 MB app | artifact budget |
| ObservabilityCost | 1 | 多套重复持久化 | retention/refcount |
| CostVisibility | 0 | billing ledger | 保持 provider/source attribution |

## 13. AI / LLM Safety Analysis

| Subtype | Count | Boundary Crossed | Recommended Action |
|---------|-------|------------------|-------------------|
| PromptInjection | 2 | model Markdown → network/navigation | safe renderer + CSP |
| ToolAuthorization | 3 | preload/MCP/full_access | origin/trust/monotonic permission |
| RAGLeakage | 0 | 无独立 RAG | 继续保持无隐式远端检索 |
| ModelFallback | 1 | control fallback | fail closed |
| OutputValidation | 2 | Markdown/MCP report | sanitize/schema |
| EvalGap | 1 | 无 adversarial Electron eval | 加 release gate |
| AbuseCost | 2 | orphan turn/remote load | cancellation/network budget |

## 14. Observability / Operability Analysis

| Subtype | Count | Critical Signals Missing | Recommended Action |
|---------|-------|--------------------------|-------------------|
| Logging | 1 | catalog write/parse failure | structured degraded event |
| Metrics | 2 | ordinary provider failures、orphan turns | terminal outcome + counter |
| Tracing | 1 | late Codex turn correlation | client request ID |
| HealthCheck | 2 | initialized vs spawned、DB degraded | explicit health state |
| Alerting | 1 | full_access fallback | blocking UI alert |
| Runbook | 2 | migration/catalog recovery | operator docs |
| Debuggability | 1 | unknown rendered zero | preserve completeness |

## 15. Configuration Safety Analysis

| Subtype | Count | Affected Keys / Files | Recommended Action |
|---------|-------|-----------------------|-------------------|
| SchemaValidation | 2 | MCP Guard DTO、permission request | shared schema |
| UnsafeDefault | 1 | full_access fallback | default/fail closed |
| EnvironmentSeparation | 1 | shellEnv | billing/runtime split |
| SecretConfig | 1 | Admin API keys | Keychain/main-only |
| FeatureFlag | 1 | SCRY_RUN_CONTROLS | visible dangerous-state gate |
| ConfigDocs | 2 | MCP execution、release identity | document exact semantics |

## 16. Data Integrity Analysis

| Subtype | Count | Invariants at Risk | Recommended Action |
|---------|-------|-------------------|-------------------|
| TransactionBoundary | 2 | migration、delete | transactions |
| Idempotency | 1 | DDL replay | guarded/restartable migration |
| ConcurrencyConsistency | 2 | stale lock、frontend context | OS lock/CAS + request IDs |
| MigrationSafety | 1 | v2/v3 | crash matrix/backup |
| InvariantValidation | 1 | terminal result | adapter outcome contract |
| BackupRestore | 2 | DB/catalog | backup + rebuild |
| Reconciliation | 3 | orphan turn、catalog/archive、blob refs | startup reconciliation |

## 17. Fallback / Defensive Code Analysis

| Subtype | Count | KeepWithAlert | FailFast | Remove |
|---------|-------|---------------|----------|--------|
| SilentFallback | 4 | 1 | 2 | 1 |
| EmptyCatch | 2 | 0 | 2 | 0 |
| CompatibilityBranch | 1 | 1 | 0 | 0 |
| SilentCorrection | 2 | 0 | 2 | 0 |
| DefensiveGuess | 3 | 0 | 2 | 1 |

## 18. Testing Authenticity Analysis

### Confidence Assessment

| Test Area | Real Confidence | Risk | Action |
|-----------|-----------------|------|--------|
| Pure/shared/provider transforms | High | 少量真实 SDK drift | Keep + contract probe |
| Recorder/Git filesystem | High | stale recovery 双进程缺口 | Extend |
| Renderer SSR | Medium | interaction/effect/IPC 全缺 | Keep + interaction |
| Electron security | None | Critical exploit | Add immediately |
| Release/migration | Low | crash/rollback 未测 | Add before release |

### Valuable Tests

workspace path/revision、防恶意 Git hooks/filters、Provider normalization、archive/recorder 正常路径、billing ledger 和 renderer output contract 提供真实回归价值。

### Suspicious Tests

renderToStaticMarkup 能验证文案和结构，却不能支撑“交互正确”“焦点正确”“IPC 安全”结论；纯 reducer tests 也不能验证订阅/cleanup 时序。

### Missing Tests

导航与 remote preload、远端图片网络、child env secret stripping、MCP fingerprint gate、migration interruption、双进程 stale lock、迟到 RPC、context race、modal keyboard/focus、installer rollback。

## 19. Type Safety Analysis

| Subtype | Count | Critical | High | Medium | Low |
|---------|-------|----------|------|--------|-----|
| AnyEscape | 0 distinct | 0 | 0 | 0 | 0 |
| UnsafeAssertion | 1 | 0 | 1 | 0 | 0 |
| ContractDrift | 2 | 0 | 1 | 1 | 0 |
| Nullability | 1 | 0 | 0 | 1 | 0 |
| Exhaustiveness | 0 distinct | 0 | 0 | 0 | 0 |
| ExternalBoundary | 2 | 0 | 1 | 1 | 0 |

核心问题不是 TypeScript 编译失败，而是 external/unknown payload 被宽松 assertion 与危险默认值转换成可信事实。

## 20. Recommended Fix Order

### Immediate — release blocker

1. F-01/F-02：封死同窗导航、window.open 和远端自动资源；为 privileged IPC 增加可信 origin/root token。（1–3 天）
2. F-03：从所有 Provider child env 剥离 Billing Admin secrets，并让 MCP probe 固定使用 allowlist env。（1 天）
3. F-05：permission 缺失/失败全部 fail closed。（0.5–1.5 天）
4. F-04：MCP 执行加入 fingerprint trust gate，取消打开面板即执行。（2–4 天）
5. F-08：transactional/idempotent migrations，并写 interruption matrix。（1–2 天）

### Next — data and lifecycle correctness

6. F-07：替换 stale directory lock recovery。（1–2 天）
7. F-09/F-13：Provider terminal outcome、超时 quarantine 与 reconciliation。（2–4 天）
8. F-11/F-12：catalog 原子写、全 store 删除、blob/refcount/retention。（3–7 天）
9. F-06/F-14/F-15：unknown schema、context token 与 composer rollback。（2–4 天）
10. F-10/F-16：Electron/interaction/accessibility tests 和 CI。（4–8 天）

### Scheduled — release and maintainability

11. F-17：原子安装、签名、公证、checksum、rollback。（3–7 天）
12. F-18：排除未使用 Qoder CLI，建立 artifact budget。（0.5–1 天）
13. F-19：分阶段拆 main/App/format/Overview/recorder/CSS。（5–10 天）

## 21. Quick Wins

- 在 createWindow 增加 will-navigate deny 与 setWindowOpenHandler deny；先切断最短 Critical 链。
- 把 fallbackRunControlCatalog 的危险分支统一改成 default/disabled。
- child env 统一删除三类 Admin API key 和组织/member 变量。
- 禁用远端 Markdown img，并补最小 CSP。
- BYOK 选项加 disabled；start reject 不清草稿。
- installer 改为 staging copy → verify → atomic swap。
- builder 排除 bundled qodercli，并加 artifact size assertion。
- app-sessions 写入改 temp + fsync + rename。
- MCP/Diagnostics 缺数据一律显示“未知”，不显示绿色/0。
- CI 固定 Node 22，至少跑 typecheck、test、build、report lint。

---

审计验证摘要：Node 22 typecheck 通过；完整启用测试通过（63 个测试文件，3 个 opt-in real integration 文件跳过）；build 与 macOS dir pack 通过；CLI npm dry-run 通过；离线 npm audit 报告 0 已知漏洞；Electron 初始 UI 与不可信 data-origin preload 探针完成。在线 advisory 全量核验未获外发依赖元数据授权，因此不把离线 0 漏洞解释为实时无漏洞。
