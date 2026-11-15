# Claude 历史按窗口分页（2026-11-15）

## 背景

用户反馈：切换会话时经常看到“正在读取会话历史… 会话已切换；内容将在本机证据读取完成后显示。”。该提示在 `sessionLoading || sessionCacheVisible` 持续超过 150 ms 时出现（`ChatView.tsx`、`useDelayedFlag`），即权威 `agent:loadSession` 未在 150 ms 内返回。

代码定位：Pi/Codex 等无 transcript 的路径已按 `DEFAULT_LOAD_SESSION_TURNS`（10）只读页内归档；**Claude（有 transcript）因 `sessionArchiveIsPageable` 为 false，每次打开都**：

1. `readTraceArchiveAsync` 读取并解析全部 turn 文件；
2. 对全部归档轮次与全部 transcript 轮次执行 `persistTraceToolEvents`。transcript 缓存每次返回 `structuredClone`（`transcript-file-cache.ts`），正文仍是内联，因此每个工具正文每次都要重新哈希、读回已存内容比较并 fsync（`content-store.ts` 的复用路径）；
3. 全量 `mergeSessionTurns` 后再切 40 轮页。

所以 Claude 打开耗时随会话长度线性增长，与页大小无关。

## 实验 1：按合并窗口读取归档正文

- 假设：合并位置只取决于归档索引（runId、userText、顺序），不取决于正文 → 用完整索引定位，只读取/持久化返回窗口内的正文，首页工作量从 O(会话轮数) 降到 O(页大小)，且页内容与全量合并逐字节一致。
- 基线：`a464aff`。
- 优化源码：`ffe1ec7`（`src/main/transcript-archive-paging.ts`，接线 `history-archive.ts` / `history-load.ts` / `history-older.ts`，`readTraceArchiveMetadataAsync` 增加 `requireComplete`）。
- 正确性：
  - 等价测试：30 轮，含页内外重复 prompt（`continue`）、只在归档中的轮次（追加在 transcript 之后）、只在 transcript 中的轮次、工具正文；第 1/2/3 页与全量合并对应切片 `toEqual`，每个归档轮次只读一次。
  - 负对照：把窗口内正文替换回索引元数据后，等价测试失败；恢复后通过。
  - 失败安全：索引 `sourceComplete === false`、任一条目缺 metadata、单体归档、正文 userText 与索引不符、缺正文、选择性读取报 “index entry changed or is corrupt” → 首次加载回退全量读取；翻页时清空缓存并提示重新打开会话（`historyCopy.archivePageReload`）。其他读取错误照常抛出。
  - transcript 读取失败时与原合同一致：只有存在归档（窗口或回退全量）才容忍，否则抛出。
- 减少的工作去了哪里：**不做了**。窗口外的正文不读、不持久化；翻到更早页时只补该页窗口，不会把全量读取推迟到首次翻页。

## 实验 2：Claude 首页与其他 Provider 对齐为 10 轮

- 优化源码：`45426df`。只在 transcript 路径且请求未指定 limit 时使用 `DEFAULT_LOAD_SESSION_TURNS`；显式 limit、`hasOlder` 与滚动/按钮续读不变。
- 这是可见行为变化：Claude 首屏从最近 40 轮变为最近 10 轮，更早轮次滚动到顶部自动续读（Pi/Codex 已是此行为）。可单独回退该提交。

## 验证与结果

L2（Node 受控、生产函数、非 App 毫秒）：临时 vitest 基准（未提交），Claude 分段归档 + 等长 transcript，每轮 30 次工具调用、8 KB 输出；先各跑一次预热内容库，再 7 次 ABAB 交替；transcript 每次 `structuredClone`（与生产缓存行为一致）。全部经 `timing-run.mjs`，4 核，`highLoad=false`（load 0.6–1.3）。

| 会话轮数 | 全量合并（首页 40） | 窗口分页（首页 40） | 窗口分页（首页 10） |
|---:|---:|---:|---:|
| 40 | 1460 ms | 1482 ms | — |
| 100 | 3582 ms | 1542 ms | 529 ms（同批全量 3744 ms） |
| 200 | 7065 ms | 1704 ms | — |

40 轮会话本来就整页读取，两者相同，符合预期；收益随会话长度增长。分段读取单项（100 轮）：全量归档读取 70.6 ms → 索引 3.4 ms + 10 轮正文 10.1 ms。

