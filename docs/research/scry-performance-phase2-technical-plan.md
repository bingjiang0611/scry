# Scry 第二阶段性能与稳定性优化方案

日期：2026-09-16

状态：技术方案，尚未实施。基于 Scry 0.2.148、HEAD `04b5711` 与当前工作区的定向源码审阅；工作区包含尚未提交的性能及 UI 改动，HEAD 不能单独标识这份基线。本次未重新跑 benchmark、采集进程指标或进行真实 App 验收。

## 1. 结论与范围

下一轮的重点不是继续增加缓存、全面改成 Worker 或单纯减少 React render 次数，而是：

1. **把资源消耗量出来**：区分 Scry 与 Provider，打通主进程、IPC、renderer 和持久化的时间线。
2. **先消除无效工作和无界增长**：隐藏页面查询、过期历史请求、renderer 待消费队列、RPC 残留缓冲。
3. **再优化已证明的重计算**：活跃长轮次、Markdown、历史解析与索引冷重建。
4. **用长期运行和故障恢复证明稳定性**：低内存不应以丢证据、误报成功或失去恢复能力为代价。

范围为桌面客户端 main/preload/renderer 及其 Provider transport、历史读取、持久化路径。远程连接作为资源与事件消费者纳入测试；iOS 客户端本身不在本轮实施范围。

不承诺降低模型推理耗时，不通过减少必要证据、取消 trust gate、关闭 sandbox 或截断 canonical 内容换速度。

## 2. 当前基础：不重复建设

当天工作区的 [性能基线](../performance.md) 记录了以下成果；下列数字是该文档的既有结果，不是本次新测结果：

| 已有优化 | 已有结果 / 边界 |
| --- | --- |
| 历史分页后再 hydrate 附件 | 4,000 轮、40 轮可见：约 1,098.5 → 31.3 ms mean |
| 分轮 archive 索引读取 | 10,000 轮、40 轮可见：约 3,068.7 → 20.9 ms mean，属于稳态读页，不能代表索引失效后的首次读取 |
| 流式事件 IPC 合批、ACK、字节水位与显式降级 | 已实现，不另建流控框架 |
| 已完成 turn 引用稳定、memo、content-visibility | 已实现；不等于活跃长 turn 的每批处理或 DOM/数据内存都恒定 |
| Markdown 按文本长度 48/80/120 ms 采样 | 已实现；采样后仍全段规范化与解析 |
| 单份历史缓存、Analytics lazy chunk、Git baseline 复用 | 已实现；单份缓存不等于字节有界，lazy chunk 不等于数据查询按需 |
| 启动、历史、发送、终态分段 timing | 已有 `PerformanceTrace`，本轮扩展它，不新建遥测系统 |

今天已有资源释放回归不需要重写。下一步补的是真实长时间运行证据，而不是因为未测就断言存在泄漏。

## 3. 源码观察与待验证假设

| 位置 | 已确认的实现事实 | 待测问题 / 优先级 |
| --- | --- | --- |
| `src/preload/index.ts`、`src/renderer/hooks/useAgentSession.ts` | preload 在回调返回后 ACK；回调把事件加入 `traceBuf`，随后 rAF / 250 ms 兜底消费 | ACK 证明接收，不证明消费或绘制；高负载/后台下队列与终态突发是否放大内存，P0 测量、P1 修复 |
| `src/main/trace-output.ts` | `flushAll()` 可绕过 high-water 排空缓冲；降级后使用权威快照对齐 | 终态与快照是否形成大 IPC/长任务，P1 |
| `src/main/index.ts` 的 `agent:loadSession` | Claude transcript 全文件读取/解析；Qoder/Pi 全历史 enrichment；缓存同时持有 merge 输入和结果 | 峰值内存、过期请求重叠工作；保留多份引用不必然等于正文复制三份，须 heap 验证，P1 |
| `src/main/transcript-archive.ts` | 分轮索引失效后需重建；索引本身仍整体读取/解析 | 大会话首开、每次新增后再打开的慢路径，不能只测热索引，P1/P2 |
| `src/renderer/format.ts`、`src/renderer/turn-stream-projection.ts` | 每批创建 turn/event 索引；投影复用前比较结构前缀 | 历史 turn 不重渲染，但活跃 turn 随事件数增长的 CPU 仍待测，P2 |
| `src/renderer/components/MarkdownImpl.tsx` | 采样降低频率，但文本增长后仍整段处理 | 大表格、长代码块与终态完整解析是否抢占输入，P2 |
| `src/renderer/hooks/useAgentSession.ts` | 早期历史页 prepend 后继续保留在 `turns` | 连续加载很多页后 React 数据与 DOM 是否持续增长；content-visibility 不回收对象，P1 测量 |
| `src/renderer/hooks/useIntegrations.ts` | 启动 timer 会调用 `loadAnalytics`；data-updated 也会触发分析查询 | 未打开分析页时的无效 SQL / IPC / state 更新，P1 |
| `src/main/providers/pi.ts` 当前未提交 diff | 删除累计 stdout 64 MiB 和单行 16 MiB 检查；`feed()` 等待换行并做 `JSON.parse` | 去掉累计会话上限有合理性，但无换行残留与单条大 JSON 的内存风险仍需受控，P0 |
| `src/main/index.ts` | renderer 崩溃会 reset trace bridge；已有 run 与恢复生命周期 | 重挂、关闭、异常停止后是否释放并恢复一致，只能由故障测试证明，P1 |

