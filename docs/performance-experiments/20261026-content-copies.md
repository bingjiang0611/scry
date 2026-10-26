# 2026-10-26：单条内容的双权威目录准备批次

## 结果与授权

用户在UI验收收敛后明确选择“继续批量同步实验”：允许改变目录fsync批次，要求公开返回点仍满足耐久性及双事实源合同；不改变存储格式，不合入开发分支或安装。

本轮完成L1工作量下降。mac2上两种相反执行顺序均观察到函数级L2下降；这不是日常App、整轮结束延迟或L3结论。全部样本、源码哈希及限制见[测量](20261026-content-copies-measurements.json)和[验收证据](20261026-content-copies-evidence.json)。

| 身份 | 版本 |
|---|---|
| 冻结测量/生产baseline | `1fae1e62682e341245dea25182ad100188574caf` |
| 优化提交 | `129f1bf3` |
| 独立验证组合 | `1dd69260b1df0427576a1efff057ad49b07e5735`，另含既有CLI修复`5bb630e1` |
| 全量unit执行时 | `9fece7ac` + 本次精确patch和新测试；转为提交后6个改动文件逐字节一致 |
| 当前源码App构建 | 0.2.221，build `750348006ae8f1a91b8ad9ef347941946b0162526c0ad80659926147f2c62aae`；没有安装 |
| 机器 | mac2，M1/8核，macOS/Darwin25.3.0，Node24.18.0，Electron42.10.1 |

验证组合与优化提交在`src/`下只差CLI的`workspace-init.ts`及`hook-fallback.test.ts`。不能把组合的完整unit通过称为裸性能分支已修复既有CLI失败。

## 为什么不跨事件批量

真实入口`src/main/index.ts`将单个event交给`persistTraceToolEvents(..., [event], recorderRoot)`，`LiveTraceIngestion`逐条等待持久化。历史加载虽然有数组，原函数也逐条处理，避免同时保留整轮序列化大正文。

因此本轮不是把固定基准里的4条事件硬改成真实队列不存在的4事件批量。批次严格限于**同一条内容的App与workspace两份副本**，不引入时间窗口、跨事件队列、额外后台服务或常驻缓存。单根继续走原入口和同步流程；底层仅有等价函数提取，并非整个IO文件字节不变。

## 协议与最小改动

```text
一份正文 -> 一次UTF-8编码/摘要
              |
       检查各根是否已有完整内容
              |
       准备所有缺失副本的目录
       同一目录条目只检查一次
              |
       同一父目录同步一次
       [所有祖先条目durable]
              |
       App副本：写临时文件 -> 文件sync -> 独占link
                -> 目录sync -> 删临时link -> 目录sync
              |
       workspace副本：同样完整流程
              |
       EEXIST竞争者：核对完整字节，再sync最终目录
              |
       两份完成 -> 返回ref -> 允许持久化UI补充事件
```

- `src/core/turn-recorder/io.ts`：提取原目录类型检查及原独占发布实现；新增副本目录准备。目录集合只存在于本次调用，下一次调用重新检查、同步。**任何最终正文名称出现前，全部祖先条目已经同步**。
- `content-store.ts`：新增`writeRecorderContentCopies`，复用一份Buffer和SHA；已有正文和并发EEXIST均核对完整字节。不将“目标存在”当成成功。
- `src/main/trace-tool-content.ts`：仍逐条处理，只把原两个单独写入换成上述两根调用。workspace副本仍独立可供离线CLI读取。
- 格式`recorder-content-v1`、路径布局、各文件数据sync、发布后sync和删除临时link后的sync均保留。没有降低权限、trust或来源校验。

这不是跨文件系统的全有或全无事务。第二份失败时第一份完整副本可能保留；调用拒绝，不返回持久化引用，也不危险地回滚删除其他调用可能已经复用的内容。

## L1：减少的工作确实不再执行

固定负载不变：4条不同256KiB正文，初次目录创建/发布包括在测量内；单根和真实双根调用各5次独立重复。临时根每次新建，**不表示OS缓存冷启动**。

| 双根指标 | before，每轮相同 | after，每轮相同 |
|---|---:|---:|
| SHA256调用 | 12 | 8 |
| stat | 92 | 68 |
| mkdir+stat | 109 | 85 |
| open | 116 | 88 |
| sync总数 | 116 | 88 |
| mkdir | 17 | 17 |
| 读/写/link/rm | 各8 | 各8 |

