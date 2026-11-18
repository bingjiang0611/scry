# AGENTS.md

本文件是唯一项目规则正文；根 `AGENTS.md` 仅为自动发现的符号链接。本文相对引用以本文件 canonical realpath 的父目录为基准；代码与命令路径仍相对仓库根。

客户端入口、兼容状态与加载验证见 [指令加载](../docs/agent/instruction-loading.md)。

# Scry

产品定位、架构与代码地图见 [architecture.md](../docs/agent/architecture.md)。

Scry **不是安全沙箱**。它能做授权、指纹校验、观测和治理，但 Provider 与获批工具最终仍以本机用户权限运行；文件足迹也不是完整审计日志。

本文是仓库内 Agent 与维护者的默认工作约定。用户的明确要求可以覆盖一般偏好，但不能静默弱化权限语义、证据诚实性、renderer 隔离、仓库配置 trust gate 或发布验证。

## 我们绝不妥协的事情

### 1. 证据不能说谎

`exact`、`estimated`、`inferred`、`partial`、`disabled`、`unavailable` 不是样式差异，而是产品语义。

修改 trace、usage 或证据投影时，加载 [证据合同](../docs/agent/change-checklists.md#trace--usage--evidence-改动)。

### 2. Provider 差异必须显式存在

修改 Provider、run-control、能力或恢复状态时，加载 [Provider 合同](../docs/agent/change-checklists.md#provider-或-run-control-改动)。


### 3. 权限与 trust 不是一回事

`full_access` 表示用户明确选择让 Provider 以本机权限运行；它不是 Scry 提供了更强隔离。仓库控制的 MCP、Hook、plugin、executable 仍必须经过独立 trust/fingerprint 检查。

- 默认模式保留 Provider 原生/映射后的审批语义。
- **维护者 2026-10-15 明确确认**：已配对 owner 可通过桌面端专用目录选择接口浏览宿主当前用户可读取/遍历的任意目录，包括用户目录外与目录符号链接的 canonical 目标。浏览不授权；明确选择后，宿主校验真实目录并通过与本机目录选择器相同的项目 authority 持久化，其他已配对 owner 随后也可访问该项目。发送时仍重验工作区授权及仓库 trust/fingerprint；不自动运行或发送。原有项目根内的手机目录浏览接口不因此放宽；旧宿主未声明该能力时显示 unavailable，不绕过校验。
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

修改 recorder 或独立 CLI 时，加载 [Recorder 合同](../docs/agent/change-checklists.md#recorder--cli-改动)。


## 补充安全边界

- 启动环境清洗、package resource allowlist、sandbox preload CJS/native unpack 和私有 CLI 绝对路径是运行/分发边界，不得为开发便利取消。
- auth 与同 provider/profile operation 保持互斥；只停止登记且重验 identity 的进程，不使用模糊 pkill。
- 自动化/破坏性测试使用临时 workspace/userData，不写真实 `.scry` records、transcript 或 DB。

## 按任务加载

不预读全部文档；需要定位时先检索并读取相关小节。

涉及领域概念、接口命名或业务行为时，先读取根目录 [GLOSSARY.md](../GLOSSARY.md)，沿用规范名称。发现需求、代码与词汇表冲突时，先说明差异；需要产品取舍时征求确认，不把现有代码行为自动当作正确规则。概念确认后，在同一变更中更新词汇表及受影响文档；词汇表只保留术语、简短定义和易混概念，不写实现细节。

| 场景 | 参考 |
|---|---|
| 架构、代码定位或首次安装 | [架构与地图](../docs/agent/architecture.md) |
| 修改对应领域/边界 | [检查清单](../docs/agent/change-checklists.md)，只展开受影响领域 |
| 普通代码、UI、跨边界或发布验证 | [验证与交付](../docs/agent/verification.md)，按下述范围选择小节 |
| PR、分诊、评审与门禁 | [贡献指南](../CONTRIBUTING.md)；修改流程必须遵循[维护清单](../docs/agent/pr-workflow.md#workflow-maintenance)；分诊用 `contribution-triage` |
| 界面样式、组件选择、UX 文案 | [设计系统](../DESIGN.md)：token、组件语义目录、文案规则；`scry-design-system` skill 给出执行顺序、验证与已知陷阱 |
| 性能分析、优化、指标/门禁维护 | [持续性能闭环](../docs/performance-loop.md)、`scry-performance-climb` skill |
| 内网 registry、内网需求单、本地内部资料 | `.claude/company-context.local.md`（已 gitignore，缺失时按公开默认配置工作） |

## macOS / Linux 是共同维护目标

macOS / Linux 是共同维护目标；共享代码、UI 或平台边界变更加载 [跨平台合同](../docs/agent/change-checklists.md#macos--linux-跨平台改动)。

- 保留 Chromium sandbox；不以 `--no-sandbox`、默认禁用 GPU、自动改 Hyprland 全局配置或 Linux 明文凭据后端换取“能运行”。
- 按改动范围和平台选择[验证](../docs/agent/verification.md#linux-验证与交付)。共享或平台边界改动覆盖两端；缺目标环境须标未验证，不以 macOS 通过或交叉构建代替 Linux 运行。纯文档只核对引用与 diff，不扩大门禁。

## 性能是默认要求

### 写代码时的护栏

修改 main、IPC、trace 或 renderer 用户路径时，加载 [性能护栏](../docs/agent/change-checklists.md#性能护栏)。

### 遵守性能闭环

分析或优化性能、修改指标与门限时，使用 `scry-performance-climb` 并加载 [性能任务合同](../docs/performance-loop.md#性能任务的证据与授权合同)。

## 快速迭代

本节只调整执行时机与方式，不删除、跳过或放宽现有强制门禁。按改动范围选级，保留每项结果与确切提交；失败不记为通过。

### 验证分级

- **L0 开发中**：只跑改动相关的测试和类型检查。A/B 对照只备份、临时改回并还原单个文件，不 stash 整个目录，不覆盖用户改动。
- **L1 候选提交**：仓库规定的适用门禁跑一次，全量测试交给 CI，不在本地重复跑大目录。超时类失败先看负载并保留原日志，排除负载干扰后只单独重跑一次确认；仍失败就诊断，不反复重跑碰运气，也不凭一次通过断言 flake。
- **L2 发布**：对确切候选提交执行一次所需 CI，核对正式包校验值，在隔离环境做关键路径冒烟。提交或构件变化后重新验证，不复用旧证据；不因此重复触发已有的同提交流水线。
- **L3 真实宿主**：仅在改动钩子、认领、门卫或会话记录解析时按批验证，每批一次；现有明确要求的发布宿主检查仍保留。每批必须包含中文系统语言环境与中文工作区／脚本路径，记录实际 OS、locale、宿主版本及是否为正式包；不能用英文环境或替身代替，缺环境须标未验证。长等待场景优先用测试已支持的环境变量调小阈值，记录变量与值，不改产品默认值；缩短阈值只证明受控边界，不冒充默认阈值下的真实等待。没有可用变量时报告限制，不临时绕过门禁。

### 长跑、等待与推送

- 长跑前执行 `python3 -B ~/.config/agent-config/preflight.py`：看 uptime、核数、前 5 个 CPU 进程和 recorder/宿主候选进程。1 分钟负载超过逻辑核数的 1.5 倍，或有陌生进程占核，先报告并停止本地全量计划。
- 先停止自己之前测试留下的 recorder 守护进程和宿主进程。按 PID、启动时间、工作区及会话归属核实后用其正常停止入口；预检列表不证明残留，不模糊 pkill，不动其他会话或用户进程。
- 后台长跑必须把默认 stdout/stderr 同时 `tee` 到独立日志文件，使用 `set -o pipefail` 保留退出码；开跑一分钟内确认文件存在且能读。显式 JSON 报告不能替代默认日志。
- 等 CI 用下面的阻塞等待脚本，放到有完成通知的后台任务；等待期间做独立工作。不在 Agent 回合间固定 sleep 轮询，不自动重跑或取消流水线。
- 本机推送统一用 `bash ~/.config/agent-config/git-push.sh origin <目标分支>`；新分支加第三参数 `main`。调用前核对远端、基线及全部待推送提交。包装先 fetch、检查快进、dry-run，再推送并回读 SHA；不强推。它只在 GitHub 使用本机已验证的专用身份，内网 GitLab 不带该密钥。脚本仅存本机，不把凭据或机器配置提交到仓库；缺失时按本机 `~/.config/agent-config/local.md` 恢复，不猜身份。

### 发布前后

- 触发前打印并逐项核对：目标提交、远端 main 归属、所有待发版本号、recorder pin、registry/发布包/通道及实际流水线参数；核对完成再触发，不靠启动后取消纠偏。
- 版本号被其他会话占用是常态。版本变更前及发版前重新读取远端 main、发布记录、registry 的确切版本与 dist-tags，取当时未占用的下一个版本；查询不等于占号，冲突后同步所有 pin/lock/文档并重跑受影响预检。
- 发布记录在拿到最终结果后一次生成，保留提交、run、校验值与验证范围；不提前写成功结论。失败或受阻照实记录；纯文档与运维脚本任务不因此发版。

CI 等待：`bash scripts/wait-ci.sh <run-id> [owner/repo]`（默认 `bingjiang0611/scry`）。包装 `gh run watch --exit-status`；失败直接打印失败 job/步骤和日志最后 80 行，完整失败日志保留在输出的临时文件。认证、网络或日志不可用仍返回非零，不冒充 CI 成功。

## 任务收敛与验证成本

开工前加载 [任务收敛与验证成本](../docs/agent/verification.md#任务收敛与验证成本)。

- **持续收敛**：用户问进度不是撤销已有授权；简答后继续，不反复询问“是否继续”。范围内可查的问题当场查完；同一失败无新假设或改动时不重复长测刷绿，未知写入先查结果。阻碍需交代证据、责任人和具体下一步；只询问缺少的决定或授权，不重问已获授权的步骤。

## 发布与 CI 取证

以下规则只约束已获授权的发布任务，不额外授予安装、外部上传或发布权限。

- **先验产物，再发布**：用目标提交的候选构件，在隔离工作区与配置目录验证受影响的真实链路，再走既有发布入口与门禁；记录提交、构件校验值和实际执行版本。采集与上传改动须核对记录落地及完整远端 ACK，不能用入队、回调退出成功或替身测试代替。正式包下载后补关键路径验证；候选产物经重打包或重建后须重新核对，不能沿用旧产物证据。
- **失败先取证，不重跑刷绿**：先保存完整 job 日志、退出码、提交和环境，再区分代码失败、环境故障与未确定原因。相邻提交通过或一次重跑通过不证明 flake；只有证据支持瞬态故障时才定向重跑，并保留原失败。run 未结束而汇总日志不可用时，可读取已完成 job 的日志；不要反复请求尚未可用的汇总日志。
- **版本在变更前与发布前各核对一次**：核对远端 main、目标 registry 的确切版本、dist-tags 和下游版本映射，不能只看 latest。查询不是占号；并行发布冲突时保留历史记录，协调未使用的新版本，再同步 pin、lock 与文档并重跑受影响预检。依赖包发布并可下载后，才发布引用它的下游包。
- **对照脚本可复用，验收证据分层**：需要重复执行的跨版本回归应扩展仓库已有 smoke/fixture，不长期依赖一次性脚本。先用小场景核对内容路径、基线时点与进程环境隔离，再跑大场景；脚本入库，运行数据留在隔离目录。模拟事件或改写时钟的测试只能证明受控行为，不能冒充真实宿主或真实等待；自动投递验收不得用手工 flush/wakeup 代替。

## 测试维护纪律

执行测试前必读[测试维护纪律](../docs/agent/verification.md#测试维护纪律)。原有真机、负对照、隔离、真实持久化与失败证据要求不变；以上效率规则不减弱安全边界或发布门禁。

## 最小验证与完成条件

按本次实际改动选择 [验证与交付](../docs/agent/verification.md#验证与交付)：纯文档、普通代码、UI 或完整门禁，不因无关 WIP 扩大范围。

- 允许继续修复本次授权范围内的安全本地失败并重跑受影响检查；既有失败单列，不顺手扩大改动。外部结果未知、授权不足或需要用户决定时停止对应动作并交接。
- **构建安装按需执行**：默认不打包、不安装 App。用户要求安装、准备可安装版本或发布时，在 macOS 宿主执行 `npm run install:mac:dev`，不绕过打包与安装校验；Linux 宿主按 [Linux 验证与交付](../docs/agent/verification.md#linux-验证与交付) 构建检查，系统级 pacman 安装须明确授权。
- **使用独立 test 实例验证**：修改代码后需要验证 App 行为时，启动基于当前代码、使用独立 `userData` 和临时工作区的 test 实例，不要求用户重启当前 App，也不停止或干扰用户正在使用的实例。安装后的日常实例仍由用户自行重启加载新版本，但不作为验收前置条件；不把安装成功或 test 实例验证通过当作用户当前运行版本已更新。构建或安装失败时如实报告，不宣称已安装。
- **本地提交前自查（默认）**：Agent 完成改动和对应验证后，必须主动按 [本地自查](../docs/agent/pr-workflow.md#local-preflight) 检查需求与批准、改动范围、风险边界、验证证据和待提交内容，无需用户再次要求；在提交和宣称完成前处理发现的问题，并在交付中简述结论与未验证项。此项不因维护者分诊豁免而跳过，不替代正式 PR 分诊、独立评审或 CI。
- 常规交付使用任务分支与 PR，不直接推送 main。自查后默认提交本次相关改动、推送任务分支并创建 PR，无需再次询问；合并、发布和关闭他人 PR 仍须用户明确要求。已有 WIP 和无关未推送提交不混入。报告改动与实际检查；仅在涉及产物或验收时补充构建、安装、待用户重启状态及未验证项。纯文档不要求重启 App，不用 L1/L2 冒充 L3。

## 提交身份

所有提交（author 与 committer）必须使用公开的 GitHub 身份：`bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。

- 禁止用公司内部邮箱（域名见 `.claude/company-context.local.md`）提交：仓库历史已统一重写为该 noreply 地址，新提交不得把内部邮箱带回来。
- 本仓库 `.git/config` 已固定该身份；在缺少该配置的检出或临时 worktree 里，用 `git -c user.name=bingjiang0611 -c user.email=307659028+bingjiang0611@users.noreply.github.com commit` 显式覆盖，不改全局 `user.email`（本机全局值是工作仓库需要的内部身份）。
- 提交前自查 `git config user.email` 与 `git log -1 --format='%an <%ae>'`；rebase、amend、cherry-pick、merge 和 `--reset-author` 同样保持该身份。
- 发现内部邮箱已经进入历史时先停下来报告并取得授权，再决定重写范围；不要自行改写已推送历史。

## 代码风格与品味

修改代码时，加载 [代码合同](../docs/agent/change-checklists.md#代码合同)。

- 本次明确请求覆盖一般流程与偏好，无需对同一决定重复确认。仅当冲突会引入尚未授权的数据损失、外部写入、费用或权限变化时，说明具体影响并询问缺少的决定。
