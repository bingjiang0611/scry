# 工作区 numstat 只读路径（批次 C）

## 测量基线

- 生产基线：`bf92d04`；测量单独提交（本文件随测量代码提交）。
- 命令：`npm run build:cli`；`node .agents/skills/scry-performance-climb/scripts/timing-run.mjs c-workspace-baseline -- npm run bench:git-diff -- --workspace-numstat`。
- 固定负载：9 / 5001 tracked 文件，1 修改、1 删除、3 未跟踪（含空文件、中文路径），ignored `.scry/noise.txt`。每组一次预热、6 个正式样本。断言 5 条 diff、真实 index 字节不变。显式 excludedPaths 另由等价性测试覆盖。
- 两组每次均 8 个 Git spawn、4 个新 loose objects（3 blob + 1 tree）。对象数由 pass-through execFile 包装在 cleanup 前枚举隔离对象目录并读取 object header；不是把 `write-tree` 调用次数冒充对象数。
- Git 没有提供全部内容哈希次数，`hashOperations=unavailable`；新写入 blob 数不是所有哈希操作数（去重、只读哈希不计）。
- 小仓库 p50 236.95ms，大仓库 p50 281.87ms。8 核，load 17.39→15.96，`highLoad=true`，**这些毫秒不能作为可靠 L2 基线**。原始记录 `/tmp/scry-c-baseline.log`。

## 假设与选型

只读视图无需可持久 before tree。候选用临时 HEAD index（不是用户 index）直接读工作树 diff，单独有界统计未跟踪文件；移除 add、write-tree、隔离对象库。保留 recorder 全部实现。

| 视角 | 选择 |
|---|---|
| 根本不做 | 不再创建 before tree / blob 对象（本轮） |
| 只做一次 | 同 canonical cwd 合并进行中请求（本轮）；不缓存已完成结果，避免工作树无法廉价失效 |
| 提前做 | 不预热，避免后台无需求扫描 |
| 推迟做 | 不推迟取证或提前报告完成 |
| 换地方 | 不引入 worker，先删工作 |
| 更便宜 | 临时 HEAD index + diff / ls-files，正确处理 staged、assume-unchanged 等 index 影响 |
| 少做几次 | in-flight 合并，不新增轮询 |
| 先显示 | 刷新时保留旧结果，明确标刷新中/来源时间 |
| 算法 | 未跟踪文件有界读取，不哈希/写对象 |
| 架构 | 常驻 Git / FSEvents 不在本批引入 |

与 20261016 的既有 8-spawn 门禁、20261017 Service.diff 双 revision 实验不同：本轮仅 agent:gitDiff；不改变 readWorkspaceGitDiff / SourceControlService / recorder。

## 交付状态

优化源码 `0dcd7fe`；测量提交 `26cca06` + `c2802e1`。第二个只补计数对真实仓库对象的观察，不含生产改动。未合入、未安装、无 L3；用户日常 App 未改变。已构建 App 0.2.219 / CLI 0.2.51 的隔离测试用途产物，无发布/安装 build 身份声明。

## 最终结果（冻结源码）

| 固定规模 | Git spawn | unique objects written | p50 baseline → candidate |
|---|---:|---:|---:|
| 9 tracked / 5 dirty | 8 → 8 | 4 → 0（3 blob + 1 tree → 0） | 277.29 → 224.18ms（-19.2%） |
| 5001 tracked / 5 dirty | 8 → 8 | 4 → 0 | 289.90 → 218.83ms（-24.5%） |

这是 **L1 对象写入减少 + 固定 API 场景受控 L2**，不是单次进程数下降，也不是日常 L3 或屏幕绘制收益。6 个正式样本，baseline/candidate 同锁串行；8 核 load 6.81→6.63，`highLoad=false` 但非空闲机，不承诺在别的仓库/负载重复该百分比。全部样本（包括高负载和被否决的初版）保存在[JSON](20261022-workspace-numstat-readonly.json)，只把 `frozen-*` 作为最终源码结果。

