# 状态

本地实现与验证已推进到 R3 并发修复；本轮检查见
[attention 竞态报告](reports/R3-attention-race.md)，分支汇总见 [SUMMARY](reports/SUMMARY.md)。
**待核验指独立 PR 评审，不表示尚未执行本地测试。** 分支未合入、未发布。

维护者随后以 full-send 授权推送、创建 PR、跟进 CI / 评审并按保护规则合并。
不安装日常 App / CLI，不重启日常 daemon。Sol 后续修正见 [SOL](reports/SOL.md)。
历史报告按各自 revision 解读，不用旧通过替代新改动的验证。

| # | 条目 | 批次 | 状态 | 报告 | 备注 |
|---|---|---|---|---|---|
| M1 | L1 工作量计数 | M | 待核验 | [M](reports/M.md) | 真实文件系统 / Git，固定 workload |
| M2 | Git 快照正确性对照（oracle） | M | 待核验 | [M](reports/M.md) | 21 个场景与 full 路径一致；本轮补齐 discovery 测试的对象库环境，不放宽断言 |
| M3 | 基线 | M | 待核验 | [M](reports/M.md) | `1ff8bc5c`；后续比较各自标明基线 |
| G1-1 | 复用 discovery index 构建 afterTree | G1 | 待核验 | [G1](reports/G1.md) | `b6a2c338` 结束阶段 −1 read-tree；无法证明索引未变时回退 |
| G1-2 | 合并 numstat 与 name-status | G1 | 待核验 | [G1](reports/G1.md) | `91a3d23a` diff 2→1；常见单仓库每轮 13→11 个 Git 进程 |
| G1-3 | 多仓库有界并发 | G1 | 延后（证据不足） | [G1](reports/G1.md) | 高负载测量不支持实施，也不能证明没有收益 |
| G1-4 | 大 patch 内存峰值 | G1 | 待核验 | [G1-4](reports/G1-4.md) | `315e3639` 分片写入；历史 S5 阶段 RSS 增长 1208→316 MB，不宣称普遍延迟下降 |
| C | CLI 记录保留一份完整 inline patch | G1-4 后续 | 待核验 | [C-inline](reports/C-inline.md) | `efbb391b`；保留正文与引用、不迁移旧记录；D 与 App managed 路径未授权 |
| G2 | 跨轮复用评估 | G2 | 延后 | [G2](reports/G2.md) | S3 / S6 已过评估门槛；11 个进程不是 README 的豁免条件；本次 PR 不实现 |
| G2-1 | 跨轮索引种子 | G2 | 未开始 | [G2](reports/G2.md) | 需另行评估正确性与收益 |
| G2-2 | 私有对象库跨轮保留 | G2 | 未开始 | [G2](reports/G2.md) | 未实施 |
| G2-3 | 布局与配置缓存 | G2 | 未开始 | [G2](reports/G2.md) | 未实施 |
| R1 | transcript 增量读取 / 解析 | R | 待核验（部分） | [R](reports/R.md) | `1fc96816` 锚点 33.0→6.9 MB；真正的增量解析未做 |
| R2 | 正文写入去重 | R | 待核验 | [R](reports/R.md) | `eba96f91` 相同正文 hash / verify / sync：20/19/19→1/0/0；不同正文仍并行 |
| R3 | 恢复路径只看需要的会话 | R | 待核验 | [R](reports/R.md)、[doctor](reports/R3-doctor.md)、[竞态](reports/R3-attention-race.md) | 已实施索引、缺失索引诊断修复及发布 / 清理互斥；正常恢复仍不随已完成目录数增长 |
| R4 | 提交临界区测量与设计 | R | 待核验 | [R4-design](reports/R4-design.md) | 未实施提交路径重写，当前证据不足以支持 |
| R5 | 统一日志等架构 | R | 延后（证据不足） | [R](reports/R.md) | S10 不支持扩大架构 |

延后项不构成本次 PR 的隐含承诺。安静独立宿主、真实 Provider / App 与安装版本验收仍未完成；
Linux guest 不是 Arch/Omarchy x86_64 目标机验收。新锁要求参与进程使用更新后的 core，混用旧
CLI / daemon 不在验证保证内；缺少完整初始化标志的旧索引会先重建，不能仅因目录存在就跳过旧会话。
