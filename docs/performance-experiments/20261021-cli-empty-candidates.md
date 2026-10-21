# 独立 CLI：零候选快照复用（2026-10-21）

## 结论与交付状态

**L1 成立：固定 19 仓库负载中，无变化轮的 Git 子进程由 190 降到 114（−40%）；一个仓库发生改动的轮次由 192 降到 120（−37.5%）。全部证据断言通过。L2 unavailable：两次测速均为高负载；L3 未验证。**

- 基线源码：`3cdf6d78d0f98d650eac31de1f1d1965b5766df3`。
- 优化源码：`9391016476f24a41f1e16498f7a0c132a238d799`，仅 `src/core/turn-recorder/git.ts` 与 `src/main/git.test.ts`。
- 构建：`npm run build:cli`，仅隔离测试构建，未升版本。开发包仍标 0.2.50，不能凭版本号判断是否包含本轮优化。
- 基线 Git 模块 SHA-256：`5cf99846159a6db7442fc5ada45ec0b654f66871773bacb2ae8139f1852e1b0b`。
- 候选 Git 模块 SHA-256：`3ee2e35a578f5c7880cf3deee44c7acbb9966a79f4ade6bce6489b5ead7270b9`。
- 合入 / 安装 / 发布：仅本地隔离分支提交，未合入主工作区、未安装、未推送、未发布 npm、未操作 App。两个实际独立 CLI 安装中的 Git 模块仍与本轮基线 hash 相同；上一轮 ACK 隔离已经部署，不代表本轮采集优化已生效。
- 日常 baseline→candidate：候选未部署，没有日常对照，不声称用户实际变快。

## 依据、假设与取舍

前一轮[并发实验](20261021-cli-multirepo-concurrency.md)表明：限制并发可以降低峰值进程数，但正常无变化轮仍需 190 次 Git。已有日常样本的成功快照约 98.5% 没有文件变化，值得先删除这一分支的冗余工作，而不是继续凭高负载时长选择并发值。

**假设**：成功完成 Git 候选发现后，如果作用域内候选数为零，就可以直接复用不可变的 beforeTree 和已刷新 discovery index，不必再 read-tree、write-tree，然后 diff 同一内容两次。每个无变化仓库少四次 Git，19 仓库应少 76 次。

| 视角 | 想法与本轮决定 |
| --- | --- |
| 根本不做 | 不重新构造并比较同一快照；选中 |
| 只做一次 | 同一次采集复用已完成发现的 index；选中，不增加跨轮缓存 |
| 提前做 | 预热 Git 进程或预建基线需额外授权与时点正确性验证；暂缓 |
| 推迟做 | 不能在 diff 收敛前提交正式记录；不采用 |
| 换地方做 | worker 不会消除这些 Git 工作，还增加边界；暂缓 |
| 做得更便宜 | 将 changed 分支的 numstat/name-status 合成一次输出可另测；本轮不改解析合同 |
| 少做几次 | 有界调度仍缺可靠 L2；不改生产并发 |
| 先显示 | 进度展示不能替代证据，本次不改 UI |
| 换算法 | 历史查询/汇总的索引与分组仍是独立机会，本轮不夹带 |
| 换架构 | 文件监听、跨仓库服务需授权和失效合同；本轮不用 |

排序：零候选冗余消除有直接调用链依据、局部改动面和固定计数验证，优先于收益仍不确定的并发调度；更复杂的持久缓存和常驻服务暂缓。尚未覆盖 CLI 启动、仓库发现、transcript、通知、不同文件规模与日常机器负载。

## 实现边界

- 仍执行配置重扫、隔离 index 的 read-tree reset、really-refresh、完整作用域 Git status；不是因为工具路径为空就认定没有改动。
- 只有发现成功、没有 fallback、候选确为零时复用基线。新一轮 preview/finish 仍重新发现，不缓存“无变化”。
- 保留 discovery index 的现有生命周期；即使 turn 没有改动，也先发布共享 after-view，再跳过相同对象的比较。较早 session baseline 仍可看到已经提交的会话累计改动。
- 有候选、Git 语义文件变化、发现失败、超时、强制 full 等路径的采集与回退合同不变。任何合法路径得到相同不可变对象时都无需再做 diff。仓库范围、过滤器禁用、真实 index 不写入、完整 patch 和 deadline 均未放宽。
- **减少的工作是真的不再执行**：每个零候选仓库少一次重复 read-tree、一次 write-tree、两次 diff；没有移到后台、后续查询或计数器看不到的调用方式。

## 固定测量与结果

沿用既有 `scripts/cli-multirepo-experiment.mjs`，没有改测量代码或 workload。驱动脚本 SHA-256 为 `26f75a54444ba912eea7563141c03251641fff09784ae059ae17b02e07c5d0b6`，与基线逐字节相同。

