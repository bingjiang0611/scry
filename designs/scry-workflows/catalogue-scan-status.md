# 性能目录扫描：迁出模块覆盖修复

本项是既有门禁维护，不是性能优化、实验或 M2 功能完成。没有改变 metric、benchmark、workload、budget、ratchet 或操作归属。

## 改动

- `scripts/performance-catalogue.mjs` 负责目录、operation 映射、benchmark 覆盖及源码扫描。递归发现 `src/main/**/*.ts`，排除 `.test.ts` / `.fixture.ts`；每次检查只读取每个生产源码一次。迁出的 conversation/workflow/template/git 注册及以后新增的生产模块均纳入检查。
- 沿用单引号 literal `handleTrusted` / `register` 与 `new PerformanceTrace` 规则；不是 TypeScript 语义分析器。动态 namespace 仍依赖现有 catalogue prefix，不宣称覆盖任意动态拼接或其他字符串写法。
- `scripts/performance-journal-files.mjs` 只持有 journal 文件选择、snapshot、gzip/hash 读取与完整性逻辑。`performance-report.mjs` 保留汇总与 CLI，并维持原公开 exports。
- `performance-paths.json` 补迁出模块的 sources。包括 providers/navigation/history/send/controls/persistence 相关领域；去掉本次引入的重复 sources，不改变其他字段。

当前 report / journal / catalogue 均低于 20000 bytes；report 18336 bytes，保留实际余量，不靠合并语句或删校验过门禁。

## 验证与首败

日志根：`/tmp/scry-workflow-template-editor.ZnkC6L/`。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 提取等价 | 19 个原声明 AST 一致；catalogue 除 sources 外完全一致，无重复 sources | `catalogue-extraction-equivalence.json` |
| focused 回归 | 3 文件、17 测试通过；原 snapshot/gzip/完整性/CLI 断言保留 | `catalogue-canonical-cli-regression.log` |
| 类型 | Node/web 通过 | 同上 |
| 实际 inventory | 原 16 个 path 通过 | 同上 |
| 扫描负控 | 恢复旧入口文件名单后，新回归正确失败；随后恢复当前源码并验证通过 | `catalogue-old-source-negative.log`、`m3-policy-current-counter-gate.log` |
| 既有计数 | workflow.sequence-completion 五样本的 parent publications 均 3；ratchet 通过，collector 8 测试通过 | `m3-policy-current-counters/measure.json` |

新 CLI 回归在临时合成仓库中逐一加入未分类的 moved-module channel、新生产模块 channel 与 trace，要求实际 CLI 非零退出。healthy 正控还解析并核对完整 inventory JSON，不能只凭进程 exit0。

首轮候选 report 超过 20000 bytes，并有语句粘连的 parse failure；父会话增加 catalogue 职责拆分、修复语法，恢复 worker 未经要求改变的 observations/summarizeBaseline/summarize 及 PATH_IDS，使原聚合声明保持 AST 等价。日志 `catalogue-source-first-parent-gate.log` 和 `catalogue-unaccepted-report.diff` 保留。

随后新 fixture 暴露 macOS `/var` 与 canonical `/private/var` 差异：CLI main guard 未执行时也会 exit0。已 canonicalize fixture root，并加入 JSON 正控；保留 `catalogue-source-preserved-parent-gate.log`、`catalogue-fixture-failure-detail.log`。未放宽原断言、deadline 或 metric。

## 未关闭的事项

- 计数结果只证明原 workload 没有新增 parent publication；不是毫秒提速或真实日常性能结论。没有新增 profiler、cache、worker、场景或实验。
- `providers.catalog` collector 仍 unavailable；没有伪造零值。历史默认完整单测的 SystemStep 5000ms 失败与完整 release gates 未关闭。
- M2 TaskSubmission、入口 policy/routing/authoring 和必要的 App 领域拆分仍待实现；`index.ts` 仍超过 authored blob 上限。
- 没有真实 SDK/账号/Jev/费用验证，没有 commit、push、安装、版本更新或日常 App 重启。

由父会话继续 M2 生产入口与职责拆分。本项不借 Goal mode 增加权限，也不把 worker 的完成消息当验收。

冻结 checkpoint：`/Users/baobingjiang/.local/state/rotom/verification-evidence/workflow-catalogue-scan._b5_fxnt`。保存当前源码、旧聚合 AST 对照、首败与负控、既有 counter 报告及产物 hash；前一个策略 checkpoint 不变。Checksum 不是签名，合成现场不是可恢复执行权限。
