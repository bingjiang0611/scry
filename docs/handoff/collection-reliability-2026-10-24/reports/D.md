# 批次 D：核验与修订

[原批次修改记录](D-initial.md) 原文归档。其 D1 降级规则与手验预期属于历史规格，已由下方用户选定的 VD1 方案 A 及末尾修改记录取代；D2 的已核验结论不变。

## 核验意见（审查方，2026-10-25）

**结论：D2 及两个附项已核验；前置拆分逐声明比对通过，但需要恢复被删掉的注释（VD2）；D1 的语义需要调整（VD1），等用户选定方案。**

### 复跑

- 红测在各自的测试提交上复现：`d1321fe` repository-coverage 3 个失败；`8b82f9c` user-hook-diagnostics、hook-environment、repository-snapshots 共 10 个失败。与报告一致。
- HEAD `9f408fc` 全量（Linux/Node 22）：8 个失败、3965 个通过、5 个跳过。其中 7 个是此前记录的环境失败。新出现的 1 个是 `desktop-client.test.ts > does not evict recorded runs merely to satisfy receipt capacity`：单独重跑 3 次都通过，D 批次没有改动 `src/main`，它只从 `shared/trace` 引入类型。按「首次失败」如实记录，判断为负载下的偶发，不归因到本批。
- Recorder Core 独立性：`src/core/turn-recorder/` 下新拆出的文件没有引入 Electron、SQLite 或 Provider SDK。

### 前置拆分的核验方法与结果

我用 TypeScript AST 把拆分前后的顶层声明逐个按名字比对（去掉 `export` 前缀后归一化空白），测试则按 `describe > it` 的标题比对函数体：

- `recorder.ts`、`scry.ts`、`workspace-init.ts`（`ffbc022`）对比 `1e3c269` 的全部新文件：202 个声明中只有 `parseCodexRollout` 有变化，原因是末尾的 skill 注入循环被抽成 `finalizeCodexTurns`，逐行等价。两个同名的 `hookCommand` 哈希一致。**行为没有变化。**
- `scry.test.ts`（`d1321fe`）对比拆出的 4 个测试文件（`acddcc7`）：41 个测试没有缺失；只有 doctor 健康用例的 checks 列表多了 `repositories.depth`，符合预期。
- `shared/trace.ts`、`turn-record.ts`（`8b82f9c`）对比 7 个文件（`0febe9e`）：136 个声明没有缺失，变化只出现在 D2 的合同、normalizer 和校验里。
- 流程问题（记录，不要求返工）：测试文件拆分混进了 D1 修复提交 `acddcc7`，shared 和 README 的拆分混进了 D2 修复提交 `0febe9e`，红测和修复的边界因此不如前几批清楚。以后拆分请单独提交。

### VD2（必改，小）：恢复拆分时删掉的注释

拆分时删掉了 9 行解释证据来源的注释，而且 `parseCodexRollout` 里出现了缩进错乱。CLAUDE.md 要求注释解释证据来源和失败模式，如果是 20 KB 门禁迫使删注释，应该继续拆文件，而不是删注释：

- `parseCodexRollout`：`turn_context` / `token_count` 是 host-authored 事实；只有一个模型时才归因；每轮重建 `CodexUsageDeltaFilter` 的原因；`last_token_usage` 相邻同值帧必须丢弃，否则会高估。
- `recorder.ts:133`（`ffbc022`）：`// These Provider Stop contracts expose the same-turn continuation flag; do not infer parity.`

用 `git show 1e3c269 | grep -E '^-\s*//'` 与新增注释对比就能找出原文。只恢复注释和缩进，不改代码。

### VD1（需要用户决定）：深度截断几乎让所有 record 都变成 partial

问题出在我写的 D1 规格，执行方是照规格做的。

- `depthLimitedDirectories` 统计的是走到深度边界、没有继续下探的**所有非 Git 目录**，而不是「可能漏掉的仓库」。`init` 默认是 `discover-nested-git`、`maxDepth=2`。
- 探针（临时，已删除）：一个普通的单仓库，只有 `src/features/auth` 这种三层目录，就得到 `{"repositories":[root],"maxDepth":2,"depthLimitedDirectories":1}`。
- 结果是几乎所有工作区（包括没有任何嵌套仓库的单仓库）的每一条 record 的 diff 都会被降为 `partial`，`doctor` 的 `repositories.depth` 也永远是 warn。partial 和 warn 因此不再携带信号，下游分析无法再区分「确实可能漏了仓库」和「只是目录比较深」。

推荐方案（A）：

