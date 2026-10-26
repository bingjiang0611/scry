## V3 与手验核验意见（审查方，2026-10-25）

**结论：V3 已核验；A 的真实 Provider 手验接受；OpenCode/Qoder 180 秒宽限按现有行为接受，不算丢数据。**

### V3

- 复跑证实：在 `17a5333` 的独立 worktree 上 `npx vitest run src/cli/hook-skip-recency.test.ts`，1 个文件 7 个测试全部失败，与报告一致。
- 修复后（`ae6db68`，Linux/Node 22）：`src/cli/hook-skip-recency.test.ts` 加 `src/core/turn-recorder` 共 25 个文件 378/378 通过；`npm run typecheck` 通过。
- 代码审读：`recentCount` 按最近 24 小时计算（含边界）；无法解析或晚于当前时间的时间戳按「近期」计，偏向告警，方向正确。doctor 的分级是：近期有跳过记为 fail/error 退出 5；只有旧记录记为 warn，退出码不变。status 与 support-bundle 同步输出 `recentCount`。没有改动 hook 脚本，**升级 CLI 即可生效，不需要 repair**。

### 真实 Provider 手验

- 范围接受：A-1 到 A-4 在 OpenCode 1.18.31、Qoder 1.1.73、Codex 0.164.0 上各跑一遍，并且用的是隔离 worktree（`a21110c`）、临时 HOME 和临时 workspace，没有写入日常 `.scry`，进程逐 PID 重验后停止，临时认证已清理，符合 CLAUDE.md 的探针纪律。
- 结果与预期一致：A-2 出现 `cli_not_executable` 时 Provider 正常继续；A-3 缺开始事件后 orphan 与 `missingStartTerminals` 各加一；A-4 的 invalid_config 让 doctor 报 error 并退出 3。最终每个 Provider 各 2 条 record、`droppedEvents=0`。
- 驱动脚本多发了一轮 invalid_config（Codex、Qoder），以及 OpenCode 首次认证失败，这两件事都原样保留并写进报告，做法正确。
- 局限与报告一致：这次验证的是 `a21110c`，不能代表 B/V3 在真实 Provider 上的表现；没有覆盖 curl 快路径、实际工具调用或掉电场景。A-5（Codex 子目录启动）留给 C3。

### OpenCode/Qoder：终态后 180 秒才落盘

我读了代码（`recorder.ts:141-143`、`2862`、`3000-3013`、`3340-3345`）：

- 原因：这两个 Provider 的 Stop 不带 turn id，也不带时间戳，因此每轮都开启「陈旧终态保护」。开始后 30 秒内到达的 Stop 先存成 lifecycle 事件（`open.json` 走同步写），状态置为 closing，然后等待 180 秒。保护的目的是防止上一轮迟到的 Stop 把新一轮提前结束。手验里的轮次很短，正好全部命中这条路径。
- 不丢数据：宽限期内用户发下一条 prompt，这一轮会立刻按 `completed` 提交（`recorder.ts:2903`）；没有下一条 prompt 时，daemon 在仍有 open turn 时以 1–15 秒退避轮询 recover，而且不会空闲退出，所以宽限结束后十几秒内会自动落盘。手验里看到要手动 recover，是因为没有 daemon 在跑（报告写明未走 daemon 路径）。
- 剩余风险：没有 daemon 时（例如机器没有 curl，又没有被拉起的 daemon），这一轮要等到下一次 hook 或 scry 命令才会提交。数据在磁盘上不会丢，只是上传会延迟。
- 决定：按现有行为接受，不在 A 范围内修改。宽限期的长短属于正确性上的取舍（缩短会增加把新一轮提前结束的风险），需要先有数据。我把它列为后续观察项：C1 处理回退链路时顺带确认「无 daemon 时谁来触发宽限后的 recover」；若用户的上传时效有硬要求，再单独立项。

### 状态

H2 备注更新为「真实 Provider 已验收（a21110c）；V3 已核验」。A 批次全部关闭。下一步是 VB1 + VB2。
