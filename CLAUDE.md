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
- **维护者 2026-09-21 明确确认**：项目 MCP、Codex Hook、OpenCode plugin 与 recorder commit callback 自动授权，不再弹确认窗；首次执行及指纹变化仍重验 canonical cwd + 内容/executable fingerprint，校验失败必须拒绝执行。
- 真实后果是打开不可信仓库可能直接以本机用户权限执行其配置的代码。Recorder 自动授权仍标 `source: auto`，不得把自动放行显示成用户批准；`SCRY_COMMIT_HOOK_TRUST=prompt` 不再恢复询问。App 与独立 CLI 的 recorder commit callback 均按此策略执行。改动这一策略要显式征得维护者同意。
- 同一 macOS 用户下的并发攻击者不在此信任模型保证范围内，不要作更强承诺。
- 观测 hook 可以 fail open，避免阻断用户 Agent；执行 trust gate 必须 fail closed，不能为“记录完整”而执行未授权代码。

### 4. Renderer 保持不可信且无特权

保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。Renderer 只能通过 typed `window.scry` preload API 调用经过校验的 main handler。

- 禁止任意命令、任意路径、任意 URL IPC。
- 用户目录（`~/`）文件预览默认允许，不再逐目录弹窗授权或依赖持久化目录 grant；main 仍重验相对路径、canonical home containment 与文件类型。用户点击的文件链接也允许指向用户目录外，包括符号链接目标；main 为这类目标签发仅限单个 canonical 文件的内存只读引用，后续读取/外部打开重验引用与目标，不能将引用用于写入或换成同目录其他文件。目录链接使用相同的单目标引用，只交给系统打开，不授予目录浏览或写入权限。维护者明确要求文件打开不按类型拦截：用户请求外部打开时，所有文件类型（包括可执行文件）均交给系统默认应用，可能执行程序。此策略不授予工作区外写入权限，也不绕过操作系统权限或仓库配置 trust gate。
- 主进程验证 sender/frame/origin，并对 payload 再做 schema、cwd、path 和 operation authorization。
- 阻止 webview、任意 navigation/window open 和非 allowlist 网络请求；合法 HTTP(S) 链接（包括 localhost/private URL）直接交给默认浏览器，不再二次确认。仍拒绝非 HTTP(S) 协议；不允许外部页面在特权 renderer 中加载。
- 不为恢复 React HMR 或开发便利而放宽 CSP/sandbox。当前 dev 配置刻意牺牲 HMR 以保持生产安全边界一致。

### 5. Recorder Core 必须独立

`src/core/turn-recorder/` 与 `scry-turn-recorder` 必须保持无 Electron、无 SQLite、无 Provider SDK、无原生依赖。CLI 在 macOS/Linux Node 20/22/24 上独立运行，并只写工作区 `.scry/`。

- `.scry/records` 是 recorder 的 canonical 一轮一文件事实源；runtime/state/health 是恢复或观测状态。
- managed recorder 两阶段提交需要等待 Provider result、hook、diff 等证据收敛，不能悄悄降级为 rollout 近似。
- Hook 通过明确的 private CLI 绝对路径运行；App 私有 CLI 与全局 npm CLI 是两个分发面。

## 补充安全边界

- 启动环境清洗、package resource allowlist、sandbox preload CJS/native unpack 和私有 CLI 绝对路径是运行/分发边界，不得为开发便利取消。
- auth 与同 provider/profile operation 保持互斥；只停止登记且重验 identity 的进程，不使用模糊 pkill。
- 自动化/破坏性测试使用临时 workspace/userData，不写真实 `.scry` records、transcript 或 DB。

## 按任务加载

不预读全部文档；需要定位时先检索并读取相关小节。

| 场景 | 参考 |
|---|---|
| 术语、架构、代码定位或首次安装 | [架构与地图](docs/agent/architecture.md) |
| 修改对应领域/边界 | [检查清单](docs/agent/change-checklists.md)，只展开受影响领域 |
| 普通代码、UI、跨边界或发布验证 | [验证与交付](docs/agent/verification.md)，按下述范围选择小节 |

## 测试维护纪律