减少了重复父目录准备及第二次正文摘要，没有把工作移到计时外、异步后台或以后补算。文件数据和每份发布/清理的同步未减少。相邻单根控制全部10组计数不变：stat44、mkdir8、sync/open56等。

**限制**：本夹具的两根共享6个目录组件，合并后每条少7次父目录sync。真实App与workspace路径通常共享更少祖先；不把28次减少当成任意工作区的固定收益。摘要从每条两次变一次不依赖共同目录深度。

旧workload字符串仍含`sync=unchanged`，它不是“调用次数不变”的证明。本轮经用户授权改变重复目录调用粒度，输入负载未改变；是否保持耐久性以实际依赖检查和故障检查为准。

### 测量与实现分开

先提交`1fae1e62`：将双根的精确重复序列断言改为与调度无关的耐久依赖断言。每个目标都必须具备：

1. 每个祖先在创建后、正文link前完成父目录sync。
2. 临时文件数据在正文link前sync。
3. 正文link在临时link删除前被目录sync覆盖。
4. 临时link删除在返回前被目录sync覆盖。

单根仍保留旧精确序列。真实完整字节及独立SHA检查保留；删除任一类barrier的4个反例都必须失败。旧生产实现先通过15项测量测试，然后才改生产代码。这是用户授权的新调度合同，不是为错误实现删除保护。

## L2：保留三轮全部原始样本

每个数字为完整4条event双写函数体ms，含原投影/序列化和磁盘操作，不含Provider、网络、React或整轮收尾。

| 轮次 | 顺序 | 8核负载前→后 | 单根中位 before→after | 双根中位 before→after | 判断 |
|---|---|---|---:|---:|---|
| 1 | A后B | 4.58→8.11 | 133.908→136.693 | 303.573→296.549 | `highLoad=true`，无效L2 |
| 2 | A后B | 1.96→2.20 | 141.912→116.504 | 284.564→215.210 | 低负载；但单根控制也变快 |
| 3 | B后A | 2.84→3.27 | 101.103→118.104 | 234.051→167.610 | 交换顺序；双根下降方向仍成立 |

A是baseline，B是候选。第二轮出现对照漂移后，只再做一次预先说明的反向次序检查；本假设三轮到此停止。未剔除首轮或离群样本。两种次序支持这个函数与夹具下的下降方向，不将约66–69ms差值宣称为稳定百分比、统计显著性或真实App收益。

## 验证与失败保留

| 检查 | 结果 |
|---|---|
| 旧行为负对照 | 临时恢复逐根独立写入后，共同父目录断言失败：2次而非1次；随后恢复精确源码 |
| 保护负对照 | 故意删清理目录sync后，失败信息为`persisted before the second cleanup barrier`；没有用超时充当敏感性 |
| 9个真实FS/实时队列用例 | 覆盖共享准备、跨调用重验、prepare失败、第二份文件/发布/清理sync失败、完成前无ref、并发EEXIST和等长损坏；通过 |
| 2个实际进程中断点 | Node子进程在第1/2个最终link后、目录barrier前被SIGKILL；无返回标记；新`--no-addons`进程恢复两份完整内容；通过。不是断电模拟 |
| 完整unit | 346文件，4023通过、4既有opt-in跳过、0失败；文件串行，`--maxWorkers=2 --no-file-parallelism`，原测试超时不变 |
| typecheck / build:cli | 通过 |
| 当前App构建及production conversation IPC | 通过；含归属拒绝/正对照、启动失败保留、三轮恢复与2次重启；受控Provider，不是付费真实Provider |
| 编译后独立Core | `node --no-addons`双根完整读取、复用与等长损坏拒绝通过 |
| 收紧后台账检查 | 22项通过；完整guard通过；全部文件正常通过20KB提交门禁 |

本机首轮进程中断测试有两个原5秒超时。随后观察负载205.58，未发现匹配的publisher进程；原日志没有足够阶段信息，不能断言唯一原因。补充仅登记子进程的超时回收及失败阶段信息后，同样5秒限制在mac2通过并进入全量检查。首轮失败日志保留，没有加sleep、skip或扩大超时。

