# 2026-10-25：首次内容发布与目录准备

## 结论与明确取舍

**L1成立，未证明稳定L2收益。** 首次发布4个256KiB内容块，目录元数据API调用80→52；App与工作区各保留一份时167→109。没有缓存目录，没有减少任何sync，也没有改两份证据的所有权或存储格式。

**有6项candidate仍为`worse`，不是全项变好：**

- 本轮有意增加`stat`：单份36→44、双份75→92。新增8/17次是检查尚不存在的目录的代价；对应取消36/75次注定失败的`mkdir`。总量下降不取消这两项`worse`，未抬高它们的基线或删除指标。
- 另4项为已知历史偏差：files read417 vs336、readdir20 vs18、read bytes1227200 vs1183197、archive IPC bytes10558 vs10536。已用本轮基线同机对照；前三项中的读取字节差为+4，在已有4-byte tolerance内，其余计数相同。没有为旧偏差抬基线，也不将它们升为门禁。

底层诊断进一步发现：当前Core首次发布的10个受控样本中，文件和目录sync的等待时间占总时间约66%–81%；目录`stat/mkdir`合计仅约5.8–15.8ms。继续微调目录检查的空间有限。后续先转向查询/归档索引；不擅自通过减少sync来追求大幅提速。

## 方案扫描与机会日志

延续[执行计划](../performance-climb-plan-20261025.md)与[上轮mac2记录](20261025-mac2-climb.md)，本轮消除了“首次发布、双存储、sync时间组成未测”的缺口。

| 视角 | 想法与决定 |
|---|---|
| 删除工作 | 不对既有祖先目录发mkdir；本轮采用 |
| 修复层次 | 在共享`mkdirDurable`修复，所有exclusive publication受益；不在App caller打补丁 |
| 平台能力 | 使用现有Node `stat`，不用额外库或native addon |
| 计算 | 多root共享body编码/hash可能省计算，但未单独测得其CPU占比；不先扩大API |
| 缓存 | 不缓存“目录已持久化”；前次失败或目录替换后仍必须重验并sync |
| 批处理 | 一次准备多个内容目录可能摊薄sync；触及本轮“不减sync”约束，需要另行授权与故障模型 |
| 并行 | 两个root并发发布可能隐藏等待，但需明确部分失败与收敛语义；本轮不改变顺序 |
| 数据布局 | blob pack可能减少小文件操作，但属于格式迁移，不自行实施 |
| 所有权 | 不用App根替代工作区根；离线CLI不能依赖App userData |
| 调度/worker | 大体积编码可考虑专用执行路径，但先测主线程阻塞；不新增常驻资源 |
| 查询/IPC | 下一轮检查分页是否仍扫描/解析全部归档，再决定索引或增量投影 |
| Provider | 已否证的目录热缓存不重做，继续保留完整刷新边界 |

根机会日志已经超过完整文件20KB门禁，本轮进展继续记录在本文件与执行计划，不为追加日志扩大重构。

## 实现与冻结身份

生产改动只在`src/core/turn-recorder/io.ts`：

1. 对每一级目录先`stat`。
2. 已存在且确为目录时，不再执行必然返回EEXIST的`mkdir`。
3. 缺失时仍创建；竞争创建导致EEXIST时，重新检查目标必须为目录。
4. 非目录、权限错误等仍拒绝；**无论新建或已存在，都执行原来的父目录sync**。

`writeFileAtomicExclusive`的文件sync、不可替换发布、临时链接清理、两次最终目录sync，以及内容完整性检查均未改变。

