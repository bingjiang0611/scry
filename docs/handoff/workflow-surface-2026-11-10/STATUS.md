# 状态

执行中（macOS 本机）。「待核验」表示执行方已完成并 push，等审查方核验。

| 包 | 条目 | 状态 | 报告 | 备注 |
|---|---|---|---|---|
| A | macOS 环境与基线 | 待核验 | [reports/A.md](reports/A.md) | 全部命令退出码 0；`ef8d455d`；本机 EDR 会 SIGKILL 直接拉起的 claude，B 用 shim 绕过 |
| B | 真实事件核对，Q1 到 Q11 | 阻塞 | | 公司网关对 `claude-sonnet-4-6`/`claude-opus-4-6` 持续 429“模型提供方限流”（证据见 reports/B.md），其他模型名 400/404；等待网关恢复后立即开跑 |
| B | 真实夹具与回放测试 | 未开始 | | |
| C | 真实 App 验收与截图 | 部分完成 | [reports/C.md](reports/C.md) | 真实 App 已覆盖：完成态、真实退出再启动、窄宽/窄窗口/宽窗口、Agents 标签页、切到无 Workflow 行的会话再切回；运行中/失败/停止等真实运行态被 B 阻塞 |
| D | 归档回放冒烟与负对照 | 待核验 | [reports/D.md](reports/D.md) | `npm run test:workflow-archive` 正向通过，启动两次（含真实退出重启）；负对照（去掉 workflow 去重键）失败；回放发现并修掉“活动行先到 → 两个运行”“已观测到调用却说没有”两个缺陷 |
| E1 | 从聊天区打开面板 | 待核验 | [reports/E.md](reports/E.md) | 卡片入口 + focus store 选中本次运行；`ChatView` 漏传回调已补，负对照失败过 |
| E2 | 文案以实测为准 | 未开始 | | |
| E3 | 脚本不可得时的说明 | 未开始 | | |
| E4 | 大规模运行的上限与耗时 | 待核验 | [reports/E.md](reports/E.md) | 1,000/3,000 agent 夹具；128 行/事件、2,048 行、48 chip、300 日志均有断言；归一化 9ms、40 次重折叠 24–42ms，无需增量折叠 |
| E5 | 用量不重复计算 | 待核验 | [reports/E.md](reports/E.md) | 总量/分析/落盘只认 `harness/result`；面板任务级用量单独展示，测试用 26,600 vs 1,200 证明不双计 |
| F | macOS 全量门禁与总结 | 未开始 | | 不安装到 /Applications |

## 已由审查方完成（Linux 容器）

| 条目 | 结果 |
|---|---|
| 数据层、投影、面板、冒烟脚本 | 提交 `09304e7b` |
| 历史恢复去重修复与回归测试 | 提交 `09304e7b`，拆分在 `3a015367` |
| 真实 workflow 运行 | 未做，交给包 B |
| macOS、打包产物 | 未做，交给包 A、F |
