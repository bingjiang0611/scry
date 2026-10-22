# CLI verify：复用校验读取，只计算身份覆盖

## 结论与范围

`turns verify` 不再第二次读取所有 canonical records，也不再为了 identity 字段生成完整工具、文件、用量和时间线汇总。原有完整性校验、输出结构和退出码保留。

- L1：固定 64 条记录，读取和 JSON parse 均 **128→64**；返回字节 **8,614,000→4,307,000**，减少 50%。这是逻辑读取量，不是物理磁盘 IO 或总 CPU 比例。
- L2：同一固定输入，新启动的真实 Node CLI 进程，p50 **103.264→78.285 ms（−24.19%）**，p95 **106.763→80.276 ms（−24.81%）**。仅代表本次受控、文件缓存已热的场景，不外推到任意规模或日常使用。
- L3 未验证；未合入、推送、发布或安装。两份实际安装 CLI 的 store 模块仍是旧 hash。

提交分开：计数 `aec4a4780398c51471fa17b0e5cb17f6f8e702a5`；实现与六项回归 `2a99eb6db07257833c38e21a4054e0e3bb2e27d9`；追加独立冷进程耗时模式 `1643c233c3cbc1af6b91dcbe794cff6d0fef8d00`。机器可读结果见[实验数据](20261021-cli-verify-once.json)。

## 调用链与最小改动

旧路径：`verifyStore` 扫描 canonical 文件并读入、校验每条记录 → 丢弃记录 → CLI `listRecords` 再读一遍 → `summarizeTurnRecords(...).identity` 只取完整汇总中的身份部分。

新路径：

1. `store.ts::verifyStore` 保持绕过可丢弃索引、扫描 canonical 文件的行为；成功读取后可同步调用 `onRecord`。返回值仍是原来的四个字段。消费者异常在读取错误的 catch 外传播，不能误报成记录损坏。
2. `scry.ts` 的 verify 分支只保存 provider、turnRoleStatus、turnRole、taskLinkStatus，不建立完整记录数组。
3. `turns-summary.ts` 导出现有 `summarizeIdentity`，将输入类型收窄到实际使用的字段；统计逻辑不变。

第二遍读取、解析和无关汇总是真的不做了，没有推迟到后台或换到不计数的接口。没有缓存、持久索引、数据库、常驻进程或新依赖，也不声称峰值内存下降。

语义边界：

- 任何文件读取或 schema 校验失败，identity 仍为 null，完整性失败退出 4。
- 序号缺口等结构错误不抹掉可读取记录的身份统计；identity 和 pending open turns 仍只是 advisory，不决定退出码。
- 空库仍成功，identity 为 null；health 读取失败沿用既有处理。
- identity 来自本次校验实际读取的同一组文件，不再另扫一个可能已变化的集合。仍不承诺跨文件原子快照，也不承诺复现旧版两次扫描之间的竞态结果。
- 不改 ACK、trust、上传、记录格式或数据清理。

## 固定测量与观测有效性

`scripts/cli-verify-experiment.mjs` 创建隔离 Git workspace / HOME，生成 64 条合法 canonical 记录，每条 prompt 为 64 KiB；每条一个 Read 调用，一半有观测到的身份，health 中 pending=2。不开 Provider、上传或自动更新。

默认模式经真实编译后的 CLI dispatch，pass-through 包装实际 `readFile` 和 `JSON.parse`；getter 统计生产代码对 tools envelope 的访问。至少读、解析全部 64 条；读与 parse 次数必须一致；schema 校验必须仍访问每条 tools envelope。避免把绕过观测当成零工作。

| 项 | 基线 | 候选 |
| --- | ---: | ---: |
| canonical readFile 成功返回 | 128 | 64 |
| 返回字节 | 8,614,000 | 4,307,000 |
| 记录 JSON parse | 128 | 64 |
| tools 属性读取 | 1,024 | 64 |
| 完整输出 hash / 退出码 | 相同 / 0 | 相同 / 0 |

剩余 64 次 tools 读取来自必要的 schema 校验，不为数字更小而跳过它。输入生成字节 hash 与完整输出 hash 均相同。新增回归放到旧生产实现后，三项一次读取断言得到 `[2,2]` 而非 `[1,1]`，observer 异常传播用例也失败；另外两项既有语义用例通过。

