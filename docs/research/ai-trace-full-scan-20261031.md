# AI Trace 全量本地扫描：证据与对比修正

本报告补充[原对比文章](ai-trace-vs-scry-cli-20261030.md)。快照时间为 **2026-10-31 02:58:41–02:58:46 UTC**，主机时区为 UTC−07:00，当地日期仍为 2026-10-30。日期以机器生成的 manifest 为准。

[公开证据 JSON](ai-trace-full-scan-evidence-20261031.json) 是白名单统计投影，不是原始数据库或原始会话导出。本文所有数量均指本机这次检查，不代表产品默认值、所有用户或所有版本。

## 1. 先修正结论

**AI Trace 不是只有代码动作统计。** 本机实际有轮次、消息、thinking、工具输入输出、工作区 patch、来源位置、缺失原因以及带重试/终止状态的投递记录。

| 过去未确认的能力 | 本次证据 | 仍不能得出的结论 |
| --- | --- | --- |
| 逐轮过程组织 | 1,348 条轮次事实、43,744 条消息及关联校验 | 每个 Provider、每一轮都完整 |
| 工具输入输出 | 17,915 个 tool_use、17,873 个 tool_result 内容块 | 内容块数就是独立调用数、所有结果都完整 |
| 思考片段 | 3,932 个非空 thinking 块 | 完整内部推理或决策原因已经被证明 |
| 缺失/部分证据 | 203 个 patch 不可用原因；11 个工作区快照标 partial | 每种数据都有与 Scry 同构的 evidence envelope |
| 有状态投递 | revision/hash、投递意图、尝试计数、dead/cancelled 等真实记录 | 服务端已经收到，或端到端可靠性已验收 |
| 代码调用关联 | 37,944 条代码动作有 tool_call_id | 每个动作都有 ID、关联就等于因果归因准确 |

Scry 的逐轮文件、统一 evidence 合同和公开源码仍是明确设计特点；但不能将上表能力笼统描述为“Scry 有、AI Trace 没有”。两者采集完整性、准确性和隐私保护没有做同任务对照。

## 2. 究竟“完整”检查到哪一层

对应附件 `scope`、`coverage`、`rowCounts`：

- 只读调查主数据根。SQLite 通过 read-only 源连接及 online backup 形成一致数据库副本；其他文件复制时检查大小/mtime，无复制错误、无检测到的复制期间变化。数据库与其他文件并非跨文件原子快照。
- **37 张表逐行、逐列读取，共 272,170 行**，含 `sqlite_sequence` 及状态/游标等表，不是 272,170 个唯一业务事件。
- 非空 `*_json` 列解析 **172,438 个值**，无 JSON 解析失败。SQLite `quick_check` 返回 `ok`，不等于业务完整性检查。
- **1,889 个其他文件全部读取、计算 hash**，包含配置、日志及本机脚本/skill。解析 1,552 个 JSON 文档、13,393 条直接可解析 JSON 行；不能把这些数直接称为采集事件数。
- 首次有 18 条 JSONL 首行解析失败。逐一确认它们只有纯 NUL 前缀，前缀合计 402,237,587 字节；跳过前缀后 18 条 JSON 均可解析。没有修改源文件，也不声称恢复此前丢失的历史。
- 排除软件安装依赖目录；未遍历游标引用的全部 Provider 原始 transcript，未抓包、查询服务端或触发重传/导出。
- **全量解析不等于主模型逐字阅读全部会话。** 文本日志按结构扫描；正文只核对字段、类型、非空性、字节长度和代表性结构。没有语义分析每次对话内容。

临时副本约 2.22 GB，分析后已删除。公开附件不含原始副本，也不能由公开统计重建完整会话。主要业务表的记录截至 2026-10-10 附近，不能据此推断当前实时行为。

## 3. 数据规模和消息结构

附件 `rowsByClient` 可区分 Provider；不同表存在重叠且时间窗口不同，不相加成唯一事件。

| 数据 | 数量 | 重要边界 |
| --- | ---: | --- |
| 会话事实 | 588 | Codex 127、Qoder 41、qoder-cli 420 |
| 轮次事实 | 1,348 | 均来自 Codex |
| 消息事实 | 43,744 | Codex 42,422、qoder-cli 786、Qoder 536 |
| 模型用量 | 7,265 | 不是 Token 总数或费用准确性证明 |
| 独立工具索引 | 5,895 | 与消息正文中的调用块不是同一口径 |
| Skill 调用 | 66 | 26 条有结束时间，22 条有耗时 |
| 代码动作 | 113,840 | 覆盖 7 个客户端标识；不同入口可使用不同名称 |
| 上报状态 | 46,404 | 不是独立会话数或实收数 |
| 通道投递意图 | 2,912 | 2,585 delivered、327 cancelled |
| 网关投递记录 | 33 | 21 dead、12 cancelled |
| 工作区开始快照 | 520 | ready 386、skipped 79、failed 55 |

消息角色为 system 864、assistant 23,143、user 19,737。结构化内容块里有 text 25,160、thinking 3,932、tool_use 17,915、tool_result 17,873。

工具入参非空 17,886 块，结果正文非空 17,447 块。qoder-cli 的 content 是字符串，不能因为没有相同 block 结构就断言它没有消息内容；文本中的 JSON 也不自动算工具证据。