| 身份 | 值 |
|---|---|
| 冻结collector | `389cedf3`，在旧生产代码上通过；覆盖真实Core和实际App双根caller |
| 注册基线 | `9ae5b8da`，新增20项candidate，未升门禁 |
| 生产优化 | `16941f1f` |
| 验证组合树 | `dd5abea1`；与生产分支的src差异仅为已有CLI修复的两个文件 |
| unit实际执行快照 | `0aa591f` + 已保存patch + 新目录测试；生产源码SHA与最终提交一致 |
| io.ts before SHA256 | `60e53976c736c8729dbaa46919dbb76ec8d16c24a389276ddcd8759316fb44d1` |
| io.ts after SHA256 | `4c0939c5777e8bb345ea7c03337a688f1c34b48c47312023050bd5036b8cfc01` |
| 构建 | 包版本0.2.221，build `f8835e1fb896c15a002f15b4fc12fd748ca81c1cd48f87e5e9dee9a2b0c9f51c` |
| 机器/运行时 | mac2，Apple M1/8核，macOS26.3.2，Node24.18.0，Electron42.10.1 |

本轮未单独重建baseline App；L2是冻结源码入口的固定负载比较，不是整App A/B。当前App构建用于验收，不与旧日常日志混算。

测量、注册、生产变更分别提交。新台账按“内容发布”职责独立成文件，避免超过20KB文件门禁。只通过现有proposal收紧两项mkdir和两项目录总量基线；stat的旧基线保留。

## L1：真实首次发布，5/5一致

“cold”表示内容首次发布，不表示清空OS缓存。每次使用新临时root，4个不同的256KiB内容块，初次创建/发布全部计入。双根场景调用实际`persistTraceToolEvents`，不是只手写两次writer调用。测量期间执行真实文件系统操作；验证完整字节和独立SHA，逐项检查所有祖先、文件与最终目录sync的完整顺序。

| Node API工作量 | 单份before→after | 双份before→after |
|---|---:|---:|
| mkdir | 44→8 | 92→17 |
| stat | 36→44 | 75→92 |
| mkdir+stat | 80→52 | 167→109 |
| sync | 56→56 | 116→116 |
| open | 56→56 | 116→116 |
| read | 4→4 | 8→8 |
| write / link / rm | 各4→4 | 各8→8 |
| SHA256 | 4→4 | 12→12 |

减少的工作没有转移到计时外、native黑箱、worker或后台：不再发出那36/75次失败的mkdir。新增8/17次stat如实计入。未缩小负载、合并掉单项指标或跳过持久化步骤。

## L2与成本诊断

受同一把timing锁保护、相同collector与lockfile，before后接candidate；每侧每场景5个样本。负载2.01→2.01/8核，`highLoad=false`。

| 场景 | before中位 | after中位 |
|---|---:|---:|
| 单份首次发布4块 | 154.854ms | 141.336ms |
| 双份首次发布4块 | 292.670ms | 289.947ms |

样本明显重叠，顺序也未随机化；不宣称稳定9%或1%提速。原始注册阶段的样本也保留，没有挑掉较慢样本。详见[完整计数与样本](20261025-directory-publication-evidence.json)。

为决定是否继续优化这个位置，另对**当前编译后的Core**进行一次阶段诊断：每种root数量各5次，包装真实fs Promise与FileHandle，记录等待时间和调用数；不比较优化前后，不包含App投影/cwd哈希。锁内负载2.99→2.99，`highLoad=false`。

- 单份：sync等待占65.8%–81.0%；目录检查/创建5.8–8.3ms。
- 双份：sync等待占66.0%–73.0%；目录检查/创建13.0–15.8ms。
- 这些是带仪表的Core调用样本，包含系统排队等待，不是CPU占比、磁盘内核时间或整个App延迟。

[阶段原始数据](20261025-directory-publication-profile.json)保留每个样本和阶段。结论：在“不减sync”的边界下，本位置暂不继续微调。跨body批量持久化可以另做方案，但不能把一次sync当作已经验证了所有失败恢复语义。

## 验证

