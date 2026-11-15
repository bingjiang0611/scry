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

## 剩余成本与下一步

10 轮首页仍约 0.5 s（本负载），主要是页内每个工具正文的复用校验：读回已存内容比较 + fsync。transcript 缓存每次克隆内联正文，所以每次打开都会重复这一步。recorder content store 刻意“不缓存目录证明”，若要在加载路径跳过同进程已验证内容，需要维护者决定持久性/缓存策略，未在本次实施。

其他候选（未实验）：侧边栏 hover/pointerdown 预取 `loadSession`（需要 main 侧页缓存与失效设计）；设置 `setCwd`+`activeRuns` 与 `loadSession` 并行（仅省一次 IPC 往返，收益小）。

- 锁定：未改 ratchet/台账。
