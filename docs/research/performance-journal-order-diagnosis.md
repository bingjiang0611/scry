# 性能日志乱序与全量测试截止排查

基线：`f21b5b2`。环境：macOS arm64、Node 24.18.0。范围仅本地代码、临时目录及测试；没有读取或修改真实用户的 performance 日志，没有安装、发布、真实账号调用或放宽测试门禁。

## 结论与修复

`PerformanceJournal.rotate()` 原来直接使用当前毫秒时间加随机 UUID 后缀命名。reader 和清理器按文件名排序，因此：

- 同一毫秒多次轮转时，随机后缀决定顺序，而不是实际写入顺序。
- 系统时间回退后，新归档可能排到旧归档前。重启会丢失仅在内存中的顺序信息。
- 旧 `performance-3/2/1.jsonl` 按 mtime 转换文件名；mtime 相同时，同样丢失已知的 3→2→1 顺序。
- 影响不仅是报表显示：超过磁盘上限时，也可能误删较新的归档。

修复位于 `src/main/performance-journal.ts`，不在 reader 或测试里重新排序来掩盖问题：

1. 归档排序时间使用 `max(当前时间, 上次排序时间 + 1ms)`。
2. 启动时从已存在的普通/压缩归档恢复最高排序时间，包括崩溃后尚未压缩的文件；随后才允许轮转 active 文件。
3. 旧格式先按 3→2→1 原子改名。以剩余旧文件的最早 mtime 为起点，为各旧索引分配固定毫秒位置。迁移中断后，剩余文件的起点只可能变为更晚时间，索引位置也更晚，不会反超已迁移的旧文件。
4. gzip 仍在后台执行；JSONL schema、采集字段、真实 `recordedAt`、队列/文件/归档容量上限均不变。文件名时间是排序标记，不冒充实际采集时间。

新增工作只在打开日志时发生：一次异步目录列表，旧格式存在时最多三个文件的 stat/rename；不读取整份归档正文来恢复顺序。没有新增逐条记录 I/O、轮询或持久化第二份索引。

## 测试与反向证明

先添加回归，再运行旧实现：同毫秒/回拨/重启和旧格式相同 mtime 两项失败，保留 `/tmp/scry-journal-order-negative.log`。未修改或删除原有顺序断言。

新增场景覆盖：同毫秒连续轮转、时钟回退后重启、容量裁剪保留最新连续记录、未压缩归档与截断 active 的恢复、相同 mtime 的旧格式迁移、旧格式迁移中断后的恢复。另验证 `recordedAt` 仍是实际回退的时钟值，不用伪造采集时间让排序通过。

| 检查 | 结果 | 日志 |
|---|---|---|
| focused journal + report | 2 文件、25 测试通过 | `/tmp/scry-journal-order-focused-final.log` |
| `npm test` | 266 文件、3274 测试通过；原有 4 个按开关关闭的检查跳过；shell 通过 | `/tmp/scry-journal-order-full.log` |
| `npm run typecheck` | node/web 通过 | `/tmp/scry-journal-order-typecheck-final.log` |
| `npm run build` | 通过，未启动或安装 App | `/tmp/scry-journal-order-build.log` |
| `npm run performance:measure` | ratchet 通过；25 unchanged、2 pass、3 CPU instruction candidate missing；无 worse | `/tmp/scry-journal-order-performance/measure.json` |

## 全量 240 秒超时的证据边界

前次 `/tmp/scry-agent-switch-full-unit-current.log` 没有 Vitest 最终汇总，外层工具在 240 秒截止。截断前仍有测试通过，并非日志显示某个用例已经死锁。可解析的 92 个文件累计测试时间约 443.72 秒；原配置最多两个 worker，累计时间不等于墙钟时间。更早完整的一轮共耗时 225.50 秒，已经接近外层截止。

本次保持所有用例超时、断言、worker 数量和 workload 不变，仅给观察命令 600 秒的外层窗口。经仓库 timing lock 串行执行 `npm test`：

- Vitest 完整结束：219.45 秒；包括 shell 的外层墙钟时间：224.312 秒，退出码 0。
- 10 核机器，开始/结束 load1 分别为 12.70/17.59，`highLoad: true`。
- 这证明本次修订可以完整收敛，不是“放宽用例超时后通过”。高负载下这些耗时不能用来宣称性能提升。
- 没有前次运行的完整系统负载轨迹，不能精确归因前次变慢，也不宣称此前所有 Vitest/Provider 偶发超时已修复。

## 限制

已有的同毫秒随机后缀归档，若文件内容也没有可区分的顺序证据，无法可靠还原原始先后。此次不重命名已生成的 timestamped 历史，也不修改真实日志。新写入及旧 3/2/1 格式迁移的顺序已覆盖验证。

本次没有 UI/Provider/IPC 改动，不重跑发布安装 gate。日常 App 生效需要后续安装包含此修复的版本；真实账号和正式发布不属于本次排查。
