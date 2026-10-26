# 2026-10-26：修正文件读取计数器，替换错误 candidate

> 后续：用户已选择独立集成验证，冻结开发版本的既有失败及UI未决项见[集成记录](20261026-integration-check.md)。以下保留本轮完成状态。

## 结论与批准记录

这是**测量修正，不是产品性能优化**。没有修改`src/`、固定业务负载、其他75项指标、门禁阈值或App产物。

本会话明确询问是否授权替换`files.fixed-operations/io.read`和`io.read.bytes`两项candidate并重建基线。用户选择 **“修复并替换 (Recommended)”**，范围为：补直接反例、修正口径、保留历史证据、替换两项candidate；其他门禁不变，不合入或安装。

旧定义和原始基线完整保存在[证据JSON](20261026-read-meter-evidence.json)的`retiredMetrics`中，也保留在Git历史。不能把新旧数值连成同一性能趋势。没有给旧键改含义，也没有用调高旧baseline来消掉`worse`。

## 错误、修正与覆盖边界

唯一计数实现改动位于`scripts/performance-counters/files.counters.test.ts`：

1. Promise `readFile`原来在调用前、成功返回后各加一次read。现在每次尝试只计一次，失败也计一次。
2. `readFileSync`原来把第一个参数——文件名——传入字节计数器。现在只统计成功返回的内容，失败贡献零字节。
3. `readSync`和`FileHandle.read`使用实际`bytesRead`。删除FileHandle读不到结果时猜测整个目标缓冲区长度的分支；真实Node合同保证返回`bytesRead`。

新键：

| 指标 | 含义 | mac2初始基线 | 容差/状态 |
|---|---|---:|---|
| `files.fixed-operations/io.read.api.calls` | `readFileSync`、`readSync`、Promise `readFile`及测量期间打开的FileHandle的`read`调用尝试次数；失败算一次 | 214 | 0 / candidate |
| `files.fixed-operations/io.read.payload.bytes` | Buffer返回值长度；字符串返回值的UTF-8表示长度；分段读取的实际`bytesRead`；失败为0 | 1397923 | 0 / candidate |

这不是操作系统syscall数、物理磁盘读量或完整文件审计。没有覆盖callback API、stream或其他原生读取；本固定调用链使用已列出的API。字符串若以hex等编码返回，统计返回字符串的UTF-8表示，不冒充原文件编码长度。新增真实文件测试明确证明这一点。

## 独立正确性检查

先给旧计数器加回归，再修实现：旧实现7项检查中**6项按预期失败、1项通过**；原固定负载6项在这个`-t`负对照中未选中，不是新增skip。

修正后8项直接检查全部通过：同步/异步各Buffer与UTF-8字符串；失败调用；实际partial/EOF；多一次真实读的敏感性；hex字符串表示。测试使用真实临时文件，并比较实际返回内容，不只断言计数器内部变量。

- 旧同步读报告文件名长度，而不是10字节内容。
- 旧异步读一次报告2次；增加一次真实读错误地增加2次。新实现分别为1和1。
- 64字节目标buffer只读到3字节、随后EOF：分别统计3和0，不按容量统计。
- 2字节文件以hex返回`ff00`：返回字符串表示为4字节；两个读取API合计8字节。

## 固定负载与新基线

原始`fixed-local-temp-workloads`保持不变：500会话、240用量行、120归档轮次、40轮分页、1MiB文件和64KiB分页、32份草稿及原功能断言。源码逐字比较确认：fixture/setup/import/measure、五轮固定业务主体、原重复生产读敏感性检查均未改动。只改变观测实现、指标键、来源说明和报告单位选择；新增小文件回归在独立describe中，不进入固定样本。

mac2初始五轮：

- API次数：`[214,214,214,214,214]`。
- payload字节：`[1397876,1397911,1397898,1397868,1397923]`。
- 原open/stat/readdir/write/rename仍为`6/1038/20/3/3`；未顺带收紧其旧基线。

