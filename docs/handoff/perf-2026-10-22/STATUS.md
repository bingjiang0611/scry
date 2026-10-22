# 状态

状态值：`未开始` → `进行中` → `待核验` → `已核验` / `需修改`；测量后判定不值得做：`放弃（附证据）`。

- `perf/handoff` 上的批次（A、B）由执行方直接更新本表。
- 并行分支（C、D、E、F）**不改本文件**，只写 `reports/<批次>.md`；审查方核验后在 `perf/handoff` 上更新。

| # | 问题 | 批次 | 分支 | 状态 | 报告 | 核验备注 |
|---|---|---|---|---|---|---|
| 1 | 发送时同步全系统 `ps` | A1 | `perf/handoff` | 未开始 | | |
| 2 | store 同步读写/重复写 | A2 | `perf/handoff` | 未开始 | | |
| 6a | 后台不暂停的轮询 | A3 | `perf/handoff` | 未开始 | | |
| 4 | 提交时同步重复读归档 | B1 | `perf/handoff` | 未开始（等 A） | | |
| 3 | 启动全量归档扫描 | B2 | `perf/handoff` | 未开始（等 A） | | |
| 5 | 工作区 diff 只读路径 | C | `perf/c-git-readonly` | 未开始 | | |
| 8 | transcript 观察者 / App 重渲染 | D | `perf/d-renderer-transcript` | 未开始 | | |
| 6b | 远程 trace 增量协议 | E | `perf/e-remote-delta`（A 核验后创建） | 未开始（等 A） | | |
| 7 | iOS store 观察粒度 | F | `perf/f-ios-observable` | 未开始 | | |
