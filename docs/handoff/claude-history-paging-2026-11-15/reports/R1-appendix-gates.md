# R1 附录：T1 门禁原始记录

主报告：[`R1.md`](R1.md)

| 命令 | 退出码 | 耗时 | 证据 |
|---|---|---|---|
| `npm run typecheck`（首次） | 0 | 33.05 s | `evidence/t1-typecheck-first.log` |
| `npm run typecheck`（脚本改动后复跑） | 0 | 24.02 s | `evidence/t1-typecheck-final.log` |
| `npm run test:unit`（全量，首次） | 1 | 1321 s | `evidence/t1-unit-full-suite.log` |
| `npm run test:renderer:ui`（首次） | 1 | 290 s | `evidence/t1-renderer-ui-first-failure.log` |
| `npm run test:renderer:ui`（重建原生模块后） | 0 | 882 s | `evidence/t1-renderer-ui-pass.log` |

- renderer UI 首次失败原因：`better-sqlite3` ABI 不匹配（`NODE_MODULE_VERSION 137` vs `146`），Credits fixture 报 `Temporary DB write failed`。两边执行 `electron-builder install-app-deps` 后全量通过，含 `--loading-only`、`--cache-only`、`--structure-only`（`session-capability-ui-smoke.mjs` 的会话缓存与结构检查在内）。
- unit 全量：`Test Files 8 failed | 644 passed`，`Tests 14 failed | 5998 passed`。失败项全部是 **`Test timed out in 5000ms`**，无断言失败。
- 定性（下表）。结论：**无本次改动引入的新失败**。

| 文件集合 | HEAD（默认 5 s） | HEAD（`--testTimeout=60000`） | 基线 `a464aff`（默认 5 s） |
|---|---|---|---|
| 7 个可疑文件（managed-tool-hooks、commit-environment、codex-app-server、pi-commands、pi-settlement、pi-usage、workspace-choices） | 4 文件 / 11 例超时（`t1-unit-failing-files-head-default-timeout.log`） | 7 文件 / 97 例全过（`t1-unit-failing-files-head-60s.log`） | 5 文件 / 13 例超时（`t1-unit-failing-files-base-default-timeout.log`） |
| `transcript-archive-paging.test.ts` | 1 例超时（分页主用例 6685 ms > 5000 ms） | 8 例全过 | 分页主用例同处超时（撤掉本轮全部改动后 8351 ms） |

最后一行是负对照：把本轮改动全部撤掉，同一用例仍是 8351 ms（比有改动时的 6685 ms 更慢），说明超时来自本机负载而不是改动。我没有修改任何测试超时配置或跳过断言。

