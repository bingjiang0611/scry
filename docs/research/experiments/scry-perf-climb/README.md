# 性能爬坡：真实多仓库工作区上的 recorder + uploader

给执行爬坡的 Agent 看。目标是在一个真实的多仓库工作区上，把同事使用 Scry CLI（recorder）+ uploader 时付出的代价一路降下去，直到证明降不动为止。核验方（另一个 Agent）只看这个分支上推送的东西，所以每个结论都要能从推送的文件里复核。

本目录：`README.md`（本文）、`LEDGER.md`（台账，你维护）、`experiments/`（每个实验一个文件）、`results/`（脱敏后的测量结果）、`allowed-regressions.example.json`。

工具在 `docs/research/experiments/scry-rollout-check/`：

| 工具 | 用途 |
| --- | --- |
| `perf-bench.mjs` | 在工作区副本上测量。阶段：`recorder`（Scry 自己的 hook）、`hookwrap`（uploader 包装后的 hook，同事实际用的组合）、`uploader`（上传排空，假传输层） |
| `ab-session.mjs` | 一次 A/B：基线和候选交替跑（A B B A），每次跑前有负载门槛，最后调用 `perf-ab` 出结论 |
| `perf-ab.mjs` | 判定：计数（L1）任何增加都算变差；耗时（L2）必须超过最小幅度和噪声带才算数；记录内容摘要变了算变差 |
| `perf-compare.mjs` | 同一版本多次运行合成基线（只看稳定性） |
| `fake-transport.mjs` | 假传输层，不联网 |

## 你要降的东西（按优先级）

1. **每轮 hook 等待**（用户每轮都在等）：`hookwrap / daemon fast path / * / wrapped.hookTotalPerTurn`，以及 `wrapped.turnStart`、`wrapped.stop`。CLI 回退模式（daemon 不在）是第二优先级。
2. **每轮 git 调用数**（L1，最稳的证据）：`gitCalls.turnStart`、`gitCalls.stop`。多仓库工作区里每个子仓库都要做快照，这一项会随子仓库数量放大。
3. **uploader 上传成本**：每条记录的传输调用数（`transportRequests`、`capabilityCalls`、`recordsPerRequest`）、积压排空速度、worker 内存、上传目录占用、`notify` 耗时。
4. **资源**：daemon 内存与空闲 CPU、每条记录磁盘占用。

已知线索（容器里 12 个子仓库的合成工作区测得，只作方向）：轮次开始约 32 次 git 调用、结束约 55 次；uploader 包装每轮多约 0.8–1.0 秒，其中 `wakeup` 每次约 180 ms、每轮两次；uploader 每条记录一次请求、每条都查一次能力。以你机器上的实测为准。

## 一次性准备

1. **工作区**：用已经执行过 `init.sh`、子仓库齐全的主检出作为 `--source`。不要改它；所有测量都在副本上。`init.sh` 用普通 clone 拉子仓库，perf-bench 会把子仓库连同各自的 `.git` 一起写时复制，副本里的 git 操作不碰源。不要用 linked worktree 做 `--source`（perf-bench 会拒绝：副本会共享原索引）；没有合适的主检出时，另 `git clone` 一份并执行 `init.sh` 作为源。结果里用别名：`--workload-name rn-shell`，不要写真实仓库名。
2. **协议映射放在仓库外**：把填好真实值的协议文件放到 `$HOME/scry-perf/climb/protocol.json`，所有命令加 `--protocol "$HOME/scry-perf/climb/protocol.json"`。仓库里的 `protocol.json` 保持公开别名，永远不改、不提交。
3. **构建基线二进制**，放到不会被改动的目录：
   - recorder：在 scry 检出（本分支）执行 `npm ci && npm run build:cli`，把整个 `packages/turn-recorder-cli` 复制到 `$HOME/scry-perf/climb/bin/scry-base-<commit>/`，CLI 是其中的 `dist/cli/scry.js`。
   - uploader：用当前发布版本的 `dist/cli.js`，或在私有仓库的发布提交上构建后复制到 `$HOME/scry-perf/climb/bin/uploader-base-<commit>/`。
4. **A/A 校准**（必须）：基线对基线跑一次 `ab-session`（两边用同一套二进制，`--pairs 2 --rounds 7`）。期望结论 `NO CLEAR CHANGE`、计数全部相同、记录摘要一致。把它推送到 `results/aa-<日期>/`。之后每次 A/B 都加 `--calibration <这次 A/A 的 AB-*.json>`：耗时变化必须超过 A/A 里同一指标变化的 2 倍才算数。A/A 出现“变好/变差”，先查原因（负载、缓存、后台进程、电源模式），解决后重跑 A/A，不要开始爬坡。机器状态变了（重启、系统更新、换电源）就重做 A/A。
5. **基线**：A/A 的四份结果用 `perf-compare` 合成，写进 `LEDGER.md` 的“当前基线”。

## 循环（每个假设一轮）

对应四步：想要什么 → 怎么验证 → 给足条件去做 → 找最大阻碍。

