# rate-native 历史序号缺口：只读核对

## 结论

前一轮 verify 对照中的 **120 处缺口报告，实际覆盖 230 个缺失序号**。它们全部位于 86–874 之间，后续 875–2411 在旧快照中连续。不是 120 条坏 JSON，也不是本次 verify 优化新造成的缺口。

截至本次检查，不能证明具体移除操作、操作者或发生时间。当前证据不能将其认定为正常归档，也不能直接断言是手工清理或某个旧版 bug。保持 verify 退出 4，不补造、重编号、跳过缺口或伪造 archive floor。

## 范围与方法

只读检查既有本机快照 `20261021T120244Z-rate-native-cli`；manifest 创建时间为 `2026-10-21T12:02:55.598412+00:00`。逐个核验全部 canonical 记录的字节数、SHA-256、文件名与内容的 sequence / recordId；程序解析 JSON 不等于人工通读会话正文。本次没有输出正文、记录 ID 或完整错误内容。

真实 `rate-native/.scry` 只列举 canonical 文件名和检查归档元数据存在性，没有运行 CLI、获取锁或触发上传。两次列举间文件名集合相同，但不是全局原子快照。其他现有 performance 快照检查目录与完整 manifest 结构；它们记录 performance journal，不提供缺失 canonical records。项目的 `telemetry-archive` 当前只有 README，无会话归档文件。

另读取四份快照日志并做确定性的序号引用、关键词扫描；读取 574 份 session 状态中的 last-committed 指针；核对 recorder 的初始和当前提交路径、归档实现、maintenance 与项目 uploader 的删除调用。没有访问 shell history、Time Machine、其他机器或远端上传系统，也没有执行恢复。

## 证据

| 检查 | 结果 | 意义 / 边界 |
| --- | --- | --- |
| 快照记录集合 | 2181 条，序号 1–2411；重复序号 0 | 230 个缺失号，形成 120 个连续缺号区间 |
| 缺号分布 | 最早 86，最后 874；1–85 和 875–2411 连续 | 不是简单移除开头的连续前缀；边界记录日期不能用作删除时间 |
| 快照复制完整性 | 2181 条全部匹配 manifest 的大小与 hash；全部 stableDuringRead；调查结束复核记录 hash 未变 | 排除快照文件相对 manifest 被漏拷或改写；manifest 本身不是事发前完整性审计 |
| 真实目录文件名观察 | 2208 条，最大序号 2438；旧快照 2181 个序号仍全部存在，缺失的 230 个仍全部缺失 | 缺口也存在于源目录，不只是性能快照复制时的竞态；不代表检查了所有真实记录正文 |
| archive 元数据 | 快照与源目录均无 archive-state.json、archive-journal.json；快照 manifest 无 archive 路径 | 没有可解释缺口的归档凭证；不能据此证明从未有过归档或文件被外部移走 |
| 日志 | 四份共 17716 行，均匹配快照 manifest；缺失序号文件引用 0，archive/unlink/delet/cleanup/repair/dedup/migrat 关键词均 0 | 未找到归档、清理或删除证据；日志非完整审计，且 recorder 日志已轮转 |
| runtime 指针 | 574 份 session：482 指向现存记录，54 指向当前快照中不存在的 recordId，38 未设置 | 旁证存在悬空状态；指针没有 sequence，不能将 54 对应到这 230 个缺号，更不能据此补写记录 |

原始完整缺号区间只保存在本机证据中，不在文档铺开。缺号数是序号集合差，不证明曾有 230 条独立业务轮次，更不证明远端缺少 230 条记录。

## 代码能说明什么

- 初始发布 `a0bff04` 的 `commitRecord` 从 canonical 文件最大序号 +1 分配，成功写入后才写 `state/next-sequence.json`。该文件是只写缓存，不参与分配；当前已删除该写入。快照中的旧文件停在 nextSequence=1359，不能用它解释低位缺口，也不能拿它覆盖当前进度。
- 当前 `store.ts` 仍按 canonical 最大序号与 archive floor 的较大值 +1 分配，在写入前做 schema 校验。本次 verify 优化不写记录，也不改变分配。仅凭源码不能排除曾运行其他版本、外部修改或文件系统事件。
- 正式 `records archive` 于 `11fa832` 引入，移动的是指定上界之前的前缀并写 floor；当前版本还拒绝有缺口的源库。已检查的正常流程不能解释“仍有序号 1，但中间有 230 个洞且没有 floor”的状态。不会为了让 verify 通过而反向合成归档凭证。
- 当前 `maintenance.ts` 的 retentionEligible 是报告；apply 删除的是孤立 content、过期临时文件并压缩日志，不删除 canonical records。项目 uploader 成功后 unlink 的是 outbox 文件，不是 `.scry/records`。这排除了这些已检查路径作为直接解释，不代表任意历史程序都不可能删除文件。

## 仍缺什么

具体原因仍是 **unknown**：没有找到能把缺失序号连接到一次实际写入、移除或搬迁操作的历史证据。邻近记录完成于 7–8 月，不说明缺口也形成于当时。mtime 的变化也不能证明删除主体或时间。

继续定位需要数据维护者提供以下至少一种来源：

1. 含 86–874 区间原始文件的历史 `.scry/records` 备份，或更早的文件清单 / hash manifest。
2. 清理、迁移、脱敏或修复操作的执行记录，至少含命令、目标目录和时间。
3. 其他机器或远端系统中保留的原始记录及可靠身份映射；访问前另行授权，不把 uploader 脱敏副本自动当作 canonical 恢复源。

取得来源后，下一动作是只读比对文件身份、内容 hash 和缺口集合，再提出恢复方案。恢复写入需另外确认；不得直接把任意同序号文件放回当前库。缺少这些来源时，保留错误是正确行为，不再通过重复跑 verify 寻找不存在的删除审计。

## 交付与验证

本轮只有调查文档改动，运行 `git diff --check` 并核对链接与代码合同，不重复 unit、构建、安装或版本升级。真实 records、archive state、队列、daemon 与 App 均未改；没有网络请求。

本机私有证据：`/tmp/scry-cli-multirepo.AVEdj0/verify-once/investigate-gaps.py` 与 `gap-investigation.json`。脚本 SHA-256：`bb72955e9cf08f8478761a3d36bd0f06553fdc8b12a01a7c3173c6bf27f6040d`；结果：`0ca09b056f5b56066cce077d8a870a95c0e4106f380ed257149c57f87adb060e`。观察时间 `2026-10-22T05:20:09.913720+00:00`。本地结果保留缺号集合与 hash，不包含会话正文或标识；未上传。

关联：[verify 优化与原始错误对照](20261021-cli-verify-once.md)。此次调查不改变该优化的 L1 / L2 结论，也不代表当前真实库完整性通过。
