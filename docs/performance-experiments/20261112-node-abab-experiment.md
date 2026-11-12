# Node ABAB / 20样本实验（不合入 main）

## 授权与边界

维护者批准独立实验：同一 runner 连续三轮，Node 场景按 ABAB 交替、每侧每场景至少20个样本，并记录批内 Git/文件阶段。先提交结果审阅，不修改正式门限公式，不合入 main，不改 native 测量或产品实现。

本分支暂时用**已注册的** `.github/workflows/performance.yml` 作为只读、手动实验入口；它不是可直接合入的正式 CI 配置。main 上的原工作流不受影响。原有工作流合同测试保持原样，不为实验分支改写断言；本分支不宣称完整正式 CI 通过。

## 测量方法

- 一个 Ubuntu job 内运行三轮；每轮启动新的两侧 worker 与独立临时 fixture。
- 冻结同一套 fixture、场景与诊断代码到两侧；不覆盖 baseline 的产品实现。
- 17个原 Node 场景、原 workload、预热与批内 iterations 保留。每场景严格执行 A1、B1、…、A20、B20，测量批次不并发。
- 保留全部20个原始样本。最近秩 P95取第19个排序值；数值相同仍可能等于最大值。
- `performance-compare.mjs` 的默认15样本入口保持原合同；实验显式传入20样本合同，并仅在内存策略副本中替换 sample count。固定上限、counter ceilings与公式完全不变：`min(policy.p95Ms, baselineP95 + max(10ms, baselineP95 * 0.5))`。不截样本、不伪装采样元数据。
- 批次携带 side/scenario/batchId、起止时间、CPU、事件循环与真实计数。跨批工作计数必须一致。

## 阶段诊断及限制

benchmark-only wrapper调用真实 fs与execFile，保留参数、返回、错误以及promisified execFile的原Promise/child属性。它记录命名同步/异步fs API和真实Git命令区间，不改产品代码。普通Node/shell exec不冒充Git。

每批最多256个stage，超过后明确记录droppedStageCount；GC最多512条并记录丢弃数。区间可能并发，不能把duration之和当作独占总耗时。覆盖范围不包括FileHandle方法、native模块与子进程内部syscall，不是完整文件审计。若待分析峰值对应批次有丢弃或残余时间无法归因，应增加按操作聚合或定向FileHandle诊断，再作根因结论；不能用未记录解释为“没有操作”。

## 验证设计

- 编排回归验证20对顺序、样本合同、有限值、socket协议与有界阶段数据。
- 合成分位数fixture明确区分第19样本与第20最大值；真实TraceOutputBridge重复投递使工作量翻倍，比较器必须报回归。
- 本机完整同源码握手最小实验先暴露split export错误并修正；修正后在预热阶段遇到既有resources-shell的1秒子进程预算（SIGKILL/timedOut），没有得到完整本机计时。未增大该预算、重试到绿或把失败当测量成功。
- 三轮原始JSON、worker日志、失败与comparison分别保存。测量失败与真实回归分开标识。实际远端结果、revision及运行链接待实验后附入。
