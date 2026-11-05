# 批次 R：recorder 执行与持久化的规模性成本

状态：**部分完成 / 待核验**。R1 完成一半（锚点扫描），R2 已优化；R3 未做；R4 有测量与设计说明；
R5 按 R.md 条件不写。

| # | 条目 | 结论 |
|---|---|---|
| R1 | transcript 真正增量解析 | **部分**：锚点扫描增量已做（6 次恢复扫描 33.0 MB → 6.9 MB），解析仍每次读整个窗口 |
| R2 | 正文写入合并 | **已优化**：20 个相同正文 20/19/19 → 1/0/0，已存在时 20/20/20 → 1/1/1 |
| R3 | 恢复路径只看需要看的会话 | **未做**（进入条件成立，超出本批执行预算；见下） |
| R4 | 提交临界区 | **部分**：补了 10,000 条历史的提交耗时；结论「不需要改」，见 [R4-design.md](R4-design.md) |
| R5 | 统一日志 / 会话执行器 / 监管器 | **未写设计**：S10 数据不支持（见下） |

## R2 正文写入合并（已优化）

提交 `eba96f91`。测量方式：`scripts/recorder-engine.measurement.test.ts` 的
「20 identical patches in one turn」，统计 `contentStoreStats()`。

| 指标 | 前 | 后 |
|---|---|---|
| 首次写入：哈希次数 | 20 | **1** |
| 首次写入：读回校验次数 | 19 | **0** |
| 首次写入：目录同步次数 | 19 | **0** |
| 已存在时：哈希 / 读回 / 目录同步 | 20 / 20 / 20 | **1 / 1 / 1** |

改动两处：

1. `persistTurnDiffContent` 原来对每个文件各调一次 `writeRecorderContent` 且并发
   （`Promise.all`）。同一个正文并发写同一条目时，一个赢，其余 19 个拿到 `EEXIST` 后各自读回
   比对并同步目录——那 19 次都是「我们自己的并发」产生的重复工作。现在同一轮里相同的正文只发布
   一次（按正文值去重后保序映射回各文件），不同正文仍并发发布。
2. `writeRecorderContentBatch` 先按正文值去重再哈希：同一批里相同的 payload 只算一次 SHA-256。

### 中途发现的回归与修正（同一提交内）

第一版把整轮 patch 直接交给 `writeRecorderContentBatch`。20 个相同正文确实降到 1/0/0，但 S4
（300 个不同 patch）结束阶段从 3545–5310 ms 涨到 6043–8588 ms。隔离测量确认原因：
`writeFileAtomicExclusiveBatch` 的发布循环是串行的（先统一准备目录，再逐个 publish），
300 个**不同** payload 时：

| 300 个不同正文 | p50（7 轮，交替顺序） |
|---|---|
| 300 次并发 `writeRecorderContent`（原路径） | 1396 ms |
| 一次 `writeRecorderContentBatch` | 5162 ms |

所以最终实现不去碰 batch 的串行发布语义（它「全部父目录 durable 后才发布任何最终文件名」的保证
是别的调用方依赖的），而是在 `persistTurnDiffContent` 里按正文值去重后仍并发发布。修正后
S4 结束阶段回到 3469–4747 ms，S1 637–681 ms，20 个相同正文仍是 1/0/0 与 1/1/1。

**没有削弱的保证**：已存在文件的读回比对（损坏检测）保留，同一批里只做一次；目录同步仍执行
（`writeFileAtomicExclusiveBatch` 内部对所有父目录 `syncDirectory`，不是省成 0）；
新增两条回归测试：批内去重的计数断言，以及「已存储的批内 payload 被改坏仍然报
`collision or corruption`」。

## R1 transcript 增量解析（部分完成）

提交 `1fc96816`。

### 先测量：解析窗口本来就是「本轮」

新增 bench 场景 S12（同一份 52.3 MB transcript，10 轮，最后要第 10 轮）：

| 场景 | parse 字节 | anchor 字节 | 文件大小 |
|---|---|---|---|
| S8 单轮 50 MB | 52,429,033 | 52,429,033 | 52.3 MB |
| S12 10 轮共 50 MB | **5,234,585** | 5,242,880 | 52.3 MB |