1. record 的 diff 状态**不再因为 `depthLimitedDirectories > 0` 降级**。`diff.discovery.maxDepth` 和 `depthLimitedDirectories` 照常写入，作为覆盖边界的元数据，供分析侧过滤。`omissionReason` 只在有缺失证据时写。
2. doctor 只有在下一层探测**实际看到 `.git`** 时才 warn，并列出路径。探测不完整但没有发现时保持 pass，detail 写明「下一层探测不完整（32 个目录 / 128 个条目上限）」，不声称已经确认没有。
3. 原有的红测按新语义调整断言，并在提交说明里写明依据：断言改变是因为规格修订，不是为了变绿。新增两个反例测试：普通的深目录单仓库，record 保持 available，doctor pass；`root/a/b/c/.git`，doctor warn 并列出路径，record 带有 discovery 元数据。

另一个选项（B）是保持现状：任何目录深的工作区都会出现 partial 和 warn。

### D2 与附项

接受。同一毫秒内不同仓库的快照不再被合并：去重键加入了仓库身份、scope、baseline 和 status，相同快照重放仍然去重。`requestedRoot` 与 `repoRoot` 分开，Git 没有解析到时不冒充。缺少 discovery 证据时直接省略，不补 0。旧 record 仍能通过校验。用户级 `bridge_not_found` 作为独立 evidence，不计入当前 workspace 的退出码；日志被截断时标 partial 并 warn。`unset SCRY_RECORDER_DAEMON_TRIED` 放在 `set -u` 之后，所有分支之前。

### 状态

D2 → 已核验。D1 → 需修改（VD1 待用户选定方案，另含 VD2）。在此之前不开始 E。

**用户 2026-10-25 选定 VD1 方案 A**（只在发现嵌套仓库时告警）。执行方按上面「推荐方案（A）」的三点实施，并一起完成 VD2。

## VD1 修改记录

基线 `c21a2829`。VD1 方案 A 与 VD2 已完成，交审查方核验；D2 不改回待核验，未开始 E。

### 提交与规格依据

| 提交 | 内容 |
|---|---|
| `76e046d9` | 先提交失败测试；提交正文说明用户选定方案 A，旧 partial/omission 断言因规格修订而改变，不是为变绿 |
| `42a2334a` | 单独修复 VD1；恢复 VD2 注释/缩进及经用户追加授权的最小纯提取；同步 CLI README |

`depthLimitedDirectories` 只证明存在未继续遍历的目录，不证明有漏掉的 Git 仓库或缺失的已请求快照。按用户选择，不再把它直接映射为 diff partial 或 doctor warn。

### VD1 实现

- `src/core/turn-recorder/recorder-turn-finalize.ts` 删除仅因深度边界改 status/quality/omissionReason 的分支。`diff.discovery`、请求清单与 source 仍保留；真实 Git 失败、transcript 缺口、stalled closing 的降级不动。历史 record 不重写。
- `src/cli/doctor-command.ts` 仅在 `nextDepth.repositories` 实际非空时 warn，列出相对路径并提示 maxDepth/exclude。探测不完整但未观察到 `.git` 时 pass，detail 仍写 `next-level probe incomplete (bounded to 32 directories / 128 entries, or unreadable)`；不把 pass 当成“已确认没有更深仓库”。
- 默认 maxDepth=2、上限 5、排除规则、目录符号链接策略、下一层 32/128 探测上限和退出码不变，没有扩大扫描范围或增加扫描次数。
- `packages/turn-recorder-cli/README.md` 已同步新语义：available 表示纳入清单的快照可用，不代表全盘所有仓库都已采集。

### 红测与新反例

`repository-coverage.test.ts` 保留原有范围、exclude、symlink、探测上限与 stalled-closing 检查。旧“深度必然 partial/omission”改为“保留 discovery、正常快照 available/exact、不增加 omissionReason”；stalled closing 仍 unavailable 且保留真实 baseline 原因。测试内和提交正文均注明规格修订依据。

新增两个反例及一个不完整探测控制：

1. 普通单仓库只有 `src/features/auth` 深目录：record available、doctor pass，边界计数仍为 1。
2. 下一层存在 `root/a/b/c/.git`：record available、discovery 保留边界，doctor warn 且路径包含 `a/b/c`。
3. 下一层目录项超限但没有观察到 `.git`：doctor pass，无调整范围的 remediation；detail 明确 incomplete 和 32/128 上限。

修复前实际输出节选（去 ANSI 颜色）：

```text
npm run test:unit -- src/core/turn-recorder/repository-coverage.test.ts

expected 'turn received its terminal event but …' not to contain 'maxDepth=2'
expected { status: 'partial', …(5) } to match object { status: 'available', …(3) }
expected 'partial' to be 'available'
expected 'repository discovery stopped at maxDe…' to be undefined
expected 'warn' to be 'pass'
expected 'review repositories.maxDepth or add i…' to be undefined

Test Files  1 failed (1)
Tests       5 failed | 4 passed (9)
```

