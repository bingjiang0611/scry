# 2026-10-16 同毫秒归档排序修复与 L2 复测

## 排序缺陷

上一轮专项暴露了既有问题：多次轮转发生于同一毫秒时，归档文件名的时间戳相同，reader/pruner按随机后缀排序，可能打乱原始写入顺序。基线journal/report代码与`1c3cf63`一致；不是上一轮Node/usage优化引入。

### 最小修复

- 只修改新归档名的排序时钟：`max(Date.now(), lastArchiveTime + 1)`。
- 打开时异步读取已有归档名，从最大的排序时间恢复；压缩前的.jsonl和压缩后的.jsonl.gz均可识别。
- 文件名仍为原有 `performance-<UTC>-<随机>.jsonl[.gz]` 格式，兼容现有snapshot/report和保留策略。事件payload、schema、真实recordedAt、采集内容、字节上限、间隔与权限均不变。
- 同毫秒高频轮转或系统时钟回拨时，文件名时间只表达逻辑先后，不是精确的归档墙钟时间；真实事件时间仍读recordedAt。
- 新增一次open时的异步目录枚举是恢复排序状态所需的正确性工作，不宣称它使启动更快。
- 不尝试根据随机后缀猜回已经存在的同毫秒旧归档顺序；旧数据的歧义无法由这次修复消除。旧版数字轮转文件的mtime迁移仍沿用原合同。

### 回归与负对照

新增`performance-feedback`场景使用真实临时目录、真实轮转/gzip、snapshot/hash验证和生产reader；只冻结Date，不加sleep、不放宽超时、不替换I/O。

- 第一session在固定毫秒写12条；第二session重启并把墙钟回拨一天，再写12条。
- 要求归档排序时间互不相同、reader完整读回0..23、两个session的health保留、recordedAt仍分别等于实际固定墙钟值。
- 修改前确定性失败：12个archive stamp只有2个不同时间，`expected 2 to be 12`，非timeout失败。
- 修改后journal+feedback：21测试通过；既有断言保留。
- 全量`npm run test:unit`：3261 passed / 4既有opt-in skipped；`npm run typecheck`、`npm run build`、`git diff --check`通过。
- `npm run performance:measure`：30 observations，28 candidate unchanged、2 gating pass、3 macOS CPU指令candidate缺失，无worse；上一轮3个收紧基线保持1/0/0。没有升级门禁或放宽。

## 上一轮两个优化的配对计时复测

仍使用冻结于`cafc418`的collector，两个独立Vitest进程顺序运行，比较原始与`7ac7fcb`两个生产路径；脚本退出时恢复候选源码。没有修改workload或缩短负载。journal本身不在这两个场景调用链中。

|固定操作，5个fixture|基线p50|候选p50|
|---|---:|---:|
|五次Pi环境解析，包含首次冷探测|541.87 ms|382.85 ms|
|10000行暖账本，五次performance append+stats|25.17 ms|1.95 ms|

**这些毫秒数是高负载下测得，不可信；L2仍未验证。**

`SCRY_TIMING_RUN`：`label=runtime-evidence-followup`，10核，`loadBefore=10.36`、`loadAfter=9.39`、`highLoad=true`，命令exit=0。正常退出不等于有效收益证明。保留前几次高负载结果，不继续重跑挑选绿样本。

因此本轮确认日志顺序修复与原有L1工作量减少，不宣称12秒目录查询已经解决，也不升级为真实用户L3收益。

## 后续与现场

- 原始失败、通过日志、配对脚本、全部计时样本和性能报告保留在本机`/tmp/scry-perf-followup-results/`，不上传。
- worktree：`/tmp/scry-perf-climb-runtime-evidence-20261016`；无打包、安装、push或合入main，未修改真实userData记录。
- 当前阻碍：缺少机器低负载窗口。需维护者安排/暂停其他重负载工作，再执行一次锁内配对测量；不擅自停止别的进程。
- 下一项授权范围内工作是capability RPC启动/响应/关闭分段，再是turn+session共享after-tree；本轮因持续高负载按skill收尾，不把这两项写成已完成。
