# Recorder 性能交接：Git 快照引擎与 recorder 执行路径（2026-11-05）

来源：用户提交的 scry CLI 性能深挖报告（提案二、提案三），审查方对照 `main@50bd720`（CLI 0.2.59）核对了代码事实，见 [review.md](review.md)。审查只读代码，**没有新测速**。报告里的历史毫秒数据来自旧候选 `38686164`，不能当成当前版本的基线。

本次范围只包括：

- **提案二**：Git 快照引擎。同一轮内复用已有工作，再评估跨轮常驻。
- **提案三**：recorder 执行与持久化路径。先测量规模性成本，再做有证据的增量改动。

**不在范围内**：Pi 集成（用户 2026-11-05 明确先不管）、uploader、Electron App、原生 Git 引擎、新的统一持久接收日志和用户级服务监管器（后两者只允许写设计说明，见 [R.md](R.md)）。

## 协作方式（为减少往返而设计）

- **审查方**（Claude，本会话）：写交接文档、在全部批次结束后集中核验。
- **执行方**（另一个 agent）：在分支 `perf/recorder-engine` 上**连续完成所有批次**，每个批次写报告、更新 [STATUS.md](STATUS.md) 并 push，**不需要等审查方核验就继续下一批**。
- 只有遇到下面的「必须停下」条件才停止并在 STATUS 写明原因；其他问题自行判断，在报告里写清楚理由。
- 不 push `main`，不开 PR，不合入，不发布 npm。合入由用户决定。

### 执行顺序

| 批次 | 内容 | 依赖 | 文档 |
|---|---|---|---|
| M | 计数测量工具 + 正确性对照（oracle）+ 基线 | 无，**先做** | [M.md](M.md) |
| G1 | 同轮复用 discovery index；合并两次 diff；多仓库有界并发；大 patch 内存 | M | [G.md](G.md#g1同一轮内不重复做) |
| G2 | 跨轮常驻：仓库布局/配置缓存、索引种子、私有对象复用 | G1，且满足 G.md 中的**进入条件** | [G.md](G.md#g2跨轮复用) |
| R | recorder 规模性成本：transcript 增量、正文写入、提交临界区、恢复扫描 | M（可在 G2 之前或之后做） | [R.md](R.md) |

G 和 R 改的文件基本不重叠，但都在同一分支上**串行**提交，避免冲突。

### 必须停下的情况（其余自行决定）

1. 需要改变 `.scry/records` 的 schema 字段含义、record 文件格式、或提交时的重复检测与序号分配规则（`store.ts` `commitRecord` 里 “Allocation and duplicate detection never trust a derived projection”）。
2. 对照测试（oracle）出现新旧实现不一致，且你无法解释为「新实现更正确」。不要改 oracle 让它通过。
3. 需要删 fsync、把原子写换成非原子写，或让 hook 在证据收敛前提前 ACK。
4. 需要往 `src/core/turn-recorder/` 引入原生依赖、Electron、SQLite 或 Provider SDK。

遇到第 2 条以外的情况，也可以选择**放弃该条目、写明证据、继续下一条**，这是合格结果。

## 硬约束

1. **先测再改，测量与优化分开提交**（仓库 CLAUDE.md「不骗计数」）。每个优化条目先有一条在旧实现上给出基线数字的测量提交，再有优化提交。不缩小 workload、不换调用方式、不把工作挪到不计数的地方。
2. **正确性先于速度。** 所有 G 批次改动都必须通过 [M.md](M.md) 的 oracle：同一场景下 targeted / 新实现与 `SCRY_TURN_DIFF_STRATEGY=full` 的全量路径产生**完全相同**的 afterTree 和文件证据。
3. **不弱化现有保证**：
   - 观测 hook 继续 fail open（返回码 0），不能让 Provider 卡住。
   - 证据诚实：拿不到的证据标 `unavailable` / `partial` 并写原因，不能显示成空或 0。
   - 持久性：不删 fsync，不改非原子写，不缩短 canonical 发布的互斥范围。
   - 用户真实 index、真实 `.git` 目录、工作树文件**一律不写**。私有 index/对象只能放在 recorder 自己的临时或数据目录。
   - Recorder Core 保持独立（见上面第 4 条）。
4. **不能走的捷径**（来自用户报告，必须遵守）：
   - 上一轮的结束树**不能**直接当下一轮的开始树：用户可能在两轮之间改文件。
   - watcher 或工具声明的路径只能当**提示**，不能当完整事实源。
   - 不能漏掉 sparse checkout、外部改写 index、`.gitattributes`、换行转换、符号链接、子仓库（submodule / 嵌套仓库）。
   - 不能声称对并发外部写入提供原子快照。
   - 收益必须是**减少真实工作**，不是把相同工作移到后台或移到 hook 返回之后。
5. **宣称收益写明级别**：L1 计数（git 子进程数、读写字节、fsync 次数、readdir 次数、锁等待）、L2 受控毫秒。L1 是本次主要证据；毫秒只作参考并注明机器、负载和 `timing-run.mjs` 锁。不用 L1 冒充 L2。
6. 改热路径后跑 `npm run performance:measure`（可加 `--scenario`），报告中每个 `worse` 都要解释。不手改 `scripts/performance-ratchet.json` 放宽。
7. **测试**：focused `npm run test:unit -- <files>` + `npm run typecheck`；每个批次结束前跑一次 `npm run test:unit` 全量。原有失败只报告不修。自动化测试一律用临时目录，不写真实 `.scry`。
8. 只提交本批相关改动；单文件预计超 20KB 时先按职责拆分（仓库有大小门禁）。
9. 提交身份：`bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。

## 使用场景（所有批次都要覆盖）

- **单仓库**：小仓库（~100 文件）和大仓库（≥20,000 个已跟踪文件，可用脚本生成）。
- **多仓库工作区**：`repositories.mode = discover-nested-git`，日常一轮约 18–19 个仓库。
- **基线状态**：开始时干净 / 开始时有未提交改动（dirty baseline 走 `writeSnapshotTree`，成本更高）。
- **改动规模**：0 个文件、1 个文件、300 个小文件、1 个 50 MB 文件。
- **轮次形态**：无工具调用；30 次工具调用（= 60 个前后事件）；长会话（transcript ≥ 50 MB）。
- **历史规模**：`.scry/records` 0 条、1,000 条、10,000 条。
- **并发**：同一工作区 1 个会话 / 4 个会话同时运行。
- 平台：macOS 与 Linux 都是维护目标。L1 计数与平台无关；只在一个平台测得的毫秒要注明。

## 回报格式（核验依据）

每个批次在 `reports/<批次>.md` 写：

- 每个条目：`已优化 / 放弃 / 部分` + 一句话结论。
- 测量提交与优化提交的 hash。
- 前后 L1 计数表（按场景），可选 L2 毫秒（注明机器与负载）。
- **减少的工作去了哪里**：删掉、合并、缓存，还是移到后台（移到后台的必须说明 hook 返回时间与 record 可读时间分别怎么变）。
- oracle 运行结果：场景数、是否全部一致。
- 运行过的测试命令、结果、首次失败与重跑都如实记录。
- 是否需要 `scry integrations repair` 或 `scry recorder restart` 才生效。
- 未验证项、留给用户决定的事。

全部批次结束后，在 `reports/SUMMARY.md` 汇总：每个场景的最终 L1 前后对比、所有放弃项及理由、需要用户决定的事。然后 push，并在 STATUS 顶部写「全部待核验」。
