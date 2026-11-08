# 文件树渲染计数与受控 L2（2026-11-08）

## 结论与范围

Pierre 迁移后的工作区文件树此前没有任何专用工作量计数，`performance:measure -- --scenario workspace.files` 也无法运行：`workspace.files` 是磁盘毫秒基准，没有对应 collector。本轮补齐**两层**证据，均未改产品行为，也未升门禁：

- **L1 计数（新增 candidate）**：`workspace.tree` 5 个指标，固定 1,000 文件工作负载，5/5 次完全一致；新增 `npm run performance:measure -- --scenario workspace.tree` 可运行路径。
- **受控 L2**：真实 Pierre 组件在隐藏 Electron 里挂载、展开、搜索、键盘跳转的耗时，3 次采样、`highLoad: false`（10 核，load 6.85–7.46）。

只描述“条件被观察到的耗时”，不是绘制完成证据，也没有真实 App L3、真实磁盘或 Linux 数据。

## 1. 为什么要先拆出投影

原来 `WorkspaceFileTree` 在组件内部完成：索引已加载子项 → 按查询过滤 → 生成展开祖先。组件无法在 Node 中挂载出与生产一致的虚拟化行，所以在组件内加计数只能测出 jsdom 假象。

因此先做一个行为等价的重构（提交 `workspaceTreeEntries` / `filterWorkspaceTreePaths` / `normalizeWorkspaceTreeQuery` / `workspaceTreeAncestors` 到 `src/renderer/workspace-tree.ts`），组件只调用它们。重构保持原有语义：目录带尾斜杠、空白查询保留全部、只匹配条目名、祖先按每个命中各一条。

同一提交把 `src/renderer/workspace-tree.ts` 登记进 `scripts/performance-paths/workbench.json` 的 workspace sources。

## 2. L1：`workspace.tree` 计数

collector：`scripts/performance-counters/workspace-tree.counters.test.ts`。固定负载：40 个已加载目录 × 25 文件 = 1,000 文件；一次组件更新 = 一次索引 + 初始全量发布 + 一次按键（查询 `FILE-01`，命中 `dir-00/file-010..019`）。

| 指标 | 观测（5 次） | 含义 |
|---|---:|---|
| `workspace.tree/childrenReads` | 41 | 索引一次读取的已加载目录数（含根） |
| `workspace.tree/entriesIndexed` | 1040 | 发布的索引条目数 |
| `workspace.tree/nameReads` | 1040 | 一次按键过滤读取的条目名次数 |
| `workspace.tree/pathsPublished` | 1050 | 两次交给 Pierre `resetPaths` 的路径数（初始 1,040 + 过滤 10） |
| `workspace.tree/ancestorsRevealed` | 10 | 过滤后交给模型的展开祖先条目数（每个命中一条） |

计数用 pass-through Proxy 观测生产函数真实读取的 `children[path]` 与 `entry.name`，没有为测量在生产代码里加钩子。

**负对照（同一文件内）**：

- 多跑一次索引 → `childrenReads` 与 `entriesIndexed` 必须上升；证明“每次按键重新索引”会被发现。
- 过滤退化为不过滤（复现修复前的行为）→ `pathsPublished` 必须上升；证明“过滤失效仍发布全部路径”会被发现。
- 初始发布读取 0 次名字、按键读取 `entries.size` 次名字；证明 `nameReads` 绑定真实过滤路径。

台账：`scripts/performance-ratchet/workspace.json`（新增 `include`），5 项均为 `candidate`，`darwin-arm64` 基线为本次实测值。candidate 不阻断 CI，只把“比上次差”显示为 `worse`。

## 3. 受控 L2：真实组件、隐藏 Electron

`node .agents/skills/scry-performance-climb/scripts/timing-run.mjs pierre-tree-l2-N -- npm run test:pierre:ui -- --measure`，3 次：

| 场景 | 样本（ms） |
|---|---|
| 挂载（切到工作区 → 首行可见） | 21 / 15 / 16 |
| 展开目录（点击 → 首个子文件行） | 19 / 15 / 17 |
| 搜索无匹配（输入 → 空状态） | 20 / 18 / 19 |
| 搜索命中（输入 → 单行） | 24 / 30 / 30 |
| 清除搜索（输入 → 树恢复） | 21 / 27 / 24 |
| 折叠后重开 + End（点击/按键 → 最后一行） | 21 / 21 / 22 |

DOM 计数：1,000 个已加载路径下挂载 **29 行**、树 shadow root 内 **939 个元素**。

测量方式：页面内 `performance.now()` 打点，两次 CDP 调用不在计时区间；包含 fixture 自己的 rAF 轮询与条件判定。隐藏窗口每帧约 16.7 ms，样本多为 1–2 帧，因此这些数字足以发现“整棵树重挂载/全量重排”这类量级回归，不足以区分 2–5 ms 的差异。

## 4. 尚未测量

- **绘制**：只到条件观察，没有 frame timing、合成或长任务数据。
- **真实工作区**：fixture 的目录读取是本地异步桩，不是真实 IPC/磁盘；冷缓存、超大仓库（10k+ 文件）、多根目录、网络盘未测。
- **真实 App 与 Linux**：没有 packaged L3，也没有 Linux 基线；CI 的 Linux 门禁仍缺。
- **门禁状态**：全部 candidate。升为 gating 需要稳定性、敏感性、相关性三项证据并要求用户确认，本轮未做。

## 5. 后续机会（未实验）

- 过滤命中同一目录的多个文件时，`ancestorsRevealed` 会重复提交同一个父目录（当前 10 个命中 → 10 条 `dir-00/`）。去重可能减少 Pierre `resetPaths` 的输入，但 `resetPaths` 内部本身会去重，收益未测、也未验证是否影响展开状态，本轮不改。
- 文件树投影每次 `children` 变化都会重扫全部已加载条目；10k 文件下的代价未知，先补真实工作区/大仓库数据再决定是否建索引缓存。

## 6. 交付状态

- 生产重构与 measure 工具分开提交：重构在上，计数/台账/受控 L2 工具在下。
- 未改 workload 口径、未改任何门限、未放宽 tolerance。
- 已安装的 App 不含本轮重构（版本号未变），需按交付说明重新构建安装后生效。
