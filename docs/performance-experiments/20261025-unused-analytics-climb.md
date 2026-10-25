# 2026-10-25：取消无人消费的自动统计查询

## 结论与机会日志

首轮完成 **L1 工作量下降**；L2 因两侧 `highLoad=true` 未验证，不宣称日常界面已加速。仅停止全局 hook 的无消费者自动查询，保留显式 API、现有 props 和已打开分析页的数据刷新。

这也是本轮机会日志：先删除没有消费者的工作，再讨论增量统计和worker。Pi 常驻目录被此前的完整刷新边界实验阻塞，不重复已否证方案；证据写入、历史索引、客户端增量仍按[执行计划](../performance-climb-plan-20261025.md)推进。根机会日志已超过完整文件大小门禁，本次不为追加一条记录扩大重构；新进展记录在此和执行计划。

## 源码与构建身份

| 项目 | 身份/状态 |
|---|---|
| 冻结起点 | `d822f840`，独立分支 `perf/evidence-climb-20261025` |
| 计划 | `7787c78a` |
| 冻结测量 | `cd40ee06`；复用历史 `436d63d` 的固定负载，不改小负载 |
| 台账按领域拆分 | `138b4217`；49项定义/数值深比较一致，含本轮新增3项candidate |
| hook 按职责拆分 | `3afb730f`；六组计数与拆分前完全相同 |
| 优化 | `a50bfad9`；复用历史 `9471221` 的删除无消费者查询思路，不冒充全新发现 |
| 当前源码构建 | App包版本仍0.2.221；build `5eb0dac42984426298236612c239df97c0e4c3aaaaf582576882fa3a704147ca`，未安装 |
| 日常记录基线 | 已安装0.2.223，build `2d6b6d7e0d9dba6cce72d3fbc23f842c1a99e726ff793e3be6578eddbfe5a56a`；不是受控A/B的baseline App |
| 受控baseline→candidate | `cd40ee06`生产源码→`a50bfad9`生产源码；没有单独构建baseline App，不做整App A/B毫秒宣称 |
| 交付 | 本地提交；未合入、未push、未打包安装；用户运行实例未重启 |

构建发生在优化提交前，构建后的生产源码未再改变。产物ID与安装包版本分开记录，不能以0.2.221/0.2.223判断哪份源码更新。后续合入应基于当前交付分支重新验证，不直接安装这个实验分支来覆盖日常App。

## 为什么先做结构拆分

提交门禁限制每个完整暂存文件20,000 bytes，不豁免既有大文件。用户明确选择按职责拆分，不绕过门禁。

- 台账入口保留为 `scripts/performance-ratchet.json`，定义迁入 `scripts/performance-ratchet/{analytics,providers,source-control,data-flow}.json`。`performance-ledger.mjs`负责合并/写回；旧单文件baseline仍可读取。CLI、比较时冻结harness、自动收紧CI一并更新。
- `useIntegrations`拆出运行控制/能力派生、MCP、指标/工作区、会话模型；原公共导出保留。涉及文案集中到`constants/integration-copy.ts`。
- 旧integration测试按职责拆成6套。32个测试声明的AST与拆分前逐条一致，展开后38个用例；没有删断言。
- 最初尝试拆分大组件/渲染测试未完成，并造成语法错误。已撤回该部分自有改动，没有带入提交。最终保持`App.tsx`、`RemoteChat.tsx`、`OverviewPanel.tsx`及`render.test.tsx`原样，只拆真正需要修改的文件。
- 拆分自审修正了缺失导出、未用导入和analytics活动状态闭包问题。后续native回归明确覆盖“先打开分析，再接收dataUpdated”。这些失败不是原有失败，均在提交前修正。

结构拆分不算性能收益；它的六组工作计数与原实现完全一致。

## 单假设与结果

假设：`dataUpdated`和启动定时器不应读取无人消费的全局stats/billing投影。删除自动触发后，不影响显式查询、已打开的范围分析或工作区diff。

固定负载：`span-results=240;tools=240;data-updates=5;analytics-active=0;invalidate-per-update=1`。真实临时SQLite，Electron ABI；每侧5次独立重复。没有减少seed、改缓存失效或把工作移到计时外。

| 指标 | before，5/5相同 | after，5/5相同 |
|---|---:|---:|
| `refresh.stats.calls` | 5 | 0 |
| `refresh.billing.calls` | 5 | 0 |
| `sqlite.queries` | 130 | 0 |
| 相邻cold stats：prepare/queries/exec | 11 / 11 / 0 | 11 / 11 / 0 |

**减少的工作去了哪里：确实不执行了。** 没有新增缓存、预热、worker、后台补算；原显式API与props未删除，也未拿旧数据当新结果。统计页本来的`usageAnalytics`调用继续运行。

