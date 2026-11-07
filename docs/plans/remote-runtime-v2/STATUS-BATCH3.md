# Batch 3 状态

分支 `claude/remote-runtime-v2`。任务书：[EXECUTION-BATCH3.md](EXECUTION-BATCH3.md)；核验结论：[REVIEW-BATCH2.md](REVIEW-BATCH2.md)。
起点 `577995b`。

## 总览

| 任务 | 状态 | 提交 | 说明 |
|---|---|---|---|
| B3-F1 核验修复（F1-1/2/3） | 完成 | `见下` | [b3-f1-review](status/b3-f1-review.md)：跟随 run 首次发现即读、读取单飞、换 run 立即读；三项都先失败 |
| B3-F1 trace 尾沿补读 | 完成 | `见下` | [b3-f1](status/b3-f1.md)：尾沿 + 跟随 run 按窗口读；L1 仍 60/min；另加 security smoke 产物版本闸门 |
| B3-F2 Mac run 绑定发信号 | 完成 | `b95e47f` | [b3-f2](status/b3-f2.md) |
| B3-D 设计稿三处更正 | 完成 | `见下` | [b3-d](status/b3-d.md)：§7 凭据如实拆分、新增 §8.1 daemon 运行时、§11 删除共存版本项、§8 加进度表 |
| B3-M1 前置 db.ts 拆分（纯搬移） | 完成 | `见下` | [b3-m1-split](status/b3-m1-split.md)：8 个模块，全部 < 20 KB，`db.ts` 只做 re-export；调用方与逻辑不变 |
| B3-M1 核验修复（M1-1、M1-2） | 完成 | `见下` | [b3-m1-review](status/b3-m1-review.md)：counters 收集器与 analytics smoke 注入 storage；`initDb` 对 `storage_not_configured` 直接抛；measure 0 个 unavailable |
| B3-M1 存储注入化 | 完成 | `见下` | [b3-m1](status/b3-m1.md)：`storage-paths` 注入，db 各子模块与 `remote-history` 不再要 electron；导入图测试先失败后通过 |
| B3-M2 运行管线去 Electron 化 | 完成（5 段） | `见下` | [b3-m2](status/b3-m2.md)：M2-1 renderer sink、M2-2 存储根注入、M2-3 通知/dock/shell 边界、M2-4 `create-run-pipeline.ts` 组装入口 + 导入图断言；M2-5 管线不再持有窗口（`renderer.send`/`isFocused`） |
| B3-P1 daemon 承载宿主 | **完成（已核验）** | `见下` | [REVIEW-BATCH3-P1-R](REVIEW-BATCH3-P1-R.md)、[REVIEW-BATCH3-P1-N](REVIEW-BATCH3-P1-N.md)、[REVIEW-BATCH3-P1-CLOSE](REVIEW-BATCH3-P1-CLOSE.md)：单写者锁、真实宿主装配与 mTLS 端到端、能力诚实、启动恢复先于服务、共享 lease 进程身份、私有 recorder CLI、打包与 macOS/Ubuntu SIGKILL 验收均已通过 |
| B3-V1 security smoke 归属 | 完成（结论：非回归，调用方式错误） | `见下` | [b3-v1](status/b3-v1.md)：无 `--dev` 时脚本跑的是 0.2.220 旧产物，源码 0.2.237；`--dev` 下起点与当前 HEAD 均通过 |
| 交付前全局验证 | **除 renderer UI 既有失败外完成** | `见下` | test/typecheck/build/CLI/inventory/measure/desktop/security/pack 全绿；renderer performance fixture 在 P1 前 `59fa817` 与 Batch 3 起点 `577995b` 均同样失败 |

## 剩余任务的执行顺序（不得跳序）

Batch 3 已收尾，无待办。不自行开始新的 Batch，等待维护者下发 Batch 4 任务书。

## 后续事项（不阻塞 P1 关闭）

以下六项由 [REVIEW-BATCH3-P1-CLOSE](REVIEW-BATCH3-P1-CLOSE.md) 带入后续批次或单独立项。

