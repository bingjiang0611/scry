# 批次 E：核验与修订

[原批次修改记录](E-initial.md) 原文归档。E1/E3 的旧行为与手验预期以本页核验意见及后续修订为准；E2 已核验，M3 放弃已接受。

## 核验意见（审查方，2026-10-26）

**结论：E2 已核验；M3 放弃接受；E1 需修改（VE1：协议不匹配被当成「可能已送达」）；E3 需修改（VE2：短暂故障也会被永久死信）。**

### 复跑

- 红测在各自的测试提交上复现：`fdecff3` commit-environment 4 个失败；`d63ca89` commit-notification + recorder 3 个失败、147 个通过；`46c158e` commit-delivery 6 个失败。与报告一致。
- HEAD `4e7ea9c`（Linux/Node 22）全量：7 个失败、3986 个通过、5 个跳过。7 个失败与之前记录的环境失败完全一致，**没有新增**。`npm run typecheck` 无错误。
- 测试拆分：`recorder.test.ts` 加 `managed-turn-commit.test.ts` 在 `01c2c46` 与 HEAD 上都是 **190 个测试**，数量一致。片段由原入口注册，并在 vitest 配置里排除，避免被独立重复收集。`check:cli-release` 用目录过滤，也不会重复执行。
- 源码拆分：用 AST 对比 store/daemon/managed（`01c2c46`）与拆出来的 13 个文件。161 个声明没有缺失；有变化的 18 个都是 E1–E3 涉及的通知、ACK、daemon 传输和 managed handoff，新增的 25 个都属于死信和 env 快照。
- 流程（记录，不要求返工）：源码拆分又混进了修复提交（`a820079`、`5210078`），测试拆分混进了红测提交（`d63ca89`）。

### E2

接受。`recordPath` 相对于 dataRoot，SHA-256 按原始文件字节计算，测试用自定义 dataDir 加多余空白来证明；文件只读一次、parse 一次；通知 schema 升到 2，旧字段不变；显式 redelivery 仍然不推进 ACK。README 的 ACK 语义写明「依赖 uploader U1」，没有越界承诺。

### VE1（必改，E1）：daemon 返回 409 时，shell 也把事件当成「可能已送达」

- 机制：daemon 在读取 body **之前**就会因为协议不匹配返回 409（`daemon.ts:325-327`），同理 400 和 404 也都发生在 apply 之前。但 shell 只对 rc=7 清除标记，其他非 200 一律设置 `SCRY_RECORDER_DAEMON_TRIED=1`，CLI 随后只入队，也不会拉起 daemon。409 请求不会触发 `scheduleRecovery`，却会重置 idle 计时器，所以只要 Provider 一直在发事件，这些 inbox 条目就可能一直等不到重放。
- 探针（临时，已删除）：把当前生成的 `provider-hook.sh` 中的协议头改成 1，模拟 C/D 时期没有 repair 的脚本；启动真实的 E daemon，再投递一次 UserPromptSubmit。结果 `{"triedHandedToCli":"1"}`，事件被交给 CLI 只入队。
- 影响范围：已发布的旧脚本（C 之前）没有这个标记，不受影响；受影响的是本分支 C/D 期间 repair 过的测试工作区。更重要的是**以后每一次协议升级**：E 时期的脚本遇到协议 3 的 daemon，会重演这个问题。
- 改法：shell 在 `rc=0` 并且 HTTP 码是 4xx 时，与 rc=7 一样视为「确定没有送达」，清除标记，让 CLI 正常走（CLI 会用自己的协议再试 daemon，或者直写）。只有超时、断连和 5xx 才保持「结果未知」。同时确认 daemon 只会在 apply 之前返回 4xx。先补一个在当前实现上失败的测试：协议头不匹配时，事件被应用，或者经由 CLI 的 daemon 调用成功，inbox 为空。

### VE2（必改，E3）：短暂故障也会在几百毫秒内被永久死信

