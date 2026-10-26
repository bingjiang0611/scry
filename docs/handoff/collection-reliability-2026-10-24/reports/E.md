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
