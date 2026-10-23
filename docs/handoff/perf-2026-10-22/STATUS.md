# 状态

状态值：`未开始` → `进行中` → `待核验` → `已核验` / `需修改`；测量后判定不值得做：`放弃（附证据）`。

- **本文件以 `perf/handoff` 上的版本为准。** 并行分支上的 STATUS 改动在整合时丢弃，取本分支版本。
- `perf/handoff` 上的批次（A、B）由执行方直接更新本表；并行分支（C、D、E、F）只写 `reports/<批次>.md`，由审查方在此更新。
- 核验方式见各报告末尾「核验意见」。审查方本轮**未能独立重跑测试**（会话网络策略拒绝访问 npm registry），核验依据是逐行读 diff、核对红线与执行方的命令记录；独立复跑留到整合时。

| # | 问题 | 批次 | 分支 | 状态 | 报告 | 核验备注 |
|---|---|---|---|---|---|---|
| 1 | 发送时同步全系统 `ps` | A1 | `perf/handoff` | 已核验 | [A](reports/A.md) | 单 PID 异步采集（720 行全表→1 行）；`e5b9236` 恢复未回收子进程的句柄回退，stop 在身份不可用时仍有效 |
| 2 | store 同步读写/重复写 | A2 | `perf/handoff` | 已核验 | [A](reports/A.md) | 读次数 6→2，写/fsync 仅 exact no-op 时减少；fsync 与 `.bak` 保留 |
| 6a | 后台不暂停的轮询 | A3 | `perf/handoff` | 已核验 | [A](reports/A.md) | 隐藏 60 s 四类轮询 0 次；恢复可见先撤回旧确认再刷新 |
| 4 | 提交时同步重复读归档 | B1 | `perf/handoff` | 待核验 | [B](reports/B.md) | 提交时同步 read+lstat 4→0；disabled 读 2→1；managed 锁内读取为避免 TOCTOU 保留；L1 |
| 3 | 启动全量归档扫描 | B2 | `perf/handoff` | 待核验 | [B](reports/B.md) | 首屏前 await 的发现工作→0；后台只扫 Qoder（200→40 文件）；索引异步发布；删除不再同步重建；L1，无 L2 |
| 5 | 工作区 diff 只读路径 | C | `perf/c-git-readonly` | 已核验 | [C](https://github.com/bingjiang0611/scry/blob/perf/c-git-readonly/docs/handoff/perf-2026-10-22/reports/C.md) | 对象写入 4→0，受控 p50 约 −20%；spawn 8→8 未减；无法等价的场景显式 unavailable；跟进 `5daa809` 加 O_NOFOLLOW，已核验 |
| 8 | transcript 观察者 / App 重渲染 | D | `perf/d-renderer-transcript` | 已核验（D1）/ 放弃（D2，附证据） | [D](https://github.com/bingjiang0611/scry/blob/perf/d-renderer-transcript/docs/handoff/perf-2026-10-22/reports/D.md) | 1000 轮时 IO 1000→1、输入 30 字的检查 30000→120；App 拆分数据不支持 |
| 6b | 远程 trace 增量协议 | E | `perf/e-remote-delta` | 可开始 | | 已从本分支 A3 之后切出 |
| 7 | iOS store 观察粒度 | F | `perf/f-ios-observable` | 已核验 | [F](https://github.com/bingjiang0611/scry/blob/perf/f-ios-observable/docs/handoff/perf-2026-10-22/reports/F.md) | 真机 RootView body 601→0、输出完整；selfTest/UI 无新增失败；L2 提速未证实（不再要求） |
| 7b | iOS 流式输出主线程跟不上 | F2 | `perf/f2-ios-stream-layout` | 进行中 | | 600 段按 33 ms 调度应约 20 s，真机实测 52–56 s，FPS≈26；推测单个变长 row 每次追加都全文重排版（O(n²)），需 Time Profiler 确认 |

## 本轮发现的既有问题（不属于任何批次，需另行处理）

| 问题 | 证据 | 影响 |
|---|---|---|
| `npm run test:renderer:ui` 在 `chat-preview-ui-smoke` 的 workspace dirty 断言失败 | **已修复，待合入**：`fix/chat-preview-workspace-dirty`（`052ea92`），已核验 | 根因是 fixture 第二次输入前没等原生焦点和全选生效，产品 dirty 逻辑无误；只改测试脚本，原断言与超时保留，完整组合入口一次通过 |
| iOS `catalog-refresh.py` 146 项中 4 项失败 | F 执行方在基线与候选上得到完全相同的 PASS/FAIL 列表 | `followUp.routingDoesNotResumeAnotherProfile`、`recovery.explicitModelChoice`、`model.explicitAutoIsRemembered`、`model.catalogRecoveryRestoresReadiness` 的合同目前未满足 |
| iOS 真机 `-selfTest` 117 项中 3 项失败 | F 执行方真机基线/候选结果相同 | `run.recovery.explicitModelChoice`、`run.model.explicitAutoIsRemembered`、`run.model.catalogRecoveryRestoresReadiness`；与上一行 catalog 的 3 项同属“模型选择恢复”合同，可能同一根因 |
| iOS XCTest UI 31 项中 5 项失败 | F 执行方真机基线/候选失败名与错误文本相同 | `ConversationUITests` 的 failedTurnKeepsItsOutcome、homeRefreshFailureKeepsCache、openingAndSendingFromOlderMessages、sessionStatusAndReadOnlyWorkspaceBrowser、turnDetailsDoNotInventMissingUsage |
