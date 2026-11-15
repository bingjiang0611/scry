# Claude 历史分页：真机验证交接（2026-11-15）

## 协作方式

- **执行方**（另一个 agent，在用户的 macOS 宿主上运行，非 root）：按本文完成 T1–T6，**尽量一次做完、自行验证**，把报告与证据推送到同一分支。
- **核验方**（Claude，原会话）：拉取分支，按报告逐项复核；有问题写进报告末尾「核验意见」，执行方据此再推送。
- 分支：`claude/vibrant-planck-l2d4dh`（基线 `a464aff`）。**只推送这个分支**；不推 main、不开 PR、不合入、不安装到 `/Applications`。
- 遇到阻碍不要停下来问：记录证据、标「阻塞」，继续其他任务。只有下文「需要用户决定」的事项才停下。

## 被验证的改动

| 提交 | 内容 |
|---|---|
| `ffe1ec7` | Claude（有 transcript）历史按窗口读取归档正文，不再每次读取全部轮次 |
| `45426df` | Claude 首页默认 10 轮（与 Pi/Codex 一致） |
| `bb38e13` | 合并计划只合并窗口内位置；缓存不留原始 transcript；重复 runId 回退全量；更早页 20 轮且可取消；历史路径的进程内“已校验内容”记忆（维护者已批准） |
| `101fa58` | 移除会话历史横幅（维护者决定：无论耗时都不显示）；更早页失败经 composer 错误显示 |
| `ab1c52d` 及之后 | 文档、opt-in Node 基准 `scripts/claude-history-paging-bench.test.ts` |

背景与已测数据：[实验记录](../../performance-experiments/20261115-claude-history-paging.md)。核心文件：`src/main/transcript-archive-paging.ts`、`src/main/session-history.ts`（`sessionMergePlan`/`mergeSessionTurnAt`）、`src/main/bootstrap/history-{archive,load,older,runtime}.ts`、`src/main/trace-tool-content.ts`（`persistHistoryToolEvents`）、`src/renderer/components/ChatView.tsx`、`src/renderer/app-queue-actions.ts`。

原容器未验证的内容（这正是你要补的）：真实 Electron App（容器以 root 运行，Electron 拒绝无 `--no-sandbox` 启动）、renderer UI 脚本、macOS APFS 上的 fsync 成本、真实 Claude transcript 文件读取与解析耗时。

## 硬约束

读仓库 `CLAUDE.md` 与 `.agents/skills/scry-performance-climb/SKILL.md`，特别是：

1. 不加 `--no-sandbox`，不放宽 CSP/sandbox；Electron 测试用独立 `userData`、临时 HOME/工作区、隐藏窗口；不碰用户正在运行的实例。
2. 毫秒测量一律串行经 `node .agents/skills/scry-performance-climb/scripts/timing-run.mjs <标签> -- <命令>`；退出码 75 表示锁被占用，稍后重试，不绕过。`highLoad: true` 的毫秒只能写“高负载下测得，不可信”。
3. 不调用付费/真实 Provider；不在开发仓库驱动真实 Agent。
4. 不手改 `scripts/performance-ratchet.json`，不删断言、不 skip、不加大超时/sleep/重试来变绿；首次失败如实保留。
5. 用户真实数据（`~/Library/Application Support/scry`、`~/.claude`）只读，且只在 T6 使用；报告不粘贴会话内容、prompt 或真实路径，只写计数与耗时。
6. 提交身份：`git -c user.name=bingjiang0611 -c user.email=307659028+bingjiang0611@users.noreply.github.com commit ...`，提交后核对 `git log -1 --format='%an <%ae>'`。
7. **测量代码与优化代码分开提交**；不缩小基准负载来让数字变小。

## 你可以自主做的修复（无需再问）

在下列范围内发现的问题可以直接修，前提是：先写一个在旧代码上失败的测试 → 修复 → 测试通过 → 做负对照（撤掉修复确认测试失败）；每个修复单独提交，报告写明。

