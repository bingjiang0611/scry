# AGENTS.md

本文件是唯一项目规则正文；根 `AGENTS.md` 仅为自动发现的符号链接。相对引用以本文件 canonical realpath 的父目录为基准；代码与命令路径相对仓库根。
客户端入口与加载验证见 [指令加载](../docs/agent/instruction-loading.md)；产品定位与代码地图见 [architecture.md](../docs/agent/architecture.md)。

Scry **不是安全沙箱**：它能做授权、指纹校验、观测和治理，但 Provider 与获批工具最终以本机用户权限运行，文件足迹也不是完整审计日志。
用户的明确要求可以覆盖一般偏好，但不能静默弱化权限语义、证据诚实性、renderer 隔离、仓库配置 trust gate 或发布验证。

## 绝不妥协的事情

- **证据不能说谎**：`exact` / `estimated` / `inferred` / `partial` / `disabled` / `unavailable` 是产品语义，不是样式差异。改 trace、usage 或证据投影前加载 [证据合同](../docs/agent/change-checklists.md#trace--usage--evidence-改动)。
- **Provider 差异必须显式存在**：改 Provider、run-control、能力或恢复状态前加载 [Provider 合同](../docs/agent/change-checklists.md#provider-或-run-control-改动)。
- **权限与 trust 不是一回事**：`full_access` 表示用户明确让 Provider 以本机权限运行，不是 Scry 提供了更强隔离；仓库控制的 MCP、Hook、plugin、executable 仍须独立 trust/fingerprint 检查。观测 hook 可以 fail open，执行 trust gate 必须 fail closed。
- **Renderer 不可信且无特权**：保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；Renderer 只能经 typed `window.scry` preload 调校验过的 main handler；禁止任意命令、路径、URL IPC；不为开发便利放宽 CSP/sandbox。
- **Recorder Core 必须独立**：改 recorder 或独立 CLI 前加载 [Recorder 合同](../docs/agent/change-checklists.md#recorder--cli-改动)。

## 已确认的权限策略（改动须维护者同意）

- 2026-09-21：项目 MCP、Codex Hook、OpenCode plugin 与 recorder commit callback 自动授权、不再弹确认窗；首次执行与指纹变化仍重验 canonical cwd 与内容/executable 指纹，校验失败必须拒绝。自动放行标 `source: auto`，不得显示成用户批准；`SCRY_COMMIT_HOOK_TRUST=prompt` 不再恢复询问。
- 2026-10-15：已配对 owner 可经桌面端专用目录选择接口浏览宿主当前用户可读/遍历的任意目录（含用户目录外与符号链接目标）。浏览不授权；明确选择后由宿主校验并持久化项目 authority。发送时仍重验工作区授权与 trust/fingerprint。
- 用户目录文件预览默认允许，不逐目录弹窗：main 仍重验相对路径、canonical home containment 与文件类型；用户点击的文件链接可指向用户目录外，main 签发仅限单个 canonical 文件的内存只读引用。外部打开不按类型拦截（含可执行文件），交给系统默认应用。
- 真实后果：打开不可信仓库可能直接以本机用户权限执行其配置的代码。同一 macOS 用户下的并发攻击者不在信任模型内，不作更强承诺。

## 补充安全边界

- 启动环境清洗、package resource allowlist、sandbox preload CJS/native unpack、私有 CLI 绝对路径是运行/分发边界，不得为开发便利取消。
- auth 与同 provider/profile operation 保持互斥；只停止登记且重验 identity 的进程，不用模糊 pkill。
- 自动化/破坏性测试用临时 workspace/userData，不写真实 `.scry` records、transcript 或 DB。
- macOS 与 Linux 是共同维护目标：保留 Chromium sandbox，不用 `--no-sandbox`、默认禁用 GPU、改全局 Hyprland 配置或明文凭据后端换「能运行」；缺目标环境标未验证，不以另一端通过代替。

## 按任务加载

不预读全部文档；需要定位时先检索再读相关小节。

| 场景 | 参考 |
|---|---|
| 修改对应领域/边界 | [检查清单](../docs/agent/change-checklists.md)，只展开受影响领域 |
| 领域概念与命名 | [GLOSSARY.md](../GLOSSARY.md)：沿用规范名；需求与词汇表冲突先说明差异，概念确认后同变更更新词汇表 |
| 验证范围与交付 | [验证与交付](../docs/agent/verification.md) |
| PR、分诊、评审与门禁 | [贡献指南](../CONTRIBUTING.md)、[PR 工作流](../docs/agent/pr-workflow.md)、[CI 接线](../docs/agent/validation-workflows.md)；分诊用 `contribution-triage` |
| 界面样式与 UX 文案 | [设计系统](../DESIGN.md)、`scry-design-system` skill |
| 性能分析、指标与门限 | [性能闭环](../docs/performance-loop.md)、`scry-performance-climb` skill |
| 内网 registry 与本地资料 | `.claude/company-context.local.md`（已 gitignore；缺失时按公开默认工作） |
| 机器专属路径与工具配置 | `~/.config/agent-config/local.md`（不提交到仓库） |

## 工作流要点

细节见 [验证与交付](../docs/agent/verification.md)、[PR 工作流](../docs/agent/pr-workflow.md) 与 [CI 接线](../docs/agent/validation-workflows.md#merge-required-checks)；这里只留判断依据。

- **验证分级**：L0 只跑改动相关的测试与类型检查；L1 跑仓库适用门禁一次、全量交给 CI；L2 对确切候选提交跑一次所需 CI 并核对产物；L3 真实宿主只在改钩子、认领、门卫、会话记录解析时做，每批一次。
- **合并前**只等 `node`（类型检查 + App build + CLI 编译）与 `unit`+`unit-coverage`（单测）通过，不等 `packaged-electron` 与 `Performance Check`；命令见上面链接。
- **超时类失败**先看负载并保留原日志，排除负载后只单独重跑一次；仍失败就诊断，不靠重跑碰运气，也不凭一次通过断言 flake。
- **失败先取证**：先存完整 job 日志、退出码、提交与环境，再区分代码失败、环境故障与未确定原因。
- **不要直接推 main**：常规交付走任务分支与 PR，合入、发布、关闭他人 PR 须用户明确要求；不用没有 PR 记录的快进合并顶替评审，也不得据此发版。main 的规则集若拒绝直推，不要绕开，开 PR 重走。
- **先验产物再发布**：用目标提交的候选构件在隔离工作区验证受影响链路，记录提交与校验值；改采集/上传要核对记录落地与完整远端 ACK，入队或回调退出成功都不算交付。
- **版本一处核对两次**：变更前与发布前各核对远端 main、registry 确切版本、dist-tags 与下游映射；查询不是占号，冲突后同步 pin/lock/文档并重跑受影响预检。
- **对照脚本入库**：跨版本回归扩展仓库已有 smoke/fixture，不长期依赖一次性脚本；模拟事件或改写时钟只证明受控行为，不冒充真实宿主或真实等待。
- **构建安装按需**：默认不打包不安装；用户要求安装或发布时按 [验证与交付](../docs/agent/verification.md) 执行，不绕过打包校验。验证 App 行为用当前代码、独立 `userData` 与临时工作区的 test 实例，不干扰用户正在用的实例。
- **长跑**：先跑 `python3 -B ~/.config/agent-config/preflight.py`；1 分钟负载超过逻辑核数 1.5 倍或有陌生进程占核就先报告。后台长跑把 stdout/stderr 同时 `tee` 到独立日志并 `set -o pipefail`；先停掉自己上一轮测试留下的进程，按 PID 与归属核实，不用模糊 pkill。
- **推送**：`bash ~/.config/agent-config/git-push.sh origin <分支>`（新分支加第三参数 `main`）；先核对远端、基线与全部待推提交，不强推。
- **等 CI**：`bash scripts/wait-ci.sh <run-id> [owner/repo]`，放进有完成通知的后台任务；不在回合间固定 sleep 轮询。

## 提交身份

所有提交（author 与 committer）必须是 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。

- 禁止把公司内部邮箱带进历史（历史已统一重写为 noreply 地址）。
- 在缺少该配置的检出或临时 worktree 里用 `git -c user.name=bingjiang0611 -c user.email=307659028+bingjiang0611@users.noreply.github.com commit` 显式覆盖，不改全局 `user.email`。
- 提交前自查 `git config user.email` 与 `git log -1 --format='%an <%ae>'`；rebase、amend、cherry-pick、merge 同样保持该身份。
- 内部邮箱已进入历史时先停下报告并取得授权，不自行改写已推送历史。

## 代码风格

修改代码前加载 [代码合同](../docs/agent/change-checklists.md#代码合同)。本次明确请求覆盖一般流程与偏好；仅当冲突会引入未授权的数据损失、外部写入、费用或权限变化时，说明影响并询问缺少的决定。
