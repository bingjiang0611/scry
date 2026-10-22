# 批次 A 执行报告

执行分支：`perf/handoff`。仅执行 A1/A2/A3，未开始 B，未合入 main、未开 PR、未安装日常 App。结果交审查方核验，不自行标「已核验」。

## 结论与提交

| 条目 | 结果 | 基线 / 测量提交 | 优化 / 关键修正提交 |
|---|---|---|---|
| A1 #1 | 已优化：启动身份采集改为有超时的异步单 PID 查询；stop/abort 等待身份、复核后才发信号 | `539193f`；默认实现 collector 修正 `4259c63`，最终无 sleep collector `5bdc225` | `443924a`；Claude 原生 abort 栅栏 `bcf2952`；生产 stop 回归 `68c5441` |
| A2 #2 | 已优化：recent/project 单例、元数据键读缓存；只有内容（含活动时间）完全相同才跳过 session 写入 | `f45a679` | `3428928`；空 catalog 副本修正 `465464c` |
| A3 #6a | 已优化：四条轮询隐藏暂停、可见立即刷新、单请求收敛；旧在线/活动确认等待新读取 | `784a9d1`；恢复生命周期 fixture `3bf0141` | `58e57fc`；最终新鲜度/收敛修正 `aacf651`；既有隐藏 metadata 验收对齐 `45979b4` |

详细实验：[A1](../../../performance-experiments/20261022-a1-process-identity.md)、[A2](../../../performance-experiments/20261022-a2-store-catalogs.md)、[A3](../../../performance-experiments/20261022-a3-visibility-polling.md)。

## 前后测量（全部为 L1）

环境：macOS / arm64，Node `v24.18.0`，Electron `42.10.1`，8 个逻辑 CPU。任务跨 2026-10-22/23 本地时间。L1 不从 Vitest 耗时推断收益；初期机器 load1 约 18.36，最终验证阶段约 3–10.5。未采集用户 performance journal，未作 L2 对比或 L3 日常收益声明。

| 受控工作量 | 基线 | 最终结果 | 减少的工作去了哪里 |
|---|---|---|---|
| A1：Claude/Qoder spawn 等价路径各 3 个本地子进程 | 6 次同步全表 ps；每次 720–725 行 | 6 次异步目标 PID ps；每次 1 行 | 次数不变，扫描范围缩小；不再同步阻塞 spawn 返回。不是把全表扫描移到后台。 |
| A2：发送→身份→终态，通知时间相同 | read / write / fsync = 6 / 14 / 28 | 2 / 8 / 16 | recent/project 重复 JSON 读取改为 stat 校验 + 副本；3 次 exact no-op 不再替换 primary/backup。 |
| A2：同一流程但每次活动时间递增 | 6 / 14 / 28 | 2 / 14 / 28 | 只减读取；不同活动时间仍完整持久化，不人为把工作挪出窗口。 |
| A3：已连接空闲 fixture 隐藏 60 秒 | list 20；catalog 20；remoteStatus 30；intents 40 | 四项均为 0 | 隐藏期间不调度；显示后刷新再恢复原周期。runStatus/trace 在该空闲场景两侧本来均为 0，不宣称测得活跃 trace 收益。 |

复现命令：

```bash
npm run test:unit -- src/main/process-identity-measurement.test.ts
npm run test:unit -- src/main/app-store-performance.test.ts
node scripts/desktop-remote-ui-smoke.mjs --visibility-polling-baseline
node scripts/desktop-remote-ui-smoke.mjs --visibility-polling-check
```

A1 最终 collector 原样复制到原始 `bf92d04` 的隔离 worktree 后执行，调用实际默认实现；不会把全表 lister 注入新实现冒充测量。子进程以打开的 stdin 保活，不加 sleep；清理等待自己的子进程退出。原始未加 timing lock 的毫秒样本已明确撤销，不作为 L2 证据。

## 红线检查与实现边界

