---
name: scry-performance-climb
description: 维护 Scry 的性能闭环。用于：从本机日常性能记录（performance journal）找真实慢点；问“哪里慢、卡、等太久、最大机会在哪、还能往哪优化”；做性能爬坡，降低某个工作量计数或毫秒指标；维护性能台账、基线、门禁、相关性证据和机会日志；升门禁、收紧或放宽上限、补 Linux 基线。不用于：修 CI 账单或 runner、发布、真实付费 Provider 探针、与性能无关的功能开发或 bug。
---

# Scry 性能爬坡与维护

三种模式：**A 分析** → **B 爬坡** → **C 维护**。用户只说“看看性能/哪里慢”时执行 A，再给出 B 的方案但不改代码；明确要求优化才进入 B 的实现。

开始前读：`docs/performance-loop.md`（权威合同）、`docs/performance-opportunities.md`（当前排名与覆盖缺口）、`docs/performance-experiments/`（已做过的实验）。已证伪的想法不重做，除非写明条件已变。

## 环境

- 仓库根目录执行。Node 20/22/24（CI 用 22）；`node -v` 不符时用 nvm 切换，不要写死版本路径。
- 日常记录：packaged App 的 `~/Library/Application Support/scry/performance/`。只分析 `mode: packaged` 且 build 明确的记录；`ScryProviderRegression` 等其他目录是测试数据，不分析。
- 毫秒测速一律包一层锁：`node .agents/skills/scry-performance-climb/scripts/timing-run.mjs <标签> -- <命令>`。退出码 75 = 别的 agent 正在测速，稍后再试，**不要绕过锁**。结果行 `highLoad: true` 时毫秒结论只能写“高负载下测得，不可信”。工作量计数不需要锁。

## 权限：哪些可以自己做

| 自己做 | 先问用户 |
|---|---|
| 快照与分析日常记录（只读） | push、合入 main、发布、安装 |
| 在独立 worktree/treehouse 实验、本地提交 | **把 candidate 升为门禁**（附三项证据，等用户确认） |
| 新增 candidate 指标、`propose` 降低基线或上限 | 任何放宽：上限或基线升高、删除指标、改 tolerance |
| 跑工作量计数、受控毫秒基准、真实 App 基准 | 架构级改动：缓存、预热进程池、改 IPC 协议、移到 worker |
| 更新机会日志、写实验记录 | 打包 App + soak 等占用机器 10 分钟以上的任务 |
| | 修改日常记录的格式、保留策略或采集内容 |

## 硬规则

1. **指标诚实**：测不到写 `unavailable` + 原因，不记 0。不删断言、不 skip、不加大超时、不加 sleep/重试来变绿。首次失败保留。
2. **只降不升**：每个指标单独判定，一项变好不能抵消另一项变差。
3. **不拿安全和证据换速度**：不放宽 sandbox/CSP，不绕过 trust/fingerprint 重验。缓存必须正确失效；可能显示旧结果时必须标“刷新中/来源时间”，不能把旧 diff、旧用量当成当前事实。recorder core 保持无 Electron/SQLite/原生依赖；不能为提速让 recorder 在证据收敛前提交。
4. **测量安全**：临时目录、离线受控 Provider、只停自己启动的进程；不调付费 Provider；不在开发仓库驱动真实 Agent；Electron 测试隐藏窗口、保留 sandbox、不加 `--no-sandbox`。日常记录只读，先快照再分析，报告不粘贴会话内容或路径。
5. **一个 cwd 一个写者**；保留他人 WIP；默认只本地提交。
6. **构建与生效隔离**：在原实验记录登记优化 commit、合入/构建/安装状态和 L1/L2/L3。App 版本号不等于 build ID，不为每次优化自动升版本。先确认实际运行的 packaged build 再排当前热点；未部署的优化不能被旧日志判为回归。缺少映射写 `unknown`，详见[日常记录分析](references/journal-analysis.md)。

## 防止“数字变小但没变快”（agent 必读）

计数是替身，替身可以被骗。下面任何一种都算**作弊**，结果作废：