1. **选目标**：从 `LEDGER.md` 的机会排名里取“收益 × 置信度 ÷ 成本风险”最大的一项。用仓库技能 `.agents/skills/scry-performance-climb` 的十个视角发散（先读它的 `SKILL.md` 和 `references/climb-playbook.md`）。写下假设：改什么、哪个指标从多少降到多少以内、减少的工作去哪了。
2. **先定验证**：动代码前写明要看的指标和通过线。目标指标没有计数就先补测量：测量改动单独提交，并用 A/A 证明它在旧代码上结果一致，再开始优化。
3. **实现并自查**（都在独立 worktree 里）：
   - recorder：受影响的单测 `npm run test:unit -- <文件>`、`npm run typecheck`；保留的实验再跑一次 `npm run check:cli-release`。改了 `scripts/performance-paths.json` 里 `sources` 列出的文件，跑 `npm run performance:measure`。
   - uploader：私有仓库自己的 `npm run check`；再用 `scry-rollout-check/run.mjs`（加 `--protocol`）跑全部合成场景，必须 0 个 FAIL/ERROR（S15 KNOWN 可接受）。
   - 构建候选二进制到 `$HOME/scry-perf/climb/bin/<名字>-<commit>/`。
4. **测**：

   ```sh
   node ab-session.mjs --source <工作区主检出> --work "$HOME/scry-perf/climb/workload" \
     --workload-name rn-shell --protocol "$HOME/scry-perf/climb/protocol.json" \
     --base-scry <基线 scry.js> --cand-scry <候选 scry.js> \
     --base-uploader <基线 uploader cli.js> --cand-uploader <候选 uploader cli.js> \
     --base-label "base <commit>" --cand-label "cand <commit>" \
     --calibration <A/A 的 AB-*.json> \
     --phases recorder,hookwrap --pairs 2 --rounds 7 --out "$HOME/scry-perf/climb/runs/<实验名>"
   ```

   改 uploader 时把 `uploader` 加进 `--phases`。一次会话约 20–40 分钟，期间不要跑别的重任务。
5. **保留或回退**：同时满足才保留——`perf-ab` 退出码 0；目标指标是“变好”（L1 计数或 L2 耗时）；第 3 步的检查全过；记录摘要 `same`。否则回退代码，实验记录照写（结论“不成立”及原因），这同样是有效产出。
   - 结论是“无明确变化”但计数确实下降：这是 L1 成立、L2 未证实，可以保留，但台账里级别只写 L1。
   - 只差一点没过（变化接近门槛或 p 接近 0.01）：再跑一次 `--pairs 2` 的会话，两次都过才算；不要换参数直到通过。
6. **记录并推送**：每个实验结束（无论成败）提交并推送：代码（recorder 部分）、`experiments/<日期>-<标题>.md`、`results/<实验名>/` 下的 `AB-*.md`、`AB-*.json` 和各次 `baseline-*.json`、更新后的 `LEDGER.md`。
7. **遇到阻碍**：写进 `LEDGER.md` 的“阻碍”，写清需要什么才能继续，然后换下一个机会，不要停下来等。

## 什么时候算“不能再优化”

- **单个目标见顶**：同一目标连续 3 个假设都没有得到 `IMPROVED`；或者做了“下限实验”——单独测出剩余耗时里不可避免的部分（如一次 Node 进程启动、每个子仓库一次必要的 git 调用），证明剩余空间小于 10%。
- **整体结束**：机会排名前 5 项都已见顶、被否决或被阻碍；或达到预算（40 个实验或 16 小时，先到为准）。结束时写 `FINAL.md`：基线 → 最终的对比（用 `perf-ab` 跑“最初基线 vs 最终候选”）、保留的改动清单、证据级别、阻碍清单、建议下一步。

## 预先授权（不用问）

- 在独立 worktree 里改 recorder（本仓库）和 uploader（私有仓库）的代码、本地提交。
- 构建、在 `$HOME/scry-perf/climb/` 下安装候选、跑所有本地测量和测试。
- 推送到本分支 `perf/multi-repo-climb`（只推下面允许的内容）。
- 在 `scry-rollout-check/` 里补测量能力（单独提交，A/A 证明一致）。

## 必须停下记为阻碍的（不能自己做）

- 真实 Provider 调用、真实上传、任何花钱或联网的测量。
- 发布、打包安装到日常环境、改日常 launchd/登记列表、改用户全局配置。
- 推送到别的分支、开 PR、合入 main。
- 放宽：提高门限或基线、删指标、改 `scripts/performance-ratchet.json` 的门禁、加大超时或重试来变绿。
- 改变证据语义：提前提交未收敛的证据、跳过子仓库快照、缓存没有正确失效、把缺失写成 0。记录摘要变化必须当作变差处理。
- 绕过 trust/fingerprint 检查，放宽沙箱。

## 推送内容的规矩（公开仓库）

- 可以推：recorder 代码改动、本目录的文档、`results/` 下的结果文件（`perf-bench` 已把家目录替换成 `~`，仓库名用 `--workload-name` 别名）。
- 不能推：uploader 私有源码或 diff、真实的传输变量名/工具名/包名、`protocol.json` 真实值、工作区里的子仓库名、文件路径、文件内容、任何记录正文。uploader 的改动在私有仓库本地分支提交；实验记录里用中性描述，附私有仓库的提交号、测试结果和测量结果。
- 推送前自查：`git diff --cached | grep -nE '<你的用户名>|<私有包作用域>|<真实传输变量名>'` 应无命中。
- 提交身份用仓库要求的 noreply 身份（见根目录 `CLAUDE.md`）。

## 核验方会检查什么

1. 每个保留的实验：结果文件齐全，用推送的 `baseline-*.json` 重跑 `perf-ab` 得到同样结论；测量改动和优化改动分开提交。
2. 声称的级别属实：计数变好是 L1，受控耗时变好是 L2，不宣称 L3。
3. 记录摘要一致；没有触碰上面“必须停下”的事项。
4. `LEDGER.md` 的基线、排名和阻碍与实验记录一致。

只有在核验不过时才会找你，平时不需要汇报。