这些是候选优化入口，不是经 profile 证实的耗时排行榜。

## 4. 测量与验收合同（P0）

### 4.1 基线身份与负载

先冻结当天优化后的源码快照、dirty diff/未跟踪文件清单与摘要、App/main/preload/renderer 构建身份、CLI 版本、Node/Electron、机器/内存/屏幕刷新率、电源模式。不要把旧版 App 与新源码跑出的结果混在一起。

固定 fixture 与操作脚本，全部自动化/故障测试使用临时 workspace/userData，禁用真实 commit callback，不写用户的 DB、transcript 或 `.scry` records。

| 场景 | 负载与动作 |
| --- | --- |
| 空闲 | 无 Provider 活动，前台/后台各 10 分钟；远程连接关/开分别测 |
| 启动 | 进程冷启动、再次启动分别记录；空数据和大 catalog/恢复队列分别测，不把 OS 文件缓存未清除称为磁盘冷启动 |
| 历史 | 40 / 500 / 4,000 / 10,000 轮；带/不带附件；索引有效/失效/缺失；连续翻 50 页、快速切换 100 次 |
| 流式 | 固定回放，50 / 200 / 1,000 events/s；长文本和工具交错；累计文本 12k/48k/200k 字符，工具事件 1k/10k；同时输入、滚动、点击停止 |
| 大载荷 | 单条工具结果、RPC 完整大行、跨 chunk 无换行数据；分别测字节大小与事件速率，不用大量小事件代替大事件 |
| 并发 | 1 个与 3 个 run、切换可见 run、终端与远程订阅同时存在，按实际支持的身份合同运行 |
| 稳定性 | 2 小时日常回放；候选版本再做 8 小时 soak；周期性切换、停止、恢复与异常注入 |

快速迭代每场景至少 5 次看中位数与范围；作为 p95 门槛的验收至少 50 个独立操作样本。启动样本不足时只报中位数/范围，不宣称稳定 p95。比较同机同负载，先报告方差，再判断收益。

### 4.2 指标口径

- **内存**：main、renderer、GPU/utility 分进程 RSS/平台可用的 private memory；heap used、external/ArrayBuffer；只对登记的 Provider 进程单独采样。RSS 合计标明共享页可能重复，不能冒充物理总占用。记录峰值、空闲回落值、长期斜率与缓存/队列字节。
- **CPU**：CPU 时间增量 / 墙钟时间，100% 定义为占满一个逻辑核；Scry 与 Provider 分开统计。记录空闲均值、流式累计 CPU 秒、上下文中的 event-loop delay。
- **UI**：输入/点击至可见反馈、滚动帧间隔、>50 ms 长任务次数及总时长；React Profiler 只在诊断构建使用，门槛在 production build 验证。
- **链路延迟**：进程启动 → 页面可输入；会话点击 → 第一页可交互；main 收到 trace → renderer 消费/commit/绘制代理；停止点击 → 请求已登记与 Provider 真正 terminal 分开；terminal 通知、archive、SQLite、`.scry` 提交分别计时。
- **稳定性**：崩溃/无响应、残留进程/timer/listener、队列高水位与 resync、恢复失败、持久化 pending/outbox 年龄和数量。

复用 `src/main/performance-timing.ts`，按需加入 `monitorEventLoopDelay`、Electron `app.getAppMetrics()`、renderer `PerformanceObserver` 与少量操作 timing。仅在诊断模式低频采样（资源约 1–2 秒），按窗口聚合且限制日志体积，不逐 token 打日志。