按 `(client_type, session_id, call_id)` 去重，其中 call_id 分别取 tool_use.id 和 tool_result.tool_use_id，得到 15,919 个调用 ID、15,892 个结果 ID；15,892 对匹配、27 个调用无匹配结果、0 个结果单边 ID。缺匹配不能直接解释为执行失败。附件 `messages.toolPairing` 保存计数，`representativeShapes` 给出来自真实记录的入参/结果/thinking 结构：字符串均替换为类型和 UTF-8 长度，不是原文。

原扫描递归访问结构化 content；后续用只读连接仅计顶层 content block，计数与原扫描完全一致。该复核仅校验计数，不能证明原始 transcript 未被上游裁剪。

## 4. 不能只看 schema 或单表

附件 `nonemptyColumns`、`messages.turnJoinRows`、`partialEvidence` 提供直接证据：

- Codex 42,422 条消息中，41,999 条有非空 turn_id，39,062 条能按客户端/会话/轮次精确匹配轮次事实。Qoder/qoder-cli 没有对应轮次事实行。
- 1,348 条轮次事实均标 completed，但 ended_at、degraded_reason、source offset 列为空。**这不证明每轮完整，也不证明完全没有结束时间或来源。**
- observation 的额外 JSON 中另有 1,540 个非空 ended_at，1,224 个 source start/end offset。
- dirty patch 不可用原因共 203 个：shell_evidence_missing 139、unsafe_path 63、diff_generation_failed 1。该分类计数在发布前以只读查询复核，时间另记在 JSON。
- 380 个快照包含非空工作区 patch，总 UTF-8 大小 36,430,951 字节，最大单个 1,586,188 字节。总量按快照累加，可能包含重复正文，不是去重代码量。
- 11 个 dirty-patch 扩展标为 partial，22 个跳过文件条目的原因为 not_regular_file。

代码动作中，content 非空 76,735 条，inline_diff_message 非空 63,493 条，两者可能重叠。session_id 非空 112,335 条，tool_call_id 非空 37,944 条；附件 `codeCoverage` 还按客户端展开。故初版 3 条样本不能支持“每个动作都有调用 ID”的推广。

## 5. 投递、敏感信息与导出

代码记录的本地上传状态为 success 113,834、failed 6；其他状态表还记录 pending/failed/oversized 等情况。它们是本地状态，不证明远端接收字段、保留时长或端到端投递保证。

4 份 Node 诊断 JSON 各有 2 个凭据命名的非空环境字段，共 8 个出现位置。这里只检查字段名称模式与非空性，**不确认是真实有效凭据，不输出字段值或具体变量名**。会话、工具和 patch 也有正文，原始目录不适合直接公开。

本机还存在 export-session 脚本与 ZIP/数据导出说明；没有运行，也没有核验其发布来源或与当前 SDK 的绑定。故不能说“没有导出工具”，也不能称“完整导出已验收”。

## 6. 授权环境下的只读复核

以下查询只返回计数，不打印正文、身份或路径。应由有权访问数据的人在自己的只读快照上执行；不同时间/机器可能得到不同结果，不要为复现数字生成或重传真实会话。

```sql
SELECT COUNT(*) AS rows,
       SUM(tool_call_id IS NOT NULL AND tool_call_id != '') AS with_call_id,
       SUM(content IS NOT NULL AND content != '') AS with_content,
       SUM(inline_diff_message IS NOT NULL AND inline_diff_message != '') AS with_diff
FROM session_code_adoption_detail;
```

本次结果依次为 `113840, 37944, 76735, 63493`。

```sql
SELECT m.client_type, COUNT(*) AS messages,
       SUM(m.turn_id IS NOT NULL) AS with_turn_id,
       SUM(t.turn_id IS NOT NULL) AS matched_turn_fact
FROM session_message_fact m
LEFT JOIN ai_session_turn t
  ON t.client_type = m.client_type
 AND t.session_id = m.session_id
 AND t.turn_id = m.turn_id
GROUP BY m.client_type;
```

结果与附件 `messages.turnJoinRows` 对应。注意：SQL 的非 NULL 与非空字符串一般不是同一概念；本次 turn_id 字段覆盖另做了非空计数核对。

```sql
SELECT json_extract(extra_span_attributes_json, '$.dirty_patch_unavailable_reason') AS reason,
       COUNT(*) AS occurrences
FROM session_observation_fact
WHERE json_extract(extra_span_attributes_json, '$.dirty_patch_unavailable_reason') IS NOT NULL
GROUP BY reason;
```

结果与附件 `partialEvidence.dirtyPatchUnavailableReasons` 对应。请勿只查 ended_at 一列就判断全系统没有结束时间。

## 7. 公开证据能证明什么

附件按显式字段白名单从私有统计报告派生：发布表/字段名称、数量、状态枚举、结构形状和报告 SHA-256；不发布会话/用户/仓库/调用 ID、文件名清单、本机路径、正文、凭据或内网地址。

`provenance.localReportSha256` 标识本次私有报告版本，不是对原始观察真实性的独立认证。公共读者可以复算附件内部的总和与关联差额，但无法仅凭这些文件独立重建原始数据；有权访问同机数据的人可以执行上述查询复核。没有原始数据时，不应把“统计自洽”写成“独立实测通过”。

验证范围仅为文档和统计附件：JSON 解析、对私有报告的投影一致性、计数与结构检查、脱敏审查、引用和 diff 检查；没有新增或重跑产品单测、构建、安装及真实 Provider 工作流。原 PR 的 uploader 源码与测试材料保持不变。