- 机制：失败次数只按调用次数累计，没有时间间隔（`store-notifications.ts:244-259`）。daemon 在**每个** hook 请求之后都会 drain（`daemon.ts:344`），冷启动路径同样如此。一轮里有多个工具事件时，uploader 短暂不可用（3 秒入队超时、磁盘短暂写满、锁竞争）就足以在几秒内用完 5 次。死信之后不会再自动重试，也没有重放命令，只能靠改 bundle 指纹触发全量重投。
- 探针（临时，已删除）：用 commit-delivery 测试自带的 receiver，让 sequence 1 返回 71；连续 drain 5 次，耗时 **261 ms**；然后恢复 receiver，再 drain 3 次。结果：sequence 2 和 3 收到了，sequence 1 停在死信，`notifyBacklog: 0`，不会再被投递。
- 这把「短暂故障」变成了「永久不上传」，违背采集可靠性的目标。E 之前遇到同样的情况会卡住，但故障一恢复就会自动补齐。
- 改法：
  1. 按时间退避：第 n 次重试必须等到 `lastFailureAt + 间隔(n)`，建议间隔依次为 1、5、15、60 分钟，即持续失败约 80 分钟以上才进入死信。退避期间这一条本轮直接跳过，**继续投递后面的记录**（现在的 processedThrough 和 ACK 设计已经允许乱序，ACK 仍然不能越过它），这样它也不会造成队头阻塞。doctor 显示「重试中，下次时间」。
  2. 增加显式重放：例如 `scry recorder notify-retry --sequence N`（以及 `--all-dead`）。它把对应死信移到历史记录、清零计数，然后按正常流程投递，不伪造 ACK，trust 校验照常执行。README 里写明用法。
  3. 测试：先补失败测试。连续快速 drain 5 次不应死信；超过退避时间的模拟时钟下才计入下一次；退避期间后续记录照常送达；重放命令能让死信重新送达并推进 ACK。
- 阈值 5 次和每次 10 秒的熔断保持不变。

### 其他（不阻塞）

- `record-environments/` 旁路文件不会随 archive 删除，并且可能包含 `TMCP_TRACE_URL` 这类敏感值。建议后续在 archive 时一并处理，或者在 README 的归档章节写明需要手动清理。
- M3 放弃：理由与用户 2026-10-25 的确认一致（服务端已去重，代价只是重复校验），接受。

### 状态

H3 → 需修改（VE1）；M4（E2）→ 已核验；M2（E3）→ 需修改（VE2）；M3 → 放弃（已接受）。执行方做 VE1 和 VE2，在本报告末尾追加「VE 修改记录」，H3、M2 改回「待核验」。

## VE 修改记录（执行方，2026-10-26）

审查意见原文保留在上方，不重写。本节只记录 VE1、VE2 的实际修改、验证与限制。

### 提交

| 顺序 | 提交 | 内容 |
|---|---|---|
| 0 | `4ba8148e` | 纯拆分：callback 执行提取到 `commit-hook-process.ts`；原报告归档为 `E-initial.md`。18 个声明/注释不变（`/tmp/scry-VE-split-audit.log`）。 |
| 1 | `d71c88a7` | VE1 红测：`src/cli/hook-http-outcome.test.ts`。 |
| 2 | `44f4ed00` | VE1 修复。 |
| 3 | `d837ed22` | VE2 红测：`commit-delivery.test.ts`。 |
| 4 | `2524cf11` | VE2 补充红测：CLI 重放选择、每个退避间隔前 1 ms 不计数、旧 store 断言按新规格调整。 |
| 5 | `7631f532` | VE2 修复 + 文档。 |

拆分与修复分开提交。VE2 的 `commit-delivery-ledger.ts` 是新模块，不属于既有文件提取。

### VE1

- 改法：`workspace-hook-sources.ts` 在 `case "$rc:$code" in 7:*|0:4??)` 时清除 `SCRY_RECORDER_DAEMON_TRIED`，其余（超时、断连、5xx）保留「结果未知」标记。未改 daemon 生产逻辑，未改动 404/409/400 在 apply 之前返回的既有事实。
- 红测：4 个 HTTP 4xx 用例，加一条真实 stale-protocol（协议头 1）→ 当前 CLI → daemon 全链路：事件被应用、open turn 的 prompt 正确、session inbox 为空。修复前 5 failed/1 passed（`/tmp/scry-VE1-before-final.log`），修复后 6 passed（`/tmp/scry-VE1-after.log`）。
- 红测 fixture 修正（披露）：最初断言读的是 `userText` 和全局 inbox，在修复前也没有执行到；提交前改为 typed `RecorderOpenTurnState.prompt` 与 session 级 `recorderInboxEntries()`。修改的是夹具读取位置，不是断言语义。

