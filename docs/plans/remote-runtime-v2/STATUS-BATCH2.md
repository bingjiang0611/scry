# Batch 2 执行状态（执行 agent 维护）

分支 `claude/remote-runtime-v2`，起点 `a0b2355b`。任务书：[EXECUTION-BATCH2.md](EXECUTION-BATCH2.md)。每完成一个任务更新一次并 push。

## 总览

| 任务 | 状态 | 提交 | 备注 |
|---|---|---|---|
| B2-F1 取消排队请求不误断连接 | 完成 | `2d6b0f5` | 只 drop 自己交换的 channel；回归测试在修复前失败过 |
| B2-F2 写操作 notSent 判定 | 完成 | `7f5f111` | 写回调报错按已写出处理；回归测试在修复前失败过（同一 fork 发 3 次） |
| B2-F3 长轮询 tick | 完成 | `f1527c5` | tick 恢复 1000 ms + Mac 变更通知；回归测试在修复前失败过（79 次 vs 上限 25） |
| B2-F4 预热范围 | 完成 | `bf79591` | 只有声明 `catalogWarmPool` 的 adapter 预热（当前 Pi）；Claude 不预热 |
| B2-S1 trace 读取频率测量 | 完成 | `a334c20`、`77dd703` | 基线 40/min，优化前 240/min（6.0×），合并后 60/min（1.5×）；测量与优化分开提交 |
| B2-P3a 宿主组装层 | 完成 | `3d48307` | `src/host-runtime/createHostRuntime`；值导入图断言无 `electron`（195 个文件） |
| B2-P3b daemon 与本机通道 | **未完成**（本机通道已完成） | `见 status` | 本机 unix socket mTLS 已实现并验证；daemon 进程/supervisor/影子模式被运行管线依赖阻塞，见[说明](status/b2-p3b.md) |
| B2-D 本机运行管线设计 | 完成 | `148d59d` | `P3b-local-runtime-design.md`：迁移边界、SQLite 归属、trace 推送、recorder、终端/SCM、auth 锁、步骤与回滚 |
| 交付前全局验证 | 待办 | — | |

## 每个任务的证据

- [B2-F1 取消排队请求不误断连接](status/b2-f1.md)
- [B2-F2 写操作 notSent 判定](status/b2-f2.md)
- [B2-F3 长轮询 tick](status/b2-f3.md)
- [B2-F4 预热范围](status/b2-f4.md)
- [B2-S1 trace 读取频率](status/b2-s1.md)
- [B2-P3a 宿主组装层](status/b2-p3a.md)
- [B2-P3b daemon 与本机通道](status/b2-p3b.md)
- [B2-D 本机运行管线设计](P3b-local-runtime-design.md)