日志 `/tmp/scry-VD1-before.log`。测试提交前 typecheck 通过；全量是 **11 failed / 3966 passed / 4 skipped**：上述 5 个新规格失败，以及 6 个原有测试失败，详见下文。没有把其他失败混进 VD1 的证实结论。

### VD2：9 行注释与缩进

按 `ffbc022e` 原文恢复：host-authored turn_context/token_count（3 行）、单模型才能归因（2 行）、每轮重置 delta filter（1 行）、相邻重复 last_token_usage 帧必须丢弃（2 行）、Stop continuation 不推断 Provider parity（1 行）。修正 `parseCodexRollout` 对应四处缩进。

恢复前该文件为 19,951 字节，恢复后会超 20 KB；D 报告当时也有 24,844 字节。执行方先说明约束冲突，用户本轮选择“最小拆分”，未选择临时豁免：

- 将 `patch_apply_end` 的原处理体提取为已有 `recorder-codex-calls.ts` 中的 `appendCodexPatchResult`，调用位置、控制流、字段、参数值与副作用顺序不变；没有新建实现接口或扩大功能。
- 其余 VD2 改动只有原注释和缩进。`recorder-contracts.ts` 的 AST 不变。
- `/tmp/scry-VD2-audit.cjs` 对比测试提交 `76e046d9`：将 helper 体回填到调用点后，去注释、格式归一化的 parseCodexRollout AST 完全相同；已有 Codex helper 声明不变；9 行注释与原文逐字匹配且各出现一次。
- 结果在 `/tmp/scry-VD2-audit.log`：`originalCommentLinesRestored=9`、`rolloutAstIdenticalAfterInlining=true`、`existingCodexHelpersUnchanged=true`、`contractsAstIdentical=true`。
- 拆分后 rollout / calls / contracts 分别为 19,125 / 15,532 / 13,149 字节；正常门禁通过，没有删注释压大小，也没有改 hooks 配置。
- 同一授权下，原 D 修改记录原文移至 [D-initial.md](D-initial.md)，本页保留审查方核验意见并在末尾追加本节；历史报告中的旧 D1 预期不再是当前验收标准。

### 验证

环境仍为 macOS arm64、Node 24.18.0、Vitest 3.2.7；临时 workspace/HOME/XDG，不写日常 `.scry`。CLI 版本仍 0.2.51，未发布或日常安装。

| 检查 | 结果 | 证据 |
|---|---|---|
| VD1 + recorder + 多仓库结果 | 158 passed / 3 文件 | `/tmp/scry-VD1-after.log` |
| 最终 focused（命令见下） | 572 passed / 43 文件 | `/tmp/scry-VD1-focused.log` |
| `npm run typecheck` | node/web 通过 | `/tmp/scry-VD1-typecheck.log` |
| `npm run build:cli` | 通过 | `/tmp/scry-VD1-build.log` |
| `npm run test:shell` | PASS setup-scry-workspace | `/tmp/scry-VD1-shell.log` |
| `npm run smoke:cli-package` | 临时 npm 包的 bin/init/hook/doctor/通知隔离/旧 cursor 全部通过 | `/tmp/scry-VD1-package-smoke.log` |
| 修复提交前 `npm run test:unit` | **3977 passed / 4 skipped**；336 文件通过、4 文件跳过 | `/tmp/scry-VD1-unit.log` |
| `performance:measure -- --scenario source-control.diff --compare c21a2829 --out /tmp/scry-VD1-performance` | ratchet 通过，git/total 子进程均 8→8，无 worse | `/tmp/scry-VD1-performance.log`、对应 measure.json |
| VD2 AST/注释核对 | 通过 | `/tmp/scry-VD2-audit.log` |

```bash
npm run test:unit -- src/core/turn-recorder/*.test.ts src/cli/*.test.ts src/shared/trace.test.ts src/shared/turn-record.test.ts
```

最终 focused 包括原有 Codex 用量、重复帧、模型归因、patch 结果以及 D2 mixed snapshot partial 回归。L1 相邻 diff workload 的 8→8 不证明 Codex 解析速度或冷启动 L2/L3；本轮不宣称变快。

首次全量的 6 个原有失败保留记录：staged-file-size 实际提交 fixture 5 秒超时；git-readonly 两项 5 秒超时；Git racy-clean fixture 得到 timeout 而非 captured；Pi menu-only 两个参数场景得到 false 而非 true。它们在 VD1 生产修复前已经失败，相关文件未修改，未提高超时、skip 或弱化断言；修复提交前的完整全量均已通过。不能把后续通过写成这些原有问题已被本次修复。四个 skip 仍是 performance-correlation、billing-admin-real、P0、P1。

