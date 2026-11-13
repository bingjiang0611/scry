# 2026-11-12 — 相同工作区目标不再使 Markdown 失效

## 起点与边界

PR #63 的 `e415c4a7` 已通过 Node 性能比较，但 Native run `43242847350` 失败：

| 指标 | baseline | candidate | 上限 |
| --- | ---: | ---: | ---: |
| markdown stop-immediate settled-visible max | 1123.70 ms | 1016.80 ms | 1000 ms |
| short-heavy nativeOpen fixtureP95 | 556.10 ms | 774.00 ms | 500 ms |
| short-heavy script fixtureP95 | 376.17 ms | 327.47 ms | 300 ms |

诊断性同 artifact forward/reverse 比较也失败。全部 12 份 Native 锁记录均为 `highLoad: true`（3 cores，load 约 12–45）。保留这些失败，不把高负载当成通过或重跑断言的理由。此前 head 的 Native 成功不是本次 head 的验收。

## 定位与假设

在本地临时为既有 `measureHistory` 加 CDP CPU profiler，运行完整 `short-heavy`：20 turns × 32 sections、原有 2 次 warmup + 12 次采样、全部正确性检查保留。随后完整恢复 `session-open-bench.mjs`，不发布 profiler 配置或改变正式门禁。

锁内命令：

```sh
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs pr63-short-heavy-diagnostic -- node scripts/session-open-bench.mjs short-heavy
```

该诊断退出 0；锁记录为 `highLoad: true`，10 cores，load 21.94→20.65。3.198 s CPU profile 中 Markdown 的 inclusive samples 约 955 ms，parser 约 816 ms。这是带 profiler 开销的热点线索，**不是稳定毫秒收益，也不是历史 CI 失败的精确复现或唯一根因证明**。

生产调用链：workspace discovery 更新 `projects` → `app-state.ts` 重新生成 `workspaceRoots` → `WorkspaceFileLinkProvider` 的引用型依赖变化 → 新 context → Markdown components 变化 → 即使文字和目标完全相同也重解析。嵌套 provider 同样受父 context 变化影响。

选择：稳定既有 context memo 的语义身份。不加入跨文档 AST 缓存，不预热、不延迟解析、不降低 Markdown 功能或历史规模；后几种方案分别增加失效风险或把工作挪出测量窗口。

## 先测量，再实现

测量提交 `0c81201d` 扩展现有 Chromium Markdown layout fixture，Vite transform 只计数真实 `MarkdownChunk` 执行。原排版、拖选、原生复制、点击和键盘打开检查及期限全部保留。

固定场景：嵌套 provider，初次完整解析后，10 次用新数组传入相同 workspace/file index，然后分别改变父 workspace、file index、父 callback 并实际打开文件校验目标。

| L1 | 原实现 | 当前实现 |
| --- | ---: | ---: |
| 10 次等值刷新造成的额外 MarkdownChunk 执行 | 10 | 0 |
| 首次解析 | 执行 | 执行 |
| 新 workspace、索引、callback 的交互结果 | 保留 oracle | 通过 |

负对照日志：`/tmp/scry-pr63-markdown-context-negative.log`，明确失败于 `10 executions`，不是超时。正向日志：`/tmp/scry-pr63-markdown-context-positive.log`，3 文件 / 34 tests 通过。

实现仍使用 React memo：第一层按数组引用生成目标的 JSON key，第二层按完整目标内容和 callback identity 保留 context。顺序、去重、文件索引、父 workspace 合并和 callback 继承不变。引用不变时不额外序列化；内容变化时立即失效。JSON key 保留任意字符串边界，不依赖路径分隔符碰撞假设。

**减少的工作去了哪里？** 等值更新命中既有 React memo，不再执行相同 Markdown 的解析和重建；没有推迟、改走未计数 API 或移到 worker。目标变化仍走原文件解析和主进程授权链。

## 验证与交付

- 已验证 L1 及真实 Chromium 文件链接、选择/复制、键盘交互合同。
- PR head `46aa78b9` 的正式 run `43256174937` 完整 Performance 通过：Native 132/132，四个场景每侧仍为 2 warmups + 12 samples，Node 61/61。报告使用 baseline `73c1cd99` 与 CI merge `421214861d9635faecef755d5d0a1fff6fdd032d`，不是将 PR head 冒充 merge artifact。Native short-heavy open 251.10→242.80 ms，script 172.115→191.244 ms；markdown stop-visible max 794.20→497.00 ms。三项均按各自原预算通过，但 script 点值上升，且全部 8 份 Native 锁仍为高负载；**不能声称稳定 Native 毫秒收益或已证明旧失败的唯一根因**。Node 低负载，workspace P95 18.421→17.211 ms。
- 同 head Remote G0 通过；CI 的两片 macOS 在 runner_id=0、0 steps 时 cancelled，官方 annotation 明确 hosted runner 未取得及 arm64 capacity constraints。聚合 Check 正确拒绝。随后 main 合入 #69/#70，必须同步并验收新 head；不在过期 head 消耗 retry，不用旧绿绕过保护。原报告保留于 `/tmp/scry-pr63-{native,node}-46-dir.txt` 所指目录。
- 当前候选的 `npm run typecheck`、`npm run build` 通过。`npm run test:renderer:ui` 三段完整通过，包括生产 Workspace、侧聊、conversation ownership、unified conversation 和 Pi native history；Electron 42.10.1 / arm64，SQLite ABI 146 加载已核对。
- 同步 #69/#70 前，`npm run test:unit -- --maxWorkers=2` 完整结束：639 文件 / 5940 tests 通过，4 文件 / 5 tests 失败，5 个既有 skip（本改动未新增 skip）。3 个 launcher 断言因 stderr 多出环境注入的 `[UNDICI-EHPA]` warning 失败；managed hooks 与 recorder delivery-hole 各有一个原 5000 ms 超时。相关 Markdown 3 文件 / 34 tests 在此次全量中仍通过。不改断言、不屏蔽 stderr、不延长 deadline，也不原样重跑；超时的精确原因尚未确定。
- 同步 main `436c4e26`（#69/#70）无冲突；20 个已有提交的 range-diff 全为 `=`。再次 typecheck/build、SQLite ABI146 实载及完整 renderer UI 三段通过。再次完整 unit：658 文件中 647 pass / 6 fail / 5 skip；5997 tests 中 5984 pass / 8 fail / 5 skip。3 项为同类环境 stderr warning，5 项为原 5000/15000 ms deadline 超时（CI detector 2、archive index、recorder journal、workspace first-send 各 1），另有 recorder 超时后的 ENOTEMPTY 清理错误。没有修改期限、断言或重跑这些用例；精确超时原因未确定。Markdown 34 项仍全部通过。
- 日志：`/tmp/scry-pr63-markdown-{context-typecheck,context-build,full-unit,renderer-ui}.log`、`/tmp/scry-pr63-main70-{full-unit,typecheck,build,renderer-ui}.log`。最新提交的远端全量验收仍待完成，旧 head 成功不替代当前提交验收。
- 优化提交：本文件首次引入提交，与生产修改同提交；可用 `git log --diff-filter=A --format=%H -- docs/performance-experiments/20261112-markdown-context-identity.md` 定位。测量提交先于优化。
- 合入、发布、安装：未完成。日常 App 未替换；L3 未验证，需要用户以后安装并收集同场景 ≥30 样本、≥2 会话。
- 不新增或提升 gate，不修改 Native 工作量、样本、oracle、预算、runner 或 timeout。失败记录不能由后续成功抹掉。