- 把工作挪到不被计数的地方：换调用方式、移到 worker/子进程、推迟到测量窗口之后、改成懒加载但首次使用照样等。
- 在同一个提交里同时改优化代码和测量代码（collector、`performance-counters.mjs`、相关性脚本、台账的 workload）。**测量改动必须单独提交**，并先在旧代码上证明它测得一致。
- 缩小固定负载或新建一个更小负载的指标来“替代”旧指标。
- 只报计数下降、不报毫秒。

每次宣称优化成功，报告必须回答：**减少的工作去了哪里？**（真的不做了 / 缓存命中 / 移出关键路径 / 合并了），并附毫秒证据（L2）。

## A. 分析

按 [journal-analysis.md](references/journal-analysis.md)：核对运行 build 与已有优化的交付状态 → 快照 → 选定当前 build，旧 build 另作历史对照 → `scripts/journal-hotspots.mjs` 排名 → 判断是否阻塞用户、归属（Scry/Provider）、已有覆盖、趋势。

## B. 爬坡

按 [climb-playbook.md](references/climb-playbook.md)：

1. 发散：每个慢点用 10 个视角各提至少一个想法（要大胆，包括架构级）；列出从未测量的地方。
2. 收敛：收益 × 置信度 ÷ 成本风险排序，选出此刻最大机会；违反硬规则 3 的直接否决并写理由。
3. 先测量：目标路径没有稳定计数就先加（单独提交）。
4. 单假设实验 → 验证（L1 计数、L2 毫秒）→ `performance:propose` 锁定 → 按手册模板写实验记录及交付状态；后续合入/构建/安装时更新原记录，不另建版本台账。

**收尾条件**（满足任一就停下汇报，不要无限循环）：

- 一个假设最多 3 轮实现尝试；仍无 L1 改善即记为“不成立”。
- 一次会话最多 3 个实验，或总耗时约 2 小时。
- 剩余机会都需要“先问用户”的授权。
- 机器持续高负载导致 L2 无法得出结论：交付 L1 结果并标“L2 未验证”。

## C. 维护

按 [metric-maintenance.md](references/metric-maintenance.md)：日常回归检查、`worse` 处置、新增指标、升门禁、放宽流程、Linux 基线、定期复核、覆盖缺口。

## 交付前的测试要求

- 改了生产代码：受影响测试 + `npm run typecheck`；提交前 `npm run test:unit` 全量。
- 改了界面：再加 `npm run test:renderer:ui` 和真实 App 重放（项目 CLAUDE.md 要求），截图/真机不可用时写“未验证”。
- 改了计数或台账：`npx vitest run scripts/performance-ratchet.test.ts` 和对应 collector；`performance-ratchet.mjs guard <旧台账> <新台账>` 必须通过。
- **已知的原有失败**（不是你造成的，也不要“修”它们来变绿，只需报告是否仍然存在）：高负载下 `src/main/source-control/service.test.ts` 的 push endpoint / PR recheck 用例、`src/renderer/remote-workbench.test.ts` 的 source-control 用例会 5 秒超时；同一用例在 main `1c30b76` 上同样失败；负载约 200 时 `src/main/providers/pi.test.ts` 的 “menu-only command” 用例出现过一次断言失败，单独重跑改动前后均通过。若出现新的失败，按自己的问题处理。

## 需要交给用户的步骤

agent 做不到时，明确写“到这里交给你”和具体动作：

- **L3 验证**：需要用户安装新版本并正常使用（同场景 ≥30 样本、≥2 会话），之后再运行 `npm run performance:report -- <快照> <旧build> <新build>`。
- **push / 合入 / 发布**：需要用户确认。
- **CI**：账单或 runner 问题由用户处理；CI 不可用时只能宣称本地结果。

## 输出格式

先一句话结论（最大机会是什么、验证到哪一级），然后：

- **慢点/机会表**：项 | 证据 | 预计收益 | 置信度 | 成本/风险
- **大胆想法**：按视角分组，标“可立即实验 / 需先测量 / 需用户决定”
- **本次改动与验证**：命令、前后数值、负载（`SCRY_TIMING_RUN`）、减少的工作去了哪里、优化 commit、合入/构建/安装状态、baseline→candidate build 与未验证项
- **需要你决定**：只列真正需要用户拍板的事项

中文、短句；区分“已测量事实”和“推测”。
