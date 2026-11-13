# 代码事实核对（main@50bd720，CLI 0.2.59）

审查方逐条对照源码核对了用户报告里的代码事实。行号以 `50bd720` 为准，执行前请先在当前分支 HEAD 上读回确认。下面只写**代码确认的事实**和**由此推出的线索**；耗时影响都没有测过。

## 一、Git 快照（提案二）

### F1 同一轮内 discovery index 被丢弃后重建（已确认）

`src/core/turn-recorder/git-compute.ts`

- 发现阶段（约 185–238 行）：把可复用的启动 index（`capture.beforeIndex` 或未被改写的真实 index）复制成 `discovery.index`，执行 `update-index --really-refresh`，再 `status --porcelain=v1`。此时 discovery.index 的内容等于 beforeTree，stat cache 是热的。
- 构建阶段 `writeTargetedSnapshotTree`（90–104 行，250 行调用）：先 `rm` 掉 `after.index`，再 `read-tree <beforeTree>` → `add -A -- <候选>` → `write-tree`。
- 也就是说，`read-tree` 会把整棵 beforeTree 重新展开成一个**没有 stat 信息**的新 index，成本随已跟踪文件数线性增长；发现阶段刚刷新好的 index 没有被利用。
- 例外已经存在：候选为 0 时（241–247 行）直接沿用 discovery.index。

**线索**：在 discovery.index 的副本上直接 `add -A -- <候选>` + `write-tree`，可以省一次 `read-tree` 和一个 git 进程。需要证明的点：sparse checkout（此时 discovery 走的是 `read-tree --reset`，skip-worktree 位的处理要单独验证）、`assume-unchanged` 已被 `--really-refresh` 清掉、racy-clean 时间戳语义（`copyIndexWithTimestamps` 的注释）。

### F2 两次 diff 可以合成一次（已确认）

`git-compute.ts` 318 行起：`Promise.all` 并行跑 `diff --numstat -z` 和 `diff --name-status -z`，参数相同，只是输出格式不同。Git 支持在同一次调用里同时输出 `--raw` 和 `--numstat`。**线索**：合并后少一个进程和一次树对比；解析器 `parseNumstat` / `parseNameStatus`（`git-patches.ts` 418–446 行）需要改为解析组合输出，`-z` 下的格式要逐字节测试（包括含空格、换行、非 UTF-8 的路径，二进制文件 `-\t-`）。

### F3 每轮都从头发现仓库并探测布局（已确认）

- `recorder-turn-state.ts` 约 84–95 行：每次开始一轮都调用 `discoverRepositories`（`config.ts` 226 行，递归 `readdir` 到 `maxDepth`，默认 2），然后对每个仓库调用 `beginGitTurnDiff`。
- `git-capture.ts` `beginGitTurnDiff`（222 行起）：每个仓库都跑 `rev-parse`（布局）+ `status --porcelain=v2`（并行），`mkdtemp` 一个新私有目录，dirty baseline 时再跑 `config --get-regexp`（filter 配置）+ `writeSnapshotTree`（`read-tree --reset HEAD` → `update-index --really-refresh` → `add -A` → `write-tree`，见 `git-command.ts` 107 行起）。
- 结束时 `computeGitTurnDiff` 又跑一次 `config --get-regexp`（注释说明：配置可能在本轮中变化，必须重扫）。

**线索**：布局和 filter 配置可以在 daemon 里按 `(repoRoot, .git/config 的 stat, info/sparse-checkout 的 stat, HEAD)` 缓存；但结束时重扫 filter 配置是**安全要求**（防止新加的 clean/process filter 执行副作用命令），缓存命中必须以文件身份未变为前提，不能省掉校验。dirty baseline 每轮都要重新 hash 所有未提交改动，这是跨轮复用的主要机会。

### F4 多仓库无上限并发（已确认）

`recorder-turn-state.ts` 91 行（开始）、`recorder-turn-finalize.ts` 100/115 行、`recorder-hook-locked.ts` 215 行（结束/预览）都是 `Promise.all(repositories.map(...))`，没有并发上限。18 个仓库时会同时起几十个 git 进程。**线索**：先测，再决定是否加有界并发；更快与否取决于磁盘和 CPU，不能假设。