- 本次改动引入的正确性/回退问题（上表文件）。
- 本次改动的 UI 检查脚本 `scripts/loading-ui-checks.mjs`、`scripts/session-cache-ui-checks.mjs` 中由“横幅已移除”导致的断言问题。断言意图必须保持：**任何时长都不出现历史横幅**、预览/锁定/无旧权威内容这些合同不变。

**需要用户决定、不要自己做**：悬停/按下预取；提高 transcript 缓存上限；改 recorder 写入/fsync 策略或扩大“已校验内容”记忆的使用范围；任何权限、trust、证据语义变化；把 candidate 升为门禁。发现需要这些的，写进报告「建议」。

## 任务

每个任务写明：命令、退出码、耗时、负载、结果、证据文件。全部证据放 `docs/handoff/claude-history-paging-2026-11-15/evidence/`（JSON/日志/截图；截图 deviceScaleFactor 2）。

### T1 门禁（macOS，必须）

```bash
git fetch origin claude/vibrant-planck-l2d4dh && git checkout claude/vibrant-planck-l2d4dh && git pull
```

```bash
npm ci
```

```bash
npm run typecheck
```

```bash
npm run test:unit
```

```bash
npm run test:renderer:ui
```

通过标准：typecheck 通过；unit 无新增失败（如有失败，在 `a464aff` 的独立 worktree 上重跑同一文件，基线也失败的标“既有”）；renderer UI 全部通过，**尤其** `session-capability-ui-smoke.mjs --loading-only` 与 `--structure-only`（含 session-cache 检查）。失败先判断是改动问题还是既有问题，属于“可自主修复”范围的就修。

### T2 Node 级 L2 复测（macOS APFS）

对 100、200 轮各跑一次（经 timing lock），JSON 存到 evidence：

```bash
SCRY_CLAUDE_HISTORY_BENCH=1 BENCH_TURNS=100 SCRY_CLAUDE_HISTORY_BENCH_OUT=docs/handoff/claude-history-paging-2026-11-15/evidence/node-bench-100.json node .agents/skills/scry-performance-climb/scripts/timing-run.mjs claude-history-100 -- npx vitest run scripts/claude-history-paging-bench.test.ts
```

报告 complete / pagedCold / pagedWarm 中位数，并与 Linux 容器数据（100 轮 3655/263/128 ms，200 轮 7632/308/159 ms）对照，说明 APFS fsync 是否明显更贵。

### T3 真实 App L2：Claude 会话打开（核心任务）

现有 `scripts/session-open-bench.mjs` 只覆盖 v3 单体 Codex 归档，不覆盖本路径。新建独立脚本 `scripts/claude-session-open-bench.mjs`（单独提交，属于测量代码），参考 `session-open-bench.mjs`、`session-open-fixture.mjs`、`session-open-timing.mjs`：

- **夹具**：临时 HOME + userData + 工作区。写真实格式的 Claude transcript JSONL（位置见 `transcriptPath` / `resolveTranscriptPath` 与 `inspectTranscriptIdentity`，格式参考 `src/main/transcript-parser*.test.ts` 与 `claude-jsonl-projector`），并用生产函数 `upsertTraceArchiveTurnAsync` 写分段归档（可用 `npx vite-node` 跑一个 TS 夹具生成脚本），`app-sessions.json` 里登记 `providerId: 'claude'` 的会话。`SCRY_DISABLED_PROVIDERS` 可禁用所有 Provider 的执行，历史读取不依赖执行。
- **负载**（固定，写进报告）：至少两个会话——中等（100 轮，每轮约 30 次工具调用、8 KB 输出），超大（transcript 序列化后 > 32 MB，用于覆盖不能进 transcript 缓存的情况）。
- **测量**：原生 CDP 鼠标点击侧边栏会话 → 目标会话 `.chat-transcript[aria-busy="false"][data-history-source="authoritative"]` 且最新一轮在视口内、输入框可用。记录点击到权威历史就绪的毫秒、main `[scry:perf]` 中 `session_history.load` 各阶段（`archive_read`、`archive_window`、`transcript`、`page_hydration`）。每个会话至少 2 次预热 + 12 次样本，两个会话交替打开（同一进程，覆盖“进程内首次”和“再次打开”）。
- **A/B**：同一夹具、同一脚本，对基线 `a464aff`（独立 worktree，`npm ci && npm run build`）和本分支 HEAD 各跑一遍，ABAB 交替批次，全部经 timing lock。
- 通过标准：脚本自身断言合格（夹具会话确实走 Claude transcript 路径：perf 记录里 `archiveIndexTurns > 0` 且有 `archive_window`）；报告前后中位数/p95、负载、减少的工作去了哪里。数字本身不设门槛，如实报告；没有改善或变差都要解释。

