# 2026-10-25 性能爬坡执行计划

## 授权与目标

用户已批准按三套方案的推荐次序制定计划并开始优化：证据/查询为主线，Provider 初始化争取早期收益，客户端先改增量数据流而非重写原生壳。

目标是删除不必要工作、降低必要工作的成本、隔离交互阻塞。三者分别记账；不能用缓存旧事实、移出计时窗口、减少采集或降低安全保障冒充性能收益。

本轮使用独立 worktree，冻结起点 `d822f840`，不混入原工作区的 CLI WIP。默认仅本地提交；不合入、不 push、不安装。存储格式迁移、日常采集变更、额外驻留资源预算、真实付费 Provider 与原生客户端迁移仍单独确认。

## 当前证据

日常观测 App 0.2.223，build `2d6b6d7e0d9dba6cce72d3fbc23f842c1a99e726ff793e3be6578eddbfe5a56a`；2026-10-24T11:45Z—2026-10-25T09:39Z，62,153条、1个App会话。完整源码到此build的manifest映射 unknown，不用它证明某个提交回归。

| 机会 | 观测或代码依据 | 首个验收重点 |
|---|---|---|
| Pi 目录 | probe p50/p95 2.03/3.86s；首响应约1.99/3.82s；已有会话池与probe并发合并 | 目录生命周期和真实刷新，不重做进程池/close优化 |
| 证据处理 | trace queue p95 473ms；出队后处理p50/p95 49/103ms | 内容/FS/sync真实工作量；Provider结束到durable完整时钟 |
| 终态diff | 一个13样本分组p95 6.98s，其中diff阶段6.68s | dirty/workload、fallback与共享快照；不提前提交 |
| 统计 | stats p50/p95 0.99/2.11s；主进程同步聚合 | 先取消无人消费的请求，再测查询/物化/worker |
| 历史/远程/UI | warm归档仍检查全目录metadata；delta revision仍hash全部事件；turn壳未真正窗口化 | O(page/visible/changed)，同时保留外部修改、重连、选择和可访问性 |

这些是机会线索，不是受控基线。已有计数/实验见[性能闭环](performance-loop.md)、[机会日志](performance-opportunities.md)和[证据引擎](performance-experiments/20261022-evidence-engine.md)。

## 先复用既有成果：不重复已否证的实验

调查到历史分支 `perf/kernel-first-experiments-scry-performance-kernel-ryYbvT`：

- `2f338041` 等记录了Pi native ESM刷新边界。`new_session`或loader局部失效不能证明完整extension/config/auth重载；本轮不继续保留settled目录缓存。后续由Provider维护者先给出完整刷新合同，再决定常驻实现。现在保留fresh probe。
- `436d63d` 已冻结 `analytics.data-updated-unused` 测量，`9471221` 曾删除无人消费的全局stats/billing刷新。当前起点尚未包含对应代码。**本轮迁移既有测量和优化并重新验证，不把旧L1/L2冒充当前结果。** 历史固定负载是240个结果/工具、5次dataUpdated，不能缩小。

## 分阶段执行

| 阶段 | 范围、所有者 | 完成条件 | 状态 |
|---|---|---|---|
| 0 身份与计划 | agent：隔离cwd、依赖、源码与结果目录，核对既有实验 | 无他人WIP混入，测量与生产分别提交 | 已建立，计划待提交 |
| 1 删除无消费者计算 | agent：迁移上述统计刷新collector和最小生产变更 | 旧实现负对照；5轮L1；受锁L2；可见analytics刷新仍有效；UI/全量unit/type/build检查 | 下一步执行 |
| 2 证据写入窄切片 | agent：测量content突发、重复body、双authority写入、directory/file sync | 先定位实际成本；不改格式、不减fsync；必要才做批量准备/提交实验 | 待阶段1结束，计入本轮实验上限 |
| 3 查询与归档索引 | agent：固定40/400/4000轮与大账本；外部修改/删除/repair验证 | 先移除重复查询，再决定增量projection和专用执行进程；derived可重建、canonical不变 | 后续爬坡 |
| 4 Provider运行层 | agent + 上游维护者：完整刷新合同与隔离reload夹具 | 配置/模型/auth/extension/executable变化正确失效；再验证热目录收益、冷启动与驻留成本 | 原刷新边界阻塞，禁止重复旧假设 |
| 5 客户端增量 | agent：在写入点产生event revision，真正窗口化投影 | 固定大负载O(变化/可见)，重连、tombstone、选择、读屏、anchor不回归 | 后续爬坡 |
| 6 交付与L3 | agent准备产物；用户批准合入/安装并正常使用 | build→源码映射明确；每侧同场景≥30样本、≥2会话 | 未开始 |

原生桌面、blob pack格式迁移和常驻预热资源增加不在本轮自动实施范围。不是因为不够激进，而是先证明能解决当前瓶颈，再承担不可逆迁移成本。

## 单实验流程

1. 冻结 workload、源码/依赖身份与计时边界。测量代码、collector、workload变更单独提交。
2. 在旧实现上跑测量和敏感性检查；新检查应能识别真实重复工作。失败保留，不靠重试、sleep、超时放宽变绿。
3. 单假设最小实现。减少的工作必须说明去向：不再执行、合并、缓存命中或仅移出关键路径。
4. L1：对应collector至少5次；`npm run performance:measure -- --scenario <场景>`，必要时`--compare <测量提交>`。
5. L2：所有毫秒测量经 `node .agents/skills/scry-performance-climb/scripts/timing-run.mjs <标签> -- <命令>`。固定同负载，保留冷/热与首次操作；highLoad=true时毫秒结论不可信。
6. 验证：受影响测试、`npm run typecheck`、本项目普通代码检查；生产变更提交前全量`npm run test:unit`。UI变更加`npm run test:renderer:ui`及隔离当前App交互；不可用明确记录。
7. 台账只收紧：`npm run performance:propose -- <观测文件> --write`；跑ratchet tests与 `performance-ratchet.mjs guard`。candidate不擅自升门禁，不放宽上限。
8. 每个实验单独记录优化commit、验证范围、首轮失败、合入/构建/安装状态与baseline/candidate build。L1不冒充L2，旧L2不冒充本轮L2。

## 收尾与继续条件

每个假设最多3轮实现尝试；本轮最多3实验或约2小时。持续高负载时交付L1并明确L2未验证；不通过反复测速挑样本。遇到外部结果unknown、需要新费用/权限/格式决策时停下对应分支，不重放外部写入。

每轮更新此计划和原实验记录。未完成阶段由agent负责下一次继续，阻塞项写明依赖与解除动作。用户当前授权覆盖计划内的本地爬坡，不必逐个小修复再确认；仍保留上述明确的外部动作与迁移审批。
