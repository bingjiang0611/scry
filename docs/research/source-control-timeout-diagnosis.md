# Git 集成测试超时诊断

## 结论与边界

已定位直接触发链：**多步真实 Git 流程 → 每条多操作用例仅经 ScProcess 就串行调用 55 / 78 / 60 次 Git → 启动阶段的耗时波动累加 → 超过 Vitest 默认 5 秒墙钟预算**。不是只有文件间并发才会触发；单文件定向运行也复现了超时。采样未发现单条 Git 卡住、非零退出、Node close 回调积压或 conversation 保护导致的阻塞。

这不是“重跑通过即修复”。诊断阶段未修改正式 timeout；后续依据上述调用次数和计时证据，将 `source control real temporary Git` 集成 suite 单独设为 15 秒，与仓库既有真实 Git 测试预算一致。没有改变默认 workers、生产 Git 命令时限、权限复验或断言，也未加入重试。当前全量结果见文末。启动之前的宿主调度、装载和安全检查成本仍未进一步分离，不能归因到某一个后台进程；没有停止其他任务或调整系统设置。

## 范围和方法

- 基线：`e2b93fa` 的 `git archive`，不含共享工作区的 remote WIP；目录 `/tmp/scry-timeout-rootcause-UciYgX`。
- macOS arm64，Node 24.18.0，Vitest 3.2.7，Apple Git 2.50.1 (Apple Git-155)，Git 自报 CPU 为 arm64。
- 仅在隔离副本给 `ScProcess.run()` 加计时：环境准备、同步 spawn、spawn/exit/close 回调、总耗时。同时启用 Git 自带 `GIT_TRACE2_EVENT`，按 PID 对齐 Git 入口/退出时间。
- 探针会增加日志开销，不把它当无探针性能基准；原始无探针全量超时早已存在。日志用于定位耗时分布，不用于降低验收要求。
- 原始数据和探针 patch 保留在该目录的 `diagnostics/`；诊断后源码已恢复，与基线 `process.ts` 逐字节一致。

## 结果

| 试验 | 结果 | 证据 |
| --- | --- | --- |
| 默认 5 秒，定向原来失败的 3 条用例 | 1 超时、2 通过、24 条因 `-t` 未运行 | `alone-vitest.log` / `alone.jsonl` / `alone-summary.json`；192 次 ScProcess 调用全为退出码 0，最长 463 ms |
| 同次调用耗时分解 | 总计 9805 ms；Git Trace2 覆盖阶段 1425 ms | 约 85% 时间在 Git 自身运行阶段之外；环境准备合计 16 ms、同步 spawn 131 ms、close 等待 6 ms |
| 首条超时用例 | 54 次调用已花 4528 ms，尚未完成整条测试 | 同一流程正常完成需要 55 次调用；另有 fixture 的直接 Git 调用、持久化和断言耗时 |
| 临时诊断时限 15 秒，取得完整流程 | 3 通过、24 条未运行；193 次调用全为退出码 0 | `complete.jsonl` / `complete-summary.json`；三条用例实际均低于 5 秒，因此不能把本次通过归因于放宽时限，反而体现耗时波动 |
| 默认 5 秒，进一步对齐首次 Git Trace2 事件 | 单条用例通过；55 次调用 | `boundaries-summary.json`：Git 入口之前合计 1352 ms，Git 运行阶段 109 ms，退出至 Node 回调 7 ms；主要等待确实在 Git 入口前 |
| Apple shim 与直接 Xcode Git 交错对照，各 20 次 `--version` | 版本完全相同；中位耗时约 37.5 / 29.8 ms | `git-launch-ab.json`；直接调用也有明显启动成本，不能只怪 `/usr/bin/git` shim |

失败命令：

```sh
SCRY_SC_DIAGNOSTICS="$PWD/diagnostics/alone.jsonl" npm run test:unit -- \
  src/main/source-control/service.test.ts \
  -t 'preserves the existing index|uses the push endpoint|rechecks PR account'
```

其中 `SCRY_SC_DIAGNOSTICS` **仅为保存的诊断 patch 所识别**，不是产品配置。完整采样那次额外传入 `--testTimeout=15000`，仅用于诊断，不作为正式门禁通过的证据。该诊断试验没有新增 skip、重试、修改原断言或提交测试时限变化；后续正式 suite 的 15 秒预算与理由另记于文末。

