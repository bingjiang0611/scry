# 状态

状态值：`未开始` → `进行中` → `待核验` → `已核验` / `需修改`；测量后判定不值得做：`放弃（附证据）`。

- **2026-10-23 起本文件以 `perf/port-2026-10-23` 上的版本为准**（main 重写历史后，旧 `perf/*`、`fix/*` 分支已停用，见文末「移植到重写后的 main」）。
- `perf/handoff` 上的批次（A、B）由执行方直接更新本表；并行分支（C、D、E、F）只写 `reports/<批次>.md`，由审查方在此更新。
- 核验方式见各报告末尾「核验意见」。审查方本轮**未能独立重跑测试**（会话网络策略拒绝访问 npm registry），核验依据是逐行读 diff、核对红线与执行方的命令记录；独立复跑留到整合时。

| # | 问题 | 批次 | 分支 | 状态 | 报告 | 核验备注 |
|---|---|---|---|---|---|---|
| 1 | 发送时同步全系统 `ps` | A1 | `perf/handoff` | 已核验 | [A](reports/A.md) | 单 PID 异步采集（720 行全表→1 行）；`e5b9236` 恢复未回收子进程的句柄回退，stop 在身份不可用时仍有效 |
| 2 | store 同步读写/重复写 | A2 | `perf/handoff` | 已核验 | [A](reports/A.md) | 读次数 6→2，写/fsync 仅 exact no-op 时减少；fsync 与 `.bak` 保留 |
| 6a | 后台不暂停的轮询 | A3 | `perf/handoff` | 已核验 | [A](reports/A.md) | 隐藏 60 s 四类轮询 0 次；恢复可见先撤回旧确认再刷新 |
| 4 | 提交时同步重复读归档 | B1 | `perf/handoff` | 已核验 | [B](reports/B.md) | 同步 read+lstat 4→0；disabled 路径读取 2→1；锁内读取为避免 TOCTOU 保留 |
| 3 | 启动全量归档扫描 | B2 | `perf/handoff` | 已核验 | [B](reports/B.md) | 首屏不再等待发现；只扫 Qoder（200→40 文件）；索引异步发布、并发写入复核；仅 L1 |
| 5 | 工作区 diff 只读路径 | C | `perf/c-git-readonly` | 已核验 | [C](https://github.com/bingjiang0611/scry/blob/perf/c-git-readonly/docs/handoff/perf-2026-10-22/reports/C.md) | 对象写入 4→0，受控 p50 约 −20%；spawn 8→8 未减；无法等价的场景显式 unavailable；跟进 `5daa809` 加 O_NOFOLLOW，已核验 |
| 8 | transcript 观察者 / App 重渲染 | D | `perf/d-renderer-transcript` | 已核验（D1）/ 放弃（D2，附证据） | [D](https://github.com/bingjiang0611/scry/blob/perf/d-renderer-transcript/docs/handoff/perf-2026-10-22/reports/D.md) | 1000 轮时 IO 1000→1、输入 30 字的检查 30000→120；App 拆分数据不支持 |
| 6b | 远程 trace 增量协议 | E | `perf/e-remote-delta` | 已核验 | [E](https://github.com/bingjiang0611/scry/blob/perf/e-remote-delta/docs/handoff/perf-2026-10-22/reports/E.md) | 1000 items 线上字节 55.9 MB→1.8 MB；5000 items 从 2400 起超限失败→完整显示；安静轮询退避到 5 s；reset 仍整包（原有限制） |
| 7 | iOS store 观察粒度 | F | `perf/f-ios-observable` | 已核验 | [F](https://github.com/bingjiang0611/scry/blob/perf/f-ios-observable/docs/handoff/perf-2026-10-22/reports/F.md) | 真机 RootView body 601→0、输出完整；selfTest/UI 无新增失败；L2 提速未证实（不再要求） |
| 7b | iOS 流式输出主线程跟不上 | F2 | `perf/f2-ios-stream-layout` | 已核验 | [F2](https://github.com/bingjiang0611/scry/blob/perf/f2-ios-stream-layout/docs/handoff/perf-2026-10-22/reports/F2.md) | 根因是 coalesce 每次更新行 id 导致整条消息重建；改用 ordinal 后段落 body 180,300→600，真机 stream600 约 52.6 s→20.3 s（接近调度下限，宿主高负载，不作稳定 L2 结论） |

## 本轮发现的既有问题（不属于任何批次，需另行处理）

| 问题 | 证据 | 影响 |
|---|---|---|
| `npm run test:renderer:ui` 在 `chat-preview-ui-smoke` 的 workspace dirty 断言失败 | **已修复，待合入**：`fix/chat-preview-workspace-dirty`（`052ea92`），已核验 | 根因是 fixture 第二次输入前没等原生焦点和全选生效，产品 dirty 逻辑无误；只改测试脚本，原断言与超时保留，完整组合入口一次通过 |
| iOS `catalog-refresh.py` 146 项中 4 项失败 | F 执行方在基线与候选上得到完全相同的 PASS/FAIL 列表 | `followUp.routingDoesNotResumeAnotherProfile`、`recovery.explicitModelChoice`、`model.explicitAutoIsRemembered`、`model.catalogRecoveryRestoresReadiness` 的合同目前未满足 |
| iOS 真机 `-selfTest` 117 项中 3 项失败 | F 执行方真机基线/候选结果相同 | `run.recovery.explicitModelChoice`、`run.model.explicitAutoIsRemembered`、`run.model.catalogRecoveryRestoresReadiness`；与上一行 catalog 的 3 项同属“模型选择恢复”合同，可能同一根因 |
| iOS 流式结束后自动跟随停在中段 | F2 执行方真机上基线与候选都复现：输出到 0600 后视口停在约 0290–0300，“回到最新”也只到中段 | 用户看不到最新输出，需要手动滚动；涉及滚动跟随合同，需另行授权修复 |
| iOS XCTest UI 31 项中 5 项失败 | F 执行方真机基线/候选失败名与错误文本相同 | `ConversationUITests` 的 failedTurnKeepsItsOutcome、homeRefreshFailureKeepsCache、openingAndSendingFromOlderMessages、sessionStatusAndReadOnlyWorkspaceBrowser、turnDetailsDoNotInventMissingUsage |

## 整合预检（审查方，2026-10-23）

用 `git merge-tree` 把各分支合入 `perf/handoff@1ad3825` 试算：

| 分支 | 源码冲突 | 文档冲突 |
|---|---|---|
| `perf/e-remote-delta` | 无 | 无 |
| `fix/chat-preview-workspace-dirty` | 无 | 无 |
| `perf/c-git-readonly` | 无 | `STATUS.md`、`docs/performance-opportunities.md` |
| `perf/d-renderer-transcript` | 无 | `STATUS.md`、`docs/performance-opportunities.md` |
| `perf/f-ios-observable` | 无 | `STATUS.md` |

解决规则：`STATUS.md` 取 `perf/handoff` 版本；`performance-opportunities.md` 两边条目都保留。F2 仍在进行，不参与本轮整合。


## 整合结果（审查方，2026-10-23）

- `perf/integration-2026-10-23` **已核验**：5 个分支 `--no-ff` 合入，无源码冲突；7 个 gate 第一次运行全部通过，`test:renderer:ui` 整条全绿；A1 停止/强制停止与 B2 后台恢复刷新已在独立 test 实例中重放通过。详见该分支 `reports/integration.md`。
- `perf/f2-ios-stream-layout` 已核验，尚未合入整合分支；试算无冲突。
- 下一步需维护者决定：把 F2 合入整合分支，再把整合分支合入 main，然后按仓库规定 `install:mac:dev` 安装，积累 L3 日常数据。

## 移植到重写后的 main（审查方，2026-10-23）

main 已在 10-23 重写历史（清除内部邮箱、内部引用和 designs/、.claude/skills 历史），与本轮各 `perf/*`、`fix/*` 分支不再有共同祖先。本轮工作因此逐提交移植到新分支 **`perf/port-2026-10-23`**（起点 `origin/main@b358dcb`）：

- 70 个非合并提交按 handoff → fix → C → D → E → F → F2 → 整合报告的顺序 cherry-pick；作者和提交者统一为 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`，作者时间保留。
- 冲突处理：`STATUS.md` 取 handoff 版本；`performance-opportunities.md` 两边条目都保留；与新 main 的源码冲突 4 处（`scripts/desktop-remote-ui-smoke.mjs` 参数取并集、`RemoteChat.tsx` 两处、`desktop-client-ipc.ts` 方法列表取并集）均为两边都保留。`RemoteChat.tsx` 中 main 新增的“提交回执未知时阻止发送”放在优先级最前，`unknownIntent` 采用 main 去掉上下文过滤的新写法。
- 整合报告中的旧包名 `@ali/scry-turn-recorder` 已改为 `scry-turn-recorder`。
- 核对：未与 main 同时改动的 105 个文件与源分支逐字节一致；其余差异都在预期内（F2 覆盖 F、STATUS 取 handoff、上述脱敏，以及 `qoder.ts` 保留 main 重写时的脱敏注释）。node 侧差分类型检查没有新增生产代码错误，61 个改动的 TS 文件语法检查通过。**完整 gate 尚未在移植结果上运行。**
- 各报告中出现的提交哈希指向旧分支，旧分支删除后这些哈希将无法在远端访问，仅作历史记录。
- 旧的 9 个远端分支（`perf/handoff`、`perf/c-git-readonly`、`perf/d-renderer-transcript`、`perf/e-remote-delta`、`perf/f-ios-observable`、`perf/f2-ios-stream-layout`、`perf/integration-2026-10-23`、`fix/chat-preview-workspace-dirty`）含重写前历史。按维护者决定，移植分支 gate 通过并核验后再删除；在此之前，任何会话都不要再向这些旧分支推送。

### 移植分支 gate（2026-10-23）

- 桌面端 **已核验**：7 个 gate 通过；首次唯一失败是合并后 IPC 方法数断言过期（28→29），已在 `815c0e8` 单独修复。详见 [reports/port.md](reports/port.md)。
- iOS **已核验**：在 Xcode 机器上 `build-for-testing` 通过；Catalog 146 项与基线逐项一致；Markdown 17/17（`7fe1c34`）。
- **结论：`perf/port-2026-10-23` 可以合入 main**（main 是其祖先，可 fast-forward）。合入、删除旧分支、安装由维护者决定。