- 手机端操作与验收不使用模拟器或仿真设备；需要操作手机时，直接使用 `ictrl-phone-control` skill，通过 iCTRL 操作真实手机。真机或 iCTRL 不可用时，明确报告阻碍，不改用模拟器，也不将未执行的验收标为通过。
- 先按业务/权限合同写验收场景；关键回归证明一次旧实现或故意破坏保护时失败。测试可以由 AI 维护，但删断言、改预期、skip、扩大超时必须说明依据；首次失败不能被重跑通过抹掉。
- 本地 focused 使用 `npm run test:unit -- <test-files>`；`npm test` 是 unit 与 shell 的复合入口。合入沿用现有 CI，macOS gate 同时执行 `npm run test:renderer:ui`（含 Credits），避免有脚本却没有门禁。
- DOM/事件问题走现有隔离 Electron fixture；CSS 源码、SSR 或程序化 `.click()` 不单独证明 cascade、坐标命中与焦点行为。main IPC 拒绝测试必须触发生产注册 wrapper 并证明特权 listener 未执行，不能只看 iframe 没有 preload API。
- shell fixture 按参数记录并检查 argv 边界及退出码，不能用 `$*` 展平后 grep 证明含空格路径正确。持久化、SQLite 与 Provider transport 优先复用现有真实临时目录/本地进程测试，不绕过本次风险边界。
- `P0_PROBE`、`P1_PROBE`、`BILLING_ADMIN_REAL` 默认关闭；真实探针仅在明确账号/费用授权后执行，使用临时 workspace/HOME/配置与凭据 allowlist，结束后确认进程收敛再清理。不得在当前开发仓库直接驱动真实 Agent。
- 超时先调查 fixture、资源争用和子进程收敛，不先加 sleep/retry。报告具体环境、执行范围、skip、首轮失败及未验证项；组件 smoke 不等于完整 App 或真实 Provider 验收。

- `npm run test:coverage` 是 Node CI 的 unit/contract 入口，同时保存覆盖率报告。对比固定源码与测试范围；并行 WIP、focused 与 full 的数字分别报告。报告目录不能复用源码/备份目录，细节见验证文档。

## 最小验证与完成条件

- 纯文档/Agent 配置：`git diff --check`，核对引用路径、命令、合同与边界；不构建、不启动 App、不升版本。改可执行脚本则按代码处理。
- 普通代码：运行受影响测试及本项目对应 type/lint/build 检查；以验证参考的普通代码小节为准，不把全量发布 gate 套到小改动。
- UI 修复：记录原始操作、预期及相邻路径，补 focused 回归，在当前版本真实 App 重放；构建/自动测试与真实交互结果分别报告。截图/设备/Provider 不可用则明确未验证。
- 跨核心安全/持久化边界、高风险合入或发布：读取验证参考中的扩大/完整 gate 与发布小节；真实外部操作、成本和设备授权不可由本地测试替代。
- 允许继续修复本次授权范围内的安全本地失败并重跑受影响检查；既有失败单列，不顺手扩大改动。外部结果未知、授权不足或需要用户决定时停止对应动作并交接。
- 检查 diff，默认只提交本次相关改动，不 push；已有 WIP 不混入。报告改动、实际检查、未验证项，不用 L1/L2 冒充 L3。

## 代码风格与品味

- 使用 strict TypeScript、discriminated union、typed envelope 和明确 domain state；避免 `any` 与字符串猜测。
- 保持 semicolonless、single quote、两空格的既有风格，不做无关格式清洗。
- 复杂度留在 adapter/trust/persistence 边界；renderer 保持展示导向，recorder core 保持纯净。
- 优先扩展现有 contract、registry、store 和 projection，不建立第二套同义状态。
- 注释解释证据来源、信任边界、失败模式和为何必须如此，不逐行翻译代码。
- fail-open 只用于不应阻断用户 Agent 的观测附加路径；权限、信任、路径和发布完整性必须 fail closed。
- 先做最小真实修复，再考虑抽象；不要保留复杂度只因为它已经存在。
- 本次明确请求覆盖一般流程与偏好，无需对同一决定重复确认。仅当冲突会引入尚未授权的数据损失、外部写入、费用或权限变化时，说明具体影响并询问缺少的决定。
