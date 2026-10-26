# 2026-10-25：归档分页诊断与远程流式投影

后续状态：用户授权的[2026-10-26独立UI夹具维护](20261026-ui-acceptance.md)已让完整UI命令一次退出0。下文保留本轮当时的失败与分段验证，不将历史记录改写成通过。

## 结论

归档分页没有新增生产优化：正文早已并行读取且限定40轮，剩余增长主要是全历史新鲜度校验。不能删掉这些校验来做出漂亮数字。

客户端补上一个现有机制的遗漏：远程delta合并把实际保留的事件前缀传给既有流式投影缓存。固定20次尾部更新的投影前缀读取从100,020降到0，数组合并的100,000次读取保持不变。Node受控函数计时已记录，但绝对差异很小且有离群值；**不宣称可感知的界面提速**。

本轮机会日志在此：先解决完整UI验收阻塞，再评估更大收益。继续只做这类亚毫秒优化的优先级低于持久化与初始化路径；前者的重复目录同步、后者的常驻运行时方案都需要额外授权及正确性证明。未改同步协议、IPC协议、存储格式或日常日志。

## 身份与交付

| 项目 | 身份 |
|---|---|
| 查询诊断脚本 | `360314f1`，`scripts/profile-archive-scaling.mjs` |
| 最终冻结计数器 | `2866eed1`，`scripts/performance-counters/remote-projection.counters.test.ts` |
| candidate登记与路径映射 | `b26116e9` |
| 生产优化 | `67952e75` |
| 完整验证组合 | `0f4fadc1`；含此前独立CLI修复`5bb630e1` |
| 构建 | mac2验证工作区，App包版本0.2.221；build `d42af910ace0c33cfdcc96a6f9392c23780416e4f5e587e393554eee0285a6a2` |
| 状态 | 仅本地实验分支；未合入原工作分支、未push、未打包安装，日常App未改变 |

mac2：Apple M1、8核、macOS26.3.2、Node24.18.0、Electron42.10.1。原工作区与mac2既有项目未改动。所有数据是临时合成夹具，没有真实Provider调用或用户记录迁移。

完整unit与App验证基于包含CLI修复的组合，不把组合成功说成裸性能分支已消除原有CLI失败。提交前测试的是`c1576ffe`加精确生产patch；提交后校验三个源码文件SHA完全相同。组合分支相对`67952e75`的`src/`差异仅为原CLI修复的两个文件。当前构建也是组合产物，不是已安装App。

## 一、查询规模诊断：没有把已有能力重做一遍

脚本打包真实归档实现，分别写入40、400、4000轮，每轮256字节模型文本。独立临时目录，每组首次访问后再读5次40轮页；校验总数、页大小、顺序、完整性，并以额外实际lstat与JSON.parse验证计数敏感性。

| 历史轮数 | warm中位数 | canonical lstat/次 | 稳态正文读取 | 首次访问 |
|---:|---:|---:|---:|---:|
| 40 | 9.175ms | 120 | 40文件，26,510B | 17.201ms |
| 400 | 10.938ms | 480 | 40文件，26,600B | 66.862ms |
| 4000 | 38.393ms | 4080 | 40文件，26,680B | 482.124ms |

锁`mac2-archive-scaling`负载2.41→3.90，`highLoad=false`。首次访问是首次reader/checkpoint访问，**不是清空OS缓存的冷盘测试**。首次读取为N份元数据sidecar加40份正文；第一个warm样本还读取一次新checkpoint，不能把它删掉后声称每个样本都只有40次总readFile。完整原始样本和16个输入SHA见[查询证据](20261025-archive-scaling.json)。

代码证据：

- `readTraceArchivePageAsync`已经使用`Promise.all`读选定正文；元数据指纹校验也已限制并发32。
- N+80次canonical lstat包括全体成员新鲜度检查及40份正文的前后重验。外部原地改写、删除或新增文件仍必须被发现，不能仅看index文件mtime。
- Pi原生历史存在且同时存在Scry归档时，`agent:loadSession`路径可能先读页、再读完整元数据做身份合并、再读所选正文。原先页同时承担native读取失败时的canonical fallback。这里只确认调用链，没有把三次函数调用冒充已测得的整IPC耗时或断言都可删除。
- 进一步优化要先设计同一请求内的快照复用与回退合同；或批准新的失效/索引架构。没有增加缓存、放宽指纹校验或迁移数据库。

