# CI 验证接线

PR 治理、维护与合入条件见 [PR 工作流运行手册](pr-workflow.md)。本页记录具体工作流及其验证范围。

| 文件 | 行为 | 门禁身份 |
| --- | --- | --- |
| `ci.yml` | changes 后并行执行 Node/typecheck、`check:harness-bindings`、shell/App build、4 片 coverage（合并报告）、Node 20/22/24 CLI 编译与运行/包校验、3 片 macOS 15 renderer UI（第 2 片打包，第 3 片共享一次新鲜 App 构建）、Linux App / pacman 检查；桌面 typecheck 仅在 node 执行，独立 CLI 发布命令仍包含它；main push 同组只留最新 run 并全量验证 | `Check` 汇总全部 jobs（含 changes 与 `packaged-linux`）；纯文档时全部跳过，`desktop=false` 时仅 macOS 分片跳过，其余失败、取消、缺失或意外跳过均拒绝 |
| `performance.yml` | changes 后并行执行 compare 与 native；Node 在同一 runner 按 A1/B1…A20/B20 交替采样并记录阶段耗时，counter 随后执行；native 顺序、各场景负载与预算不变 | `Performance Check` 汇总 changes 与两个测量 jobs；纯文档时全部跳过，`desktop=false` 时 native 跳过，`node_performance=false` 时 compare 跳过；评论明确标明未测量，不计为测量通过；评论不属于正确性门禁 |
| `validation-changes.yml` | CI/Performance 共用的只读 diff；仅 README.md 与 docs/**/*.md 跳过全部验证；只改测试、Agent 指导、PR/Issue 模板、名单或 apps/ios 时 `desktop=false`；仅 apps/ios 加文档时同时 `node_performance=false`，其余 Ubuntu 验证照跑；混合任何非文档、非 iOS 输入均保留 Node 性能测量；无法读取 diff 时失败，手动 dispatch 与 main push 总是全验 | 不在触发器上过滤 required workflow，三个原有必需检查名不变 |
| `.github/actions/cache-electron/action.yml` | 仅 Electron runtime jobs 使用；按 OS/架构/锁定 Electron 版本缓存 ZIP 与校验文件，原安装器继续校验 SHA256；不缓存 node_modules、App 或编译输出，不使用宽泛 restore prefix | 不替代运行时校验，首次下载失败仍失败 |
| `remote-g0.yml` | 每个 PR 发出检查，仅 remote/iOS/工作流的非 README 改动并行运行 transport 与 ios（同一 runner、共享 DerivedData/一份 Swift 包源码缓存，依次编译 ScryRemoteG0、ScryRemote；普通 PR 共用 4 个 macOS slot，remote/iOS 变化时最多 6 个 job 竞争 GitHub Free 的 5 个 slot，可能有一个排队）；transport 限 20 分钟、ios 限 30 分钟 | `Remote Check` 要求两项全部成功，或 changes 明确判定无影响且两项全部跳过；检测失败、结果缺失或任一项取消均拒绝 |
| `pr-vouch.yml` | 使用默认分支的 VOUCHED 配置，自动同步 `vouch:*` | 仅上下文，不是准入或门禁 |
| `pr-size.yml` | 基础仓库代码读取 PR git diff，不运行 PR 内容；混合 PR 排除测试行 | 仅上下文，不按大小拒绝 PR |

Node 测量豁免以当前 harness 不读取 `apps/ios` 为前提；若未来加入该目录的运行时或生成输入，须先收紧分流范围并恢复相关测量。该豁免不代表手机端性能验收通过。

size 采用上游阈值 XS <10、S <30、M <100、L <500、XL <1000、XXL ≥1000；忽略空白改动，纯测试 PR 仍计算测试行。二进制改动没有行数，这个标签不表示风险。移植补充了标签定义任务的 push/手动触发入口、PR retarget 的 edited 事件，适配 Scry fixture 路径，并禁止 git 外部 diff/textconv。

`pull_request_target` 标签任务只运行可信 workflow/Action，以 PR 为数据，不安装 PR 依赖、不构建 PR 代码、不运行 PR 脚本。不得在这些有写权限的 job 中切到 PR head 执行代码。PR 构建/测试 job 保持只读 token；`performance.yml` 的独立 `comment` job 仅对同仓库 PR 使用 `actions: read` 和 `pull-requests: write`，读取被动报告 artifact 并发布评论，不 checkout、构建或执行 PR 代码。fork 仅保留只读 summary/artifact。不添加 Provider、签名或生产凭据。

`performance-ratchet.yml` 用 `GITHUB_TOKEN` 创建的 PR 通常不会触发后续 PR Actions。当前保持原行为：维护者在获授权后用个人身份关闭再重新打开该 PR，以触发正常检查，并核实 head 与检查结果；不要免检合并。若频繁产生此类 PR，再单独授权最小权限 GitHub App token，不能为了自动化添加宽权限 PAT。