复现：`npm run build:cli`，在 `node .agents/skills/scry-performance-climb/scripts/timing-run.mjs <label> -- ...` 锁内，分别设置 `BENCH_IMPL=gitNumstat` / `BENCH_IMPL=readWorkspaceNumstat` 执行 `npm run bench:git-diff -- --workspace-numstat`。最终日志 `/tmp/scry-c-frozen-{baseline,candidate,timing}.log`。

### 被否决的初版

裸 HEAD index 没有用户 index 的 stat hints，大仓库会重读大量未变文件（高负载候选 p50 1439.13ms，不用于 L2）。它也与旧路径保留 skip-worktree 的行为不同。最终复制 index 并保留时间戳，避免这项退化；不再生成快照对象。特殊 index 标记、属性 fallback、规范化和子模块无法严格等价的项均明确 unavailable，不用额外副作用或假空列表隐藏。

### 实现边界

- 只给 agent:gitDiff 使用新读路径；recorder、readWorkspaceGitDiff、SourceControlService、managed recorder 不改调用链。共享 loader 仅增加可选预载配置，旧默认调用行为不变，旧函数体 AST 比较通过。
- 临时 index 写入仍存在；不写真实 index/object store，不 add/write-tree。未跟踪内容总量 16MiB、最多1000条变更、路径输出128KiB、Git输出16MiB、5秒预算；超出 unavailable/timeout。
- filter clean/process/required、fsmonitor、hooks、ext-diff/textconv 均禁用；配置键中的 filter subsection 保留大小写。禁止 lazy-fetch，缺失 promisor 对象失败而不执行仓库 remote helper。
- canonical cwd 仅合并进行中请求；不缓存已完成结果。HEAD/index 无法使任意工作树编辑可靠失效，因此不采用方向中的 TTL 缓存。刷新保留同工作区结果且标来源/刷新中；旧 cwd/旧 seq 不覆盖。
- assume-unchanged/skip-worktree、暂存属性变化、需要转换的未跟踪文件/命名 diff driver、变化的子模块、特殊文件类型明确 unavailable + reason。升级这些范围时先增加 oracle 等价性与副作用拒绝测试，不静默回退 recorder 快照。

## 验证与剩余项

- 最终全量 unit **3711 pass / 4既有 opt-in skipped**，含新增11项只读验收、IPC合并/权限测试、50项旧Git与10项terminal-pair，以及全部recorder。typecheck、CLI build、ratchet/feedback24项与不变台账guard通过。
- source-control 真实隔离 App + Git UI 通过，新增生产 agent:gitDiff 未跟踪内容/index不变断言。workspace-only renderer UI、完整 dev安全/fake-provider冒烟通过。
- 完整 renderer UI **未全绿**：先有 SQLite Node/Electron ABI不匹配（已以独立 Electron ABI 构建解决），后为 chat-preview/workspace dirty 超时；在原基线 `bf92d04` 同依赖的 detached worktree 完全复现。剩余11组UI逐组原命令通过，不冒充复合入口通过，不扩大超时或删除断言。
- 初轮3项focused失败、首轮full特殊index失败和hook负对照失败均保留；最终统一合同后通过。lazy-fetch测试含真实Git调用fixture helper的敏感性控制，生产路径不触发。
- `performance:measure --scenario source-control.diff` 既有gate为8 pass，total8 unchanged，无worse；它不是新numstat路径的计数，新增路径由冻结bench取证。workspace.files目前无collector。不改ratchet、不升门禁。
- 逐条红线、完整命令、失败和范围见[批次报告](../handoff/perf-2026-10-22/reports/C.md)。后续由审查方核验、维护者决定合入；workspace/UI维护者另案处理基线同样失败的dirty标记。Linux、其他Node/Git、真实Provider、安装与L3未验，不扩大本批宣称。