### L2：尝试过，但不可信

`timing-run.mjs`记录：10核，before负载44.48→45.08、after19.95→19.95，均`highLoad=true`。5次完整refresh body的原始耗时：

- before：33.089、19.584、19.450、18.927、20.255ms。
- after：0.017584、0.003292、0.004626、0.001334、0.001291ms。

这些数字只保留为高负载原始记录，不计算提速倍数，不当作有效L2。后续全量检查期间负载又达到30–38；本轮不继续第二个优化实验、不反复测速挑样本。

## 回归证明与验证

| 检查 | 实际结果 |
|---|---|
| 新unit负对照 | 旧实现确实失败：未打开分析时stats spy被调用1次 |
| 新native负对照 | 旧实现确实失败：`stats=1,billing=1,analytics=2` |
| 当前native回归 | 坐标点击先打开分析，再发送dataUpdated：`stats=0,billing=0,analytics=2`；不是只测纯helper |
| 当前focused | 9文件、60用例通过，含integration、ledger、ratchet、真实比较工作树清理 |
| 类型/构建 | `npm run typecheck`、`npm run build`通过 |
| UI验收 | 原`test:renderer:ui`串在外层300s中断前产生20段完成结果；剩余第20–26段单独续跑全部exit 0。记录原超时，不称单串命令成功 |
| 当前真实App | UI后段包括production App + 临时真实Git、conversation ownership真实IPC、unified conversation UI/IPC与Pi历史恢复；离线受控Provider/临时userData，无真实付费调用 |
| 台账 | scoped `performance:measure`双侧通过；三个candidate基线5/5/130→0；完整`guard`通过，未升门禁、未放宽其它项 |
| 大小/差异 | 正常pre-commit门禁通过；最终diff检查通过；未改CLI/core/Git生产路径 |

`npm run test:unit`全量尝试未完成，不能标绿：

1. 首轮300s外层超时前，174文件给出结果，含2个既有CLI失败。
2. 带JSON报告的第二次在900s外层超时，未生成最终报告。
3. 对未给出结果的157文件单独执行：153通过、4默认关闭的探针跳过（1111通过、4跳过）；没有新增skip。
4. 增加只读进度reporter定位组合运行：240s中断时pending为`performance-baseline.test.ts`、`git-terminal-pair.test.ts`；同轮subprocess collector有失败标记但未拿到最终断言。它们在首轮曾完成。组合问题未定因，不能简单归为机器负载，更不能把分段覆盖冒充单次全量通过。
5. 本次生产变化没有进入上述Git/CLI路径；但合入前仍需在低负载下完成同版本全量验证。

两个明确的既有CLI失败，在未改动路径上focused复现：

- `hook-fallback.test.ts`：stale socket rc=7仍进入queue-only，直接处理/启动daemon断言失败。
- `hook-socket-path.test.ts`：生成shell缺少`-O`socket owner检查。

这些用例已存在于冻结起点`d822f840`；原工作区正有相关CLI WIP。本分支不擅自修复或削弱断言，待对应修复合入后重新验证。

## 可复现命令与产物

工作区：`/private/tmp/scry-performance-climb-20261025.yjlnNW/source`。结果目录为同级`results/`，包含before/structure/after计数、timing、`analytics-compare/measure.json`、guard输入、unit/UI日志和退出记录。未提交日常会话内容。

```sh
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs analytics-unused-after -- \
  node scripts/performance-counters.mjs collect ../results/analytics-after.json analytics.data-updated
npm run performance:measure -- --scenario analytics.data-updated --compare cd40ee06 --out ../results/analytics-compare
node scripts/session-capability-ui-smoke.mjs --workspace-diff-only
npm run typecheck
npm run build
npm run test:unit
npm run test:renderer:ui
```

收紧使用现有`makeProposal`的`ledgerPath`参数只写analytics领域，避免把未修改Git领域的新数值顺带纳入：

```js
makeProposal('../results/analytics-after.json', {
  write: true,
  ledgerPath: 'scripts/performance-ratchet/analytics.json'
})
```

此前直接对部分观测运行全台账`performance:propose`会因缺少Git门禁证据拒绝，未被绕过。领域提案之后仍对完整展开台账运行`guard`。所有已有门禁保持不变。

## 下一步与责任

- agent：在负载合适时，先完成同版本全量unit与有效L2；若组合阻塞仍在，沿进度定位的Git基准/终态fixture继续诊断，不增加测试超时。
- CLI修复所有者：完成冻结起点已知的两项socket修复；本分支合入时重新验证。
- agent：前置验证收敛后，再执行计划中的证据写入窄切片。此轮不再开始新实验。
- 用户：只有合入/push/安装和后续L3正常使用需要另行决定；本轮没有请求或执行这些外部动作。