**纠错记录**：初读时误把已并行正文读取判断为串行，并过早委派了归档职责拆分。复读后立即纠正并取消；在确认子任务登记资源结束后，归档并撤回原文件及11个未完成模块。没有提交这些代码，没有声称归档路径变快。

## 二、远程尾部投影：复用已有的变更边界

真实链路为`RemoteChat → mergeRemoteTrace → activeRun.items → ChatTurn → TurnStreamProjectionCache`。本地`applyTraceBatch`已经记录变更位置，远程合并遗漏了这一步。

`remote-trace.ts`现在在通过cursor/base和新增索引完整性检查后，计算最早变化位置（包括截断、无序变更），调用既有`recordTraceItemsChange`。未变前缀仍是原对象引用，缓存可跳过重复比较。

- 复用既有WeakMap/WeakRef，不新建持久缓存；每次有效数组变化增加一次变更来源登记。
- 完整snapshot、缺口、未渲染中间更新仍走原有安全路径。缓存只认直接前一数组；没有把多步更新链当作已经校验的前缀。
- 早期工具更正、删除、append、子agent尾部和terminal替换与冷投影逐项比对。
- 主机侧全量哈希、协议、轮询、附件、数组复制、DOM与UI文案均未改动。

### L1与减少的工作去了哪里

冻结负载：`structural-items=5000;live-tail=1;updates=20;indexed-delta=true`。每侧5次独立样本。

| 指标 | before | after | 一致性 |
|---|---:|---:|---|
| `projection.prefix.reads` | 100020 | 0 | 5/5相同 |
| `merge.prefix.reads` | 100000 | 100000 | 5/5相同 |

减少的工作确实不再执行：消费者使用生产合并过程已经掌握的精确边界，省去逐项再比较。没有推迟到以后、移到worker或少处理事件。新增的20次弱引用来源登记包含在完整merge+project计时内；数组复制仍完整保留并单独计数。

计数使用数组属性访问器，返回原事件，不伪造工作量。额外一次真实读取使计数增加1。**毫秒另用无访问器的普通数组先测量**，不把访问器成本当生产成本。

### L2与范围

同一锁、先baseline后candidate；测量20次真实`mergeRemoteTrace + project`，初始投影是固定setup，不含IPC、网络、React commit或Chromium paint。

- before(ms)：0.693584、0.366458、0.197125、0.275958、0.478875。
- after(ms)：0.321375、0.160209、0.124709、1.828250、0.064750。
- 中位数0.366458→0.160209ms；candidate有1.828250ms离群值，完整保留。
- `mac2-remote-tail-paired`：负载2.15→2.15，8核，`highLoad=false`，exit0。

这是Node受控函数级L2，不是浏览器或日常App延迟。样本少、顺序未随机、绝对量小，**不宣称稳定百分比提速或用户体感改善**。此前登记采样也保留，不挑较好样本替换。

## 验证与首次失败

| 检查 | 实际结果 |
|---|---|
| 旧实现负对照 | 新回归预期0次前缀读取，实际5001，确实失败 |
| 错误变更边界负对照 | 故意忽略早期更正，旧工具输入被错误保留；冷投影对比确实失败。随后恢复精确源码SHA |
| 最终focused | 6文件、43用例通过 |
| 当前完整unit | 343文件、3990通过、4既有opt-in跳过、0失败；验证组合 |
| typecheck/build | 均exit0；生产代码SHA在最终提交后重验一致 |
| 完整UI命令 | exit1：第19段DesktopRemote综合夹具仍在55s截止；前19段完成，包含Credits |
| UI剩余第20–26段 | 7段全部exit0；不把续跑说成完整UI门禁通过 |
| 真实App | 当前production App的真实临时Git、conversation ownership IPC、统一对话UI/IPC、Pi历史分页/恢复通过；受控Provider、独立userData |
| 完整工作量 | 74观测/77登记，门禁passed；3项CPU指令指标missing，非0 |
| 台账 | 仅将投影前缀candidate基线100020→0；完整guard通过，没有升门禁或放宽其他项 |

