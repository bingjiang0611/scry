# 批次 G：Git 快照引擎（提案二）

分支 `perf/recorder-engine`，M 完成后开始。先读 [README.md](README.md)、[review.md](review.md) 第一节、[M.md](M.md) 的 oracle 场景。

每个条目的固定流程：

1. 用 M 的计数工具在当前代码上记下该条目相关场景的基线（如果 M 的基线已覆盖，引用即可）。
2. 改代码，单独提交。
3. 跑 oracle（`git-snapshot-oracle.test.ts`）全部通过，再跑计数，记录前后对比。
4. 结论写进 `reports/G1.md` 或 `reports/G2.md`。

---

## G1：同一轮内不重复做

### G1-1 复用 discovery index 构建 afterTree（review F1）

**改法方向**：`git-compute.ts` 的 targeted 路径不再 `rm after.index` + `read-tree <beforeTree>`，而是把发现阶段已刷新的 `discovery.index` 复制成 `after.index`（保留时间戳，用 `copyIndexWithTimestamps`），在它上面 `add -A -- <候选>` + `write-tree`。

需要证明并在报告里写清楚：

- discovery.index 的内容此时确实等于 beforeTree（可以加一个只在测试中启用的断言：`write-tree` 结果 == beforeTree）。
- sparse checkout（O6）：discovery 在这种仓库里走 `read-tree --reset` 分支，skip-worktree 范围外的路径不能被 `add -A` 当成删除。
- `.gitignore` / `.gitattributes` 变化（O8）：现有代码在候选里出现这些文件时直接走全量回退（`changesGitSemantics`），保持不变。
- 为什么不直接在 discovery.index 原地修改：同一 capture 可能被预览和终态共用（`serializeCaptureOp`、`sharedAfter`），原地改会破坏另一次计算的前提。如果你判断原地修改安全，给出理由和测试。

**完成标准**：oracle 全部通过；S2、S4 结束阶段 `read-tree` 次数减 1、git 进程数减 1，`after.index` 写入字节下降（报告给出数字）。

### G1-2 合并 numstat 与 name-status（review F2）

**改法方向**：一次 `git diff --no-renames --no-ext-diff --no-textconv --raw --numstat -z <before> <after> -- <pathspec>`，新写一个解析函数同时产出变更类型和行数。保留旧的 `parseNumstat` / `parseNameStatus`（其他调用方还在用，例如 `git-workspace.ts`），除非你确认没有其他调用方。

**测试**：给新解析器写针对 `-z` 组合输出的单元测试，覆盖 O11（特殊文件名）、O12（二进制 `-\t-`）、类型变化（`T`）、gitlink。

**完成标准**：oracle 全部通过；有改动的轮次结束阶段 `diff` 进程数从 2 降到 1。

### G1-3 多仓库有界并发（review F4）

**先测再决定**。这条只靠 L1 计数说明不了问题（进程总数不变），需要 L2 毫秒：在 S6 上分别用并发上限 1、2、4、8、不限，经 `.agents/skills/scry-performance-climb/scripts/timing-run.mjs` 加锁串行测量开始和结束阶段的墙钟时间，每组 ≥10 次，报告中位数和 p90、机器型号与负载。

- 如果差异在噪声内，**放弃**，写明数据。
- 如果有界并发更快，再改。注意 **deadline 的计算起点**：现在每个 `beginGitTurnDiff` 的 5 秒 deadline 从它自己被调用时开始算；排队后起点会推迟，整个 hook 可能超出 Provider 的超时预算（Claude Stop 15 s、其他 10 s、SessionEnd 3 s）。deadline 必须从 hook 开始时统一计算，排队等待也计入；超时的仓库照常标 `timeout`，不能静默缺席。

### G1-4 大 patch 的内存峰值（review F5）

**先测** S5 的峰值 RSS。只有当峰值明显超过「基线 RSS + 单个 patch 大小」时才改成流式读取与切分（`git-patches.ts` 314 行起）。改动必须保持现有的字节预算、截断标记（`patchStatus` / `patchReason`）和逐文件匹配语义；oracle 的 patch 逐字节比较必须通过。

---

## G2：跨轮复用

### 进入条件（由你根据 G1 之后的计数自行判断）

在 G1 完成后的代码上看 S3（dirty 基线）和 S6（多仓库）：如果「开始 + 结束」阶段里，**下一轮本可以复用上一轮结果**的工作（重复 hash 未变化的 dirty 文件、重复探测未变化仓库的布局与配置、重复 `read-tree --reset HEAD`）占 git 进程数或 hash 字节数的 **30% 以上**，进入 G2；否则**放弃 G2**，在报告里给出数字。放弃是合格结果。

