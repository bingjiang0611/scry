# CLI 汇总：文件调用按记录一次分组

## 结论与范围

本轮完成 L1 工作量优化，尚未部署。`summarizeFiles` 不再为每条记录三次遍历整个调用时间线。固定 186 轮、3348 个调用的输入上，`OrderedCall.record` 读取从 **1,889,376 降为 24,540（−98.70%）**。这不是总 CPU 工作量下降比例，也不是耗时提升比例。

- 测量源码先独立提交：`ed5c47f57dcffe1ea2d75da53983e7c7216aa5d1`。
- 实现与两个回归：`7e8d4811bfd8b9f9f5d7a5851f6b89886f0da31c`。
- 改动位于 `src/core/turn-recorder/turns-summary.ts`，其调用方为 CLI summary / verify；没有改 records、上传、ACK、Provider、CLI 参数或输出结构。
- 固定输入和原始结果见[机器可读记录](20261021-cli-summary-linear.json)。基线是 `b3bf6f2` 的实现；测量脚本当时尚未提交，之后原样冻结为 `ed5c47f`。候选原始 JSON 的 sourceCommit 仅记录当时 HEAD `ed5c47f`，实际优化尚为 dirty；外层记录的实现提交、源码 hash 与产物 hash 标识实际候选。

## 最小实现

旧实现每次 `structuredFileCalls(record, allCalls)` 都重新筛选、投影所有调用；每条记录分别在候选路径收集、文件计数和 legacy 回退判断时调用一次，关联阶段为 O(轮次数 × 调用数)。

新实现只遍历一次时间线，把有 file 证据的调用按 **record 对象身份** 分组。没有相应调用的记录，再填充自己的 legacy files。随后三处复用这份局部索引。

- 不能改为按字符串 recordId 合并；原函数比较的是对象引用。
- 保留 call-backed 文件优先级、legacy 回退、partial/unavailable、Bash 推断、Skill/MCP 文件证据，以及失败调用不计为完成写入的行为。
- 排序和其他汇总阶段未变，不能把整个 summary 宣称为纯 O(N)。
- 新增按文件调用、legacy 文件证据及轮次数线性增长的临时索引，返回后可回收；没有跨调用缓存、持久索引或常驻服务，也不声称峰值内存下降。
- 没有解决全库文件读取、JSON 解析、会话选择性读取或 verify 的重复读取；这些仍是后续独立假设。

## 固定实验与可信度

`scripts/cli-summary-experiment.mjs` 调用实际编译后的 `summarizeTurnRecords`，使用通过生产 schema 校验的合成数据。两个固定规模为 1 / 186 轮，每轮 18 次调用、9 个路径、先读后编辑。每组 3 次预热、9 次原始采样，保留完整汇总字段。

计数通过 pass-through getter 观测生产代码创建的 OrderedCall 的 record 属性读取，包含排序等共享阶段，不是根据 N×T 推导填数。观测到的 entry 数必须等于实际调用数；若以后创建方式绕开观测，脚本失败而非输出零。重复执行两次汇总时计数严格翻倍；计数前后完整输出相同，输入不被修改。

耗时阶段全部先执行，随后才安装计数 getter，避免 getter 影响后续 V8 属性反馈。计时不含 instrumentation，但也不含 CLI 启动、records 文件读取/解析、Provider 或上传。首次草稿曾先计数再计时，存在反馈污染风险；已在优化前调整阶段顺序并重新冻结基线，第一次草稿不用于前后比较，未改变数据规模或采样次数。

| 输入 | 基线 record 读取 | 候选 record 读取 | 完整 summary |
| --- | ---: | ---: | --- |
| 1 轮 / 18 调用 | 156 | 120 | JSON hash 相等 |
| 186 轮 / 3348 调用 | 1,889,376 | 24,540 | JSON hash 相等 |

所有耗时通过 timing-run 串行锁执行。10 核机器：基线 load1 22.25，候选 26.54，均 highLoad，**L2 unavailable**。原始数值保留，不据此宣布提速：

| 输入 | 基线 p50 / p95 ms | 候选 p50 / p95 ms |
| --- | ---: | ---: |
| 1 轮 | 0.0845 / 0.0955 | 0.0912 / 0.1548 |
| 186 轮 | 14.2078 / 15.9960 | 2.6185 / 3.2490 |

单轮原始耗时上升不能被长会话的计数收益抵消。Map 有构建成本，但本次负载不允许把差异归因给它或断言没有小输入回归；性能 owner 需在低负载下同时复测这两个固定规模，之后才决定分发。L3 未验证。

## 正确性与检查

| 检查 | 结果 / 范围 |
| --- | --- |
| 新回归在旧实现上 | 17 项 summary 测试通过，证明新增用例描述的是既有行为 |
| 相关测试 | summary 17 + credits 3 + CLI 36，共 56 项通过 |
| 故意破坏对照 | 把分组键换成 recordId，新增回归失败：两个记录被错误合并，a.ts 被双计、b.ts 消失；恢复对象身份后通过 |
| 真数据只读对照 | 在既有隔离快照中程序读取全部 2181 条记录，整个 workspace 及全部 531 个 session 的完整 summary JSON 前后字节相等，输入未修改；没有输出正文或标识，也没有启动 Provider / 上传 |
| 类型 / 构建 | `npm run typecheck`（Node / Web）与 `npm run build:cli` 通过 |
| 完整 unit | **3481 通过、1 失败、4 个既有 opt-in 跳过**，不报告全绿 |
| 失败项定向基线 | 干净 `ed5c47f` 上该用例通过；只选择这一项，另外 5 项未执行 |
| 失败项候选 | `npm run performance:measure -- --scenario source-control.diff --out …`：6 个 collector 测试通过，5 次 Git / total 均 8，ratchet 通过 |
| Diff | `git diff --check` 通过；没有改 timeout、门限或删断言 |

全量失败是 `scripts/performance-counters/subprocesses.counters.test.ts` 的 `counts real git subprocesses for recorder diff and source-control status/diff`：生产 Git 查询返回 timeout，而非 captured。该测试和 `src/core/turn-recorder/git.ts` 与基线逐字节相等，失败调用链不经过本次汇总函数。全量结束后 10 核机器 load average 约 12.43 / 34.51 / 36.13，但没有证明具体超时阶段或负载因果。两侧定向通过不能证明全量失败已在基线复现，也不能抹掉首次失败；测试维护者后续需按全量运行条件调查，不在此扩大修改 Git deadline。

本机证据在 `/tmp/scry-cli-multirepo.AVEdj0/summary-linear/`：`baseline-frozen.json`、`candidate.json`、`real-equivalence.json`、`check-real.mjs`、`git-counters/measure.json`、`full-unit.log`。真数据对照只在本机保留，不纳入 Git 原始数据。机器可读文档只包含合成实验结果。

## 交付状态

仅隔离分支本地提交。未合入主工作区、推送、发布 npm、安装 CLI / App，也没有改真实 daemon、记录或队列。两份实际安装 CLI 的 summary 模块仍与基线 hash 相等，不能把源码验证当作本机运行版本已更新。临时 baseline 工作树和依赖链接验证后清理；实验源码、产物与本机日志保留。

后续代码优先级：复用 `turns verify` 已解析的记录，避免第二次全库读取和无关汇总；会话选择性读取随后评估，不预先引入持久索引。发布与安装仍需用户确认，不能因为 L1 下降而跳过验证边界。