- **A1**：两处 spawn 仍同步返回 child，并保存立即发起的身份 Promise；Qoder 的两个 onPid 调用方与 abort 均已检查。未知、失败、超时不发 Scry 控制信号，也不直接 fallback 到 child.kill。Claude 原生 `spawn(signal)` 也改为相同栅栏；等待后重验 child 退出状态。采集与发信号复核仍为 `LC_ALL=C/lstart` 同格式。`readProcessSnapshot` 与发信号前的全表诊断/树校验不改；不宣称消除了 stop 路径的全表扫描。
- **A2**：缓存键为 `dev:ino:size:mtimeMs`，每个 store 一份，返回值包括空默认值均为副本；外部原地改写、同时间戳原子替换、删除/损坏/修复有回归。未缓存 degraded backup，避免隐藏外部修复。实际写入仍采用原 atomic rename、file/directory fsync 和 `.bak`；不延后、不删除 fsync。不同时间戳不合并，这是明确限制，不降低活动排序语义。
- **A3**：首/末连接订阅共用一个有界 controller，组件各自拥有生命周期，无永久 session-key Map。visibility 变化撤回确认并使旧 revision 失效；旧响应完成后最多追加一个可见的新读取。历史、错误和草稿保留，不把未知状态伪造成 disconnected；窗口隐藏不会永久 pause 提示词队列，也不会自动发送。
- **Pairing**：已跟踪 `remoteStatus → remote:status → RemoteHostService.status → PairingAuthority.inspectLocal` 及 relay diagnostics；这都是读取快照，不是租约心跳。授权操作的 wall/monotonic 过期检查独立执行，暂停 renderer 不延长配对期限。
- 不改变 trace 协议、renderer 隔离、trust gate、Provider 权限模式或 recorder 收敛规则。

## 验证

| 检查 | 最终结果 | 证据 / 命令 |
|---|---|---|
| 受影响 focused | 13 files、242 tests 全通过 | `npm run test:unit --`：process-diagnostics、agent-runner-options、agent-runner-process-identity、qoder、三份 app-store 测试、identity collector、pairing、visibility hook、RemoteLocation、ArchivedRemoteChatsPanel、DesktopRemote |
| 全量 unit | 303 files / 3731 tests 通过；4 files / 4 tests skipped | `npm run test:unit`，最终源码日志 `/tmp/scry-batch-a-unit-final.log`；4 个默认关闭项为 performance-correlation、billing-admin-real、P0、P1。首轮全量也通过。 |
| 类型 / 构建 | 通过，exit 0 | 最终 `npm run typecheck && npm run build`，`/tmp/scry-batch-a-final-checks.log`；未打包/安装 |
| 持续性能门禁 | 43/43 measured，ratchet 通过；无正向 delta | `npm run performance:measure -- --compare bf92d04 --out /tmp/scry-batch-a-performance-native`；candidate `45979b4-dirty`（dirty 仅交付文档），SQLite 3 项已实测；read.bytes -1 不计为收益 |
| A3 隐藏 / 恢复 | 隐藏 60s 六项 delta 均 0；恢复 fixture 通过 | `node scripts/desktop-remote-ui-smoke.mjs --visibility-polling-baseline`、`--visibility-polling-check`；日志 `/tmp/scry-a3-hidden-60s.log`、`/tmp/scry-a3-visibility-check.log` |
| 完整 renderer UI 命令 | **未全绿**：在 chat-preview 的 workspace dirty 断言失败 | 已实际运行 `npm run test:renderer:ui`；最终用 timing lock 串行，日志 `/tmp/scry-batch-a-renderer-native.log`。之前的 selected controls、session capability 与 Credits 均通过。 |
| UI 失败基线对照 | 原始 `bf92d04` 同样失败，低负载也复现 | 在隔离 worktree 运行同一个未改动的 `node scripts/chat-preview-ui-smoke.mjs`，load1=2.97，相同值 `# Edited preview`、dirty=false；`/tmp/scry-a-chat-preview-baseline.log`。未删断言、未重跑掩盖、未扩大 timeout。 |
| 余下 UI / IPC | 完整命令链 exit 0，覆盖被上项提前截断的全部余项 | timing lock 下执行下列原命令；`/tmp/scry-batch-a-renderer-remaining.log`，load1 3.14→3.41，无高负载标记 |
| diff / 范围 | 通过 | `git diff --check`；只改 A 与实验/交付文档，不改既有 ratchet / workload / B |

被原完整命令提前截断、随后原样逐项通过的命令：

```bash
node scripts/session-performance-ui-smoke.mjs
npm run test:background-ui
npm run test:steer-ui
npm run test:remote-queue-ui
node scripts/desktop-remote-ui-smoke.mjs
node scripts/desktop-remote-ui-smoke.mjs --session-parity-only
node scripts/desktop-remote-ui-smoke.mjs --composer-history-only
node scripts/desktop-remote-ui-smoke.mjs --remote-settings-only
node scripts/desktop-remote-ui-smoke.mjs --session-lifecycle-only
npm run test:source-control:ui
npm run test:conversation:ipc
node scripts/electron-security-smoke.mjs --dev-pi-history-only
```

上述链没有改写 `test:renderer:ui`，也不是把失败项 skip 后宣称完整通过。原完整入口仍会暴露既有 workspace dirty 失败。Conversation IPC 验证包含隔离的真实 main/preload/renderer 与测试 Provider，不是用户账号的真实 Provider 验收。

### 已验证的反例

