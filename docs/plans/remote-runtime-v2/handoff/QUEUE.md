# 任务队列

协议见 [README.md](README.md)，并发规则见其 §1a。每个执行方只做「执行方」列分给自己的任务，按表内顺序做；某项受阻就写清证据并跳到自己的下一项。状态写在各自报告的第一行（取值：进行中 / 待核验 / 需修改 / 受阻 / 通过），不改本表。

- 执行方 A：真机验证（W1 已通过附条件、W6 已通过；W2b 只剩注销与 FileVault，等维护者约时间），W10 已通过；W12 中继部署已通过；W13、W14（P5-8）已通过；现做 W17 真机验收（W17.md §3）；之后是最后的停机复验。W2b 的注销与 FileVault 两项按维护者 2026-11-21 的决定，挪到最后，与 S3 前的整体复验合并成一次停机。独占 `/Applications` 安装、日常 App、iPhone，以及会中断全机的注销与重启。
- 执行方 B：P5（W2、W3、W11 已通过）；Antigravity（W7、W8 已通过）；W15、W17 已通过；W17 小修已由核验方完成。维护者 2026-11-21 起：剩余代码由核验方直接收尾，B、C 不再写代码。
- 执行方 C：P4（W4、W5、W9、W16 已通过；W16 评审问题由核验方修复）。维护者 2026-11-21 起不再写代码。

| # | 任务 | 执行方 | 依赖 | 合并门槛（合入 main 之前） | 说明 |
|---|---|---|---|---|---|
| W1 | macOS 真机基线：默认 daemon、分支现状、iOS 修复 | A | — | — | [tasks/W1-mac-baseline.md](tasks/W1-mac-baseline.md) |
| W2 | P5 第 1 步：登录时启动（P5-1 至 P5-4） | B | — | W1 通过 | [tasks/W2-p5-login-start.md](tasks/W2-p5-login-start.md) |
| W2b | P5 第 1 步剩余真机项（AX 确认框、注销再登录、签名包权限、FileVault） | A | W2 代码已通过 | W2 合并前必须完成 | [tasks/W2b-p5-login-start-real-machine.md](tasks/W2b-p5-login-start-real-machine.md) |
| W3 | P5-5a 剩余：grant 读取端兼容 `approvedVia` | B | — | 至少早于 P5-7 一个发布 | [tasks/W3-p5-grant-reader.md](tasks/W3-p5-grant-reader.md) |
| W4 | P4-0：决策器、表结构、迁移执行器、EventSink | C | — | W1 通过 | [tasks/W4-p4-0.md](tasks/W4-p4-0.md) |
| W5 | P4-1：影子写、增量导入、daemon 模式 CI、首轮测量 | C | W4 | W1 通过 | [tasks/W5-p4-1.md](tasks/W5-p4-1.md) |
| W6 | MCP 密钥不进 Provider 命令行：macOS 真机核对 | A | 修复已推送（`d29a6cf3`…`0bda19ec`），已开放 | W1 通过 | [tasks/W6-argv-secrets.md](tasks/W6-argv-secrets.md) |
| W7 | Antigravity：真机探测（A0）与设计定稿 | B | — | 不含产品代码；A1 起另补任务单 | [tasks/W7-antigravity-a0.md](tasks/W7-antigravity-a0.md) |
| W8 | Antigravity 实现（A0.5–A7）与 macOS 真机验收（A9） | B | W7 通过 | 真机验收通过前默认隐藏（实验开关） | [tasks/W8-antigravity-impl.md](tasks/W8-antigravity-impl.md) |
| W9 | P4-2 实现（`on` 开关后）与 S3 准备（不删代码） | C | W5 通过 | P4-2：W1 通过；S3 删除另补任务单 | [tasks/W9-p4-2-and-s3-prep.md](tasks/W9-p4-2-and-s3-prep.md) |
| W10 | 默认 daemon 下恢复 iPhone 的「其他主机」路由、修正误导文案；中继僵死 leg 只分析 | A | — | **下一次合入 main 的门槛**（`main` 已含默认 daemon） | [tasks/W10-daemon-execution-targets.md](tasks/W10-daemon-execution-targets.md) |
| W11 | P5 第 2 步：命令行批准新设备（P5-5b、P5-5、P5-6、P5-7） | B | W8 通过 | 批准入口与 `approvedVia` 写入放在实验开关后，含 W3 的版本发布后再打开；P5-8 真机验收另由 A 做 | [tasks/W11-p5-step2-host-cli.md](tasks/W11-p5-step2-host-cli.md) |
| W12 | 部署 W10 的中继修复到线上（维护者已授权） | A | W10 通过 | 失败按任务单回滚 | [tasks/W12-relay-deploy.md](tasks/W12-relay-deploy.md) |
| W13 | 默认路径：MCP 可执行文件指纹按文件状态缓存（每次运行少算 3 次 SHA-256） | A | — | 安全语义不变，有测试证明 | [tasks/W13-mcp-fingerprint-cache.md](tasks/W13-mcp-fingerprint-cache.md) |
| W14 | P5-8：命令行批准新设备的真机验收 | A | W11 通过、W13 推送 | P5 第 2 步合并前必须完成 | [tasks/W14-p5-8-real-machine.md](tasks/W14-p5-8-real-machine.md) |
| W15 | S3 第一步：开发构建与测试实例默认走后台服务（不删代码） | B | — | `SCRY_HOST_DAEMON=0` 保留一个发布版本 | [tasks/W15-s3-step1-default-daemon.md](tasks/W15-s3-step1-default-daemon.md) |
| W16 | P4-2 收尾两项 + P4-3 本机订阅（只在 on 下生效） | C | W9 通过 | 默认路径零行为变化 | [tasks/W16-p4-3-local-subscribe.md](tasks/W16-p4-3-local-subscribe.md) |
| W17 | 默认 daemon 下恢复远程桌面的会话操作与工作区操作（线上回归） | B | W15 返修 | 下一次合入 main 的门槛 | [tasks/W17-daemon-remote-session-actions.md](tasks/W17-daemon-remote-session-actions.md) |

