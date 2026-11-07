# PR #31：评审后续

首个远端版本为 `5b0aeb21`。本报告只说明该版本之后的真实发现与最小修正，不覆盖尚未完成的
远端门禁，也不把旧版本检查结果当作最新版本通过。

## 记录提交后的维护失败

`recorder-attention-maintenance.test.ts` 的三个负对照在 `5b0aeb21` 上全部失败：

1. 持有真实 attention 文件锁，使用原有 2 秒等待上限，提交后清理报 ELOCKTIMEOUT。
   记录已持久化，但旧代码让 hook 报错并留下 generation 文件。
2. 当前 generation 留有 pending-open 时，先判断 attention 再删除 runtime 会留下无用标记。
3. 第 64 次周期修复遇到一个 provider 目录 EIO，会阻断已经索引的其他会话 inbox。

修复只隔离可丢弃索引的维护失败：先清理已提交 generation，再尽力清理 marker；周期修复失败时，
仅当之前及失败后都能证明索引已经完整初始化，才继续已有 marker 对应的恢复。初次重建仍失败关闭。
两种维护错误写 WARN，不伪造 droppedEvents；记录、hook 正文和重放规则不变。

## JSON 分片的极低概率 token 碰撞

原来的异常分支在已输出部分 JSON 后再追加完整 stringify，可能发布坏 JSON；与合法 marker
同形的用户值或 key 则会被错误替换。用固定 UUID 的三个负对照都复现了问题。

现在先检查 skeleton 的 token 数量：生成的每个 part 必须恰好贡献两个 token。任何额外 token
都在开始写入前选择完整 stringify。正常路径只多扫描很小的 skeleton，不扫描被移出的巨大正文；
不增加新依赖、不改变格式。删除了会追加第二份文档的旧异常分支。三个测试逐字节对照标准
`JSON.stringify`，覆盖半个 token、同形 value、同形 key，并确认没有临时文件残留。

## 文档修正与接受的限制

- G1 报告标明早期决策与后续 G1-4 / C 实现的区别，G1-3 当前是证据不足而延后。
- L2 表补回 S12 end 的 304.9 / 342.8 → 390.9 / 379.9 ms；不宣称改善，不猜测原因。
- R 报告不再把已实施的 R3 说成未完成。
- 8 KiB 锚点行证明上限保留。超长行回到完整反向扫描，证据不截断；只有真实长行负载证明
  该回退成为主要成本时，才另行测量并考虑分块证明，避免为边缘性能扩大协议。

## 验证

| 检查 | 结果 | 日志 |
|---|---|---|
| 维护失败旧代码负对照 | 3 failed | `/tmp/scry-pr31-maintenance-negative.log` |
| JSON token 旧代码负对照 | 3 failed | `/tmp/scry-pr31-json-negative.log` |
| IO + index/runtime focused | 10 文件 / 50 passed | `/tmp/scry-pr31-final-focused.log` |
| 类型检查、CLI / App 构建 | 通过 | `/tmp/scry-pr31-final-{typecheck,build-cli,build}.log` |
| 正文存储、diff 持久化与未修改的工作量测试 | 3 文件 / 20 passed | `/tmp/scry-pr31-content-counters.log` |
| 最新构建 npm tarball，私有 HOME/state 的真实 CLI / daemon | 全部 smoke 通过，夹具已清理 | `/tmp/scry-pr31-final-package-smoke.log` |

Sol 第四轮批准维护失败隔离，第五轮批准 JSON 修正；没有开放 blocker / should。
复核未代跑上述验证，也没有豁免性能门禁。

最终计数：首次 start 为 14 / 13 / 17（fsync / readdir / readFile），完整首次轮为
46 / 23 / 56。相比第三轮少一次已删除 generation 的无效读取。正常恢复在 0 / 200 / 1000
个已完成目录下仍各为 7 / 14（readdir / readFile），健康读取仍为 4 / 2。相同正文发布和
transcript 扫描计数未变，不从并行验证期间的毫秒推导性能结论。

## 首次远端门禁：保留失败，不猜测归因

`5b0aeb21` 的 Check、Remote Check 通过，包含 unit/coverage、Node 20/22/24 CLI 和 macOS/Linux
打包检查。Performance Check 的 native 比较没有通过：

- run `42198944979`、artifact `13493597033`；原始结果保留在该 GitHub artifact 和
  `/tmp/scry-pr31-native-results/`。主比较 132 个 metric 中 9 个标记 regressed。
- runner 3 核，baseline / candidate / control 的 timing wrapper 均标 `highLoad: true`，
  load 在 20.08–32.26 之间。
- 同一 candidate 产物的重复对照也失败，forward 与 reverse 各 12 个 regressed。
- 两个绝对门限在 baseline 已超线，其他相对项也有反向差异。不能把这些事实解释成已经排除
  产品回归，也不能用同构建波动覆盖主比较失败。

不放宽门槛、不删指标、不缩 workload、不反复重跑求绿。新修复提交仍需正常触发并通过最新 head
的完整 CI；在 Performance Check 通过之前不得合并。
