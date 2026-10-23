# 批次 E 执行报告：桌面远程 trace 增量（#6b）

执行分支：`perf/e-remote-delta`，基于 `b7ab08c`，保留 A3 的 RemoteChat 隐藏窗口暂停轮询。

本批未改 STATUS.md，未合入 main，未开 PR，未安装 App。结果交审查方核验。

## 结论与提交

| 条目 | 结果 | 一句话结论 |
|---|---|---|
| 先测（受控 1000 / 5000 items） | 已完成 | 基线每次轮询都传整个 run；5000 items 时从约 2400 items 起超过 4 MiB 上限，renderer 停在 2380 items。 |
| 协议游标 + revision + reset | 已优化 | 用 `delta.after = {revision, count}` 请求增量；宿主按 item hash 返回变化的 index，无法证明连续时返回 `reset`。 |
| `traceDelta` 能力协商、旧宿主兼容 | 已优化 | `info.traceDelta: 1` 经 catalog 下发；旧宿主不发 `delta`，继续读全量快照。四种新旧组合都有测试。 |
| RemoteChat 增量合并 | 已优化 | 按 index 合入，未变的 item 保持对象身份；无变化时不更新状态，安静轮询提交 389→0 ms。 |
| 无事件退避 1.5 s → 5 s | 已优化 | 安静时间隔按 3 s、5 s 递增；有变化、状态变化或用户操作时立即恢复 1.5 s。退避本身不触发重新渲染。 |
| reset 超过 4 MiB | 部分 | 增量路径不再触发超限；但首次打开或缺口后的 reset 仍是整包，长 run 仍会超限并报错，不显示为空。 |

| 提交 | 用途 |
|---|---|
| `e27681b` | 测量：remote trace profile（真实宿主 reader + 真实客户端 + 生产 RemoteChat） |
| `8b805e8` | 测量：增加 delta bridge、记录轮询间隔、空闲尾部轮询、`--corrupt-every` 缺口注入 |
| `27d3520` | 测量：记录空闲尾部的提交；注入缺口时同时清空 changes |
| `13d7cd9` | 优化：协议、宿主、客户端、RemoteChat 合并与退避，以及测试 |
| 本报告所在提交 | 文档：实验记录、`docs/desktop-remote.md`、机会台账 |

基线代码为 `b7ab08c`。最终对比时，基线运行在 `27d3520`（基线代码 + 最终 harness），候选运行在 `13d7cd9`。

## 前后数字

- 命令：经 `.agents/skills/scry-performance-climb/scripts/timing-run.mjs` 串行执行。
  - 基线：在 `/tmp` worktree 的 `27d3520` 上运行，标签 `E-baseline-final`。
  - 候选：在 `13d7cd9` 上运行，标签 `E-candidate-13d7cd9`。
  - 参数相同：`node scripts/remote-trace-profile.mjs --items 1000,5000 --timeout-ms 1500000 --out <json>`。
  - Workload：每次轮询 20 items，每 5 次轮询有 1 次安静轮询。
- 机器负载：基线 4.92→4.25，候选 3.68→3.21，8 核，均 `highLoad=false`。
- 环境：macOS 26.3.2、M1、Node 24.18.0、Electron 42.10.1。
- 级别：字节数和次数为 L1，毫秒为 L2（受控 fixture，不含 TLS 与网络）。L3 留给用户。

| 1000 items | 基线 | 候选 | 级别 |
|---|---|---|---|
| 线上字节合计 | 55,851,560 | 1,803,851 | L1 |
| 单次轮询字节 p95 | 1,655,731 | 38,000 | L1 |
| 安静轮询字节合计 | 10,639,120 | 4,195 | L1 |
| React 提交次数 | 127 | 102 | L1 |
| 提交 ms 合计 / p95 | 2002.7 / 55.0 | 941.0 / 30.8 | L2 |
| 安静轮询提交 ms | 389.1 | 0 | L2 |
| 客户端校验/映射 ms | 91.1 | 6.7 | L2 |
| 宿主读取 + 编码 ms | 124.4 + 84.7 | 140.4 + 2.1 | L2 |
| 空闲尾部 4 次轮询的间隔 | 1.5 s 固定 | 3 → 5 → 5 → 5 s | L1 |

