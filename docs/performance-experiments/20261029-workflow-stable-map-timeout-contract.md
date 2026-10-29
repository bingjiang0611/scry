# stable-map 单例 30 秒：经授权调整验收合同

日期：2026-10-29。仓库 `scry-workflow-m0`，分支 `feat/workflow-m0`。

## 结论与授权

维护者先要求“去掉5s限制”，随后明确选择 **“单例 30 秒”**：只给 stable-map 一个用例显式 `30_000`，不是全局放宽，也不是不限时。代码提交 `24d3343b1b9f7bc09a5ee346298e07e716f94800`，tree `6e4d08e3d96a4d2e5ddcf25f9c8e6ceb61ee3c12`。

**该单例已完成并通过，实际耗时超过旧 5 秒。生产代码没有改变，不能称为性能修复。完整 unit 仍未绿色。** 前一轮原 5000ms 失败、三项 File 优化及全部原证据保留于[前报告](20261029-workflow-file-checkpoint-followup.md)，不改写为成功。

## 改动边界

文件：`src/main/workflow-dynamic-revisions.test.ts`。

- 仅目标 `it(...)` 增加第三参数 `30_000`，并注明这是三轮持久化修订的正确性检查，耗时另行测量。
- TypeScript AST 检查证明目标唯一、原先没有显式 timeout、现在恰为 30 秒；**标题和 callback 正文逐字节一致**。
- 真实文件、三轮修订、扫描/复用/重排结果、scan=4 与 review=7 的断言、清理路径均未删改。
- 未改 `vitest.config.ts`、其他用例上限、hook/process/业务超时、默认 2 workers、skip、重试、固定负载、performance ratchet 或生产存储逻辑；没有添加 sleep。
- 这是维护者对单例测试预算的显式新决定，不是绕过旧性能门禁。实验五例比较中的该单例现在也使用 30 秒；不能与旧全 5 秒批次混称同一时限合同。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 目标策略及正文 AST | 仅一例 30 秒；正文一致 | `local/policy-ast-check.json` |
| mac2 聚焦完整测试文件 | 6/6；目标 5219.9ms | `remote/focused.log/json` |
| mac2 Node/Web 类型 | 通过 | `remote/typecheck.log`、`focused-exit.json` |
| mac2 冻结终稿全量 unit | **4526 passed / 1 failed / 4 既有 skipped**；目标 passed，5579.6ms | `remote/full-unit.log/json`；455.53s，8 核，load 2.34→5.23，`highLoad:false` |
| 本机独立全量 unit | **4525 passed / 2 failed / 4 既有 skipped**；目标 passed，5653.5ms | `local/local-full-unit.log/json`；约 536.7s，10 核，load 20.48→16.63，`highLoad:true` |

环境为 macOS arm64 / Node v24.18.0。两次全量均经宿主 `timing-run.mjs` 锁，沿用默认 2 workers、同 432 文件/4531 用例。上述耗时是本轮验收时钟；尤其本机高负载结果不能作为可信 L2 性能结论。

先做聚焦和类型，再提交单例策略，随后 mac2 用 Git archive/raw commit 冻结精确提交与 tree，源码干净。此前只有注释/import 差异的 File 优化快照不冒充此次输入。

### 未改动的其余失败

mac2 与本机均有：

```text
src/main/workflow-system-revision.test.ts
invalidates a consumer when the same native node definition changes
  despite identical selected scalar JSON
Error: Test timed out in 5000ms.
```

mac2 duration 5170.7ms，本机 5147.9ms。

本机另有：

```text
src/main/workflow-system-recovery-process.test.ts
recovers the sealed branch/native/child facts without redispatch;
  corrupted canonical bytes=false
Error: Test timed out in 5000ms.
```

本机 duration 5192.8ms。两份测试源码与生产运行源码均未在本轮修改；这些路径也曾出现在先前的超时调查中。但不能仅凭这一点或 CPU load 宣称唯一根因已确定，也不能把它们从完整门禁结果中扣除。**未顺手放宽这两个用例。**

### SSH 中断与未知结果处理

mac2 原全量运行期间，客户端报告连接中断，首次只读检查也连接超时；当时保留 `unknown`，没有重发远端 full 命令。于是本机使用全新合成 HOME/TMP、清洗后的无凭据环境做独立验证。

稍后恢复访问，读到原运行的 `full-unit-exit.json`、JSON 与完整日志，才确认它已结束、exit=1。远端只运行了一次全量；本机结果没有覆盖它。一次辅助日志检索误用了 mac2 未安装的 `rg`，仅该观察命令失败；随后使用 Node 读取原日志，确认上述 5000ms 错误，不将工具缺失当成 unit 失败或保护负对照。

## 归档与资源

持久证据：

```text
/Users/baobingjiang/.local/state/rotom/verification-evidence/workflow-stable-map-timeout-20261029.TYe9gi
```

入口 `manifest.json`、`final-state.json`。保存两台机器的原日志/JSON/退出码、AST 证明、代码 archive/raw commit、环境、脚本、合成 HOME/fixture、授权与传输经过。远端原始证据 tar SHA-256 为 `f5b052ad97b528cfc2eb98f8a3d7b52f5507b88f8956f189ce33046b97a1eab4`。测试 fixture 中的符号链接只保存原始 tar 与元数据，不在证据目录物化或跟随。

保留 mac2 `/tmp/scry-checkpoint-timeout-policy.OlnDJx`、`/Users/test/scry-checkpoint-timeout-home.Ym6dxT`，本机 `/tmp/scry-checkpoint-timeout-policy.iYWPrw`、`/Users/baobingjiang/scry-checkpoint-timeout-home.VnyLlP` 供复盘。登记路径进程查询只覆盖这些隔离前缀，不作整机审计；不按历史 PID 终止进程。

本轮仅测试和文档，不构建/安装 App 或 CLI、不升版本、不 push，不进行真实 Provider/Jev/billing 调用或生产 SQL 接入。App 运行代码仍为前一轮 File 优化，用户当前 App 不因本次测试修改而更新。

## 后续边界

本次获准的“单例 30 秒”调整已完成。其余重型 Workflow 用例仍按原 5 秒执行，完整门禁和完整 M1–M6 不能宣称完成。若要继续收口完整 unit，由维护者明确选择扩大测试预算范围，或保留 5 秒继续生产性能方案；我按下一授权执行，不自行扩大此次改动。