### F5 完整 patch 批次整体读进内存（已确认，影响待测）

`git-patches.ts` 314 行：`completePatches` 模式下 `readFile(patchPath)` 一次读入一个批次（最多 128 个文件，`PATCH_BATCH_MAX_FILES`）的完整 diff 输出，之后切分。`gitCommand` 的 `maxBuffer` 是 16 MB（`git-command.ts` 35 行），但 patch 走的是 `--output=<file>`，不受这个上限约束。**线索**：一个 50 MB 文本文件的改动会让峰值内存至少多出 patch 大小。先测峰值 RSS 再决定是否改成流式。

## 二、recorder 执行与持久化（提案三）

### F6 transcript 稳定性检查至少等待 25 ms，锚点从尾部向前扫描（已确认）

`recorder-transcript-cache.ts`

- `stableTranscript`（219 行起）：先 `stat`，等 25 ms，再 `stat`，大小相同才算稳定，最多 3 次。**每次调用至少 25 ms 的固定等待**，在轮次结束和恢复路径上。
- `transcriptAnchorOffset`（118 行起）：从文件末尾每次读 1 MB 向前扫，逐行转 UTF-8 字符串判断锚点；找不到锚点时会扫到文件开头。
- 缓存（182 行起）以 `(path, offset, dev, ino, size, mtime, ctime, …)` 为键，只缓存 8 条，进程内有效；**文件一追加内容键就变了**，于是重新解析整个窗口。

**线索**：保存 `(文件身份, 已消费偏移, 不完整尾行, 解析状态)`，追加时只解析新增部分；替换、截断、身份变化时明确全量重放。25 ms 等待的必要性需要单独论证，不能直接删。

### F7 每次提交都在锁内全量列出 records 目录（已确认）

`store.ts` `commitRecord`（37 行起）：持有 `locks/commit.lock`，`recordFiles(dataRoot, { bypassIndex: true })` 全量扫描 records 目录做重复检测和序号分配，注释明确要求**不信任派生投影**。归档（`store-archive.ts` 125 行）竞争同一把锁。**线索**：锁内耗时随历史条数线性增长。这是有意的安全设计，改它属于「必须停下」第 1 条；本次只允许**测量**并写设计说明。

### F8 恢复路径遍历全部会话目录（已确认）

`recorder.ts` `runtimeSessions`（133 行起）对 5 个 Provider 的 `runtime/<provider>/` 做 `readdir`，`recoverRecorder`（151 行起）逐个会话检查 inbox 与 open 状态。daemon 会周期性调度恢复（`daemon.ts` `scheduleRecovery`）。**线索**：会话目录积累越多，每次恢复越慢；可以考虑「脏会话」标记，但必须保证崩溃后仍能找回所有未完成会话。

### F9 正文内容寻址与重复写（已确认，影响待测）

`content-store.ts`：`writeRecorderContent` / `writeRecorderContentBatch` / `writeRecorderContentCopies` 已经按 sha256 去重，并有进程内已校验缓存（`rememberVerified`，19–31 行）。复用已有文件时仍会读回比对并 `syncDirectory`（37–40 行，66 行注释说明这是为了补上一次失败的目录同步）。**线索**：同一批里相同正文的哈希、读回和目录同步可以合并一次；但「读回比对」是损坏检测，不能删。

### F10 普通事件写入使用 `sync: false`（已确认）

`recorder-turn-state.ts` 95/180/210/216/219 行、`recorder-hook-locked.ts` 98/193 行等共 17 处（不含测试）。开始/终态边界已在可靠性批次 A3 改为 sync。**含义**：引入统一持久日志会**增加**每个事件的 fsync，低负载下单事件不会更快；这正是 R 批次只做测量和设计说明的原因。

## 三、已经存在、不能重复实现的东西

daemon + Unix socket、socket 长路径哈希（`daemon-transport.ts` `recorderSocketPath`）、定向快照（targeted）与全量回退、`#25` 的启动 index 复用、正文内容寻址、transcript 快照缓存、会话锁、inbox 与失败隔离、record 索引缓存（`store-index.ts`）。优化应当建立在这些之上。
