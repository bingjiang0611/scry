# 任务队列

协议见 [README.md](README.md)，并发规则见其 §1a。每个执行方只做「执行方」列分给自己的任务，按表内顺序做；某项受阻就写清证据并跳到自己的下一项。状态写在各自报告的第一行（取值：进行中 / 待核验 / 需修改 / 受阻 / 通过），不改本表。

- 执行方 A：真机验证（W1、W6，以及 W2b：W2 剩余真机项）。独占 `/Applications` 安装、日常 App、iPhone，以及会中断全机的注销与重启。
- 执行方 B：P5（W3、W2 代码已通过），现做 W7（Antigravity）。
- 执行方 C：P4（先 W4，再 W5）。

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

三个执行方可同时开工。W1 是所有合并的门槛，但不阻止 B、C 开发；B、C 的真机测量与长跑按 README §1a 的测量互斥规则错开 A。

**B 与 C 的交界**：两边都可能改 `src/daemon/host-process.ts` 的启动顺序（B：daemon 自报配置与 `launchedBy`；C：W5 的影子写挂点）。改动尽量小、各自加在独立函数里，推送前先合并对方的最新提交。

**不在队列里（维护者已定的顺序）**：P5 第 2 步（命令行配对）、S3（删除进程内路径）、P4-2 起的各段、P6（含 P6-0 探针，排在 P4 之后，见 [P6-multi-agent-plan](../P6-multi-agent-plan.md) §D）。W1 通过后由核验方补任务单。

**MCP 参数与凭据**：W6 对应的修复已推送；`src/main/providers/private-mcp-config.ts` 与各 Provider 构造 MCP 参数、历史检索凭据的代码，改动前先读该修复的提交说明，不要把密钥重新放回命令行参数。
