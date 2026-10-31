# 2026-10-29 P1a：有界 live 投影缓存（单点检查点）

## 状态

**P1a 代码与真实功能检查点均已验证；P1b 亦已实现并验证（[P1b 篇](./20261029-concurrency-trace-p1b.md)）。预注册 A/B 已执行，按 scope 分别判定，见[结果篇](./20261029-concurrency-trace-p1-results.md)。**

- 这是 P1 的**第一个检查点**，不是性能验收；32 + 16 采样已在完整候选上执行，结果见[结果篇](./20261029-concurrency-trace-p1-results.md)。
- P0 frozen 副本 `/tmp/scry-p0-accepted-baseline.zYksRe/` 未变，预注册 §3／§4 一字未改。
- 未安装、未推送。检查点代码提交 `445fa62ce33c60f3787428a0e6123db3f4f024db`。

## 1. 做了什么

- **缓存位置**：`createTraceRuntime`（`src/main/bootstrap/trace-runtime.ts`），因此覆盖所有 `boundedLiveRun` 调用（桌面 reader、`agent:activeRuns`、focused run、remote history）。
- **缓存内容**：投影后的 items ＋ 每项之后的 remaining turn budget。metadata 每次 `{...run}` 现取，**不缓存**。
- **固定 policy／source**：`LIVE_TOOL_CONTENT_POLICY` ＋ `live_renderer`。今天没有运行时改法；改它就是代码变更，必须整代失效。
- **自有上限**：最多 8 个 run、合计最多 50 000 个投影 item，LRU；单 run 超过 50 000 则完全不缓存（逐读全量投影）。
- **失效基础**：writer helper 内部的三数字状态（`revision`／`baseRevision`／`dirtyFrom`，`src/main/live-trace.ts`），WeakMap 按**原始 items 数组身份**附着；不存事件、不存历史、没有注册表。
- **重建范围**：从最早 dirty index 起重建完整后缀；prefix 的剩余预算 O(1) 取得。128 KiB 是**累计 turn 预算**，所以早项变大或变小可能影响后续项目的可见内容，不能只替换一项。
- **未跟踪数组**：从未经过 writer helper 的数组走**原来的全量** `sanitizeToolEvents`，不缓存，也不创建/消费状态。
- **多读者**：只有 `seenRevision >= baseRevision` 才信 `dirtyFrom`，否则整段重算；quiet（无写入、无 pending）直接复用缓存数组，仅刷新 LRU。
- **生命周期**：数组换代即失效；`done=true` **不**清理（终态 diff／persist 晚到仍合法写入）；显式 `forgetBoundedRun` 挂在唯一的 `runs.remove` 路径上。
- **晚到 enrichment**：`onPersisted` 仍按 id 查找、仅在存在时替换（不复活已删除项），mark 在共享 helper 内部完成。

明确不改：`desktop-trace-delta.ts` 的 `MAX_RUNS 8`／`MAX_REVISIONS 32`／`MAX_TRACKED_CHANGES 50 000`；**hash 依旧全量**（P1b 才做 hash hint）；生产 IPC／wire／raw storage／trust／ACK；无 scheduler、无配置项、无注册框架。

## 2. 盘点过的写入面（不是完备性证明）

| writer | 写法 | 何时 mark |
| --- | --- | --- |
| `appendCoalescedTrace` | 尾部 push；原地改尾项 `text`／`thinking`／`llmPerformance`；`replacesStreamedText` 先非尾 splice 删除再插入 | 三个分支各自 mark 真实位置 |
| `upsertTraceById` | 同 id 替换 / push | 替换 index 或末位 |
| `replaceTraceById` | persist enrichment，同 id 替换 | 命中 index；缺失即返回 false |
| `ensureFailedTerminalResult` | 新建 terminal，或 canonical＋全部 duplicate 原地修正 | 最早被改 index |

历史数组（`normalize`、`pi-native-history`、`conversation-history`、`session-history-page-projection`、`remote-gateway-history`、`conversation-store`、`history-load` 等）是快照或临时数组，不共享 live 状态；`remote-run-binding.ts` 的自有 items 是设备输出日志，不是桌面读到的那一份。

**诚实边界**：未记录的通知（有人直接原地改嵌套字段、没走 writer）**不会**被自动发现——没有计数器能证明这一点，源码 grep 也不是完备性证明。维护手段只有 writer 盘点 ＋ 针对性测试；漏 mark 是实现 bug，由测试抓（§3 的 red 控制）。

## 3. 验证（父会话）

- focused：`npm run test:unit -- src/main/bootstrap/trace-runtime-bounded.test.ts src/main/bootstrap/trace-runtime-bounded-controls.test.ts src/core/turn-recorder/tool-content.test.ts src/core/turn-recorder/content-policy.test.ts src/main/live-trace.test.ts src/main/run-outcome.test.ts src/main/remote/desktop-trace-delta.test.ts src/main/remote/desktop-trace-evidence.test.ts scripts/concurrency-trace-revisions.test.ts src/main/bootstrap/run-live-state.test.ts` → **59/59，10 files**；完整 `typecheck`、`npm run build`、`git diff --check` 通过。
- 新增缓存用例 16 条、负控制 3 条，并扩展 1 条真实持久化用例，包含：
  - 真实私有 userData 的 `onPersisted` 跨 `await` 重定位（persist 期间真实 splice，tool 索引 -1 后仍按 id 命中）；
  - 3 个独立 fault controls：property 通知丢失、结构性 dirty 起点后移、预算后缀陈旧（预算控制下**首项正确、尾项错误**，因此不是靠早项差异蒙过去）；
  - 未跟踪数组与嵌套 `input` 原地修改、items 数组换代、多 runtime 先后消费、8 run／50 000 item 淘汰、>50 000 逐读、`forgetBoundedRun`。