通过既有`makeProposal`，只输入两个新键的观测、只写`data-flow.json`，登记初始平台基线。完整展开台账仍为77项；其余75项逐项deepEqual，guard通过。

**214不是把旧417优化到了214。** 旧417包含203次Promise读的重复计数。旧字节指标也漏掉真实同步读正文，不能与新的1397923比较改善比例。

payload样本跨度55字节，尚不满足稳定门禁条件。保留原始数据、零容差及candidate状态；没有做归一化、增加容差、挑选样本或晋升门禁。今后若要升级，应先独立验证动态文件元数据等输入的稳定性，并保持真实业务调用及读取边界，不通过过滤真实内容来造稳定数字。

## 验证结果

| 检查 | 结果与范围 |
|---|---|
| 旧实现负对照 | 6个预期失败，1个通过；日志保留 |
| 本机focused | 4文件36用例通过：新读取回归、原固定负载、ledger/ratchet/measure |
| 类型 | 本机和mac2 `npm run typecheck`通过 |
| mac2完整unit | 346文件，4031通过、4项既有opt-in探针跳过、0失败；文件串行执行，未改测试超时 |
| 全量性能 | 74观测、77登记；全部gating通过，3个candidate仍worse，3项CPU candidate未观测 |
| 差异与文件门禁 | 无`src/`改动；业务负载源码不变；正常20KB完整文件门禁，不豁免 |

全量unit运行于既有验证组合`1dd69260`加本轮两文件补丁，包含既有CLI修复`5bb630e1`。不把它说成未含该修复的裸性能分支全绿。源码及台账哈希见证据JSON。

全量unit锁记录：8核，负载2.66→8.09，`highLoad=true`。断言结果有效，但不以622706ms总耗时作性能结论。全量performance锁记录6.73→7.05、`highLoad=false`；本轮也没有L2提速假设，不把44秒工具运行耗时当App指标。

保留的三项`worse`：

- `files.fixed-operations/io.readdir`：20，对旧baseline18。
- `persistence.archive/ipc.bytes`：10558，对10536。
- `recorder.content-cold/io.stat.calls`：44，对36；此前有意以stat替代失败mkdir的工作量交换。

它们在上一轮已存在，本轮对应生产代码、观测逻辑及基线均未动。三个CPU candidate未启用指令测量，保持missing，绝不写0。

本次汇总曾错误读取不存在的`ratchet.md.json`。发现后先列出真实产物，再用公开`checkRatchet`读取既有`candidate.json`重建报告；没有为补输出重跑测量或抹掉失败。

## 复现与交付范围

```sh
npm run test:unit -- scripts/performance-counters/files.counters.test.ts
node scripts/performance-counters.mjs collect ../results/read-meter.json files.fixed-operations
npm run typecheck
npm run test:unit -- --maxWorkers=2 --no-file-parallelism
npm run performance:measure -- --out ../results/read-meter-full
```

mac2完整检查通过已有`timing-run.mjs`串行持锁。共享SQLite绑定在完整Node检查前切到已验证Node137版本，之后恢复Electron146；没有触碰宿主其他项目的依赖。

原始结果：`/private/tmp/scry-performance-climb-20261025.yjlnNW/results/mac2-read-meter-20261026/`，含首次负对照、修正后的focused/typecheck、初始五轮观测、旧完整台账、两键提案、业务源码保留证明、mac2完整日志和JSON。原日志与新定义一起保留，不重写历史结论。

没有新增依赖、App产品代码或新构建产物。本轮不重复上一轮UI/崩溃验收，也不把旧验收当新版本重新执行。没有真实Provider、发布安装、推送或原开发分支合入；没有L2/L3收益宣称。

下一步：产品优化与完整UI维护已在独立验证组合收敛。原开发工作区仍有并行CLI/recorder未提交改动；进入当前开发基线的集成和交付前，由用户决定基于已提交HEAD先做独立集成，还是等这些改动落定。不得覆盖、混入或替用户提交这些WIP。
