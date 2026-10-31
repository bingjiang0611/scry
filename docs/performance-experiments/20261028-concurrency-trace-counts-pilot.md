# 并发归因计数与读者/原生试点（2026-10-28）

前两篇：[P0 主篇](./20261028-session-concurrency-p0.md)（native 工具与 12 格）、[remote readers 续篇](./20261028-concurrency-trace-readers.md)（readers 0/1/4 与 launcher）。
本篇只记录：实际 hash/JSON 工作计数工具、reader 变体的低负载 pilot、原生 12 次 pilot 结果，以及仍未测的项。

**状态**：P0 **已正式冻结**（baseline 冻结，不是改善结论；副本与验收见 [P0 冻结篇](./20261028-concurrency-trace-p0-freeze.md) §5），P1 **未开始**，未安装 App、未推送。focused 168/168 联跑通过；最后补齐原生错误与漏 patch 控制后，23 项相关测试、完整 typecheck 与真实 collector CLI 再次通过。测量工具单独提交，提交号以 Git 历史为准。

## 1. 计数工具范围（counts-only）

新增 `scripts/performance-counters/concurrency-trace-{probe,r4.counters.test,main.counters.test}.ts` 与 `tsconfig.node.json` 中对应的 strict include。原生 launcher / R5 timing 代码未改，没有把任何 probe 装进 timing 进程。

| 观测的 primitive | 计什么 | 不计什么 |
| --- | --- | --- |
| `node:crypto.createHash` | 真实调用次数（按相位桶） | native 内部压缩、子进程、其它 hash API |
| `Hash.update` | 原生调用**成功后**实际被接受的输入字节（含 encoding 解码后的字节） | 被拒调用、拷贝次数、GC |
| `JSON.stringify` | 调用次数 + 真实输出字符串的 UTF-8 字节 | 抛错/`undefined` 的输出字节 |

- 三个互斥相位桶 `writer` / `reader` / `other`；每种 primitive 各自 total，**不跨 primitive 相加**。
- `other` 含 setup、真实 client、fixture 编码、schema 校验、merge、cleanup，以及窗口内其它进程内 JS；不能把它说成“只含 oracle”。
- 这四类计数不是 CPU 成本，也不是 L2 证据；毫秒结论仍只能来自 timing 锁 wrapper 的测量。

## 2. 计数结果

`/tmp/scry-p0-trace-counts-complete.wT9Ehs/observations.json`：3 个 case × 16 metric = 48 observations × 5 真实 repetition。同目录保存 `collector.log` 与 `harness-hashes.json`；这些指标尚未注册为门禁。

| case | 形态 | reader hash 调用（5 次每格完全一致） | 独立核对式 | reader hash 字节 |
| --- | --- | --- | --- | --- |
| r4 | 16 tasks / 1k items / limit 4 / 1 peer / 7 steps / 112 reads | 111968 | `16*(7*1000-2)` | 79016560 |
| main-10k | 单 run 7 阶段：真实 main projection / revision / JSON 隔离 / merge / 字面 raw oracle | 69998 | `7*10000-2` | 25268664 |
| main-50k | 同上，**不是** client 50k 路径 | 349998 | `7*50000-2` | 115847868 |

- 七阶段的实际 item 数是 `[k,k,k-2,k,k,k,k]`：仅 `replace-stream` 把三个分散 delta 替换为一个，减少 2 项；随后 append 恢复到 k。旧实现每次观察都 hash 全数组，因此总数是 `7*k-2`，与传输了多少 delta 无关。等式只是父会话对旧实现的独立核对，**不是生产算法的永久下界**（P1 可合法消除重复 hash）。
- 这三个 case 里 writer 侧四 primitive 全为 0；这不等于 writer CPU 为 0，只是该窗口内没有经过被观测的 JS primitive。
- r4 的其它阶段另有 14 次 hash；证书随机性导致少量 byte 差异，照实保留，未做抹平。

### 标准 scenario 选择器补验

`c0bc5c02` 后发现：main 场景名用模板插值，标准工具按源码字面量发现 collector，导致 `trace.main-10k/50k` 选择器返回空。新增 selector 断言在旧声明下真实失败；改为字面 scenario 对象后，工具测试 5/5、main collector 15/15 与完整 typecheck 通过，计量窗口/工作负载未变。

实际运行 `npm run performance:measure -- --scenario trace.main-10k --out /tmp/scry-p0-trace-scenario-selector.VO1G4M`：同文件两场景均采样，最终 `candidate.json` 只含 10k 的 16 指标 × 5 样本，reader hash 仍为 69998。工具输出 `Ratchet: passed` **不表示这些未注册指标已晋级门禁**。

## 3. reader 变体 pilot

`/tmp/scry-p0-reader-pilot.ESaPrI/{manifest,analysis}.json`：源码 `c7cf4b665f1c2edad00f3541902bc3035b038fc2`（clean），bundle 与前篇矩阵相同；10k items / 1 peer；limit 固定序 `4,16,16,4,4,16,16,4,4,16`，每格 5 次。

| limit | quiet reader interval CPU 中位 (ms) | CV | whole-reader CPU 中位 (ms) | CV | cellWall 中位 (ms) |
| --- | --- | --- | --- | --- | --- |
| 4 | 374.565 | 2.677% | 2939.065 | 1.617% | 5847.155 |
| 16 | 448.564 | 2.868% | 3546.391 | 3.916% | 7209.996 |

