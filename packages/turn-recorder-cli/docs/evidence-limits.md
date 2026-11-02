# 证据口径

- 无调用记为 `available + []`;Provider 未暴露的记为 `unavailable`,**不会伪装成 0**。
- `普通工具` / `MCP` / `Skill` / `子 Agent` 四列互斥,总调用等于四列之和。
- Hook 同时报告"处理器实例"与"生命周期事件";文件同时报告结构化证据与 Bash 推断读取,并保留 quality/coverage —— 分母不同不可直接相比。
- Codex 子 rollout 必须匹配父会话、父轮次、cwd 与 fork 身份；不重复合入继承历史。每轮最多读取 64 个子会话、单文件 16 MiB、合计 64 MiB；同月跨日查找最多扫描 4096 个目录项，身份头最多读取 256 KiB。超限、缺失或不匹配均为 `partial`。原始 exec 程序保留但不执行；token 与最终回复只取顶层权威值，子回复单独保留在 modelSegments。Codex rollout 不含原生 Hook 事件，Hook 通常为 `unavailable`。
- Qoder 通过唯一主用户消息的 requestSetId → promptId 关联账单身份，不把 request-set ID 当 promptId。子工具依靠主日志 agent-result 与受限 sidecar 的 session/cwd/agent/parent 身份关联，拒绝符号链接；最多 64 个一级子会话、单文件 256 KiB、合计 4 MiB。缺失、超限或嵌套委派标 `partial`；需支持更大或多级子会话时，应扩展有界分页与身份链，不能移除上限。Ultimate 等逻辑档位写入 modelTier，不冒充具体 model。
- Pi 扩展把 assistant 的 UTF-8 内联正文限制为 256 KiB，把单个 tool 事件限制为 4 MiB（daemon 请求上限为 8 MiB）；超限时发送版本化 `scry_capture` 元数据。启用完整工具采集时，recorder 仍把可达的完整正文写入 CAS，并在 record 内保留有界 preview 与 `partial` provenance；不可序列化正文标为 `unavailable`。OpenCode 未观测到 usage 时不再写 exact zero；升级后需运行 `scry integrations repair --yes` 更新存量插件。
- Codex 无服务端精确 latency,`response_intervals` 是观测区间,可能包含请求构造、调度、传输与重试。
- `modelTiming.cumulativeMs` 累计并行子 Agent 时间,`occupiedMs` 是所有模型区间的并集(用于与整轮墙钟比较)。旧记录缺该字段时保持 `unavailable`。
- `modelSegments` 与 `compactions` 在旧记录缺失时标 `unavailable`,不会误算成 0。
- Recorder 只保证**新生成**记录使用当前口径,不会重写历史记录。
