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
| 交付前全局验证 | 完成，2 项 not-run、1 项失败 | `见下` | 7 项通过；security smoke 失败但与本批无关（未在起点复跑） |

## 每个任务的证据

- [B2-F1 取消排队请求不误断连接](status/b2-f1.md)
- [B2-F2 写操作 notSent 判定](status/b2-f2.md)
- [B2-F3 长轮询 tick](status/b2-f3.md)
- [B2-F4 预热范围](status/b2-f4.md)
- [B2-S1 trace 读取频率](status/b2-s1.md)
- [B2-P3a 宿主组装层](status/b2-p3a.md)
- [B2-P3b daemon 与本机通道](status/b2-p3b.md)
- [B2-D 本机运行管线设计](P3b-local-runtime-design.md)

## 交付前全局验证

分支 `claude/remote-runtime-v2`，macOS arm64 / Node v24.18.0，起点 `a0b2355b`。

| 命令 | 结果 | 证据 |
|---|---|---|
| `npx vitest run src/main src/renderer/components scripts/performance-counters` | 通过 | 348 files 通过 / 3 skipped，3435 tests 通过 / 3 skipped |
| `npm run typecheck` | 通过 | exit 0 |
| `npm run build` | 通过 | exit 0 |
| `npm run build:cli` | 通过 | exit 0 |
| `npm run performance:inventory` | 通过 | exit 0 |
| `npm run performance:measure -- --compare a0b2355` | 通过 | `Ratchet: passed`；最大偏差是 `trace.r4-cell/other.stringify-bytes` −20 B（−0.0%），无 `worse` |
| `npm run test:desktop-remote` | 通过 | exit 0；4 个默认场景 + session-opening / session-parity / composer-history / remote-settings / session-lifecycle 全绿 |
| `node scripts/electron-security-smoke.mjs` | **失败（与本批改动无关，未定位到根因）** | 断言 `gitBoundary.result.collectedAt` 为 `undefined`（`scripts/electron-security-surfaces.mjs:135`）。本批未改动该路径涉及的任何文件（`src/main/source-control`、`src/main/bootstrap/agent-runtime-ipc.ts`、`src/main/git*.ts`、两个 security 脚本的 diff 均为空），因此判断为既有/环境问题，但**没有**在分支起点复跑来证明，记为未验证 |
| `npm run pack:artifact` | not-run | 本批没有改打包配置与 resource allowlist（daemon 未打包，见 B2-P3b），触发条件不成立 |
| `swift test --package-path experiments/remote-g0/swift --filter 'WireTests\|LaneHandlerTests'` | not-run | 本机只有 Command Line Tools，缺 XCTest（Batch 1 已记录同一阻塞） |
| `git diff --check` | 通过 | 无输出，exit 0 |
| Linux 目标机检查 | not-run | 无 Linux 目标机 |
