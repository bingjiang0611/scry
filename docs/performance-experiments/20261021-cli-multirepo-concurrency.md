# 独立 CLI：多仓库采集并发与通知身份调查

> 本文保留离线实验阶段的状态。后续已另获在线授权，桥接修复已合入真实项目，并发现 App / CLI 共用 ACK 导致重复投递；最新处置与验证见[在线调查](20261021-cli-callback-online.md)。

## 交付状态（2026-10-21）

- 授权范围：隔离多仓库受控实验，以及通知身份修复调查。没有修改真实工作区配置、记录、回调或上传；没有启动 Provider。
- 基线源码：`4b624c8a6cac6296c4430bfe72afd27b8468e55c`，独立 worktree，不带主工作区并行 WIP。
- 测量与合同检查：`3f30987`。优化源码：**无**，尚不足以选择生产并发值。
- 构建：`npm run build:cli` 通过；只构建当前源码的测试 CLI，不安装。实际被测模块 SHA-256 见同名 JSON 的 `bundleSha256`。
- 合入 / 安装 / 生效：未合入 main、未安装、未推送；不要求用户重启 App。
- 验证级别：L1 受控峰值并发与工作量观测；**L2 unavailable（持续高负载）**；L3 未验证。
- 日常 baseline→candidate build：没有候选交付物，不能比较优化前后日常收益。

## 日常线索与本轮假设

独立 CLI 0.2.49 的本地快照中，排除明确 `scry_provider_adapter` 来源后，386 轮 / 33 会话通常每轮采集 18–19 个仓库。6,691 份快照中 6,271 份 captured、353 份 timeout、67 份 failed；6,176 份成功快照无变化。1,488 次 full_fallback 中 1,316 次原因为 discovery_failed。原始日常数据只留本机，不进本仓库；此处没有会话内容或工作区路径。

这些记录不是 CLI 端到端计时，且没有系统负载。`captureMs` 是同一仓库轮首与轮尾的采集耗时之和，不能跨仓库相加当用户等待。

**假设**：19 路仓库采集同时启动，造成子进程竞争和 discovery deadline 失败；将调用方限制到 4 路，可能减少 fallback 和峰值进程，但也可能延长轮首等待。1 路作为低并发对照，不能预设更快。

## 固定负载与测量边界

- 19 个隔离真实 Git 仓库，每仓库 512 个 tracked 文件；共 9,728 文件。
- 每个并发值 1 轮 warm-up、4 轮测量。前三轮无变化，第四轮仅一个仓库中的一个文件在 begin 完成后修改。
- 并发值固定 19 / 4 / 1，逐轮轮换执行顺序。19 路直接 `Promise.all`，4/1 路只在实验调用方排队，不修改生产函数。
- 使用生产 `beginGitTurnDiff` / `finishGitTurnDiff`，默认 deadline；保留完整 patch、Git 防执行参数及 cleanup。
- 记录轮首、轮尾 wall time；计数覆盖 `execFile`、`execFileSync`、`exec`、`execSync`、`spawn`、`spawnSync`、`fork`，保留 promisify 行为。
- 敏感性对照：额外真实 Git 子进程计数为 1，峰值为 1。结果断言验证所有仓库成功及唯一预设 patch；不能靠少采集仓库或丢失改动通过。
- 不执行真实 recorder hook：此实验排除了仓库发现、transcript、session 锁、通知和 Provider。这是**采集调度实验**，不是整个独立 CLI 验收。
- 仓库文件规模是固定合成负载，不声称复制了日常各仓库文件大小与脏状态。新方案不得缩小这个负载来替代本次结果。

```bash
npm run build:cli
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs cli-19-repos-concurrency -- \
  node scripts/cli-multirepo-experiment.mjs /absolute/path/concurrency.json
```

## 结果

完整样本见 [JSON](20261021-cli-multirepo-concurrency.json)。每项只有 4 个样本，因此 p95 实际为该组最大值，不代表稳定长尾估计。

| 调度并发 | 峰值子进程 | 每轮 Git 进程数 | fallback 快照数 | 证据断言 |
|---|---:|---|---:|---|
| 19 | 38 | 221 / 190 / 190 / 192 | 16，集中在第一测量轮 | 4/4 通过 |
| 4 | 8 | 190 / 190 / 190 / 192 | 0 | 4/4 通过 |
| 1 | 2 | 190 / 190 / 190 / 192 | 0 | 4/4 通过 |

高负载下的原始毫秒数如下，**不可信，不能据此宣称提速或选择默认并发值**：

| 并发 | 轮首 p50 / p95 ms | 轮尾 p50 / p95 ms | 两阶段相加 p50 / p95 ms |
|---|---|---|---|
| 19 | 431.6 / 1522.6 | 2768.8 / 6647.6 | 3282.4 / 8170.3 |
| 4 | 677.7 / 1943.7 | 2602.0 / 6874.6 | 3279.7 / 7774.3 |
| 1 | 1400.1 / 2244.5 | 9851.1 / 12881.4 | 11239.4 / 15125.9 |

`SCRY_TIMING_RUN`：10 核，loadBefore=75.25，loadAfter=45.48，highLoad=true，wallMs=178672，exit=0。未绕锁、未通过 sleep/retry/延长生产 deadline 寻找更好数字。