本轮自己的问题均保留首轮日志：

1. collector初版缺layer/source，schema校验失败；在冻结前补齐。首次提交又使用了非标准工具字段，改成`tool_use/tool`后以`2866eed1`重新冻结并重新测量；旧登记样本不用作最终A/B。
2. 错把工作量scenario加入L2 benchmark目录，5项feedback测试失败；修正目录分类，保留路径映射与独立counter登记，原31项通过。没有删测试。
3. 新的共享调用链使Node类型检查读到renderer的`@shared`别名，出现TS2307。改成相同文件的相对type-only import；esbuild输出JS逐字相同。重新typecheck并重新跑完整unit通过。
4. 最终propose首次用全领域观测，顺带提议降低无关stat/write基线；自审撤回，最终只接受本指标变化。没有把历史收益归给本轮。

最后一次完整unit锁记录`highLoad=true`（3.58→13.46）；只使用断言结果，不把其总时长作性能结论。完整counter采集也标highLoad（8.36→5.79）；L1有效，不能从该次总时长宣称L2改善。

### 六项worse均没有藏掉

- 上轮有意增加的cold/dual stat：36→44、75→92，保留原基线，不擅自提高。
- 历史文件读取：336→417、readdir18→20、字节1183197→1227197；归档IPC10536→10558。
- 本轮重新以`2866eed1`同机固定harness对照：read417→417、readdir20→20、archive bytes10558→10558；read bytes最大1227197→1227201，+4在原有tolerance=4内。没有调整tolerance。

完整UI超时已在冻结旧代码复现，详见[前轮记录](20261025-mac2-climb.md)。本轮没有靠增加超时、重试、删断言或缩小负载把它标绿。它仍是完整交付门禁的阻塞，需要独立处理。

## 证据、复现与后续决策

[原始计数、时间、控制与源码身份](20261025-remote-projection-evidence.json)。本地完整日志位于`/private/tmp/scry-performance-climb-20261025.yjlnNW/results/mac2-query-20261025/`，mac2对应`/Users/test/scry-performance-climb-mac2.cO3N5W/logs/query/`。源码工作区、测试产物、失败fixture和日志保留；最终未观测到实验根目录下的存活cwd进程，不能据此承诺任意逃逸子进程都已结束。

```sh
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs archive-scaling -- \
  node scripts/profile-archive-scaling.mjs /absolute/path/archive-scaling.json
SCRY_REMOTE_PROJECTION_TIMINGS=/absolute/path/timing.json \
  node .agents/skills/scry-performance-climb/scripts/timing-run.mjs remote-tail -- \
  node scripts/performance-counters.mjs collect /absolute/path/counters.json renderer.remote-tail
npm run test:unit
npm run typecheck
npm run build
npm run test:renderer:ui
npm run performance:measure -- --out /absolute/path/measure
```

后续需要维护者决定的不是再调一个小常数：

1. **建议先修完整UI验收组织**：独立任务拆分过大的综合场景，保留每个业务断言和场景超时，不把截止时间简单调大；这是既有测试维护，不混称性能收益。
2. 若继续持久化主线：此前同步等待占受控冷发布约66–81%，高于目录元数据工作。批量发布/合并目录同步可能更有价值，但改变同步粒度超出本轮授权；必须先确认，并证明任何公开返回点仍满足原durability与双事实源合同。
3. 未授权合入、push、安装；L3需要未来部署后正常使用的同场景≥30样本、≥2会话。没有用旧安装版本的日常日志评价未部署优化。

另外，UI设计上下文工具报告既有设计文档元数据过期；本轮没有视觉变更，也没有顺带重写设计文档。
