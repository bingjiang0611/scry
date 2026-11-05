# 状态

**全部待核验**：汇总见 [reports/SUMMARY.md](reports/SUMMARY.md)。R1、R3 未做（进入条件已成立，超出本批预算）。

状态值：`未开始` → `进行中` → `待核验` → `已核验` / `需修改`；测量后不值得做：`放弃（附证据）`；碰到 README「必须停下」条件：`停止（附原因）`。

执行方每完成一个条目更新本表并 push，**不需要等核验就继续下一个**。全部结束后在这里写「全部待核验」，并给出 `reports/SUMMARY.md` 链接。

| # | 条目 | 批次 | 状态 | 报告 | 备注 |
|---|---|---|---|---|---|
| M1 | L1 计数工具 | M | 待核验 | [M](reports/M.md) |  |
| M2 | Git 快照正确性对照（oracle） | M | 待核验 | [M](reports/M.md) | 21 个场景一致 |
| M3 | 基线 | M | 待核验 | [M](reports/M.md) | `1ff8bc5c` |
| G1-1 | 复用 discovery index 构建 afterTree | G1 | 待核验 | [G1](reports/G1.md) | `b6a2c338` 结束阶段 −1 read-tree；索引无法证明未变时回退 |
| G1-2 | 合并 numstat 与 name-status | G1 | 待核验 | [G1](reports/G1.md) | `91a3d23a` diff 2→1 |
| G1-3 | 多仓库有界并发 | G1 | 放弃（附证据） | [G1](reports/G1.md) | 高负载下未见收益，未改代码 |
| G1-4 | 大 patch 内存峰值 | G1 | 放弃（附证据） | [G1](reports/G1.md) | +1.37 GB，成因在完整 patch 留存链 |
| G2 | 进入条件判断 | G2 | 放弃（附证据） | [G2](reports/G2.md) | 单仓库已 11 个进程 |
| G2-1 | 跨轮索引种子 | G2 | 未开始 | [G2](reports/G2.md) | 随 G2 放弃 |
| G2-2 | 私有对象库跨轮保留 | G2 | 未开始 | [G2](reports/G2.md) | 随 G2 放弃 |
| G2-3 | 布局与配置缓存 | G2 | 未开始 | [G2](reports/G2.md) | 随 G2 放弃 |
| R1 | transcript 增量解析 | R | 待核验（部分） | [R](reports/R.md) | `1fc96816` 锚点 33.0→6.9 MB；解析增量未做 |
| R2 | 正文写入合并 | R | 待核验 | [R](reports/R.md) | `eba96f91` 20/19/19 → 1/0/0 |
| R3 | 恢复路径只看需要的会话 | R | 未开始 | [R](reports/R.md) | 条件成立，超出本批预算 |
| R4 | 提交临界区（只测量 + 设计） | R | 待核验 | [R4-design](reports/R4-design.md) | 结论：不需要改 |
| R5 | 统一日志等架构（只写设计） | R | 放弃（附证据） | [R](reports/R.md) | S10 数据不支持 |