三个执行方可同时开工。W1 是所有合并的门槛（2026-11-20 已通过，附条件：W10），但不阻止 B、C 开发；B、C 的真机测量与长跑按 README §1a 的测量互斥规则错开 A。

**B 与 C 的交界**：两边都可能改 `src/daemon/host-process.ts` 的启动顺序（B：daemon 自报配置与 `launchedBy`；C：W5 的影子写挂点）。改动尽量小、各自加在独立函数里，推送前先合并对方的最新提交。

**不在队列里（维护者已定的顺序）**：S3 第 2–5 步（删除进程内路径，下一个发布版本）、P4-4 起的各段、P6（含 P6-0 探针，排在 P4 之后，见 [P6-multi-agent-plan](../P6-multi-agent-plan.md) §D）。W1 通过后由核验方补任务单。

**MCP 参数与凭据**：W6 对应的修复已推送；`src/main/providers/private-mcp-config.ts` 与各 Provider 构造 MCP 参数、历史检索凭据的代码，改动前先读该修复的提交说明，不要把密钥重新放回命令行参数。

**执行方报告的缺陷（2026-11-20）**：`src/daemon/host-process.ts` 的 `dispose()` 未调用 `providerRegistry.dispose()`（见 [reports/W6-review.md](reports/W6-review.md)），由执行方 C 随 W5 下一轮修复（该文件需先拆分）。
| W18 | 一次做完：S3 收尾 → P4-4 → P4-5a（含 iOS 执行端通知）→ P4-5b → P4-6 | 维护者本机单执行方 | S3 已合入分支（`84ef9881`） | 每阶段阶段门通过；真机项叫维护者 | [tasks/W18-finish-s3-p4-p5.md](tasks/W18-finish-s3-p4-p5.md) |
| W19 | W18 核验返修（6 项应修 + 10 项小问题）+ iPhone 与 mac2/mac3 真机验收 | 维护者本机单执行方 | W18（`9f874ca1`） | A 组与 C 组完成才能合入 main | [tasks/W19-w18-review-fixes.md](tasks/W19-w18-review-fixes.md) |
| W22 | 分析页：LLM 性能与成本合并为一页，修正统计口径与空值 | 维护者本机独立执行方 | main | 推 `feat/analytics-merge`；不碰 W20 文件 | [tasks/W22-analytics-merge.md](tasks/W22-analytics-merge.md) |
