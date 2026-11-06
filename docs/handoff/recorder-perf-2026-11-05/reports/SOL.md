# Full-send：Sol 复核与后续修正

基线仍为 `50bd7202`（origin/main），第一轮审查对象为 `6cf305b2` 的完整分支差异。
维护者随后授予 full-send：允许推送、建 PR、跟进 CI / 评审并按保护规则合并；不发布或安装日常版本。

模型从实际可用目录选择：`openai-codex/gpt-6.1-sol`，通过 Pi 原生只读 reviewer；未暴露 effort。
第一轮 verdict 为 CHANGES，第二轮为 APPROVE。随后仅收紧初始化的空会话锁成本，第三轮也为
APPROVE；S1 / S2 / S3 均 resolved，没有开放的 blocker / should。
没有把失败、超时或未答复当作批准。后续轮只检查改动及开放项。

## Ledger

| ID | 严重性 | 发现 | 处理 |
|---|---|---|---|
| S1 | should | 新 hook 可先创建 attention 目录，旧会话尚未遍历却被认为已初始化；中断重建也类似 | 增加完整重建后才原子发布并同步的 `runtime/attention/initialized`。新 writer 不发布该标志；源 provider 目录遍历只忽略 ENOENT，其他错误阻止发布完成标志 |
| S2 | should | 扫描到 JSONL 半行后把游标推进到整个文件末尾；补齐该行后会漏过新锚点 | 缓存分别保留已观察文件大小与最后一个换行后的字节位置；两种扫描返回可重扫的行边界，并保持无换行 EOF 的解析语义 |
| S3 | nit | offset 失效测试用不同 prompt hash 预热和读取，没有命中同一个缓存键 | 改用同一身份预热，保留失效后必须回扫的断言 |

没有增加新解析状态机或后台缓存，也没有改变记录格式。初次初始化仍为全量扫描；只有已经完整
初始化的索引才能提供 O(需要关注的会话数) 的普通恢复。并发发布 / 清理仍使用上一轮的同会话锁。
`initialized` 是索引元数据，不计为待恢复会话；原测试仅调整这一条元数据的过滤，未放宽会话断言。

初始化还会先快照已有标记；没有标记且没有待处理证据的会话不发生删除，因此可跳过锁。
并发 writer 新增的标记仍保留；需要创建 / 清理标记的会话仍在锁内重新检查。额外计数回归
在修改前取得 51 把锁而失败，修改后 50 个已完成目录 + 1 个旧 pending 会话只取得 1 把锁。
日志 `/tmp/scry-sol-cold-lock-negative.log` 保留。没有改 workload 或放宽时间上限。

## 直接验证

六个新用例在旧实现上全部失败：旧队列 + 新 hook、部分索引目录、中断完整重建、冷 / 热扫描的
UTF-8 半行追加，以及无换行的完整 EOF 锚点。S2 不只比较事件，还逐字段比较 warm / cold 的
source range、正文及源文件身份。S3 修正后的同身份失效用例也通过。

| 检查 | 结果 | 日志 |
|---|---|---|
| 新用例旧代码负对照 | 6 failed / 6 原有用例 passed | `/tmp/scry-sol-negative.log` |
| 最终 focused：初始化、anchor、竞态、进程、attention、runtime | 6 文件 / 36 passed | `/tmp/scry-sol-focused-round3.log` |
| `check:cli-release` 的完整合同测试集合，单 worker | 80 文件 / 934 passed | `/tmp/scry-sol-recorder-contracts.log` |
| 类型检查 | 最后行为改动后通过 | `/tmp/scry-sol-typecheck-round3.log` |
| CLI / App 构建 | 最后行为改动后均通过 | `/tmp/scry-sol-build*-round3.log` |
| npm tarball 临时安装 + 真实 bridge / daemon / CLI | 最新代码再次通过 bin、init、hooks、doctor、并发通知、旧 cursor 保留；临时 HOME/state，daemon 已停止，夹具已清理 | `/tmp/scry-sol-package-smoke-round3.log` |
| harness 与 workspace shell | 通过，包含缺失 binding 负对照 | `/tmp/scry-full-send-{harness,shell}.log` |

合同集合与仓库 `check:cli-release` 的 Vitest 文件列表一致，只加 `--maxWorkers=1`，没有缩减
workload 或改超时。934 项检查后把初始化发布由 exclusive helper 换为已有 text atomic helper，
避免额外同步无关祖先目录，随后跳过不需要修改索引的空会话锁。最终 36 项、工作量、类型和
两种构建及再次执行的 tarball 实测覆盖最新代码。文件与父目录
fsync 都保留。先前 5491 全量通过只对应 `6cf305b2`；当前分支的完整 CI 结果由 PR 门禁另行记录。

## 工作量，不声明新的 L2 收益

复用未改动的 `scripts/recorder-engine.measurement.test.ts`，日志
`/tmp/scry-sol-counters-round3.log`。与 `ec44ffa1` 比较：

| 指标 | 基线 | 当前 |
|---|---:|---:|
| 新工作区首次 start fsync / readdir / readFile | 10 / 6 / 13 | 14 / 13 / 17 |
| 同一首次轮完整 start + end | 41 / 15 / 50 | 46 / 23 / 57 |
| 正常恢复 readdir / readFile，已完成目录 0 / 200 / 1000 | 每档 7 / 12 | 每档 7 / 14 |
| pending-health readdir / readFile，以上每档 | 4 / 2 | 4 / 2 |
| 6 次 transcript anchor cold / warm 读取字节 | 原 R1 结果：33,038,016 / 6,859,226 | 33,038,016 / 6,859,226 |

首次轮增加的是正确初始化和互斥所需工作，不能说总 I/O 不变；不会把遗漏旧会话的廉价路径当作
性能收益。常规恢复不回退为每次扫描全部历史。首次整库索引和每 64 次周期重建仍是 O(历史会话数)。

## 交付边界

- 提 PR 前重新同步主分支，并按 full-send 的 gate 等待最新提交的 CI 与评审；不绕过保护。
- 旧报告中的本地提交限制是当时状态，已被后续 full-send 明确覆盖；测试数量按对应 revision 解读。
- 报告中的测量机地址改为 A / B / C；保留负载、失败原因与测量限制，不发布机器专属地址。
- 仍不把离线 transcript / hook 夹具称为真实付费 Provider 验收，不把进程 SIGKILL 称为断电验证。
- Sol 使用量未在回执暴露，未估算费用。最终轮数和 verdict 在 PR 描述中记录。