19 个真实临时 Git 仓库，每仓库 512 个 tracked 文件；19 / 4 / 1 路调度各一轮 warm-up、四轮测量，第四轮只改一个仓库中的一个文件。每个版本 12 轮断言全部通过；唯一改动及完整 patch 均存在。额外注入一个真实 Git 子进程的敏感性检查在两边均为 1。

| 指标 | 基线 | 候选 |
| --- | --- | --- |
| 每个调度组前三个无变化轮 Git 次数 | 190 / 190 / 190 | 114 / 114 / 114 |
| 每个调度组第四轮 Git 次数 | 192 | 120 |
| 19 / 4 / 1 路峰值子进程 | 38 / 8 / 2 | 38 / 8 / 2 |
| fallback | 0 | 0 |
| 证据断言 | 12/12 + warm-up 通过 | 12/12 + warm-up 通过 |

毫秒仍按原脚本记录，以下是**高负载原始值，不是可信提速结论**：

| 调度 | 基线总采集 p50 / p95 ms | 候选总采集 p50 / p95 ms |
| --- | --- | --- |
| 19 | 2694.6 / 3286.8 | 1798.6 / 2137.1 |
| 4 | 5411.3 / 8678.6 | 2486.3 / 4009.4 |
| 1 | 19936.3 / 25407.5 | 7382.8 / 15781.9 |

两次均经 timing-run 主机锁串行运行，Node 24.18.0、macOS arm64、10 核：基线 loadBefore/After 166.67/162.68，候选 60.04/57.89，均 highLoad=true。全量验证完成后复核负载仍为 24.12，高于 10 核阈值，按技能收尾条件停止本轮测速，不循环重跑碰运气。

完整原始样本及源码/产物映射见 [JSON](20261021-cli-empty-candidates.json)。候选测量时尚未提交，原始 sourceCommit 记录 checkout 父提交；外层 candidateSourceCommit 和模块/source hash 标明之后提交的确切代码，不能把两个原始 sourceCommit 相同误读为同一模块。

```bash
npm run build:cli
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs cli-empty-candidates -- \
  node scripts/cli-multirepo-experiment.mjs /absolute/path/result.json
```

## 验证、首次失败与限制

| 检查 | 结果 |
| --- | --- |
| `test:unit -- src/main/git.test.ts src/main/session-diff.test.ts` | 83 通过 |
| recorder / managed / change-journal focused | 187 通过 |
| `npm run typecheck` | Node、web 均通过 |
| `npm run build:cli` | 通过 |
| `npm run test:unit` | 283 文件通过；3480 项通过，4 个既有 opt-in 跳过，无失败 |
| `performance:measure -- --scenario source-control.diff --out …` | 6 个 collector 测试通过；5 次 Git / total 均 8，ratchet 通过 |
| `performance:measure -- --scenario source-control.terminal-pair --out …` | 5000 文件、不同脏基线的共享终点场景：5 次 Git / total 均 17、write-tree 均 1，ratchet 通过 |
| `git diff --check` | 通过 |

新增回归检查真实无变化 preview 后的 tracked/untracked 写入、真实 index 不变，以及零候选 turn 与较早 session 的共享终点和清理。故意丢弃 Git status 候选的负对照使第一项失败（应有 2 个候选却得到 0）；恢复后通过。旧实现本身通过这两个功能场景，性能差别由冻结的 19 仓库测量独立证明。

首次新 fixture 有一处错误：cleanup 会清空 capture.tempDir，测试却在清理后取这个字段。改为清理前保存路径，仍检查实际目录已删除，没有删断言。首次 performance:measure 使用了不存在的 `--output`，解析阶段拒绝、未执行采集；读取参数合同后改为 `--out`。未加 sleep、重试、扩大测试 timeout 或弱化结果来变绿。

上一轮 ACK 交付记录中有 7 项全量失败；本轮首次全量执行全部通过，但没有修改那些 Provider 测试/实现，也不声称其不稳定根因已经解决。

现有 source-control.diff 门禁的固定负载不是这个 19 仓库零候选场景，数值仍为 8；不替换旧 workload、不放宽台账、不把实验升为门禁。没有可收紧的现有指标，因此没有 propose 变更。

## 下一步与 owner

- 性能 owner：机器低负载时，对同一 baseline/candidate 和完整固定 workload 做锁内 L2 对照；不要仅重跑候选，或拿本轮高负载基线作速度对照。
- 发布 owner：确认部署/发布范围后，再决定合入、版本号和 CLI 分发门禁。本次不安装、不合入、不发布；App 无需因本轮本地实验重启。
- 下一批代码机会是历史读取和汇总放大，本轮尚未实施。新指标升级门禁仍需稳定、敏感、相关证据与维护者确认。

本机测试日志和原始输入保留在 `/tmp/scry-cli-multirepo.AVEdj0/empty-candidates/`；实验临时 Git 仓库已自动清理，未操作真实 `rate-native` 记录、上传队列或 daemon。