后续 `--timing` 分支完全不安装这些计数器。每次启动一个新 Node CLI 进程，测到退出和 stdout 收集完成，包含启动、读取、解析、校验及输出；3 次预热文件缓存，随后 9 个样本。每个进程的完整输出必须匹配原始基线 hash。p95 使用 nearest rank，在 9 个样本下即最大值，不把它当成稳定尾延迟门禁。

两侧经 `timing-run.mjs` 串行锁：Node v24.18.0、10 核；baseline load1 前后均 7.35，candidate 均 8.28，均 `highLoad: false`。这不是空载机器。原始样本、产物 hash 和测量元数据保存在机器可读文件；计数与计时没有混跑。追加计时模式后，两侧 L1 的完整结果与计数分别和原始结果相等。

复测命令（在对应版本已构建的隔离工作树执行）：

```sh
npm run build:cli
node scripts/cli-verify-experiment.mjs /tmp/verify-counts.json
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs cli-verify \
  -- node scripts/cli-verify-experiment.mjs /tmp/verify-timing.json --timing
```

原始 L1 baseline 当时 HEAD 为 `b3887b0`，脚本随后原样提交为 `aec4a47`；candidate 采样时 HEAD 为 `aec4a47`、生产优化尚为 dirty，之后提交为 `2a99eb6`。追加计时脚本先在旧生产代码证明原计数不变，再单独提交。L2 baseline 是 `aec4a47` 的生产产物加同一份新脚本；candidate 为 `1643c23`，生产源码仍是 `2a99eb6`。不能只用原始 JSON 的 sourceCommit 推断实际候选，另附源码和三个相关编译模块 hash。

## 正确性与验证

| 检查 | 结果 / 范围 |
| --- | --- |
| 新回归旧实现负对照 | 4 失败、2 通过、36 项未选中；失败为重复读取及缺少 observer 行为，不是语法错误 |
| focused | CLI 42 + summary 17 + credits 3，共 62 项通过 |
| 类型 / 构建 | `npm run typecheck`（Node / Web）、`npm run build:cli` 通过 |
| CLI 分发门禁 | `npm run check:cli-release`：609 项通过；临时安装包 smoke 通过，含通知身份并发与旧游标保护 |
| 全量 unit | `npm run test:unit`：3488 通过、4 项既有 opt-in 跳过；本轮首次全量即通过 |
| 测量脚本 | `node --check`、计数前后对照、两侧真实 CLI 耗时执行通过；追加脚本后 ratchet 10 项通过 |
| 真实旧快照 | 全部 2181 条记录的新旧 CLI 输出字节相等，退出码均为 4，记录文件内容 hash 前后不变 |
| Diff | `git diff --check`；不删断言、不改 timeout、workload 或门限 |

**旧快照不是健康库。** 两侧都报告同样的 120 处 `sequence gap before`，并保留 identity；这里的 120 是缺口报告数，不是丢失记录数。该事实在旧实现已存在。本轮只验证错误没有被隐藏，不补造记录、不改归档状态；缺口来源尚未调查，若要处理，由数据维护者另行授权只读核对历史归档与清理来源。

本轮全量通过不代表前一轮未改动 Git 查询的 timeout 已被根治；本轮没有修改 Git 路径。新增耗时分支不改生产源码，全量 unit 对应的生产内容仍与最终版本相同。

## 交付、证据与后续

仅隔离分支本地提交。临时安装仅限 package smoke 的临时前缀，不是更新日常 CLI。实际两份 CLI 的 store SHA-256 仍为 `3cc4cca17b82613502600d462a1bf7ee65ca9ac92f3beeb312ed96c6590a1e7b`，候选为 `c85580ab4c72e63fdffbd5cc78d0968c41fe9bcb1fa2f036c24ffd203ac1e21a`。App、真实 daemon、记录和队列未改。

私有证据保留在 `/tmp/scry-cli-multirepo.AVEdj0/verify-once/`：baseline / candidate、L1 control、timing JSON 与日志，`real-equivalence.json`、`check-real.mjs`、`negative-control.log`、`cli-release.log`、`full-unit.log`。没有纳入真实正文、记录标识或原始错误明细。临时 baseline 工作树与依赖链接验证后清理；`check-real.mjs` 要重跑时需重建对应 baseline 并编译。

此指标尚未升为 ratchet 门禁，也未验证其他规模、Linux、其他 Node 版本或 L3。性能 owner 后续评估会话选择性读取；若需要持久缓存/索引，先提交方案并取得架构变更授权。此前 Git / summary 的 L2 缺口仍按各自实验记录处理，不能用本次 verify 数据替代。整合、安装和发布仍需用户确认。
