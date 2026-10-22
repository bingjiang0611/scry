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

候选实现、验证、L1/L2 结果待追加。无台账放宽、无升门禁。未合入、未安装、无 L3；用户日常 App 未改变。