### 当前构建 CLI 的独立读回

`/tmp/scry-VD1-built-probe.mjs` 使用当前构建入口、真实临时 Git 根和目录结构，投递合成 Pi lifecycle，再经 CLI 读取 record 和 doctor。未调用真实 Provider。三个场景均保存一份 record、quality exact、没有 omissionReason、请求目录数 1、深度边界数 1：

| 场景 | diff.status | repositories.depth | 其他读回 |
|---|---|---|---|
| 普通 `src/features/auth` | available | pass | 探测完整 |
| 下一层有 `a/b/c/.git` 标记 | available | warn | detail 包含 `a/b/c` |
| 下一层超过 128 项、未见 `.git` | available | pass | detail 含 incomplete 和 32/128 上限 |

实际输出位于 `/tmp/scry-VD1-built-probe.log`。probe 与临时 npm 安装已清理，包 smoke 原生 stop 后无匹配测试进程；保留 `/tmp` 日志/脚本和忽略的构建产物供核验。

### 用户核验步骤与边界

1. 使用本分支构建 CLI 的绝对路径，不全局安装。按 [USER-VERIFY](../USER-VERIFY.md) 为 OpenCode/Qoder/Codex 分别准备隔离环境和临时 workspace；只有用户确认账号/费用后才运行真实 Provider。本轮没有真实 Provider/设备验收。
2. 先创建普通单仓库和 `src/features/auth`（无嵌套 `.git`），默认 maxDepth=2、diff 开启。完成一次真实 README 改动后，用 `turns show` 与 `doctor` 读回：没有其他缺口时 diff available，discovery 边界数保留，repositories.depth pass。
3. 再在临时 workspace 建立真正的 `a/b/c` 子 Git 仓库，保持 maxDepth=2。新 record 仍可 available，清单不包含深层 c，discovery 边界仍保留；doctor 必须 warn 并列出 `a/b/c`。available 不表示 c 已采到。
4. 显式把 maxDepth 改为 3 后再做一轮，检查新清单才包含 c。历史 record 不回填。不完整探测的无仓库反例可直接复跑 `repository-coverage.test.ts`，不能把 pass 当成对未扫描目录的否定结论。
5. 原 [D-U1～D-U5](D-initial.md#用户验证待用户执行) 的隔离/原生 trust/宽限/日志步骤仍适用，但 D-U2“仅因深度而 partial”及 D-U3“旧 record 仍 partial”的描述已被本次规格取代：旧 record 保持它实际写入时的状态，新 record 按当前规则产生。

本轮没有修改 hook 模板，不新增 repair 要求；更新 CLI 后应重启对应 workspace 的 daemon 以加载新代码。此前 D2 的旧脚本尚未 repair 时，仍须按已核验 D2 流程执行。未改 fsync、trust/fingerprint、并发或扫描默认值。

**下一步由审查方核验 VD1/VD2；真实 Provider 手验由用户执行。D1 改为待核验，D2 保持已核验，不进入 E。**

## VD1 核验意见（审查方，2026-10-26）

**结论：VD1（方案 A）和 VD2 已核验，D1 通过，批次 D 关闭，可以开始 E。**

- 复跑证实：在 `76e046d` 上，repository-coverage 共 5 个失败、4 个通过，失败的是方案 A 的新语义用例和两个反例（普通深目录单仓库应为 available+pass；`root/a/b/c/.git` 应为 doctor warn），以及探测不完整时 pass 的用例。
- 修复后（HEAD `11beb6c`，Linux/Node 22）：`src/core/turn-recorder` 与 `src/cli` 共 549/549 通过；`npm run typecheck` 无错误。
- 代码：`recorder-turn-finalize.ts` 删掉了「截断即降级」的整段逻辑，`diff.discovery` 照常写入；doctor 的 warn 条件和 remediation 都改为 `nextDepth.repositories.length`，detail 里仍然写明截断目录数和探测是否不完整。符合用户选定的方案。
- VD2：9 行注释已恢复，缩进已修正。`patch_apply_end` 分支抽成 `appendCodexPatchResult`，我逐行比对删除与新增的代码（去掉缩进后）完全一致；它用到的 `stringAt`、`outputText`、`stableHash` 在新文件中都有来源，typecheck 通过。
- 原报告归档为 `D-initial.md`，D.md 保留了我的核验意见和用户的选择，并注明 D1 的旧降级规则已被取代，做法合适。