跨进程不能直接相减两边的 `performance.now()`；用校准过的时钟/有误差说明的关联测量。React commit 与 rAF 只作为显示代理，不伪称精确物理屏幕呈现。指标只含 Provider、数值与短生命周期关联序号，不含用户内容、路径、凭据；heap snapshot 可能含敏感内容，只在隔离 fixture 上采集。

### 4.3 初始目标：待基线校准，不是现有承诺

| 维度 | 候选验收标准 |
| --- | --- |
| UI 交互 | 正常负载输入/点击反馈 p95 ≤100 ms；60 Hz 下滚动帧间隔 p95 ≤20 ms；其他刷新率按帧预算换算 |
| 流式 | 正常负载接收到可见更新代理 p95 ≤100 ms；当前长 Markdown 120 ms 采样可能超预算，须实测并明确预算适用范围，不能隐藏矛盾；过载允许延迟但必须有界、可停止、显式 degraded |
| 长任务 | 输入/滚动关键窗口不出现重复 >50 ms 阻塞；压力场景长任务总时长较基线降低 ≥50% 为候选收益目标 |
| 客户端速度 | 40 轮热历史首屏 p95 候选 ≤300 ms；进程启动到可输入候选 ≤1.5 s；全量 enrichment /冷重建单独报告，不混入热页达标统计 |
| 内存 | 100 次等价操作并回到同一空闲状态后出现平台期；第 80–100 次中位数相对第 20–40 次增量候选 ≤max(20 MiB, 5%)，并检查 retained heap；单次 RSS 不回落不直接判泄漏 |
| CPU | 无活动 Provider 空闲候选平均 ≤1% 单核；热点场景 CPU 秒下降 ≥20% 为候选目标，若已足够低则不为达百分比增加复杂度 |
| 稳定性 | 2h/8h 固定回放无崩溃、无限队列或已结束 run 资源持续积累；注入失败可恢复或明确 pending/failed，不能伪装 completed |

目标不可能同靠一个旋钮实现：降低刷新频率可能省 CPU 却伤延迟；加缓存可能提速却涨内存。每个 PR 必须同时展示目标收益与其他维度的回归。

## 5. 分项实施方案

### A. 无效后台工作与过期请求（P1，优先落地）

**改动位置**：`useIntegrations.ts`、`App.tsx`、`src/main/index.ts` 历史加载边界。

- 分析页未打开时只标 dirty，不请求完整 analytics；打开时按当前 range/revision 拉一次。首页确实依赖的轻量 stats/billing 保留，不能把所有统计一刀切停掉。
- data-updated 短时间合并，同身份同参数的重复只读请求共享在途结果；范围限于已证明重复的查询，不加通用请求管理框架。
- 复用历史 `loadSessionRevision`，在 expensive read/parse/enrichment 前后识别过期；可取消的文件读取使用取消信号。不可取消的 Provider 调用不能谎报已取消，也不能借取消只读查询去杀活动 run。
- 卸载、切 Provider/profile/cwd/range 后拒绝旧结果；测重复查询次数、取消前后 CPU 和峰值内存。

**最小回归**：未打开分析页查询为零；打开后新鲜数据正确；连续通知只触发必要刷新；切换会话 A→B 后 A 不污染 B 的 UI/身份。

### B. 流式消费边界与长轮次 CPU（P1 → P2）

**改动位置**：`trace-output.ts`、`preload/index.ts`、`useAgentSession.ts`、`format.ts`、`turn-stream-projection.ts`。

1. 先采集 renderer 待消费事件/字节、批次处理时间、终态排空与 resync 体积。main 的 32 MiB 安全水位不能当作全进程内存上限。
2. 若 renderer 堆积被证实，将信用归还放在事件实际消费或明确忽略之后，而非仅回调返回后；仍不需要等待绘制才 ACK。批次身份绑定 sender/window generation，重复/旧 ACK 不释放新窗口额度，payload 与总量继续在 main 校验。
3. 后台仍有低频消费路径，窗口重挂/reset 和消费者异常不形成永久欠账；超限只降级 live 镜像，不能丢 canonical。终态到达必须先处理此前队列，不能靠改 flush 时机制造已完成但缺尾部的 UI。
4. 针对 `flushAll()` 与完整快照，先测最坏突发；只有超预算时才改为有界分段交付及完成屏障。终态紧急通知可及时到达，但 UI 必须标明证据仍对齐中，不能称归档已提交。
5. 若 `applyTraceBatch` / 投影比较成为热点，扩展现有缓存以复用稳定结构索引；同 id 替换、`result_superseded`、canonical text 替换、子 agent scope 改变时准确失效。不建立第二套权威事件列表。