- L1：等价测试断言首窗只读本页归档轮次、重复请求同一窗口不再读取/持久化。未新增台账指标。
- L2 真实 App：**未验证**。本容器以 root 运行，Electron 拒绝在不加 `--no-sandbox` 时启动；按规则不加 `--no-sandbox`，`session-open-bench` 未运行。现有 native 基准使用 v3 单体 Codex 归档，也不覆盖本路径。
- L3：未验证；需安装含 `ffe1ec7`/`45426df` 的构建后按同场景收集 `session_history.load`（Claude）样本。
- 单测：相关 34 文件 247 项通过；`npm run typecheck` 通过；全量 unit 6001 通过 / 5 失败 / 6 跳过，5 个失败在基线 `a464aff` 上同样失败（root 下 Chromium sandbox、不可读目录用例、进程回收），与本改动无关。
- 合入：未合入；构建：未构建 App；安装/生效：未安装。日常比较：无。

## 独立复核与第二轮（同日）

另一模型独立复核第一轮后发现问题，均已在 `bb38e13`、`101fa58` 处理：

| 问题 | 处理 |
|---|---|
| 同一 runId 落在两个分段文件（一个按 providerTurnId 命名）时，分页多出一轮 | 索引含重复 runId 即不可代替归档，回退全量；有负对照 |
| 更早页失败被 renderer `.catch(() => null)` 吞掉，按钮点了没反应 | 失败经 composer 错误显示；过期/取消请求在 main 返回 null |
| 更早页默认 40 轮、无取消 | transcript 分页的更早页默认 20 轮；新会话加载或失效时取消 |
| 缓存保留窗口外原始 transcript 正文，内存无上限 | 缓存只保留已合并窗口；更早页重新读取 transcript，并校验 prompt 与计划一致，否则要求重新打开 |
| 每次窗口仍做两遍全量合并（O(会话)） | 按 user text 生成合并计划（`sessionMergePlan`），只合并窗口内位置（`mergeSessionTurnAt`） |

第一轮记录中“剩余主要是复用校验”的判断不完整：基准从已解析轮次开始，没有计入 transcript 文件读取/解析；还有两遍全量合并。

维护者决定（2026-11-15）：

- 同意历史加载路径使用进程内“已校验内容”记忆：本进程已发布或已校验并 fsync 的 blob，再次持久化时只核对文件存在且大小一致，不再读回比较和 fsync；被删除的 blob 会重写，读取仍校验摘要；实时 recorder 写入不变。
- 会话历史横幅无论耗时一律去掉；待定状态仍由 aria-busy、`data-history-source="preview"` 与锁定的 composer 表达。
- 悬停/按下预取暂不做，待真实 App 测量后再定。

第二轮 L2（同一 Node 受控基准，10 轮首页，7 次交替，`highLoad=false`，页内容与旧路径相等）：

| 会话轮数 | 旧全量 | 新：进程内首次打开 | 新：再次打开 |
|---:|---:|---:|---:|
| 100 | 3655 ms | 263 ms | 128 ms |
| 200 | 7632 ms | 308 ms | 159 ms |

- 减少的工作去了哪里：窗口外正文不读、不持久化、不合并（不做了）；同进程已证明的 blob 不再读回和 fsync（不做了，以存在/大小检查代替）。
- 不含：transcript 文件读取/解析。复核实测同形状 25 MB JSONL 超过 transcript 缓存 32 MB 序列化上限，每次打开冷读约 220 ms；这部分仍随会话长度增长，未改。
- 验证：新增 3 项测试（变更 prompt、重复 runId、记忆的 ref/校验次数/fsync 次数与 blob 重写），各有负对照失败；全量 unit 6004 通过，5 个既有 root 环境失败与基线相同；`typecheck`、recorder/CLI 类型检查、App 构建通过。
- UI：`scripts/loading-ui-checks.mjs`、`scripts/session-cache-ui-checks.mjs` 改为断言任何时长都不出现历史横幅。**未运行**：容器以 root 运行，Electron 不加 `--no-sandbox` 无法启动；真实 App 重放与截图未做。
- 合入：未合入；构建：仅本地开发构建通过，未打包；安装：未安装；L3：未验证。

## 剩余成本与下一步

- transcript 文件本身：超大 transcript 不进缓存，每次冷解析。可选提高上限（内存换时间，需维护者决定）或增量解析。
- macOS APFS 上 fsync 成本未测；进程内首次打开仍对页内 blob 做完整校验。
- 无索引也无 sidecar 的老 Claude 会话仍走全量路径且不会补建索引；占比未知。
- 悬停/按下预取：需要拆出无副作用的只读通道和 main 侧页缓存（IPC 与缓存策略），待真实 App 测量后决定。
- 复核提出、未深查的既有疑点：Claude 历史路径不调用 `hydrateNewestSessionSnapshots`，外置 session diff 是否正确回填未确认。

- 锁定：未改 ratchet/台账。