结论：轮次结束时**只解析本轮的那一段**（S12 是文件的 1/10），不是整份 transcript。
S8 之所以是整份，是因为那个 50 MB 文件本身就是一轮。所以「每轮重解析整个文件」这个前提不成立，
真正重复的是**同一次调用里把同一段读了两遍**：先反向扫描找锚点（`transcriptAnchorOffset`），
再正向解析同一个窗口。

### 真正重复的是恢复扫描

daemon 在轮次打开期间按 `RECOVERY_POLL_MS` 起步、最长 15 s 退避反复跑 `recoverRecorder`，
每次都会对同一个未结束的轮次调用 `stableTranscript`。transcript 每次都在增长，identity 缓存命中
不了，于是每次扫描都重读整个窗口。测量（6 次扫描、4 MB 窗口、每次追加 512 KB）：

| | anchor 扫描字节 | 解析字节 |
|---|---|---|
| 改动前（每次冷扫） | 33,038,016 | 33,038,016 |
| 改动后（只有增量部分） | **6,859,226** | 33,038,016 |

锚点扫描 −79%（33.0 MB → 6.9 MB）。解析字节没变，这是 R1 剩下的那一半。

### 改法

`recorder-transcript-cache.ts` 里按 `(path, provider, promptHash, providerTurnId)` 记一个
`{ offset, scannedTo, dev, ino }`。命中要同时重新证明三件事，任一失败就回退到原有反向扫描：

1. `dev/ino` 不变（同一文件，未被替换）；`size ≥ scannedTo`（未被截断）；
2. `offset` 那一行重新跑同一个锚点判定（`transcriptLineAnchor`），仍能匹配；
3. 只在 `[scannedTo, size)` 这个**新增段**里找更新的匹配——同一个 prompt 可能重发，权威扫描
   永远返回最新匹配，所以缓存只是候选，不是答案。

codex 不缓存：它的锚点是用前向状态机在扫描块里判定的，单行无法重新证明；它的扫描也本来就停在
轮次边界。测试 `recorder-transcript-anchor.test.ts` 覆盖：追加后复用、**同一 prompt 重发时仍取
后一轮**、截断、替换、锚点行位移、无 identity 六种。

### 走过的弯路（记录，避免重复）

第一版缓存「offset + 验证该行」就直接返回，测量看起来是 9.4 MB → 8 KB。但它漏了「同一 prompt
重发」：缓存会停在较早的轮次，把两轮之间的事件都算进本轮——这是证据错误，不是性能问题。
补上「在新增段里找更新匹配」之后，如果不对 `scannedTo` 做限制、每次都从 `offset` 扫到 EOF，
省下来的又全部还回去（等于重扫整个窗口）。所以必须同时缓存 `scannedTo`。

### 还没做的一半

解析仍然是每次把窗口重新 parse 一遍。要做到「解析字节 ≈ 本轮新增字节」，需要在 runtime 状态里
保存每个 provider 的可合并解析状态（claude 的 `parseTranscriptToTurns`、codex 的
`parseCodexRollout`），并按 R.md 列出的四类情况全量重放。这动的是证据语义，本批没做，
数字留在上面（33 MB vs 6.9 MB 的解析部分）。

## R3 恢复路径（未做）

进入条件**成立**：已完成会话目录 0 / 200 / 1,000 时，恢复路径 `readdir` 12 / 1,015 / 5,015、
`readFile` 12 / 412 / 2,012、耗时 25 / 52 / 175 ms（M3 测量）；S11 场景（1,000 个已完成目录 +
1 个未完成会话）恢复 204–254 ms。

读代码后，这一条比交接文档描述的更大：**同一个全量扫描有四个入口**，都在遍历
`runtime/<provider>/<session>/`：

| 函数 | 现存位置 | 调用时机 |
|---|---|---|
| `recoverRecorder` | `recorder.ts` | 每次恢复（daemon 轮询，1 s 起步、最长 15 s 退避） |
| `recorderHasOpenTurn` | `runtime-state.ts` | 每次恢复前后各一次（`daemon.ts` 的 `run`） |
| `recorderPendingHealth` | `runtime-state.ts` | 每次健康状态更新 |
| `recorderStaleOpenTurns` | `runtime-state.ts` | 过期判定 |

所以只改 `recoverRecorder` 不会有收益——daemon 每轮仍然会因为 `recorderHasOpenTurn` 扫两遍。

