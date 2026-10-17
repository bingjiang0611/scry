# 2026-10-16 性能记录追加不再触发用量全量重扫

## 假设与范围

方案二（增量工作区与证据引擎）的第一步：`appendLlmPerformance` 追加没有计费贡献的已知记录时，保留匹配原文件的用量聚合，只推进文件版本。避免下一次 `readUsageStats` 再读/parse 整份账本。

- 冻结测量提交：`cafc418`；生产优化：`7ac7fcb`。
- 固定负载：10000条真实临时 usage rows；先暖缓存；五次性能记录追加+用量读取；五次独立 fixture 重复。
- 不减少记录、不改变返回用量或源文件字节。collector 对 rounds、cost、tin/tout、invalidLines、sourceBytes 均有功能断言。

## 结果

| 指标 | 修改前（每个fixture） | 修改后 |
|---|---:|---:|
| `analytics.usage-mixed-append/io.read.calls` | 5 | 0 |
| `analytics.usage-mixed-append/io.read.bytes` | 4757290 | 0 |
| 配对计时：五次追加+查询 p50 | 24.18 ms | 2.13 ms |

**L1 成立；L2 未验证。** 配对计时经 timing-run 锁，但负载 8.66→10.44 / 10核，highLoad=true。上表毫秒仅为高负载观测，不可信，不据此宣称倍数或用户收益。初次基线也高负载；不通过重复挑样获得成功结论。

**后续L2补证（2026-10-17）**：mac2同机同依赖/collector、每侧5个fixture的中位批耗时26.26→1.43ms，减少94.6%；8核负载7.95→7.12，highLoad=false，但接近阈值，不是完全空闲。仅该固定负载获得L2证据；L3仍未验证。详见[mac2原始样本与方法](20261017-mac2-runtime-evidence.md)，原高负载结果保留。

减少的工作：已知非计费追加后的五次全文件读取和解析真正不再发生。没有把扫描移到worker或测量窗口外。性能行仍全部写入原文件，用量、历史、归属和删除语义保留。

## 实现与正确性

- 性能追加改用 async file handle；唯一生产调用方在既有 async persistence 边界 await，保留写失败报告；测试相应 await，不降低断言。
- 只在 cache 与写前 dev/ino/size/mtime/ctime 一致、写后 size 精确等于已知行长度且对象身份未变时推进 cache；否则由现有 authoritative scan 重建。
- 记录 cache 的行尾状态；无换行的旧尾不能当作安全已知追加，保留损坏信息，不伪造聚合成功。
- 扫描缓存同时验证 inode/ctime，避免同大小、同 mtime 的原子替换继续命中。
- 外部追加、截断、替换、并发写入都可能触发保守重扫；该改动不承诺文件系统原子快照或同用户攻击防护。
- recorder canonical commit、SQLite 权威与 evidence provenance 未改变。

## 验证

- 临时真实文件回归：损坏行/partial、按provider/cwd过滤、外部追加、同大小/mtime的原子替换、截断、缺换行尾、8路并发遥测混合计费追加、0600权限、异步写失败。
- 既有性能历史 roundtrip/过期/损坏/去重/删除用例保持全部断言，改为等待已完成的异步写。
- collector 初次失败是新增检查误写成 `tokensIn/tokensOut`，实际合同为 `tin/tout`；按生产合同修正，保留原计费数值要求。生产优化前的五次基线完全一致；测量代码先单独提交，优化后未改 workload。
- 最终全量 unit：3260 passed / 4 opt-in skipped；`typecheck`、`build`、`git diff --check` 通过。首轮全量仅Pi PATH fixture失败，详情见同日 Node 实验记录。
- 全量性能计数无 worse；现有 Git gating 8/11不变。candidate 基线收紧为 read.calls=0 / read.bytes=0，不升门禁。
- 后续 ratchet/feedback 专项22 passed / 1 failed：未改动的日志归档在同毫秒多次轮转时会按随机后缀读乱。固定时钟/后缀在与 `1c3cf63` 相同的生产代码上确定性复现，独立于本优化；未通过修改断言、重跑或更改采集格式掩盖。详情见同日 Node 实验记录，保留诊断脚本和日志，待单独修复。

## 下一步

这是减少无谓投影失效，不是完成工作区共享快照/完整证据引擎。下一项高收益实验应为真实 turn+session finalize 的重复 after-tree 捕获：先新增实际生产调用链计数和固定大仓库负载，再决定共享范围；不得拿 watcher 替代 canonical 重验，不能提前提交 recorder。

本机原始计数/计时/首次失败/最终验证日志位于 `/tmp/scry-perf-runtime-evidence-results/`，不上传。无真实 App/Provider、发布、安装或 L3 结论。
