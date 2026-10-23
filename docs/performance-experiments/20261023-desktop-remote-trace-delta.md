# 桌面远程 trace 增量协议（批次 E，#6b）

日期：2026-10-23。分支 `perf/e-remote-delta`，基于 `b7ab08c`（已含 A3 的 RemoteChat 隐藏窗口暂停轮询）。

## 问题

Mac→Mac 远程会话运行时，`RemoteChat` 每 1.5 s 调一次 `api.trace`，宿主每次返回整个 live run。轮询的成本随轮次长度线性增长。安静轮询（没有新事件）也照样传输和提交整个 run。

基线测量还发现一个正确性问题：bounded live run 超过约 4 MiB 后，宿主返回 `desktop_evidence_response_too_large`。在本 workload 中，从约 2400 items 起每次轮询都失败。renderer 停在 2380 items，后续事件全部丢失。

## 测量方法

- 生产代码路径：
  - 真实 `createDesktopHostReader` + 真实 `DesktopRemoteClient`，中间是进程内 JSON 线（不含 TLS 分帧）。
  - 生产 `RemoteChat` 包在 `<Profiler>` 中，使用 `react-dom/profiling`。
  - 定时器由驱动接管，每推进一步宿主状态就触发一次轮询。
- Workload：
  - 每个单元 5 个 items：text delta 跨轮询合并、Bash/Read 调用与结果，并在原位替换较早的结果。
  - 每次轮询 20 items，每 5 次轮询有 1 次安静轮询。
  - 规模为 1000 / 5000 items。结束后再做 4 次空闲轮询，用来观察退避。
- 故障注入：`--corrupt-every N` 把每第 N 个 delta 的 base 改成客户端没见过的值，并清空 changes。计时运行不开启。
- 代码：`scripts/remote-trace-profile.mjs`、`scripts/fixtures/remote-trace-host.ts`、`scripts/fixtures/remote-trace-profile.tsx`。测量相关提交 `e27681b`、`8b805e8`、`27d3520` 与优化提交分开。
- 命令（经计时锁串行执行）：

  ```sh
  # 基线：/tmp worktree，位于 27d3520（基线代码 + 最终 harness）
  node .agents/skills/scry-performance-climb/scripts/timing-run.mjs E-baseline-final -- node scripts/remote-trace-profile.mjs --items 1000,5000 --timeout-ms 1500000 --out /tmp/scry-E-baseline-final.json
  # 候选：13d7cd9
  node .agents/skills/scry-performance-climb/scripts/timing-run.mjs E-candidate-13d7cd9 -- node scripts/remote-trace-profile.mjs --items 1000,5000 --timeout-ms 1500000 --out /tmp/scry-E-candidate-13d7cd9.json
  ```

- 环境：macOS 26.3.2，Apple M1（8 核），Node 24.18.0，Electron 42.10.1，React 18.3.1。
- 机器负载：基线 4.92→4.25，候选 3.68→3.21，两次均 `highLoad=false`。

## 结果

字节数和次数是 L1；毫秒是 L2（受控 fixture，不是真实 App 或网络）。

### 1000 items（63 次轮询，其中 12 次安静）

| 指标 | 基线 | 候选 |
|---|---|---|
| 线上字节合计 | 55,851,560 | 1,803,851（−96.8%） |
| 单次轮询字节 p95 | 1,655,731 | 38,000 |
| 安静轮询字节合计 | 10,639,120 | 4,195 |
| 宿主读取 + 编码 ms | 124.4 + 84.7 | 140.4 + 2.1 |
| 客户端校验/映射 ms 合计 | 91.1 | 6.7 |
| renderer trace IPC ms 合计 | 300.2 | 149.1 |
| React 提交次数 | 127 | 102 |
| React 提交 ms 合计（p95） | 2002.7（55.0） | 941.0（30.8） |
| 安静轮询提交 ms 合计 | 389.1 | 0 |
| 空闲尾部 4 次轮询：提交次数 / ms | 8 / 272.4 | 1 / 0 |
| 轮询间隔 | 固定 1.5 s | 活动时 1.5 s；安静时 3 s；空闲尾部 3→5→5→5 s |
| 一致性（renderer 与宿主相同） | true | true |