**回归**：FIFO、去重、工具 lifecycle、更正、终态前最后一批、ACK 缺失/重复/过期、后台/重挂、切 run、resync 中新事件。用批量与原有语义的最终投影等价检查防止“变快但少证据”。

### C. 历史与附件内存（P1 测量，按触发条件升级）

**改动位置**：`session-history.ts`、`transcript-archive.ts`、`attachment-store.ts`、`useAgentSession.ts`、`ChatView.tsx`。

- 第一轮先做对象/字节归因：full transcript string、archive、merged turns、base64/解码图片、React/DOM 分别量。优先缩短中间结果生命周期，删除无用途引用；不能仅因字段多就断定重复复制。
- 保留当前 archive-only 分页快路径；Claude 全量解析、Qoder/Pi enrichment 维持正确性，不强塞统一分页。
- 若连续翻页造成超预算，增加**可重新加载的展示页窗口**，按页数和字节双预算；活动 turn、当前选择/展开内容按明确规则 pin。淘汰只影响 UI 数据，不删除 archive。页面内查找、复制、滚动锚点、返回定位和无障碍必须有回归；不把浏览器查找范围悄悄缩小。
- 若附件主导内存，先确保不可见页淘汰后对象/blob/解码资源能释放；仍超预算再考虑受授权的按需二进制读取。不可暴露任意 `file://` 或任意路径 IPC。
- 若 Claude 全量解析产生 >50 ms main 阻塞，先将纯解析移到单个按需 Worker：main 保留身份/路径授权，传入受控数据，计量字符串/结果克隆峰值。不把整个 Provider orchestration 搬进去。
- 若峰值内存仍超预算，再设计带身份校验、轮次边界与跨源 reconciliation 的可重建 transcript 索引。这是独立格式/恢复改动，不用倒着切 JSONL 或随意截尾替代。

**验收**：每页附件开销跟页内容而非总会话图片量变化；历史冷/热与 Provider 分开报告；最新 turn、fork/resume、hook/usage provenance 和旧请求隔离不回归。

### D. UI 渲染与 Markdown（P2，profile 后实施）

**改动位置**：`MarkdownImpl.tsx`、`ChatTurn.tsx`、`ChatView.tsx`。

- 已有 memo、live-tail 分离、content-visibility 和采样保留，先定位 parse / React commit / layout 的占比。
- 尽量收窄计时器更新与 context 改变的影响范围；仅当 Profiler 证明发生无用重渲染时调整状态归属，不批量补 useMemo。
- 如长 Markdown 确为瓶颈，第一选择是在明确压力阈值下对增长中的尾部采用更轻量展示，终态恢复完整渲染；必须经 UX 验收，不默认让所有流式文本退化为纯文本。
- “已闭合块缓存 + 活跃尾部解析”仅在现有 AST 能可靠标识依赖后考虑；引用链接、列表续接、表格和未闭合代码围栏会跨块影响，不按双换行盲切。
- >1,000 已挂载 turn 的 layout/DOM 成本若超预算，再做可变高度窗口化；先解决页窗口与锚点，不立即引入虚拟列表依赖。

**回归**：代码围栏、GFM 表格、引用链接、中文增量、文本更正、子 agent、复制全文、文件链接安全过滤、图片预览、滚动不跳、键盘焦点与停止按钮响应。

### E. 主进程 I/O 与索引冷路径（P2）

**改动位置**：`transcript-archive.ts`、`trace-turn-progress.ts`、`db.ts`、`session-diff.ts`、`index.ts`。

- 用 event-loop profile 判断是同步 I/O、JSON CPU、SQLite 还是 Git 子进程等待，不能通过搜索 `Sync` 就一律替换。
- archive 索引缺失/失效的重建可分批让出主线程；已有读文件并发上限继续保留。若“每新增一轮再打开都重建”在真实使用中占主导，再做受串行提交约束的增量索引更新。
- 增量索引仍是可删可重建的派生物：canonical 原子提交先成功，索引失败不伪造成功；删除、更正、并发提交与崩溃之间的 revision/失效语义必须完整。
- SQLite 先检查查询计划、扫描行数、重复查询与已有 revision cache；只有同步 SQL 被证明长期阻塞，才考虑单一 DB Worker 所有权，不开两套 writer，也不破坏 transaction/outbox 顺序。
- Git 延续 baseline 复用和 deadline；只合并身份一致的冗余请求，不扩大扫描、不取消大文件边界，不把 deadline fallback 标成 exact。
- deferred recovery 既要让出首屏，又要有吞吐与进度，不能通过无限推迟恢复获得好看的启动分数。

