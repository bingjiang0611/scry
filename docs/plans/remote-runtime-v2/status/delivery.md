# 交付前全局验证

返回[执行状态](../STATUS.md)。按 `EXECUTION.md` §3 的顺序执行，分支 `claude/remote-runtime-v2`，HEAD `b08f9f37`，macOS arm64 / Node v24.18.0。

## 结果

| 命令 | 结果 | 证据 |
|---|---|---|
| `npx vitest run src/main/remote src/main/providers src/renderer/components scripts/performance-counters` | 通过 | 163 files / 1765 tests，exit 0 |
| `npm run typecheck` | 通过 | exit 0（node + web 两段） |
| `npm run build` | 通过 | electron-vite build 成功，`out/` 产物完整 |
| `npm run build:cli` | 通过 | `tsc` 两套配置 + `chmod`，exit 0 |
| `npm run performance:inventory` | 通过 | 输出 JSON inventory，exit 0 |
| `npm run performance:measure -- --compare 183415b` | 通过 | `Ratchet: passed`，全部行 `measured`，无 `unavailable`/`missing` |
| `npm run test:desktop-remote` | 通过 | exit 0；UI smoke 4 个默认场景（activity / workbench / runtime / hosts）+ session-opening / session-parity / composer-history / remote-settings / session-lifecycle 全绿，host smoke 完整跑完 |
| `swift test --package-path experiments/remote-g0/swift --filter 'WireTests\|LaneHandlerTests'` | not-run | 本机只有 Command Line Tools，缺 XCTest；见 STATUS「阻塞」。`swift build --package-path experiments/remote-g0/swift` 已通过 |
| `git diff --check` | 通过 | 无输出，exit 0 |

## 性能对比里唯一的上升项

`--compare 183415b` 只有 `trace.r4-cell/other` 上升：`stringify-calls` 37623 → 38073（+450），`stringify-bytes` 101,122,699 → 121,984,489（+20.86 MB，+20.6%）。ratchet 仍然通过，因为该 cell 是未登记的 candidate，不参与门禁。

定位过程（用 `git worktree` 逐提交复跑同一 `trace.r4-cell` 采集，每次 5 个 repeat 的计数完全一致，不是噪声）：

- `183415b`、`4b722947`（T0）、`6090a217`（T1）：`other.stringify-calls` 37623，`bytes` 101,122,671。
- `817778c1`（T2）、`70fc0b91`、`85891544`（T3）：38073 / 121,982,096。跳变来自 **T2 的 lane**，不是 T3。
- 逐调用点归因（临时探针包装 `JSON.stringify` 记录调用栈，用后删除）：基线在 `other` 里每个 trace 读有一次完整回包编码（`concurrency-trace-host.ts:205`，20,689,022 B / 112 次），T2 之后变成两次：同一次回包既被 host 侧 `tlsRequest` 编码（`concurrency-trace-host.ts:203`），又被 lane 假通道再编码一次产生 wire line（`desktop-lane-fixtures.ts:34`，20,691,070 B / 113 次）。

结论：**这是测量夹具的建模成本，不是生产回归**。生产宿主对 keep-alive 回包只编码一次（`src/main/remote/inner-mtls-host.ts:149`：`JSON.stringify({ keepAlive: true, ...res }) + '\n'`，one-shot 分支同样只编码一次），lane 客户端只解析、不再序列化回包。夹具的假通道为了产出给真实 `desktop-lane.ts` 客户端解析的 line，额外做了一次序列化，而它已经通过 host 侧 `tlsRequest` 模拟过一遍 TLS 编解码。

因此没有改夹具：它现在比生产更悲观，属于有意保留的保守模型（P2 的「把测量 harness 走 lane」本就要付出 framing 这一个接缝）。若要消掉这 20.86 MB，需要让假通道直接搬运 host 已经序列化好的字节，而不是从对象重新编码；这会同时改动 `desktop-lane-fixtures.ts`、`concurrency-trace-host.ts` 与 T2 的 15 个 lane 测试。已记入 STATUS「需要决定」，未擅自改动。

## 本轮为通过 §3 做的准备改动

- `scripts/desktop-remote-host-smoke.mjs` 原本 42,166 B，被 20,000 B 的 staged 文件门禁拦住（`scripts/check-staged-file-size.mjs` 对已存在的大文件也不豁免），导致 T5 要求的协议字段无法写进该 smoke。按职责拆成 `scripts/desktop-remote-host-smoke/` 下的 `harness.mjs`（传输辅助、协议 framing、启动）与 `pairing` / `workbench` / `runs` / `unknown` / `questions` / `failure` / `revocation` 七个阶段模块，驱动脚本只保留独立启停、阶段顺序和报告；提交 `b08f9f37`。
- 拆分边界按真实依赖传递：pairing 产出邀请/身份/证书，runs 产出 `submit` / `sessionAction` / `sessionPage` 供后续阶段复用，questions 返回 `activeTrace`、failure 返回 `records`/`scryEntries` 供报告使用。
- 拆分同时补上 T5 遗漏的一项：该 smoke 的每个运行通道请求现在都经 `harness.mjs` 声明 `protocol: 2`，期望的 `info` 回包也断言 `protocol: REMOTE_PROTOCOL_VERSION`。此前它断言 `protocol: 1`，即 T5 之后该 smoke 本应失败——这一点在本轮之前没有被发现，因为该文件当时无法被修改，也就没有被重跑。

## 未验证

- Swift 侧 T5 断言（`WireTests`、`LaneHandlerTests`）未运行，见 STATUS「阻塞」。
- 生产打包产物（`dist/mac-arm64/Scry.app`）未重新构建安装：本轮没有 App 运行代码改动，`test:desktop-remote` 用 `--dev` 跑的是当前代码的 Electron 实例。
- 真实 relay 链路的撤销传播（T2 已知限制）与跨 relay 1 s 传播仍未实测，需两台真实设备与 relay 端点。
