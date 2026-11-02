# 零预算正文不再编码后丢弃

## 范围与假设

- 优化提交：`412ad2c3`；父提交：`818111d6`。
- PR #11 的 CI run `41305313238` 中，50k trace coverage 样本前三次为 5052 / 5011 / 5004ms，超过原 5000ms 期限。没有提高期限、减少 50k 条目、七阶段、五次重复、完整 oracle 或负对照。
- CPU profile 指向 `limitToolContent` 的编码工作。在剩余预算为零时，旧实现仍将整段正文转成 Buffer，截取零字节，再创建解码器得到空字符串。这些正文不会发送或存储到内联字段。

## 实现与证据边界

`limitToolContent` 仅在预算大于零时编码和解码前缀。零预算继续生成原来的 omitted envelope；来源、原字节数、完整性、持久化引用和原因保持不变。JSON 仍标为 `json-fragment`。已有空内容的提前返回、正预算的 UTF-8 截断与原文保留策略不变。

**L1**：两个零预算用例（Unicode 文本和 JSON）中，`Buffer.from` 调用均从 1 降到 0；旧实现的两个负对照失败。测试严格比较完整 metadata，确认原字段未被修改。减少的是即将丢弃正文的缓冲区编码，不是观测或业务工作。

没有新增或放宽性能台账指标。原 hash、JSON、IPC、持久化等计数合同及 ratchet 保持有效。

## 诊断性计时，不是 App L2/L3 结论

在 macOS / Apple M2 Pro 10 核 / Node 22.22.1 下，复用原 Vitest 配置、V8 coverage、单 worker，仅对 worker 增加 CPU profiler。完整执行原 15 项 collector 测试，两次都通过。

| 范围 | 优化前 | 优化后 |
|---|---|---|
| 五个 50k 样本，ms | 2350, 2285, 2248, 2124, 2152 | 1931, 1964, 1946, 2001, 1962 |
| 测量前后负载 / 10 核 | 3.54 → 4.14 | 3.04 → 3.09 |
| highLoad | false | false |

这是一次带 profiler 的前后诊断，不是原生 App 延迟或稳定收益百分比。没有交换测量顺序，也不以本机结果覆盖托管 CI。若托管用例仍超时，应继续依据 profile 找工作，不能增加超时或缩小负载。

## 验证与交付

- 14 个相关文件、111 项测试通过，覆盖内容引用、正文复制、bounded projection、delta 与 renderer 合并。
- `npm run typecheck`、`npm run build:cli`、`npm run build` 通过；`npm run performance:measure` 的 ratchet 通过。
- 完整 `npm run test:coverage -- --maxWorkers=1`：5262 passed / 4 skipped，542 个文件通过。4 项既有真实探针/相关性检查未启用。覆盖率输出使用独立报告目录；Statements/Lines 78.81%、Branches 82.56%、Functions 82.02%，源码范围 100304 行，不与 focused 数字混比。
- 完整 coverage 约 914 秒，负载 2.39 → 4.15 / 10 核，highLoad=false。不是 App 性能测量。
- 本地日志保留为 `zero-budget-negative.log`、`zero-budget-tests.log`、`concurrency-coverage-profile*.log`、`zero-budget-full-coverage.log`、`zero-budget-counters/measure.json`；CPU profile 含机器路径，不上传。
- 尚未合入 main；本轮未安装。本分支 App 0.2.236 / 私有 CLI 0.2.55 不变，已安装 App 另有 0.2.237，不降级覆盖。此前打包 CLI SIGKILL 未解决，不绕过校验。Node 20/24 与托管平台结果以本次 head 的 CI 为准。