### F. RPC 与恢复稳定性（P0/P1，与性能并行）

**Pi RPC**：累计输出量不是驻留内存，不恢复“会话累计超过 64 MiB 就杀进程”的策略。但删除单行保护后，当前 `buffer` 在无换行输入下可以增长；完整超大行也会造成 JSON 解析峰值。

先调查实际 Pi/Rotom 合同与大 `get_messages` 响应样本，区分累计流量、未完成 frame 字节、单个完整 frame 和解析后对象。按已支持的最大合法 frame 制定有依据的预算，覆盖跨 chunk UTF-8；不能把旧 16 MiB 任意恢复为新产品合同。若合法消息大于可接受预算，需独立评估协议分页/流式解析或明确不支持范围，而不是静默截断 JSON。超预算必须显示可诊断失败并保留已知证据状态，仅终止已登记且身份复验的对应进程。

**最小故障集**：无换行增长、完整大帧、长时间正常小帧、RPC 写入时退出；renderer 在有在途数据时崩溃；Provider 启动失败/执行中退出；临时磁盘不可写与 DB 不可用；归档提交阶段中断后重启。

验证三类结果分别成立：

1. 生命周期与资源能收敛，没有残留 timer、listener、pending promise 或错误复用的进程。
2. archive、DB/outbox、`.scry` 各自状态真实，允许 pending/partial/failed，不允许缺少证据却显示成功。
3. 恢复后 canonical 不双计，不静默漏掉记录；renderer 重挂不重复发送 Provider prompt，自动恢复不越过授权与 fingerprint gate。

## 6. 分阶段交付与取舍

| 阶段 | 交付 | 估算与出口 |
| --- | --- | --- |
| 0 | 冻结基线、资源/队列测量、最小 fixture；Pi frame 风险复现 | 1–2 人日；产出五维基线与热点排序，预算经同机数据校准 |
| 1 | 按需 analytics、过期只读请求减负、已证实的消费队列问题、RPC 边界与故障回归 | 2–4 人日；真实输入/停止不回归，长时间资源不失控 |
| 2 | 从热点前三名中选 1–2 项：长 turn / Markdown / 历史窗口 / 解析卸载 | 3–5 人日；目标场景有稳定收益、相邻场景无显著退化 |
| 3 | production-build UI 重放、2h/8h soak、跨 Provider 与恢复验证 | 1–2 人日加 soak 墙钟时间；证据矩阵与剩余限制齐全 |

估算不含 transcript 格式迁移、DB Worker 化、大规模虚拟列表重构；只有实测触发才单独排期。整体先按约 7–13 人日安排，不将所有候选项打包承诺。

每个改动单独提交，先于最终发布完成；没有可重复收益且增加状态/恢复复杂度的改动撤回。不增加常驻开关体系；需要协议迁移时先写明版本、回滚读取能力与失效重建策略，再实施。

## 7. 验证与完成定义

实施时遵循 [验证与交付](../agent/verification.md)，本次仅文档不执行以下代码验证。

- 基线已有命令：`npm run bench:session-history`；Git benchmark 前先 `npm run build:cli`，再 `npm run bench:git-diff`。扩展现有 fixture，新增的资源/流式/soak runner 明确属于待开发，不虚构现成命令。
- 每个代码 PR 跑受影响 colocated 测试、`npm run typecheck`、`npm run build` 和 `git diff --check`。涉及 preload/安全/跨持久化高风险变更时按验证文档扩大 gate。
- UI 必须在包含当前 main/preload/renderer 的真实 App 重放，production build 上测性能；fixture/自动测试通过不等于真实 Provider 已验收。
- Claude 主路径完整验收；Codex/Qoder/OpenCode/Pi 按各自历史、终态、停止、恢复合同验证，不要求不存在的能力一致。真实外部调用只在授权范围内做，未执行的 Provider 单列 unknown。
- 交付报告：基线/候选产物身份、样本数与原始聚合指标、每进程内存/CPU、交互延迟、冷/热历史、长期趋势、故障结果，以及各持久面一致性；同时注明是否提交、安装、推送。

**完成不是“benchmark 更快”，而是：同版本可复现的目标场景变快/更省，证据与权限语义不变，压力下有界且恢复结果可解释。**