### VE2

- 退避按墙钟时间，而不是调用次数：失败后间隔 1、5、15、60 分钟，持久化 `lastFailureAt`，得出 `nextRetryAt`；首次失败到第五次至少 81 分钟。未新增后台定时进程：到期由下一次 hook、`recover` 或显式 drain 触发。
- 逐 sequence 记账：新增 `notifications/delivery-outcomes/<fpHash>/<20 位序号>.json`，状态为 `retry`/`dead`/`delivered`/`replay`。`processedThrough` 只表示遍历位置，不是成功证明；ACK 只跨连续的持久化成功凭据前进，遇到 retry 或 dead 停止。退避中的条目本轮跳过，后续记录继续投递，不做队头阻塞。
- 迁移：检查点仍是 schemaVersion 1，新增 `queueVersion: 2`。旧的内联 `failure`、旧次数、旧死信保留并迁移；不伪造旧等待历史。v2 状态里再出现内联 `failure` 视为损坏。旧 `processed > ACK` 但没有任何死信证据时报 `commit notification state is missing dead-letter evidence`，不当作已投递。
- 死信重放：`scry recorder notify-retry --sequence N` 或 `--all-dead`（二选一，`--sequence` 必须正整数）。顺序是 history → replay marker → 移出活动死信并 fsync 目录 → 正常 drain；崩溃后由 marker 续做，不重复投递。历史在 `notifications/dead-letter-history/<fpHash>/<hash>.json`，保留原始失败记录。重放前照常执行 enablement 与 trust 校验，校验失败返回 3 且不改动静止死信。
- 冷启动 redelivery 不再绕过退避：已有 retry/dead 的最新记录不会被这条路径再次调用；未 ACK 的最新记录首次失败也进入 ledger。
- doctor：`retrying sequence N: X failed attempts (reason); next retry <ISO>`，retry 为 warn、dead 为 fail，均为 degraded 5；状态读不出来时报 unavailable，不显示成 0。
- 阈值 5 次、callback 10 秒熔断不变。fsync、trust/指纹规则、fail-open 观测路径均未改。

### 验证

| 检查 | 结果 |
|---|---|
| VE1 红测（`d71c88a7` 实现状态） | 5 failed / 1 passed |
| VE1 修复后 focused | 6 passed |
| VE2 红测（`d837ed22` 实现状态） | 12 failed / 2 passed；全量 12 failed / 3992 passed / 4 skipped |
| VE2 补充红测（`2524cf11` 实现状态） | 3 个测试文件 18 failed / 11 passed；store-1 调整的 3 项在旧实现上也失败 |
| VE2 修复后 focused（3 文件） | 29 passed |
| store-1 调整的 3 项 | 旧实现 3 failed → 修复后 3 passed |
| `npm run typecheck` / `npm run build:cli` | 通过 |
| `npm run test:shell` | PASS setup-scry-workspace |
| `npm run smoke:cli-package`（隔离 HOME/XDG/cache） | bin/init/hook/doctor/concurrentNotifications/legacyCursor 全 ok |
| `npm run performance:measure -- --scenario source-control.diff` | 8 → 8，ratchet passed（本批未触该热路径，仅作回归确认） |
| 构建 CLI 隔离探针（`/tmp/scry-VE-built-probe.mjs`） | 见下 |

构建 CLI 探针用当前 `packages/turn-recorder-cli/dist`、隔离 workspace/HOME/XDG、可控制的墙钟（`--import` 注入 `Date.now`）、合成的 Pi 生命周期和本地 receiver：