没做的原因与下一步（按 R.md 的方案二）：

1. 在会话锁内维护一个「需要注意的会话」标记（`runtime/<provider>/<session>/attention` 或独立的
   标记目录）。写入时机：**先写标记，再写 `open.json`**；排队 hook 入队时也写标记。
2. 清理时机：轮次终结且 inbox 为空时删除标记。标记残留是允许的——恢复遇到没有 `open.json`、
   也没有 inbox 的标记时直接删掉即可，所以「标记先于 open.json」这个顺序在崩溃后仍然自洽。
3. 四个入口都改成读标记集合；`recoverRecorder` 保留周期性全量兜底（例如每 N 次增量恢复做一次），
   用来兜住标记丢失或历史遗留目录。
4. 故障注入测试：在「写标记」与「写 open.json」之间抛错，下一次恢复仍必须找到该会话；另外要覆盖
   标记残留（有标记、无 open、无 inbox）与 inbox 存在但无 open 两种情况。
5. 代价：每轮多一次标记写入（是否 fsync 需要按现有持久性要求决定，报告里要写清楚），
   终结时多一次删除。

按上面的顺序实施，然后重跑 S11，目标是 `readdir` / `readFile` 与已完成会话数无关。

## R4 提交临界区（部分完成，见 R4-design.md）

- 补测：`scripts/recorder-engine-bench.mjs` S9 在 0 / 1,000 / 10,000 条历史下提交一条记录
  22 / 28 / 41 ms（3 轮中位数）。
- 已有：锁持有时间 0 / 200 / 1,000 条时 22.4 / 28.0 / 29.3 ms，锁内 `readdir` 2 / 1 / 1 次
  （M3）。
- **未测**：10,000 条时的锁内 `readdir` 条目数与锁持有时间。把
  `scripts/recorder-engine.measurement.test.ts` 的历史档扩到 10,000 会让该测试在 120 s 超时
  （预置 10,000 条记录本身就是 O(n²) 的提交循环），因此回退了这次扩展，只保留 0/200/1,000。

结论与方案见 [R4-design.md](R4-design.md)：按现有数据**不需要改**，并写清复查阈值。

## R5 统一持久接收日志 / 会话执行器 / 监管器（不写设计）

R.md 的条件是「S10 数据显示一个会话的慢处理拖住其他会话，或锁等待随会话数显著增长」。
实测：S10 四个会话 × 5 轮（共 20 轮）一轮 5.47–5.59 s，即约 275 ms/轮；单会话轮次
（S7）约 240 ms/轮。并发下每轮成本与串行同阶，没有出现互相拖住；S9 的锁冲突次数在
0/200/1,000 条历史下也没有随历史增长而爆炸（每轮 1 次提交、0 次冲突）。

因此按 R.md 写「数据不支持，未写设计」。附带说明：hook 返回时间与 record 可读时间在本批
没有单独测量，若以后要评估统一日志，需要先补这两个时间，否则无法判断「提前 ACK」是否只是
把同样的工作挪到别处。

## 测试

| 命令 | 结果 |
|---|---|
| `npx vitest run src/core/turn-recorder` | 43 个文件、504 个测试通过（含 R2 新增 2 条） |
| `npx vitest run scripts/recorder-engine.measurement.test.ts -t "content"` | 通过，输出 1/0/0 与 1/1/1 |
| `npx tsc --noEmit -p tsconfig.node.json` | 无错误 |

## 生效方式

R2 在 recorder core（`packages/turn-recorder-cli`）。需要 `npm run build:cli`；daemon 场景需
`scry recorder restart`。不需要 `scry integrations repair`。

## 未验证 / 留给用户

- R1、R3 是本批未完成的条目，进入条件都已成立，数字在上面。是否要继续做、按什么顺序，
  需要你确认。
- R2 的收益只在「同一轮出现重复正文」时出现（同文件被多次读取、同一 snippet 重复）。单次唯一
  正文的轮次没有变化：S1 结束阶段 637–681 ms（G1 之后 622–828 ms，基线 914–1413 ms），
  S4 结束阶段 3469–4747 ms（G1 之后 3545–5310 ms）。
- S4 的毫秒仍在同一台高负载机器上测得（1 分钟负载 10–30），只有「批内串行 vs 并发」这个 3.7×
  的隔离对比可以当结论。
