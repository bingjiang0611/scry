# 性能优化交接（2026-10-22）

来源：基于 `main@531e88c` 的静态源码审查（见 [review.md](review.md)）。审查只读代码、**未做任何测量**，每条都是“值得去测的线索”，不是已证实的结论。

## 协作方式

- **审查方**（Claude，本会话）：写交接文档、核验执行结果。
- **执行方**（另一个 agent）：按批次文档实施，推送到指定分支。
- 执行方完成一个批次 → 写报告并推送 → 审查方核验后在 [STATUS.md](STATUS.md) 标 `已核验`，或把问题写进报告文件末尾的「核验意见」并标 `需修改`，执行方据此修改后再推送。
- **用户已授权**执行方向下表中的 `perf/*` 分支 push。不 push `main`，不开 PR、不合入，合入由用户决定。

## 批次与分支

| 批次 | 内容 | 分支 | 依赖 | 文档 |
|---|---|---|---|---|
| A | #1 ps 同步调用、#2 store 读写、#6a 后台暂停轮询 | `perf/handoff` | 无，**先做** | [A.md](A.md) |
| B | #3 启动归档扫描、#4 提交时重复读归档 | `perf/handoff` | A 核验后 | [B.md](B.md) |
| C | #5 工作区 diff 只读路径 | `perf/c-git-readonly` | 无，可并行 | [C.md](C.md) |
| D | #8 transcript 渲染层 | `perf/d-renderer-transcript` | 无，可并行 | [D.md](D.md) |
| E | #6b 远程 trace 增量协议 | `perf/e-remote-delta`（A 核验后由审查方从 `perf/handoff` 切出） | A | [E.md](E.md) |
| F | #7 iOS store 拆分 | `perf/f-ios-observable` | 无，可并行；需 Xcode 与真机 | [F.md](F.md) |

A、B 都改 `src/main/index.ts`，必须串行在同一分支。C/D/F 并行分支均从本分支的交接提交切出，各自只改自己的范围；毫秒测量仍需按仓库规则经 timing lock 串行。

## 所有批次共同的硬约束

1. **先证实再优化。** 每条先补计数/基线并单独提交，确认问题真实存在后再改。测量后判定“不值得做”可以放弃，在 STATUS 写明证据即可，这是合格结果。
2. **测量与优化分开提交**（仓库 CLAUDE.md「不骗计数」）。每条一个 `docs/performance-experiments/2026MMDD-<主题>.md`。宣称收益写明 L1/L2，不以 L1 冒充 L2；L3 留给用户。
3. 使用 `.agents/skills/scry-performance-climb`。改热路径后跑 `npm run performance:measure`（可加 `--scenario`），报告中每个 `worse` 解释原因。不手改 `scripts/performance-ratchet.json` 放宽。
4. 不弱化：权限/trust 语义、证据诚实（缺失不显示为 0/空）、持久性（fsync、`.bak`）、renderer 隔离。各批次文档里列了逐条红线。
5. 验证：focused 测试 + `npm run typecheck`；提交前 `npm run test:unit` 全量；改 UI 加 `npm run test:renderer:ui`。已知原有失败见 perf skill「交付前的测试要求」，只报告不修。
6. **分支构建不安装到 `/Applications/Scry.app`**：这些是未合入、可能并行的分支，任一分支安装都会用半成品覆盖用户日常实例。CLAUDE.md 的默认安装留到合入 main 后再做；用户若另有指示，以用户为准。需要真实 App 验证时用独立 `userData` 的 test 实例。
7. 只提交本批相关改动，不做无关格式化或重构。

## 回报格式（核验依据）

每个批次完成后，在 `docs/handoff/perf-2026-10-22/reports/<批次>.md` 写：

- 每条问题：`已优化 / 放弃 / 部分` + 一句话结论
- 基线测量 commit、优化 commit（hash）
- 前后数值、级别（L1/L2）、机器负载、测量命令
- 减少的工作去了哪里（是删掉、合并、移到后台还是缓存）
- 运行过的测试命令与结果；首次失败与重跑都如实记录
- 未验证项、留给用户决定的事

然后 push。`perf/handoff` 上的批次同时更新 [STATUS.md](STATUS.md)；并行分支不改 STATUS.md（避免多分支冲突），由审查方核验后在 `perf/handoff` 上更新。