临时文档脚本曾有两次执行前语法错误，相关写入/检查没有执行；修正后重新核对哈希、引用及文件大小。初版合并证据JSON超过20KB，按“测量”和“验收”职责拆分并验证信息无损，没有压缩格式绕过门禁。

全量unit在收紧基线前执行；随后只改5个台账数值，22项台账测试通过。生产及测试源码哈希在运行、提交、远端受控清理/checkout之间一致。完整renderer UI未重跑（没有renderer改动）；前轮完整UI结论不冒充本轮新构建的全UI结论。

Node20/22、Linux、发行打包、真实Provider和L3本轮未验证。Core返回点依据实际fsync依赖及进程故障检查，不作比操作系统/既有存储协议更强的硬件断电保证。

## 全量性能门禁及发现的旧测量问题

`performance:measure`得到74项观测、77项注册，gating全部通过；3项CPU candidate未测，明确missing。仅通过领域`makeProposal`收紧5项双根candidate，未升门禁或放宽任何指标。注意stat注册基线75→68；真实本轮before是92，不混为一谈。

5项candidate仍标`worse`，逐项保留：

- cold stat44对36：上一轮用stat替换失败mkdir的已知权衡；本轮单根控制44→44。
- files readdir20对18：相同主机/冻结harness比较仍20→20。
- archive IPC10558对10536：同源对照10558→10558。
- files read417对336、read.bytes1227187对1183197：只能称**旧计数器报告值**。进一步检查发现下述既有口径错误，不能继续当成真实API次数/字节使用。

本次相邻对照的legacy字节1227201→1227207，+6超过原容差4；未伪装为容差内。独立的只读诊断副本继续追踪实际读结果，两侧各5样本的波动，在扣除序列化`mtimeMs/ctimeMs/ino/dev/sourceMtimeMs`数值长度后均为1216660。这个归一化值只用于定位波动，**不是新门槛，也不是修正后的真实字节数**；原始那一对文件已由harness清理，不能声称逐字节重放了当时的6字节。

同时确认`files.counters.test.ts`的既有问题：

1. Promise `readFile`在调用前和成功返回后各加一次read，重复计数。
2. `readFileSync`向字节计数器传的是文件名，不是返回内容。诊断中每轮确实发生7次该同步读和203次Promise读，并非不可达代码。

没有修改该文件、旧baseline、容差或过滤掉这两行。本轮content-publication使用另一套已验证的计数器，不受这两个错误影响。下一步优先修正测量口径、增加直接反例并确定旧candidate替换策略；不能把修正计数器造成的数字下降宣传成产品优化。由于退役/重建旧指标涉及台账策略，需维护者明确决定，不擅自删除指标或放宽门槛。

## 复现与最终状态

代码：`/private/tmp/scry-performance-climb-20261025.yjlnNW/source`。结果：同级`results/mac2-content-copies-20261026/`；mac2日志：`/Users/test/scry-performance-climb-mac2.cO3N5W/logs/content-copies/`。原始三轮timing、unit/IPC、故障控制、byte诊断、每阶段状态、源码哈希均保留。

```sh
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs copies -- \
  node scripts/performance-counters.mjs collect /absolute/output.json content-publication
npm run test:unit -- src/main/trace-tool-content-copies.test.ts src/core/turn-recorder/content-copies-crash.test.ts
npm run test:unit -- --maxWorkers=2 --no-file-parallelism
npm run typecheck
npm run build:cli
npm run test:conversation:ipc
npm run performance:measure -- --scenario files.fixed-operations --compare 1fae1e62 --out /absolute/output-directory
```

配对前后使用相同collector、barrier helper与lockfile；私有脚本分别保留A/B、B/A顺序。只调换顺序和结果目录，不改变函数调用、输入或重复次数。临时byte诊断文件已移除，未进入提交或最终测试集合。

源码分支本地提交；独立验证组合已同步mac2且tracked clean，`node_modules`符号链接是预期未跟踪项。实验根cwd进程扫描无匹配，不泛化为全机器进程树证明。工作树、原始日志和测试失败现场保留。没有合入原开发工作区、推送、安装或由本任务重启日常App。

下一步由agent负责测量口径修正方案及直接回归；维护者决定旧candidate如何替换。更大的跨事件批次不在本轮实现中，也不为它预留配置或框架。