宿主同期观察到 10 个逻辑 CPU、load average 13.32 / 17.11 / 22.77、约 18.9 GiB swap 使用（sysctl 原始值 19347.19M）。它们支持“环境有压力”，但不足以证明某项资源或某个进程是具体原因。后续若要求消除这类门禁波动，应在可控宿主上测启动长尾，再为真实 Git 集成测试制定独立预算；不要为了省进程数删除执行前权限/指纹复验。

## 同轮测试 Provider 的真实执行验证

本次另建包含当时工作区 WIP 的源码副本：

`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-current-app-imxm4xma`

`verification-source.json` 保存基线、33 个覆盖文件及最终构建 hash；`verification-final.log` 保存类型检查、构建和 IPC 成功输出，`verification-restart-receipts.log` 保存补齐重启前后入口收据严格比较后的最终构建/IPC 输出。该副本不含上述计时探针。

真实 Electron 保持隐藏，使用生产 preload/main IPC、隔离 HOME/userData/workspace 和原有测试 Provider。除原来的 6 个拒绝场景、3 个正对照与启动恢复失败阻断外，新增核对：

- 测试 Provider 确实写入临时工作区 `remote-first.txt`，核对文件内容，而不是只接受 Write 事件。
- 磁盘 archive 明确为 `completed`；生产历史 IPC 与磁盘记录均包含同一 run/Provider turn、原始输入、assistant 正文、Write 工具事件及成功 result，且没有失败/中断提示。
- App 退出后用相同隔离 userData 重启，再从生产 IPC 和磁盘回读同一轮，仍与实际文件一致；Provider 调用数没有增加，不是重发后生成的结果。
- 负对照：只在副本中去掉实际 `writeFile()`，保留模型、Write、成功 result 和归档事件，检查因缺少真实文件而失败。恢复后重新类型检查、构建和完整 IPC smoke 通过。

首轮新增断言失败来自测试误把 `LoadedSessionTurn` 当作 archive，读取不存在的 `status` 字段。按 `src/shared/session-history.ts` 与 `restoreTraceArchiveTurn()` 的合同修正：archive 保留严格 `status === completed` 检查，历史投影核对 `done/error/errorHint` 及成功 result；没有把 done 当作成功的唯一证据。

这是当时实际 App 执行/持久化链路配合测试 Provider 的验证，不是手工点击 UI、真实账号、远端/手机或已安装发行包。后续 A→B→A 的生产 UI/IPC 验收见 [统一会话计划第 8 节](provider-handoff-technical-plan.md#8-生产入口与隔离桌面验收2026-10-16)。测试子进程与临时用户数据已清理，两个源码副本和诊断资料保留。

## 后续预算修正与当前结果（2026-10-16）

- 仅修改 `src/main/source-control/service.test.ts` 的真实 Git suite 为 `{ timeout: 15_000 }`。原因是单用例串行 55–78 次实际 Git 启动，5 秒单位测试预算与真实集成流程不匹配；不是因为某条失败断言需要跳过。
- 当前源码 `npm test`：**254 文件通过、3 跳过；3193 测试通过、3 跳过；shell PASS**。未改变生产 `ScProcess`、信任复验、默认并发或增加自动重试。早先失败保留为诊断证据，不由此宣称 OS 启动长尾根因解决。
- 当前完整 `test:renderer:ui`、`check:cli-release`（32 文件 / 586 测试）及无发布凭据的 `pack:artifact` 最终通过。开发 artifact 没有正式签名、公证或安装。
- 全量 unit/首轮 UI 日志：`/Users/baobingjiang/.pi/agent/sessions/--Users-baobingjiang-IdeaProjects-vibecoding-scry--/sol-pi/01a13b2e-413e-714c-92ef-a38e81c32f5c/evidence-preserving-reducer/objects/43/43d9a67af99a6eddde4be967238cba1531c31c993c517721e5a5870b26449580.txt`。
- 最终 UI/CLI/artifact 日志：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-7de9e98b4acfcb81.log`。首轮 UI cache fixture 有一次未定位的泛化执行异常；补充异常透传后定向与完整运行通过，不把它算作 Git 超时或已修复问题。
- 若还需消除宿主启动长尾，由维护者安排可控负载的宿主测量，继续分离调度/装载/安全检查阶段；不删除执行前权限或 fingerprint 校验来降低进程次数。