### 5000 items（313 次轮询，其中 62 次安静）

| 指标 | 基线 | 候选 |
|---|---|---|
| 轮询错误 | 165 次，从 2400 items 开始 | 0 |
| 最终显示 items | 2380 / 5001（**不一致**） | 5001 / 5001 |
| 线上字节合计 | 308,340,540 | 9,197,219 |
| 单次轮询字节 p95 | 3,740,261 | 38,024 |
| 宿主读取 + 编码 ms | 3344.0 + 502.5 | 2929.5 + 9.0 |
| 客户端 ms 合计 | 469.4 | 34.5 |
| 安静轮询提交 ms 合计 | 4214.6 | 0.1 |
| React 提交 ms 合计 | 21,342.9 | 17,957.3 |

5000 items 的提交总 ms 不能直接比较：基线在 2380 items 处已停止更新，而候选渲染了全部 5001 items。

### 缺口注入（正确性，不计时）

| 场景 | 轮询 / trace 请求 | 一致 |
|---|---|---|
| 候选，`--items 300 --corrupt-every 4` | 19 / 23（4 次全量重取） | true |
| 负向对照：去掉 `mergeRemoteTrace` 的 base 和覆盖检查 | 19 / 6 | **false**（显示 100 / 301） |

## 被消除的工作去了哪里

- **线上传输和客户端校验**：每次轮询只传 run 元数据和变化的 index。未变化的 items 不再序列化、传输、校验或映射。
- **宿主**：每次轮询仍做 O(n) 的工作。旧做法是序列化整个 run；新做法是对每个 item 做 `JSON.stringify` + sha256，再对较小的结果做一次尺寸检查。
  - 1000 items：读取 ms 小幅上升（124→140），但编码 ms 从 84.7 降到 2.1，宿主合计 209→143 ms。
  - 进一步优化可以按 item 身份缓存 hash。但 `boundedLiveRun` 每次都会生成新对象，需要先改 live 投影，本批不做。
- **renderer**：
  - 按 index 合并，未变化的 item 保持对象身份。
  - 没有变化时返回原 view，不调用 `setActiveRun`。
  - 内容相同的 intents、foreignRun 和 runStatus 保留旧值，安静轮询只触发 0 ms 的 bailout 提交。
  - 退避间隔放在 ref 中，退避本身不触发重新渲染。
- **轮询次数**：空闲时间隔升到 5 s，单位时间内的读取约减少到 30%。只在 delta 宿主返回“无变化”且 intent/状态也没有变化时才退避；有变化、状态变化、提交、停止、回答或切换上下文时立即恢复 1.5 s。

## 限制与升级条件

- **reset 仍然整包**：首次打开、缺口或被逐出后的 reset 仍是全量快照。bounded live run 超过约 4 MiB 时，reset 仍会像基线一样失败；失败会显示为轮询错误，不会显示空列表。
  - 触发升级的条件：真实使用中在运行途中打开或重连这类长轮次。
  - 升级路径：给 trace reset 复用 history 的 `byteChunks` / `history_chunk` 分块。
- **宿主状态按 run 存储，不按 peer**：所有已授权 peer 共享，只存 hash 和 index。
  - 释放时机：run 离开 live 集合；60 s 内没有任何读取（断连后的 peer 不再读取，清理在下一次 desktop 读取时进行）；LRU 超过 8 个 run。
  - 上限：每个 run 最多 32 个 revision、50k 个跟踪变化。
  - 状态被逐出只会让对应客户端多一次 reset。
- **测量范围**：未测真实 SSH/TLS 网络与 mac2 真机；L3 由用户在发布后的日常记录中确认。
- `performance:measure` 的 `remote.trace.preview` 属于手机 relay 路径，本批不涉及；ratchet 通过。
