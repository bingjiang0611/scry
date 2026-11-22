# 性能优化交接（2026-10-22）

这轮工作从 [静态代码审查](review.md) 开始。审查本身没有测速，测量结论以各批报告为准。

| 批次 | 主题 | 验证报告 |
|---|---|---|
| A | 进程采集、状态存储读写、后台轮询 | [A](reports/A.md) |
| B | 启动归档扫描、重复读取归档 | [B](reports/B.md) |
| C | 工作区 diff 只读路径 | [C](reports/C.md) |
| D | 会话正文渲染 | [D](reports/D.md) |
| E | 远程 trace 增量协议 | [E](reports/E.md) |
| F | iOS 状态观察粒度 | [F](reports/F.md) · [F2](reports/F2.md) |

验证状态见 [STATUS.md](STATUS.md)。分支整合、迁移到重写后的 main 及其复验分别见[整合报告](reports/integration.md)和[移植验证](reports/port.md)。原分工与任务书留在 [Git 历史](https://github.com/bingjiang0611/scry/tree/3f4afcab2b2f756aa253b2e6c680d3d483bec55a/docs/handoff/perf-2026-10-22)。