| 检查 | 结果与证据 |
|---|---|
| A1 新 Claude stop 测试对原始 `bf92d04` | 9 项中 6 项按预期失败，含未知身份时直接 child-handle SIGKILL；实际信号已 mock，不杀真实 Provider。当前同测试通过。 |
| A2 新 cache/no-op 测试对 `f45a679` | 3 项全部按预期失败：两个多余读取断言、一个 inode 被重复替换断言；当前 3 项通过。 |
| A3 故意取消 invalidation | `--visibility-polling-check --negative-visibility-control` 明确失败于 `Resume must withdraw stale online/activity confirmation`；正例验证挂起、旧响应、单请求、拒绝与历史保留。 |

### 首次失败与处理（不以重跑抹掉）

1. 初始依赖不完整，focused 命令 `vitest: command not found`；执行锁文件 `npm ci` 恢复，无 package/lockfile diff。npm audit 的既有 24 项提示不属于本次修复范围。
2. 初次 A3 helper 的类型/API 与新鲜度设计不完整；自审后移除共享永久注册表，修复 API、pending 恢复刷新和各消费表面的未知状态，再运行 typecheck 与回归。
3. Parent 首次 remote focused 超时：旧测试在第一份 list 未释放前等待第二份并发请求，违背本次 single-flight 合同。改为验证只发一份、共同完成且回读连接；没有扩大 timeout。
4. 首次 renderer 全套失败于 `Hidden composer initialized a Provider`：旧 fixture 只改 visibilityState，不改 document.hidden，还要求隐藏继续 catalog 轮询。已保持两个属性一致，断言隐藏不读、可见追赶，同时保留隐藏不初始化 Provider 的断言。`--session-opening-only` 正例随后通过。
5. 首次完整 performance 收集完成，ratchet 通过，但 SQLite 因 Node/Electron ABI 不符 unavailable，既有 formatter 对 unavailable 字符串调用 `toFixed` 导致命令 exit 1。后续环境修复及复测记录见最终门禁表；没有修改既有计数器或放宽阈值。该次 43 指标中 40 measured、3 unavailable；ratchet `passed=true`。唯一正向 delta 是 `files.fixed-operations/io.read.bytes` +3（0.00025%），调用次数不变。相同生产源码对照（`aacf651` vs `45979b4`，`git diff -- src` 为空）也出现 -28 bytes；归档索引包含未冻结的 mtime/ctime/ino 字段，重复样本的 JSON 字节数有波动，因此不把该 +3 解释为额外 I/O 回归，也不把负向波动计为收益。原始结果保存在 `/tmp/scry-batch-a-performance/measure.json` 与 `/tmp/scry-batch-a-same-code/measure.json`。
6. 首次加锁 renderer 全套在 Credits 的临时 DB 写入失败，同样是 better-sqlite3 ABI 137 / Electron ABI 146 不符。将已安装模块复制到 `/tmp/scry-a-electron-native` 后，以 Electron `42.10.1` 重建，先执行内存 SQL 正对照，再暂时用于 Electron 门禁。Credits 与全部 SQLite 指标随后通过；结束后恢复原 Node ABI 137 binding，内存 SQL 再次通过。只修复测试依赖，不改产品数据或期望。
7. 原完整 UI 入口随后在未改动的 chat-preview/workspace dirty 场景失败，原始 `bf92d04` 也同样失败。此既有问题不扩入 A；已继续跑完入口被截断的其余原命令，均通过。

## 未验证项与交付状态

- 没有真实付费 Provider 启动、手机/远端网络验收或 L3 日常样本；本批验证使用本地进程、临时 userData/workspace 与隔离 Electron fixture，不读取真实会话或凭据。
- A2 不合并不同活动时间的写入；如需继续减少这类 fsync，维护者应先决定活动时间是否可按逻辑 turn 归并，不能由本批静默改变。
- 完整 UI 入口仍有基线已存在的 workspace dirty 失败。负责人：审查方/仓库维护者；具体后续动作是在独立 UI 修复任务中用 `node scripts/chat-preview-ui-smoke.mjs` 重放并追踪 dirty 通知。本批不擅自修改该无关路径；不以剩余检查通过替代完整绿灯。
- 不打包安装到 `/Applications/Scry.app`，不要求用户重启日常实例。
- 日常 App 未被停止或替换；测试使用独立实例。交付时清理本次自建 worktree；日志、raw performance JSON 与 Electron native 暂存模块保留在上列 `/tmp/scry-*` 路径。测试后台命令均已结束。
- 本报告与 STATUS 的提交 / push 身份见分支 HEAD 与末次交付消息；A1/A2/A3 均为「待核验」。负责人：审查方，按 README 检查本报告与反例后标已核验或需修改；B 留待 A 通过后开始。