| 检查 | 结果与范围 |
|---|---|
| 工作量负对照 | 旧实现对完整存在的目录仍发14次mkdir，新用例失败；不是仅检查代码形状 |
| 持久化负对照 | 故意省略既有父目录sync，原本应拒绝的发布却成功，新用例确实失败；随后恢复并校验源码SHA |
| 目录合同 | 6项：已存在仍sync、嵌套创建与mode、竞争目录、竞争文件、权限错误、sync失败后拒绝/重验 |
| frozen collector | 11项：真实cold/dual发布、完整内容、sync全序列、额外真实metadata/sync敏感性 |
| focused | 初次相关7文件50项通过；最终目录/ledger/collector5文件41项通过 |
| full unit | 341文件，3985通过、4既有opt-in探针跳过、0失败；含已提交CLI修复的独立组合树 |
| type/build | typecheck、build:cli通过；test:conversation:ipc内的App build通过 |
| 生产App/IPC | conversation ownership、统一conversation运行/重启/证据回读通过；临时workspace/userData与受控Provider |
| 编译CLI Core | Node `--no-addons`加载实际package dist：既有目录mkdir=0、完整发布、不覆盖目标、非目录拒绝 |
| 全性能 | 75注册项、72观测；3项CPU指令candidate未测。门禁通过；6项worse分别解释，未隐去 |
| 台账/提交 | 完整guard通过；最终check通过；所有暂存文件≤20KB，正常hook与diff检查通过 |

full unit锁记录1.87→12.97，`highLoad=true`，只作为断言结果，不把其总时长当作性能结论。原性能分支仍未携带既有CLI修复；全量通过指独立组合验证，不是宣称裸分支的两个旧CLI失败已被本优化修掉。

本轮没有UI源变更，未重跑完整renderer UI。上轮已复现的基线共同DesktopRemote 55秒总期限问题仍待单独维护；没有增加deadline，也不声称发布gate全部通过。

### 首次失败与执行问题

- 新collector初稿错误地给4个事件总计设置64KiB断言，5个dual样本均失败。已有trace合同限制的是每个事件32KiB；修正为逐事件原合同，未改产品/负载，之后才冻结测量提交。
- paired基准本身exit0，但外层zsh不允许赋值`status`；通过已生成的锁日志确认完成，没有重跑选样本。
- 编译检查初次猜错输出路径。核对tsconfig后只检查实际存在的`packages/turn-recorder-cli/dist/core/turn-recorder/io.js`；初始错误日志保留。
- 最终ratchet命令首次漏report输出参数。补正后通过；没有重放已完成的提交。
- 两个负对照按预期失败。`-t`过滤造成的其他用例未执行与full suite的4个既有探针skip分别记录，未增加产品测试skip。

## 复现与交付

本地源码：`/private/tmp/scry-performance-climb-20261025.yjlnNW/source`。本轮原始产物在同级`results/mac2-publication-20261025/`，包括冻结patch、paired脚本/日志、阶段诊断脚本、full unit JSON、编译检查、App IPC与完整性能对照。mac2继续复用原隔离根；未触碰其既有项目或用户数据。

```sh
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs publication -- \
  node scripts/performance-counters.mjs collect /tmp/publication.json content-publication
npm run test:unit
npm run typecheck
npm run build:cli
npm run test:conversation:ipc
npm run performance:measure -- --compare 389cedf3
```

毫秒样本需设置`SCRY_CONTENT_PUBLICATION_TIMINGS`；正式paired脚本确认两侧collector/lockfile一致。Node full unit与Electron SQLite依赖不同ABI，本轮只在无测试运行时切换隔离依赖中的已验证binding；当前保留Electron146，后续Node full unit前恢复Node137。

- 本地提交，未合入原工作分支、未push、未打包或安装。没有重启用户App，没有真实付费Provider调用。
- 实验和组合树均保留；最后未观察到cwd在实验根内的进程，不把它扩展为逃逸子进程的保证。
- Node20/22、Linux和L3未验证。本轮不读新日常日志，也不声称日常App已加载优化。
- 下一步由agent检查查询/归档分页的实际扫描与解析成本。目录冷写不再为追求数字而扩大改动；批量sync、格式迁移、常驻资源、合入/安装均需相应授权。UI夹具维护另列，发布前收敛。