### T4 真实 App 行为验收（同一夹具）

逐条自动化断言并截图：

1. **横幅消失**：慢读取（可在夹具里放一个超大会话）期间，`.chat-transcript .loading-status` 从未出现（用 MutationObserver 捕捉瞬时插入）；输入框在权威历史返回前保持禁用。
2. **首页 10 轮**：打开 100 轮会话，初始 `.transcript-turn` 为 10，`hasOlder` 提示存在。
3. **往上翻等价**：滚到顶部持续自动续读直到最早一轮；收集全部轮次的可见文本（按 `data-run-id` 顺序）。在基线 `a464aff` 上对同一夹具做同样操作，**两边全部轮次文本逐条相同**（这是端到端等价性证据）。记录每次续读的轮数（期望 20）与耗时。
4. **切换取消**：续读进行中切到另一个会话 → 不出现错误提示，新会话不混入旧会话轮次。
5. **失败可见**：打开会话后删除或改写一个尚未加载的归档分段文件，再滚动续读 → composer 出现“无法加载更早轮次：…请重新打开会话”类错误，不静默；重新点击会话后能正常打开（是否回退全量以 perf 记录中的 `archive_window` 为准，如实报告）。
6. **重复 runId 回退**：夹具里构造同一 runId 的两个分段文件（先无 `providerTurnId`、后有）→ 打开后轮数与基线一致（不多一轮）。

### T5 已知疑点调查（只读 + 必要时补测试）

复核提出：Claude 历史路径新旧都不调用 `hydrateNewestSessionSnapshots`（只有 Pi/Codex 的 `readTraceArchivePageAsync` 调用，见 `src/main/transcript-archive.ts`）。判断 Claude 历史中外置的 session diff（`session_diff` 引用）在渲染端是否能正确显示：

- 若确认有问题：写一个失败测试证明（不修，这是既有问题，修复需另行决定），报告给出修复方案。
- 若没问题：写明依据（代码路径或测试）。

### T6 真实数据统计（只读，可选）

先对 `~/Library/Application Support/scry/trace-archives-v2/claude` 做只读快照（复制到临时目录再分析），统计：Claude 会话总数、轮数分布、有/无完整索引（`readTraceArchiveMetadataAsync(..., { requireComplete: true })` 非 null）的比例、索引含重复 runId 的数量、对应 transcript 大小分布（是否 > 32 MB 序列化上限的比例可近似用文件大小）。只报告计数与分布，不报告路径、会话 id 或内容。

## 回报

写 `docs/handoff/claude-history-paging-2026-11-15/reports/R1.md`：

- 每个任务：`完成 / 部分 / 阻塞` + 一句话结论。
- 运行环境：机器型号、核数、macOS 版本、Node 版本、负载；每条命令的退出码与耗时。
- T2/T3：前后中位数、p95、样本数、`SCRY_TIMING_RUN` 负载行、证据文件名；减少的工作去了哪里。
- T4：每条断言结果与截图文件名。
- 修复：每个修复的提交 hash、失败测试、负对照结果。
- 新增脚本：提交 hash、它在旧代码上是否测得一致。
- 首次失败与重跑都如实记录；未验证项与原因；建议（含需要用户决定的事项）。

推送前自检：`git diff --check`；`git status` 干净；提交身份正确；报告里的每个数字都能在 evidence 文件或命令输出里找到。然后：

```bash
git push origin claude/vibrant-planck-l2d4dh
```

核验方会在报告末尾追加「核验意见」。
