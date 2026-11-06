# 汇总：recorder 引擎性能（M / G / R）

分支：`perf/recorder-engine`。已完成本批实现、本地验证与 Sol 复核；未发布。
提交时点的维护失败隔离、JSON 修正与门禁情况见 [PR-follow-up](PR-follow-up.md)；最新远端状态以
[PR #31](https://github.com/bingjiang0611/scry/pull/31) 为准。并发修复见
[R3-attention-race](R3-attention-race.md)，初始化与半行修正见 [SOL](SOL.md)。
验证须按各报告的 revision 区分；完整条目见 [STATUS](../STATUS.md)。

## 本次 PR 的边界

| 改动 | 已证实的作用 | 报告 |
|---|---|---|
| M：固定 workload、计数与 Git oracle | 可复核工作量；targeted 与 full 路径按树 / patch 严格对照 | [M](M.md) |
| G1：复用 discovery index、合并 diff 查询 | 常见单仓库每轮 Git 进程 13→11；不改用户索引 | [G1](G1.md) |
| R1：transcript 锚点复用 | 六次扫描的锚点读取 33,038,016→6,859,226 字节；仍重新解析本轮窗口 | [R](R.md) |
| R2：相同正文批内去重 | 20 个相同 patch 的 hash / verify / sync：20/19/19→1/0/0；复用已有正文仍校验 | [R](R.md) |
| R3：attention 索引 | 0 / 200 / 1000 个已完成会话目录，正常恢复 readdir 均为 7；缺失或周期性重建仍为全量扫描 | [R](R.md) |
| G1-4：格式不变的分片写入 | 历史 S5 阶段 RSS 增长 1208→316 MB；避免完整字符串 / Buffer 的重复构造 | [G1-4](G1-4.md) |
| C：CLI / daemon inline 正文去重 | 新记录只保留完整 `patchContent.content` 与 `contentRef`，去掉重复 `patch`；样例文件 5.98→2.99 MB | [C-inline](C-inline.md) |
| R3 诊断修复 | 无索引时 pending / stale / has-open 从源状态重建；无 transcript 的旧 open 能报警 | [R3-doctor](R3-doctor.md) |
| R3 并发修复 | 标记与状态发布、检查与删除使用同一短文件锁；阻止真实 inbox / open 被漏索引 | [R3-attention-race](R3-attention-race.md) |

减少的工作是删除、合并与复用，不是移出计数范围。没有降低正文完整性、原子发布、fsync、序号
分配或去重要求。互斥与完整初始化有必要成本：新工作区首次轮 fsync 41→46，正常恢复 readFile 12→14；
不能把正确性成本写成性能收益，也不能声称总 I/O 不变。

## 性能结论的强度

- **L1（工作量）**：Git 进程、重复正文写入、锚点读取与已完成会话扫描的减少有计数证据。
- **L2（受控或实际毫秒）**：历史 Linux 对照支持 R3 恢复收益，但没有建立普遍的 G1 延迟收益。
  新增并发锁后的路径没有新的 L2 加速结论。详见 [L2-VM](L2-VM.md)。
- Colima guest 与繁忙宿主共享资源，不能称为独立安静机器。旧 macOS 毫秒差值及 `highLoad: true`
  的 S5 测量不支持普遍变快的结论。
- S5 原来的 +500～800 ms 反向差异，在后续各 12 轮中未稳定复现：旧 / 新的 run-p50 中位数
  为 11597 / 11430 ms。未复现不证明具体噪声来源，也不排除内存路径影响。
- C 已证明减少重复序列化字节；不宣称额外的速度或峰值内存收益。固定 S5 对照中最大绝对 RSS
  529.6→583.1 MB，最大阶段增长 378.9→319.2 MB，且宿主高负载，不能据此归因。
- **L3（日常样本）**：未完成，不用 L1 / L2 代替。

## 后续项，不纳入本次交付承诺

| 条目 | 状态与条件 |
|---|---|
| G1-3 多仓库并发 | 高负载样本不足，未实施；需要可信收益与正确性证据 |
| G2 跨轮复用 | S3 / S6 已达到评估门槛；单仓库 11 个进程不构成豁免。实现仍延后，特别是索引种子需要单独论证 |
| R1 真正增量解析 | 未实施；需要 Provider-specific 的可合并状态及重放规则，不能把锚点复用称为解析增量 |
| R4 提交路径重写 | 当前成本证据不足以支持改动；已有测量和设计，不扩大实现 |
| R5 统一日志 / 执行器 | S10 不支持架构扩张，未实施 |
| D 引用式正文 / App managed 去重 | 未获授权；C 不等于 D，App canonical handoff 未变 |

## 验证与已知限制

历史检查分别记录在各报告，不混用 revision。本轮的关键证据为：旧实现上的五个确定性负对照、
跨进程原生锁竞争、发布前后 SIGKILL、真实队列重放，以及 macOS / Linux 构建后 CLI 的
queue → recover → commit → verify 流程。详见 [竞态报告](R3-attention-race.md) 中的命令、数量和日志。

Linux 回归暴露的旧 oracle fixture 缺少 alternate object store 环境，已在未修改 `ec44ffa1`
重现。修复只让测试使用与 capture 一致的对象视图；tree / patch 相等、真实索引与对象库不变等
断言均保留，生产 Git 代码未改。

仍未验证真实 Provider / App 端到端、断电恢复、Linux 发行版目标机及安装后的日常实例。
SIGKILL 只证明进程崩溃场景，不等于断电测试。混用旧进程不受新互斥协议保护。

## 生效与交付

维护者随后以 full-send 授权推送、创建 PR、跟进 CI / 评审并按保护规则合并。
不发布 npm、不安装全局 CLI、不替换日常 App / daemon。
`npm run build:cli` 只生成本检出的 CLI 产物，不会升级已安装 CLI。后续获准部署时，需要更新
所有参与的 CLI / daemon 并重启对应 daemon；仅这些 core 改动不需要 `scry integrations repair`。
旧记录不迁移；只读取旧 `patch` 字段的外部消费者需要适配 C 的既有文档合同。