1. **N3 UI 接入 `workbenchOps`**：renderer 目前只看 `catalog?.workbench === 1`（`RemoteChatView.tsx:201-209`），全仓没有其他地方读 `workbenchOps`。连接到受限 host 时，“外部打开”和“移到废纸篓”仍会显示，点了才收到 `desktop_workbench_operation_unavailable:*`。App 切换到 daemon host 之前，必须把它接入 catalog，隐藏或禁用这两个操作并说明原因。
2. **收窄 macOS 的 command 兜底**：macOS 的 `lstart` 来自内核绝对启动时间，不随校时漂移，所以 command 兜底在 macOS 上基本只会带来误拒。可考虑只对旧格式记录（身份不完整或格式无法识别）启用；注释里“macOS drift”的说法也要相应修正。
3. **R5 余项**：`remote_lease_*` 这类确定性启动失败仍以 exit 1 退出，会被重试 4 次，且 reason 正则只匹配 `daemon_` 前缀，failure 文件里没有原因。建议映射为不重试的退出码，并把 `remote_` 前缀纳入提取。
4. **SIGKILL 覆盖分在两处**：构建产物脚本证明了 lease 恢复，但被杀前没有进行中的 run；`host_restarted` 加“不二次 dispatch”仍由单元测试证明，而那里的 lease 是正常关闭的。两部分合起来逻辑上闭合；若要全链路验收，就在被杀之前先放一个已经 dispatch 的 run。
5. **renderer UI 既有失败**：见下方“既有问题”。
6. **App 尚未切换到 daemon**：App 仍使用进程内的 remote host，launchd/systemd 模板只生成、不安装。App→daemon 的控制面迁移与切换是下一批的范围；切换前不得同时拉起第二个台账写者。

## 阻塞

无。`db.ts` 超过提交门禁的问题已按门禁要求先做纯搬移拆分（`01bca85f`），M1 随后落到子模块。

M2 完成后运行管线的值导入图已无 electron（`src/host-runtime/create-run-pipeline-imports.test.ts` + `run-pipeline-imports.test.ts` + `run-pipeline-seams.test.ts` 三重守护）。仍留在 main 的 Electron 依赖是 IPC 面（`agent-runtime-ipc`、`app-agent`、`provider-handlers`、`project-handlers`、`workspace`）与 `remote-host`，它们属于 Batch 4 的 daemon 化范围，不在 M2。

M2 阶段的未验证项已在 B3-P1 补齐：daemon 现在真实调用 `createRunPipeline` 与 `createHostRuntime`，并经 `daemon/local.sock` 上的 mTLS 端到端测试验收。

## 需要决定

无。

## 既有问题（本批未处理）

`test:renderer:ui` 的 performance fixture 失败：`session-capability-ui-smoke --performance-only` 报 `Performance control obscured: #performance-empty`。在 P1 之前的 `59fa817` 与 Batch 3 起点 `577995b` 上重建后单跑同样失败，因此与 P1 无关，需要单独立项修复（对应上文后续事项第 5 项）。

`src/main/source-control/workspace-choices.test.ts › paginates bounded refs…` 在整批并行跑时偶发 5 s 超时，单跑通过。属既有并行负载脆弱点，与本批改动无关；没有放宽超时或跳过。详见 [b3-m1-split](status/b3-m1-split.md)。

## 更正记录

上一轮我在 STATUS 里写过「counters 测试普通 Node 下 4 个失败是既有问题」——**这个结论是错的**。核验复跑显示 `01bca85`、`ee2c933` 在普通 Node 下都是 4 passed，只有我加的断言让它变成 4 failed（`installed` 只代表 JS wrapper 能 import，不代表原生 binding 可用）。M1-2 已修复：`installCounter()` 实际打开一次 `:memory:` 数据库来判定可用性；普通 Node 下回到 4 passed，Electron 收集器仍为 measured。详见 [b3-m1-review](status/b3-m1-review.md)。

## Batch 3 最终门禁（P1 关闭后）

| 门禁 | 结果 |
|---|---|
| `npm test` | 通过；unit + shell 全绿 |
| `npm run typecheck` | 通过 |
| `npm run build` / `npm run build:cli` | 通过 |
| `npm run performance:inventory` | 通过 |
| `npm run performance:measure -- --compare 577995b` | exit 0，Ratchet passed，0 worse |
| `npm run test:desktop-remote` | 通过 |
| `electron-security-smoke.mjs --dev` | 通过 |
| `npm run pack:artifact` | 通过；未安装产物 |
| `git diff --check` | 通过 |
| `npm run test:renderer:ui` | **失败**：`session-capability-ui-smoke --performance-only` 报 `Performance control obscured: #performance-empty` |

R6 归属验证：在 detached worktree 的 `59fa817dd86482617ffde6f3cfee78d29bb53d00` 与 `577995bce9bbcc03d10a5b95e03ae51df8caa072` 上各自重建后单跑 `node scripts/session-capability-ui-smoke.mjs --performance-only`，均 exit 1，均为 `Performance control obscured: #performance-empty`。日志分别为 `/tmp/b3-r6-pre-p1-performance.log`、`/tmp/b3-r6-batch3-start-performance.log`。因此失败至少从 Batch 3 起点存在；仍标为失败，不顺带修改 UI。