10/10 `highLoad=false`，环境 load 2.81–4.74（/10）。这是 pilot 描述：不是优化证明、不是正式功效分析，也不是真实 App 用户路径。

## 4. 原生 pilot（4 格 × 3 次）

`/tmp/scry-p0-native-pilot.fY5TUD/{manifest,analysis}.json`：`stream` 与 `quiet` × limit 序 `4,16,16,4,4,16`，tasks 16。

| 项 | 结果 |
| --- | --- |
| 功能 | 12 次全过，每格 16 complete；Electron 报告 4 进程 CPU，`matchedShare=1`；未报告的后代仍为 `unknown` |
| 身份 | artifact `909555…` 与旧一致；harness `5bbacf322ae3f77091f7b171c82116e4f074ae64dc26177d9dbaf2c83626f398`；生产源码相对 `87c5ff` 无变化 |
| 负载 | 10/12 低负载，load 4.46–11.88；`quiet-05-limit4`、`quiet-06-limit16` 为高负载，保留但不用于 timing 解释，未补跑 |
| stream（每 limit n=3） | batch 中位 4451.5 / 3421.1 ms（CV 8.16% / 5.33%）；mainCPU 1001.7 / 874.6 ms（CV 7.06% / 3.53%） |
| quiet（每 limit n=2） | 5s 静默窗口 mainCPU 中位 147.05 / 124.05 ms（CV 16.40% / 16.93%），**样本量不足，不下结论** |

第一次 wrapper 以退出码 75 结束，原因是另一 workspace 持有 timing 锁，尚未启动 App；锁释放后才按计划执行，不是失败样本替换。`analysis` 已修正偶数样本的 median 取法（不要把上界当中位数）。隐藏窗口、`disable-gpu`；GPU 进程 CPU 不等于硬件 GPU 使用，不能外推日常 App 热点。

## 5. 已修正的历史（勿再述为现存问题）

| 曾出现 | 现状 |
| --- | --- |
| main 通道 oracle 复用 `bounded` 后再 sanitize，12/20 失败 | 改为从原始 run + 字面 policy 的独立 oracle，并加同字节篡改/缺失 change 负控 |
| 测试通过后 typecheck 分别报 TS7022、补控制后报 TS18047 | 显式标注 `ProbePhase`，guard 后用 const 保留非空 view 收窄；未放宽类型检查 |
| reader 相位曾包 `client.traceDelta`（含 client 与 fixture 编码） | 现包真实 `createDesktopHostReader` 工厂的返回函数（含 host 自身响应 JSON），并有行为边界控制 |
| hex `'61gg'` 曾按 `Buffer.byteLength` 记 2 字节 | 改按 `Buffer.from(data, encoding).byteLength`，与原生实际接受的 1 字节一致 |
| `Hash.update` 曾在原生调用**前**计字节，可能用 probe 错误遮住原生错误 | 本轮改为原生调用成功后计/累加；控制用 `null` 输入证明保留 `ERR_INVALID_ARG_TYPE` 且不虚构字节（23 项测试与真实 collector CLI 已复验） |

## 6. 未测与不可观测项

- native 内部 crypto、子进程、其它 hash API、字节拷贝：不观测。
- 计数为 0 只说明该窗口内没有经过被观测的 JS primitive。
- 本篇的组件 scope 不含真实 App 的 remote/transport 接线；后续 R6 覆盖了受限回环链路（[R6 live lane](./20261028-concurrency-trace-live.md)），但它仍不是完整日常 App／WAN／paint，也不是 L2 改善。main-only 组件仍不能冒充完整用户路径。
- 50k 的计时：本篇写时未测（只有 50k 的计数）。**后续记录**：已由 main-only 50k lane 补上（[main-only 50k 篇](./20261028-concurrency-trace-main-50k.md)），仍不是改善结论。
- 不宣称 L2 改善；GPU 进程 CPU ≠ 硬件 GPU。

## 7. 开放项（owner：父会话）

| 开放项 | 备注 |
| --- | --- |
| 基于 pilot 预注册 MDE／重复次数／顺序 | 预注册后才允许 L2 结论；**后续记录**：已定，见 [P0 冻结与比较预注册](./20261028-concurrency-trace-p0-freeze.md) §4 |
| 核对“完整用户路径 L2”缺的真实 App remote/transport 接线 | R6 的受限回环链路已接上真实 App remote/transport（[见 R6](./20261028-concurrency-trace-live.md)），只能支持该受控 scope 的 L2，不代表完整日常/WAN/paint；改善结论仍须预注册 A/B 比较，main-only 组件不能当真实用户路径；**后续记录**：预注册已定、P0 已正式冻结（[P0 冻结篇](./20261028-concurrency-trace-p0-freeze.md)） |
| 必要的 50k 计时 | 本篇写时只有计数；**后续记录**：毫秒已由 [main-only 50k 篇](./20261028-concurrency-trace-main-50k.md) 采到，仍非改善结论 |
| 不可观测项维持明确 | 不把缺失证据显示成 0 或绿 |
| 冻结 collector、然后 P1 | P0 已冻结（[副本与验收](./20261028-concurrency-trace-p0-freeze.md) §5）；measurement 已独立提交，P1 另提交 |
