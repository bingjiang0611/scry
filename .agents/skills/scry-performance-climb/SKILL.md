---
name: scry-performance-climb
description: 维护 Scry 的性能闭环：从本机日常性能记录（performance journal）找出真实慢点和最值得优化的地方；围绕工作量计数与毫秒基准做大胆的性能爬坡（找未探索的方向、提出并验证假设、锁定收益）；维护工作量台账、基线、门禁、相关性证据和机会日志。用于“哪里慢/最大机会在哪/做性能爬坡/降低某个指标/维护性能指标或台账/升门禁/放宽上限/补 Linux 基线”。不用于修 CI 账单或 runner、发布、真实付费 Provider 探针、与性能无关的功能开发。
---

# Scry 性能爬坡与维护

三种模式，可单独或连续执行：**A 分析** → **B 爬坡** → **C 维护**。用户只说“看看性能”时按 A→B（只出方案）执行；要求改代码才进入 B 的实现步骤。

开始前读 `docs/performance-loop.md`（权威合同）与 `docs/performance-opportunities.md`（机会日志：已试过什么、结果如何）。不要重复已证伪的实验，除非说明条件已变。

## 硬规则（任何模式都不能破）

1. **指标诚实**：测不到就是 `unavailable` + 原因，绝不记 0；不删断言、不 skip、不加大超时、不加 sleep/重试来“变绿”。首次失败保留。
2. **只降不升**：门禁上限与 candidate 基线只能自动降低；升高/删除必须有 `raise` 记录 + 维护者批准（PR 标签 `performance-raise-approved` / 本地 `SCRY_PERF_RAISE_APPROVED=1`）。每个指标单独判定，不能用一项变好抵消另一项变差。
3. **不拿安全和证据换速度**：不放宽 renderer sandbox/CSP，不绕过 trust/fingerprint 校验，不为省时间跳过授权重验。缓存必须保证正确失效；若可能显示旧证据，必须带新鲜度/来源标记，不能把旧 diff、旧用量当作当前事实。recorder core 保持无 Electron/SQLite/原生依赖。
4. **测量安全**：临时目录、离线受控 Provider、只停自己启动的进程；不调用付费 Provider，不在当前开发仓库驱动真实 Agent。日常记录只读：先 `snapshot` 复制再分析，绝不修改或上传 userData；报告中不粘贴会话内容或路径细节。
5. **测速串行**：毫秒基准、真实 App、soak 一次只跑一个，并记录 `uptime` 负载；工作量计数可并行。
6. **隔离写入**：改代码在独立 worktree（或 `treehouse`）中进行，一个 cwd 只有一个写者；保留他人 WIP。默认只本地提交，push/合入 main 需用户确认。
7. **验收梯度**：计数下降只是方向信号。宣称“变快”至少需要受控毫秒基准或真实 App 证据；宣称“用户变快”需要发布后同场景日常记录对比（≥30 样本、≥2 会话，见 `performance-report.mjs report`）。达不到就如实写“未验证”。

## A. 分析：从日常记录找慢点

按 [journal-analysis.md](references/journal-analysis.md) 执行：

1. 复制快照：`node scripts/performance-report.mjs snapshot "$HOME/Library/Application Support/scry/performance" <快照目录>`，并把快照归档（日志只保留约 20 MB，约数小时）。
2. 列出 build，逐个生成单 build 基线：`node scripts/performance-report.mjs baseline <快照> <build> <out.json>`。
3. 排名：`node .agents/skills/scry-performance-climb/scripts/journal-hotspots.mjs <out.json...>`。
4. 对排名前几项判断：是否阻塞用户（还是后台）、Scry 代码还是 Provider 模型耗时、是否已有计数/基准覆盖、与上次快照相比的趋势。

输出：慢点表（路径、操作、p50/p95、样本数、是否阻塞、归属、证据成熟度）+ 未被观测的路径 + 数据本身的局限。

## B. 爬坡：找最大机会并降低指标

按 [climb-playbook.md](references/climb-playbook.md) 执行：

1. **发散（要大胆）**：对 A 的每个慢点，用手册里的 10 个视角各提至少一个想法，包括需要改架构的。同时列“从未测量过的地方”（未观测路径、无计数的热点、未覆盖的 Provider）。
2. **收敛**：按「可节省的用户时间 × 置信度 ÷ 成本与风险」排序，标出**此刻最大机会**与理由；违反硬规则 3 的想法直接划掉并说明原因。
3. **先测量再优化**：目标路径没有稳定计数时，先加计数（collector + 台账 candidate + 基线），再动生产代码。
4. **单假设实验**：写下“改 X → 指标 M 从 a 降到 ≤b，用户耗时预期降 c”，在隔离 worktree 实现，最小改动。
5. **验证**：`npm run performance:measure -- --compare <基线提交>`（无 `worse`、目标 `better`）→ 受控毫秒基准或 `performance-native.mjs bench` → 相关测试/typecheck。
6. **锁定**：`npm run performance:propose -- <candidate.json> --write`，台账与代码同一提交。
7. **记录**：无论成败，都写进 `docs/performance-opportunities.md`（假设、数据、结论、下一步）。失败的实验同样有价值。

## C. 维护指标

按 [metric-maintenance.md](references/metric-maintenance.md) 处理：日常回归检查、`worse` 处置、新增指标、升门禁（稳定/敏感/相关三项证据）、放宽流程、Linux 基线、相关性证据复核、覆盖盲区。

## 输出格式

先一句话结论（最大机会是什么、验证到哪一级），然后：

- **慢点/机会表**：项 | 证据 | 预计收益 | 置信度 | 成本/风险
- **大胆想法**：按视角分组，标注“可立即实验 / 需先测量 / 需架构决策”
- **本次改动与验证**（若有）：命令、前后数值、负载、未验证项
- **需要你决定**：只列真正需要用户拍板的事项（授权、架构取舍、放宽上限）

中文、短句；区分“已测量事实”和“推测”。
