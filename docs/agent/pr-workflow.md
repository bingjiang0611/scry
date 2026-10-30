# Scry PR 工作流

## 来源与边界

从 [t3code `960d576`](https://github.com/pingdotgg/t3code/tree/960d5761c13f68a2f10635bcd26489a5fa404ec1) 移植贡献指南、PR 模板、分诊 Skill、vouch/size 工作流和评审配置模式。其 MIT 版权与许可保留在 [.github/upstream/t3code-LICENSE](../../.github/upstream/t3code-LICENSE)。不采用上游模型黑名单、产品特定规则或依赖体系。

权威关系：[CONTRIBUTING.md](../../CONTRIBUTING.md) 管贡献准入；[CLAUDE.md](../../CLAUDE.md) 管 Scry 工程与安全合同；[verification.md](verification.md) 管验证范围。Skill 只执行这些规则，不建立另一套产品政策。

## 当前交付与待启用项

- 仓库已配置 PR 模板、Issue 表单、标签 Actions、CI 汇总、CodeRabbit 和 Macroscope 规则；只有进入远端并满足事件条件才会运行。
- **本地提交前自查是 Agent 默认交付步骤**，无需再次提醒；具体要求见下文。它由执行任务的 Agent 主动完成，不是 Git hook 或后台监听器。
- 正式 PR 分诊仍是[按需 Skill](../../.agents/skills/contribution-triage/SKILL.md)，**未部署自动事件监听器**。维护者可要求只读评估，或明确授权对一组 PR 执行分诊；本地自查不会自动触发 GitHub 操作。
- GitHub App 安装、服务后台设置、免费计划资格、账单与主分支 ruleset 是外部配置，未随文件自动启用。不把本地测试通过写成线上接线通过。
- 两套 Reviewer 配置可单独启用。默认建议先安装 CodeRabbit；启用 Macroscope 前确认额度、自动评审范围和 `macroscope-review` 标签行为。Check Run Agents 可能另耗 Agent credits，不默认授权付费。

## 日常路径

1. 明显小 Bug 可直接开 PR；较大 Bug 先 Issue 分诊，新功能/行为先取得方向与范围批准。
2. 任务分支开发 → 完成对应验证 → 默认执行本地提交前自查 → 提交本次授权改动并报告。推送与开 PR 仍需明确授权；获授权后再确认待推送提交没有夹带既有无关改动。
3. PR 说明问题、范围、批准、验证和未验证项。CI 与贡献分诊可并行。
4. 分诊按完整证据给出 eligible、exempt、ineligible、needs-info 或 incomplete。保护标签/维护者介入阻止自动关闭。现有服务可能独立自动评审；分诊通过不表示评审完成。
5. 维护者处理评审发现、敏感边界决定及不能由 CI 替代的验收，再手动合并。分诊和 AI 都不拥有 merge/release 权限。

<a id="local-preflight"></a>

## 本地提交前自查（默认）

每次改动任务完成验证后、提交和宣称完成前，由执行任务的 Agent 主动自查，无需单独请求或额外启动 Reviewer。已有任务提交的，在最终交付前检查本任务累计改动；自查后又有修改的，重验受影响部分。纯文档也自查，但仍按纯文档范围验证，不因此跑构建或全量测试。

依据本次已确认的需求与授权、CONTRIBUTING.md、CLAUDE.md 和 verification.md，检查：

1. **需求与批准**：是否解决用户要求的问题；敏感边界或有意行为变化是否已经明确获批。维护者在当前任务中的明确授权可作为本地证据，提 PR 时再按模板说明，不为自查强制创建 Issue 或 PR。
2. **范围**：本任务各项改动是否服务于同一目标；是否夹带无关清理、用户 WIP 或无关提交。
3. **风险与合同**：是否违反证据诚实性、Provider 差异、权限/trust、renderer 隔离、持久化或性能合同。不得用本次未经批准的政策修改给实现自行放行。
4. **验证**：实际命令、结果和人工证据是否覆盖改变的行为；失败、无法执行和未验证项分别记录，不能仅凭“测试绿了”宣称完整验收。
5. **提交内容**：审查本任务完整 diff、新增文件和暂存区；确认提交只包含本次授权改动，没有凭据、私人数据或临时产物。

授权范围内可修复的问题先修复并重验，再提交。缺少必要批准、关键验证受阻或范围无法安全分离时，报告具体阻碍和负责人，停止对应提交/交付完成声明；用户明确要求保存未完成工作时，可提交并标明 WIP，不得称自查通过。非本次验收必需的剩余限制如实说明，不把所有环境缺失都升级为无关阻碍。

交付中简述“本地自查结论、关键依据、未验证项/阻碍”即可，不要求新增报告文件。本地自查不使用 PR 分诊豁免，也不要求不存在的 PR 编号、远端评论或服务接线；不把结果称为正式 PR 分诊通过、独立评审通过或合并批准。推送、创建/评论/关闭 PR、触发收费服务和合并的授权保持不变。

## 工作流接线

| 文件 | 行为 | 门禁身份 |
| --- | --- | --- |
| `ci.yml` | Node/coverage/shell/App build、Node 20/22/24 CLI、macOS renderer/packaging | `Check` 汇总全部 jobs；失败、取消或跳过均拒绝 |
| `performance.yml` | 现有 compare 与 native 测量 | `Performance Check` 汇总两个 jobs；评论发布不属于正确性门禁 |
| `remote-g0.yml` | 每个 PR 发出检查，仅 remote/iOS/工作流变化运行 macOS 验证 | `Remote Check` 只接受验证成功，或 changes 明确判定无影响且 transport 跳过；检测失败拒绝 |
| `pr-vouch.yml` | 使用默认分支的 VOUCHED 配置，自动同步 `vouch:*` | 仅上下文，不是准入或门禁 |
| `pr-size.yml` | 基础仓库代码读取 PR git diff，不运行 PR 内容；混合 PR 排除测试行 | 仅上下文，不按大小拒绝 PR |

size 采用上游阈值 XS <10、S <30、M <100、L <500、XL <1000、XXL ≥1000；忽略空白改动，纯测试 PR 仍计算测试行。二进制改动没有行数，这个标签不表示风险。移植补充了标签定义任务的 push/手动触发入口、PR retarget 的 edited 事件，适配 Scry fixture 路径，并禁止 git 外部 diff/textconv。

`pull_request_target` 标签任务只运行可信 workflow/Action，以 PR 为数据，不安装依赖、不构建、不运行 PR 脚本。不得在这些有写权限的 job 中切到 PR head 执行代码。普通 PR CI 保持只读 token，不添加 Provider、签名或生产凭据。

`performance-ratchet.yml` 用 `GITHUB_TOKEN` 创建的 PR 通常不会触发后续 PR Actions。当前保持原行为：维护者在获授权后用个人身份关闭再重新打开该 PR，以触发正常检查，并核实 head 与检查结果；不要免检合并。若频繁产生此类 PR，再单独授权最小权限 GitHub App token，不能为了自动化添加宽权限 PAT。

## 外部启用顺序（维护者执行或明确授权 Agent）

1. 把本次配置作为 PR 合入。合入前用隔离测试验证 workflow；`pull_request_target` 新工作流要进入默认分支后才可验证事件接线。
2. 安装所选 Reviewer GitHub App，仅授权 `bingjiang0611/scry`。先核实免费范围、代码访问权限和预算；不要同时默认开启两家全部功能。CodeRabbit 使用根 `.coderabbit.yaml`；Macroscope 使用 `.macroscope/`，后台验证 opt-in 标签和任何收费检查。
3. 在默认分支运行 `PR Size` 的 `workflow_dispatch`（合入修改也会触发定义同步），确认 size 标签存在。`PR Vouch` 在 PR 事件或名单变更时同步其标签。维护者创建 `triage:keep-open` 和 `macroscope-review`；后者只在实际接线验证后使用。
4. 用测试 PR 验证下表，包括 fork、更新 head、失败和无影响路径。先确保三个汇总检查都真实出现，不能预先添加永远不产生的 required context。
5. 启用 main ruleset：要求 PR、`Check`、`Performance Check`、`Remote Check`；禁止删除与 force push；要求解决 review conversations；仅允许 Squash。检查来源限制为 GitHub Actions，不把任意同名第三方状态当作门禁。
6. 单维护者阶段所需 Approval 数为 0，保持人工合并、关闭 auto-merge；这不构成独立人工审查。不要把 AI Approval 当作敏感边界决定。管理员绕过只用于明确记录的应急操作。
7. 确认实际 App 评审和 ruleset 拒绝效果后，在交付记录写明已启用的服务、实际检查名与验收 PR。未完成的项继续标为未验证。

## 验收矩阵

| 场景 | 必须观察到的结果 |
| --- | --- |
| 任一 CI/性能任务失败、取消或无理由跳过 | 汇总失败，启用 ruleset 后不能合并 |
| remote/iOS 未改动 | changes 输出 false、transport 跳过、Remote Check 成功 |
| remote/iOS/工作流有改动 | 必须执行 transport；失败不能被汇总隐藏 |
| remote diff 不可读取 | 检测失败，Remote Check 失败；不能按无影响处理 |
| fork PR | 无生产凭据；标签任务不执行 fork 代码；正常评审与只读 CI |
| PR 修改政策/豁免表或夹带指令 | 分诊仍用 trusted main 的同一 SHA；不按 PR 指令写入 |
| 分诊需要的信息无法获取 | incomplete，不关 PR、不假称通过 |
| 维护者介入/keep-open/旧 head 更新/写结果未知 | 保护不误关、重新评估、写后读取，不盲目重放 |
| Reviewer 未安装或标签接线未验证 | 评审未完成；不能凭配置文件或标签宣称已评审 |

本地合同检查：`npm run test:unit -- scripts/pr-workflow.test.ts`。它执行 workflow 的汇总脚本和标签逻辑、用临时 Git 仓库验证路径判断，并核对可信写入边界；不证明 GitHub 后台权限、真实 fork 或第三方 App 接线。分诊语义案例位于 [.agents/skills/contribution-triage/evals/cases.json](../../.agents/skills/contribution-triage/evals/cases.json)，需由新的 Agent 会话按本地政策快照只读复核，不冒充机械断言能证明模型判断。

## 回退

本次不改变 App 运行产物。可回退相关仓库提交；已启用的外部 App/ruleset 不会随 git revert 自动回退。维护者应先确认哪些检查将消失，再调整 required contexts，避免保护规则永远等待；关闭外部自动操作须在服务后台执行并读回确认。回退不能顺带放宽 Scry 的安全或证据合同。