| 5000 items | 基线 | 候选 |
|---|---|---|
| 轮询错误 | 165 次（`desktop_evidence_response_too_large`，从 2400 items 起） | 0 |
| 一致性 | false，显示 2380 / 5001 | true，显示 5001 / 5001 |
| 线上字节合计 | 308,340,540 | 9,197,219 |
| 安静轮询提交 ms | 4214.6 | 0.1 |
| 宿主读取 + 编码 ms | 3344.0 + 502.5 | 2929.5 + 9.0 |

5000 items 的提交总 ms（21,343 vs 17,957）不能直接比较，因为基线只渲染到 2380 items。

`performance:measure` 的 ratchet 通过，没有 `worse`。`remote.trace.preview` 是手机 relay 路径，不受本批影响。

## 被消除的工作去了哪里

- **线上传输、客户端校验/映射**：未变化的 item 不再传输，也不再校验或映射，只发送变化的 index 和 run 元数据。
- **宿主**：仍对每个 item 做 O(n) 的 hash，没有消失。
  - 序列化整个 run 的工作换成了逐个 item 的 hash；读取 ms 略升（1000 items：124→140），编码 ms 大降（84.7→2.1）。
  - 这是有意新增的必要工作，用来识别原位修改，不是回归。
  - 未来可以按身份缓存 hash，但需要先让 `boundedLiveRun` 复用对象。
- **renderer**：
  - 无变化时复用原 view；intents、foreignRun、runStatus 内容相同时保留旧值。
  - 退避间隔存在 ref 中，不经 React state。
  - 空闲时只剩 0 ms 的 bailout 提交。
- **轮询频率**：只在 delta 宿主报告无变化时退避。旧宿主没有“无变化”的证据，因此保持 1.5 s。

## 红线核对

| 红线 | 实现 | 证据 |
|---|---|---|
| 缺口、revision 不连续或 reset 时全量重取 | 宿主遇到未知 epoch、已逐出的 revision 或 count 不符时返回 reset。renderer 遇到 base 不符、换了 run、新增 index 未覆盖或 count 失配时判为 gap，再读一次不带游标的全量。 | `desktop-trace-delta.test.ts`：400 次随机变更中渲染结果与宿主一致，另含 gap 用例。缺口注入时一致（19 次轮询、23 次 trace 请求）；去掉检查的负向对照不一致（显示 100 / 301）。另做了宿主只算追加的负向对照，随机用例失败。 |
| 增量路径同样执行授权 | delta 处理放在 workspace、session 和 `run_context_mismatch` 检查之后。 | `desktop-host-reader.test.ts`；`desktop-remote-host-smoke.mjs` 经真实 TLS 和生产 live run 验证：带 delta 的跨 profile 读取返回 `run_context_mismatch`。 |
| 宿主状态有上限并会释放 | 只存 hash 和 index，按 run 共享，不按 peer。 | 测试覆盖 LRU 上限与空闲清理。 |
| `knownAttachmentCount` 保持 | 客户端沿用 `#traceAttachments`；图片数不变时，renderer 保留原附件。 | merge 测试与 client 测试。 |
| 四种新旧组合 | 新客户端 × 新宿主：增量。新客户端 × 旧宿主：全量且无游标。旧客户端（`trace`）× 新/旧宿主：响应形状不变。另测了声明能力但忽略 delta 的宿主。 | `desktop-client.test.ts` 的 “trace delta negotiation” 共 8 项；`desktop-host-reader.test.ts` 断言旧形状的 key 精确为 `imageCount / kind / run`。 |

关于宿主状态的释放：

- 上限：每个 run 32 个 revision、50k 个跟踪变化，最多 8 个 run（LRU）。
- 释放时机：
  - run 离开 live 集合；
  - 60 s 内没有任何读取，在下一次 desktop 读取时清理。断连的 peer 不再读取，因此会在此规则下被释放。
- 交接文档写的是“按连接”。这里改为按 run 共享，原因有三：
  - 同一 run 只存一份，不随 peer 数增加；
  - 状态只含 hash，不含内容；
  - 状态被逐出只会让客户端多一次 reset。