**工作去了哪里**：有界调度降低同时在跑的子进程数量，但没有消除正常路径工作：无变化正常轮仍为 190 次 Git。19 路有一轮因 16 份 discovery_failed fallback 额外执行 31 次 Git；4/1 路本次没有该额外工作。这是一次高负载观察，不是已经证实的稳定因果收益。

**结论**：不成立的是“降低并发必然减少正常工作量”的直觉；“4 路能减少负载放大且不损害延迟”仍需低负载 L2。生产保持原样，不 propose、升门禁或新增一个伪稳定的 Git 次数门禁。

## 通知身份：原因已经分层，未操作真实上传

真实集成的定制 shell 在没有继承 hook override 时，自动设置 `SCRY_RECORDER_COMMIT_HOOK`，但没有 fingerprint。Core 将它视为 host-provided，按 `explicit-environment-v1` 查询 ACK；配置路径的 ACK 则绑定实际 bundle fingerprint。

- 快照 ACK 为 81；按配置 fingerprint 尚有 2,100 条，按 host fallback 身份则 ACK 不适用、显示 2,181 条。这里新增的是 **81 条重新具备投递资格**，不是证明所有积压都由身份不一致引起。
- 只读核验当前 7 文件 bundle 的 fingerprint 与快照 ACK fingerprint 相同。未写 grant、未执行回调。
- Core 的显式 host override 优先级是现有合同，不能为了一个项目桥接问题将其改为自动使用仓库配置。
- 最小修复 owner 是该项目集成：删除桥接脚本自行合成的 fallback export，仍保留真正继承的 host override，让独立 CLI 使用现有配置授权路径。
- 已运行 daemon 保留旧环境，改脚本不会自动更新它。切换 daemon 可能触发积压通知及外部上传，必须另获授权；不能静默补发。
- 现存执行器丢弃 stderr，无法从日志复原历史 callback 失败原因。身份修复不等于失败修复，也不等于上传成功。

新增纯临时合同测试证明：配置身份 ACK 1；同路径无 fingerprint 的 host override 得到 ACK null；还原配置身份恢复 ACK 1 且状态文件不变；同一身份下回调 exit 7 仍不推进 ACK；修改 bundle 后旧 ACK 仍不得复用。测试从未调用真实项目脚本或 uploader。

## 项目桥接离线修复（2026-10-21）

用户随后授权独立分支修复，不切换 daemon、不触发补发。`rate-native` 本地提交 `106dc3f8e86b6dd1ee1404c695ca4944719b4edf` 删除了 `scry-recorder.sh` 合成的 host override，保留真正继承的 entry/fingerprint。Scry core、配置、ACK 和现有运行环境未改；该提交没有合入真实工作区或推送，没有实际生效，也不是 L2/L3 性能结果。

- 新增断言先在旧实现上失败，修复后通过。覆盖五 Provider 的普通直连、带/不带 fingerprint 的继承 override、managed、显式空 entry、后台冷回退，以及未绑定 session 不采集。
- 两组原有 fixture 缺少当前必需的 REQ 绑定，先出现 launcher 0 次调用、managed 1 failure/1 error；补齐真实 resolver 和临时绑定，没有绕过生产 gate、删断言或增超时。
- launcher smoke、6 项 managed bridge、2 个 mock subprocess 的 record-commit helper、27 文件 Python 语法、Bash 语法、workflow dry-run 和 147 文件生成一致性通过。
- 较大 sync 门禁的 event-router / telemetry-reliability 共 32 条 failure/error 与干净基线 `5940086c` 完全一致；dual-id 同样在两侧因缺少 `tool-starts.json` 失败。本次未扩大修复。完整 runtime smoke 会启动实际 Provider CLI，未运行；只调用上述两个离线 helper。
- 为遵守离线授权，本地提交仅在该次 Git 命令中禁用了会启动真实 Qoder tracker 的 post-commit hook；没有修改持久 Git 配置或 recorder trust。
- 部署仍需要单独决定：真实工作区集成、现有 daemon 环境切换，以及是否允许处理剩余积压/外部上传。历史 callback 的具体失败原因仍未还原。

## 验证与下一步

- `node --check scripts/cli-multirepo-experiment.mjs`：通过。
- 受控实验：12 个测量轮全部证据断言通过，敏感性对照通过；L2 unavailable。
- `npm run test:unit -- src/core/turn-recorder/commit-hook-grant.test.ts src/core/turn-recorder/recorder.test.ts scripts/performance-ratchet.test.ts`：149/149 通过，无 skip。此前单独 focused 新测试 1 通过、128 因名称过滤未运行；随后整文件补齐。
- `npm run typecheck`、`npm run build:cli`、`git diff --check`：通过。
- 原台账与当前台账 `performance-ratchet.mjs guard`：通过，无变更。没有改生产代码，因此没有运行 full unit、App/UI/发布或安装 gate。
- 后续 owner（性能）：机器低负载且没有其他测速时，按同一负载重测；只有确认轮首/轮尾不回归且 fallback 改善，才考虑最小生产调度变更并运行完整相关验证。
- 后续 owner（项目集成）：离线修复见上节；保持真实环境不变，先处置既有门禁失败与 callback 失败诊断。实际工作区集成、daemon 切换、积压补发及上传需要用户单独决定。
- 对 callback 失败的下一步应是隔离复现或有界失败分类（exit/signal/spawn/input/timeout），不是持久化原始 stderr、无限重试或替用户重放外部操作。