### 范围限制

- **只在 daemon 进程里启用**跨轮状态。CLI 直写路径（`SCRY_RECORDER_TRANSPORT=direct`、冷启动）保持现有实现不变，它同时是 G2 的对照组。
- 跨轮状态放在 recorder 的数据目录下（`.scry/` 里，已被 capture 排除），或 daemon 内存里。不写用户的 `.git`。
- 必须有上限：每个仓库的私有 index + 对象占用设硬上限（建议 256 MB，可配置），超出即整体丢弃重建；daemon 退出或重启后，磁盘上的状态必须先校验再用，校验不过就丢弃。

### G2-1 索引种子（核心，风险最高）

**目标**：dirty 基线的仓库，每轮开始时不再重新 hash 所有自上一轮以来**没变过**的未提交文件。

**正确的做法**：把上一轮该仓库的私有 after index 当作**stat cache 种子**，而不是当作开始树。下一轮开始时，在种子副本上执行 `update-index --really-refresh` + `add -A -- <pathspec>` + `write-tree`。Git 会对每个条目比对 stat，变化了的重新 hash，新增和删除照常处理，所以得到的仍然是**当前工作树**的真实树。

**种子只在以下条件全部相同时可用，任一不同就走现有路径**：

- HEAD（scope 之外的条目来自 HEAD；HEAD 变了，种子里 scope 外的内容就是错的）
- repoRoot、scope、pathspec、排除路径
- sparse checkout 规则文件的身份（O6）
- filter 覆盖参数（`loadSnapshotOverrides` 的结果）
- `.gitattributes` / `.gitignore` / `info/exclude` / `core.autocrlf` 等影响内容转换和忽略规则的输入（可以用文件身份 + 相关 config 值做键；拿不准的输入就当作「变了」）
- 种子 index 文件本身的身份与时间戳（racy-clean 依赖 index mtime；必须用 `copyIndexWithTimestamps` 复制）

**禁止**：直接把上一轮的 afterTree 当作这一轮的 beforeTree；用 watcher 或工具声明的路径代替全量 stat 比对。

**完成标准**：

- oracle O15、O16 用「全新 `writeSnapshotTree`」作对照，种子路径结果完全一致；O2（同大小同 mtime）在两轮之间发生时也一致。
- 加一个专门的测试：两轮之间外部修改 1 个文件、删除 1 个、新增 1 个、切换分支各一次，种子路径和对照路径一致，并且分支切换时确认种子被丢弃。
- S3 开始阶段 `add -A` hash 的字节数下降（报告给出数字），git 进程数不增加。

### G2-2 私有对象库跨轮保留

种子 index 引用的 blob 必须在新一轮可见。可以让新一轮的私有对象目录通过 `GIT_ALTERNATE_OBJECT_DIRECTORIES` 引用上一轮保留的对象目录，或者保留一个按仓库的长期对象目录。

- 多个会话同时用同一个仓库时，对象写入本身是原子的（tmp + rename），但**回收**不能删掉仍被活动 capture 引用的对象。建议按「代」分目录，只回收没有活动 capture 引用的代。
- 写清楚回收策略与上限，并测「回收与新一轮开始并发」的情况。

### G2-3 布局与配置缓存（review F3，收益可能较小，先测）

`rev-parse` 布局、filter 配置、仓库发现（`discoverRepositories`）的结果可以在 daemon 里缓存，但每次命中都要用文件身份校验：

- 布局：仓库根和 gitdir 的 realpath + stat 身份。
- filter 配置：所有生效配置文件（仓库、worktree、全局、XDG、系统）的身份；只要出现 `include` / `includeIf`，就不缓存。**结束阶段的 filter 重扫是安全要求**（防止新加入的 clean/process filter 执行副作用命令），只有在能证明配置文件一个字节都没变时才能跳过。
- 仓库发现：遍历过的每个目录的身份；任何一个变了就重新遍历。

如果测下来每轮只省 1–2 个进程、毫秒在噪声内，**放弃**这一条即可。

### G2 的报告额外要求

- 一张「失效条件 → 处理方式」表，逐条对应上面的种子条件。
- daemon 重启、磁盘状态损坏（截断的 index、缺失的对象）时的行为与测试。
- 磁盘占用的实测上限。
- 是否需要 `scry recorder restart` 才生效（应当需要，因为改的是 daemon）。