- 没有接入 `releaseDesktopPeer`：状态不属于单个 peer，释放后也只会让其他 peer 多一次 reset。

## 验证

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run test:unit` | 304 个文件通过、4 个跳过；3746 项通过、4 项跳过（既有 opt-in） |
| focused：`src/main/remote`、`src/renderer`、`src/preload`（含 `desktop-transport`、`remote-workbench`） | 1302 项通过 |
| `npm run test:desktop-remote` | 通过（build、host smoke 带真实 TLS 与 delta 检查、全部 desktop-remote UI smoke） |
| `npm run test:renderer:ui` | 在 `chat-preview-ui-smoke.mjs` 处失败（`#workspace-fixture dirty` 超时）。该失败在未改动的基线 worktree `e27681b` 上同样复现，与本批无关。在 `13d7cd9` 上逐项运行链条中的其余 15 项，全部通过。 |
| `npm run performance:measure` | ratchet 通过，无 `worse` |
| profile 缺口注入与负向对照 | 见上文红线表 |

## 未验证与限制

- 未在真实 SSH/TLS 网络或 mac2 真机上测试；毫秒结论只到 L2。
- reset 仍是整包。bounded live run 超过约 4 MiB 时，在运行途中打开或重连仍会报 `desktop_evidence_response_too_large`，这与基线相同，会如实报错。
  - 升级路径：给 trace reset 复用 history 的 `byteChunks` 分块。
  - 触发条件：日常记录中出现该错误。
- 宿主 hash 的 O(n) 成本仍在。
  - 触发条件：宿主 `ipc.desktop` 读取耗时成为热点。
  - 升级路径：先让 live 投影复用对象，再按身份缓存 hash。
- 没有 live run 时（只轮询 intents）不退避，保持原有行为。

## 交付状态

- 分支 `perf/e-remote-delta` 与本报告一起 push。
- 未安装 App。临时 worktree `/tmp/scry-E-basewt` 已清理。
- 日志位于 `/tmp/scry-E-*.{json,log}`。

## 核验意见（审查方，2026-10-23）

结论：**已核验**。审查方未在本会话重跑测试（网络策略拒绝 npm registry），依据是逐行读 `13d7cd9` 的 diff 和本报告的命令记录。

**宿主算法（`desktop-trace-delta.ts`）**
- 逐 item 按 index 比较 hash：追加、原位修改，以及 `result_superseded` 删除后整体前移的 item 都会被列为变化；客户端按新的 count 截断。这比只看追加的方案正确，报告里的负对照也证明了这一点。
- 客户端游标对应的 revision 已被逐出、epoch 不认识、或 count 对不上时返回 reset；多个 peer 共享同一个 run 的 revision 链，从任一旧 revision 起算的变更并集都完整。
- 状态只存 hash 和 index，按 run 共享，并且有三重上限（8 个 run、32 个 revision、5 万个变化）；没有接 `releaseDesktopPeer` 的理由成立。
- 增量处理位于 workspace、session 和 `run_context_mismatch` 授权之后。

**客户端与 renderer**
- 客户端校验每个 change 的 `0 ≤ index < count`、`changes.length ≤ count`；宿主声明了能力但返回旧形状时，按快照处理且不带游标，不会出错。
- `mergeRemoteTrace` 会核对 base、runId，并确认 `prior.cursor.count` 等于当前显示的条数，还会检查客户端未持有的每个 index 都被覆盖；任一不满足即判为缺口并全量重取，重取后仍是缺口就报错，不会拼出不完整的轮次。
- 退避间隔存在 ref 中，不触发重渲染；只有宿主明确报告“无变化”时才退避，旧宿主保持 1.5 s。A3 的可见性暂停保留。

**接受的限制**
- reset 仍是整包，长 run 中途打开超过 4 MiB 时仍会报错（与基线相同，如实报错）。日常记录中出现 `desktop_evidence_response_too_large` 时，再给 reset 复用 history 的分块。
- 宿主每次轮询仍要对每个 item 做一次 O(n) 的 hash；1000 items 时读取 124→140 ms。这是识别原位修改必需的工作，可以接受。
