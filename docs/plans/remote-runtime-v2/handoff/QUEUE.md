# 任务队列

协议见 [README.md](README.md)。按顺序领；某项受阻就写清证据并跳到下一项不依赖它的任务。执行方开始和结束时更新「状态」列并推送。

状态取值：未开始 / 进行中 / 待核验 / 需修改 / 受阻 / 通过。

| # | 任务 | 状态 | 依赖 | 合并门槛（合入 main 之前） | 说明 |
|---|---|---|---|---|---|
| W1 | macOS 真机基线：默认 daemon、分支现状、iOS 修复 | 未开始 | — | — | [tasks/W1-mac-baseline.md](tasks/W1-mac-baseline.md) |
| W2 | P5 第 1 步：登录时启动（P5-1 至 P5-4） | 未开始 | — | W1 通过 | [tasks/W2-p5-login-start.md](tasks/W2-p5-login-start.md) |
| W3 | P5-5a 剩余：grant 读取端兼容 `approvedVia` | 未开始 | — | 至少早于 P5-7 一个发布 | [tasks/W3-p5-grant-reader.md](tasks/W3-p5-grant-reader.md) |
| W4 | P4-0：决策器、表结构、迁移执行器、EventSink | 未开始 | — | W1 通过 | [tasks/W4-p4-0.md](tasks/W4-p4-0.md) |
| W5 | P4-1：影子写、增量导入、daemon 模式 CI、首轮测量 | 未开始 | W4 | W1 通过 | [tasks/W5-p4-1.md](tasks/W5-p4-1.md) |
| W6 | MCP 密钥不进 Provider 命令行：macOS 真机核对 | 未开放 | 核验方推送修复后开放 | W1 通过 | 核验方推送修复时补任务单 |

建议做法：W1 先做（它是所有合并门槛）；W1 中需要等待的环节（长跑、安装、设备）期间并行做 W3、W4。W2 与 W4/W5 可交替进行。

**不在队列里（维护者已定的顺序）**：P5 第 2 步（命令行配对）、S3（删除进程内路径）、P4-2 起的各段、P6（含 P6-0 探针，排在 P4 之后，见 [P6-multi-agent-plan](../P6-multi-agent-plan.md) §D）。W1 通过后由核验方补任务单。

**正在由核验方修改的文件，执行方暂不动**：`src/main/providers/codex.ts`、`claude.ts`、`qoder-launch.ts`、`opencode-server.ts`、`pi-run.ts` 中构造 MCP 参数与历史检索凭据的部分（W6 对应的修复）。其他部分可以改，冲突时以合并解决。