- 连续 5 次快速 drain 不增加失败次数（仍是 1 次调用），sequence 2、3 照常送达；
- 只在 60 s / 300 s / 900 s / 3600 s 到期时各重试一次（每个间隔前 1 ms 不重试）；第五次失败后转为死信，`processedThrough: 3`、`ackedThrough: 0`、`notifyBacklog: 0`；
- 死信后归档被拒（`undelivered-records`），重放前无法掩盖未投递；
- `notify-retry --sequence 1` 送达 1 条、`pending: 0`，随后 `--all-dead` 重放 0 条，最终 `{ ackedThrough: 3, notifyBacklog: 0 }`；
- history 保留原失败（attempts 5）；record 原始字节与每条通知的 SHA-256 一致；env 仍按轮快照且不出现在 record 正文；sidecar 0600，归档后不自动删除。

### 首次失败与限制

- 全量 `npm run test:unit`（本机，load average 155–190）：30 failed / 3976 passed / 4 skipped（`/tmp/scry-VE-final-unit.log`）。失败集中在 `source-control/service`、`git-readonly`、`check-staged-file-size`、`desktop-client`、`pi` 等真实 Git/TLS/子进程用例的 5–15 s 超时；`commit-environment` 两项是 `delivered.jsonl` 未生成。抽样重跑 `commit-environment`、`recorder`（Codex rollout、昂贵 Git 快照、大 Diff、drain budget）6 项全部通过（`/tmp/scry-VE-affected-recheck.log`），仍不把重跑当修复，也不提高超时或弱化无关断言。
- 与 VE1 修复前的同类失败比，本次 32 条失败记录里 21 条精确同名出现过；其余 11 条是同类超时在不同文件的再现（含两条同名重复出现）。没有新增与通知投递相关的失败。
- 未验证：真实 Provider 生命周期、外部 uploader U1–U4、真实死信运维流程；探针是合成事件加本地 receiver，不等价于真实验收。
- 已知限制：成功凭据与 dead-letter-history 暂不 GC，长期会累积；`record-environments/` 旁路文件如 `storage-and-performance.md` 所述，需要维护者按 recordId 手动清理。
- 不允许多个 CLI/daemon 新旧版本对同一 dataRoot 并发或降级写入，文档已写明。

## VE 核验意见（审查方，2026-10-26）

**结论：VE1 和 VE2 已核验，E1、E3 通过，批次 E 关闭。recorder 侧的 A–E 全部完成核验。**

- 复跑证实：`d71c88a` 上 hook-http-outcome 有 5 个失败、1 个通过；`2524cf1` 上 commit-delivery、scry-integrations、recorder 合计 24 个失败、153 个通过。修复前都失败，与报告方向一致。
- HEAD `e1b120c`（Linux/Node 22）全量：7 个失败、4001 个通过、5 个跳过。7 个失败与此前的环境失败完全一致，没有新增。`npm run typecheck` 无错误。执行方在 macOS 上看到的 30 个失败，发生在 load average 155–190 的情况下，这里没有复现；建议在空闲机器上再跑一次全量，作为合入前的最后确认。
- 我原样复测了上一轮的两个探针（临时，已删除）：
  - 协议不匹配：脚本发送协议 1、daemon 是协议 2 时，交给 CLI 的标记为空，CLI 会正常重试，不再只入队。
  - 短暂故障：receiver 对 sequence 1 失败，连续 drain 5 次，之后 receiver 恢复，再 drain 3 次。sequence 2 和 3 已送达；sequence 1 只记了 1 次失败，`nextRetryAt` 是 60 秒后，`deadLetterCount: 0`。把时钟拨到 61 秒后再 drain，sequence 1 送达，`ackedThrough: 3`。
- 代码：
  - shell 用 `case "$rc:$code"`：`7:*` 和 `0:4??` 视为确定没有送达，其他情况仍是结果未知。
  - 退避间隔为 `[60s, 300s, 900s, 3600s]`（`commit-delivery-ledger.ts:8`），第 5 次失败才进入死信。
  - `notify-retry --sequence N | --all-dead` 先经过 `resolveCommitHookActivation`，trust 不通过就不执行，不伪造 ACK。
  - 前置拆分 `4ba8148` 用 AST 比对，18 个声明全部不变。这一轮拆分、红测、修复分开提交了。
- 已知未做（报告如实写明，接受）：成功凭据和死信历史暂时不 GC；`record-environments/` 需要按 recordId 手动清理。