- 真实 red 控制 `/tmp/scry-p1a-missing-mark.KGLirk`：父临时删掉 tail merge 的 mark → focused 用例 `rebuilds a merged tail …` exit 1（**1 fail／15 未选**；这 15 条是未选中的用例，不是默认 skip，也不是全量覆盖）；恢复后同命令 1 pass／15 未选；`cmp` 证明 `src/main/live-trace.ts` 回到 SHA `617d72da451db6a054938139d47216e37608c31c9dabb37f2ed7316ff9b194db`。
- 首败记录（保留，不抹）：
  - 第一轮 `50/53`（`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-97dbe6b415181047.log`）：quiet 缺 fast-return 是**真实现 bug**；same-byte 用例正文没真变、且错误要求 suffix 身份保持。
  - 第二轮 `56/60`（`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-78c6bc1fdc01d116.log`）：负控制注入换了 state 身份，所以没破坏算法；E2E 漏算启动 `controls` 事件。删除的是当轮新造、违反 same-id 合同且在当前调用链不可达的 I/O case，没有削弱真实断言。

## 4. L1 计数（唯一实测数字，只说明少了什么工作）

命令：`npm run performance:measure -- --scenario trace.main-50k --repeats 5 --out /tmp/scry-p1a-main50k-counts.bBXvOB` → 15 个 collector tests 通过、ratchet 通过，产出 `candidate.json`／`measure.json`／`p0-comparison.json`。固定 workload 未变：50 000 items、7 stages、7 observes、7 merges，16 observations × 5。

对照冻结计数 `/tmp/scry-p0-trace-counts-complete.wT9Ehs/observations.json`：

| 指标 | P0 | P1a | 变化 |
| --- | --- | --- | --- |
| reader stringify calls | 466 657 | 399 993 | −14.2854% |
| reader stringify bytes | 119 915 583 | 117 591 125 | −1.9384% |
| total calls | 583 332 | 516 668 | −11.4281% |
| total bytes | 273 416 619 | 271 092 161 | −0.85015% |
| writer／other | 不变 | 不变 | — |
| hash calls／bytes | 349 998／115 847 868 | 同左 | 不变 |

边界：此处量到的减少是**重复投影里工具 input 的编码**（同一批 tool 事件每次读取都重新 capture 并 JSON 序列化）以及相应 total 计数；hash 仍全量，所以不能叫整体 CPU 下降，也不能说"更快"。本场景无 `worse` 项。

## 5. 真实功能检查点（锁自然释放后完成）

锁释放后，父会话用同一 artifact 完成了真实功能检查点，结果 `/tmp/scry-p1a-checkpoint-functional.GNExdI/acceptance.json`：

- R6 `limit 16 / peers 1`：16 个正常回答、16 个真实 archives、112 rounds ＋ 完整 oracle，seeds 16 000；host 4 个、client 3 个登记进程 stopped 且 close0。
- main50k：35 phases、完整 oracle，3 个登记进程 stopped 且 close0。
- `corrupt-body` 负控：exit 1，确实由 oracle 拒绝并保留原始错误；3 个登记进程 stopped 且 close0。
- 身份稳定：App `out` 为 `ada10eebbd8e8cbdc467be2ce354b2b0f4eed57895df43ba89f1ae7ac9ca8337`，`liveOut` `540bb0c0…`，50k bundle 仍 `c58a7c2451687b34096b101c6eee1e0f6ab278fbbb0045d4453bde564ca9429d` / 66 673 B。
- 三次运行都是 `highLoad=true`（17.17→17、17→16.52、16.52→16.52），因此**只作功能证据**：不是 A/B 样本，不补采、不替代，也不能用来说明更快。

## 5b. 未验证与阻塞（历史，保留两次 pre-dispatch）

- **第一次尝试时真实 App 与 50k 功能未跑**：artifact 已构建 `/tmp/scry-p1a-main50k-build.i1ciZv`（bundle SHA `c58a7c2451687b34096b101c6eee1e0f6ab278fbbb0045d4453bde564ca9429d` / 66 673 B），但两次尝试都在 pre-dispatch 阶段被共享 timing 锁挡住、exit 75：
  - `/tmp/scry-p1a-functional.BX0nEZ/r6/driver.log`：`checkpoint-matched-final-sqlite`（pid 63017）
  - 确认 owner 退出、锁释放后一次重试 `/tmp/scry-p1a-functional-after-lock.jyp7Z5/r6/driver.log`：`checkpoint-final-independent-contracts`（pid 63813）
  - 两次都只有 `driver.log`，没有 App 子进程；50k 与 `corrupt-body` 命令都没到达。未抢锁、未杀他人进程、未补样本。
- 因此当时：无 R6／50k 真实回放，无 P1 A/B，无 L2／L3 结论；内存只有 before／after 有界样本口径，paint／WAN 未测。后来的真实功能检查点见 §5，但**完整 A/B 仍未开始**。

## 6. 下一步

1. 父会话提交本检查点（提交号后补）。
2. ~~锁空闲后重跑真实 App／50k 功能与 `corrupt-body` 控制~~ → 已在 §5 完成（功能证据，非 A/B）。
3. P1b（hash hint）已实现并验证；`MAX_*` 与旧 cursor／reset 合同不变。预注册 A/B 见[结果篇](./20261029-concurrency-trace-p1-results.md)。
4. P1a+P1b 候选已按预注册 §4.2 完成 32 + 16 采样，见结果篇；`highLoad` 按 §4.3 只排除该配对，未改阈值、未补采，未达 MDE 不报改善。
