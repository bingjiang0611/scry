# 终态逐轮 / 会话净 diff 共享不可变 after-tree

## 当前交付状态（2026-10-17，已安装并核对运行身份）

- 优化源码 `aff6006` 已随 `89e4465` 合入 main。安装包冻结源码为 `313f451`（base `2adcfdb`），不含构建期间稍后合入的 `2405d92`；main 的该并行改动仍保留。
- 本机安装：App **0.2.197**、CLI **0.2.49**，完整 build ID `5ef349e1d00e156fdcbedff0e1705e039b0969a23f8c7a77da38418482d4bf44`。通过标准 `scripts/install-macos.mjs` 于 **2026-10-17T12:39:42.021Z** 安装到 `/Applications/Scry.app`；目标版本、asar/可执行文件 SHA 与冻结产物一致，深度签名通过。旧版保留在 `/Applications/.Scry.app.backup`。
- 实际运行：新 PID **35636**、真实 userData 的 packaged 日志匹配上述版本/build；首条证据 **2026-10-17T12:39:42.982Z**。安装后快照解析 82713 条、无格式/清单哈希问题；其中新 build 有 659 条、1 个会话。这只证明启动身份，不能将条数当成完成业务场景或 L3 样本数。
- 构建/安装证据：`/tmp/scry-install-performance.ROQOkg/{handoff-receipt,runtime-verification,install-identity}.json` 与同目录日志。冻结包 typecheck、3331 unit（4既有 opt-in skipped）、shell、587 CLI release、packaged check 与全部 packaged smoke 通过。首次新包 CLI 的 SIGKILL 保留在 `pack.log`；原生诊断成功后，同一未改动包通过后续门禁，未改变安全策略。正常退出宿主会中断自身 Pi，故改用独立的一次性安装任务；任务完成后已卸载。
- 验证级别：下文 L1/L2 保留原实验源码归属，未冒充本次构建的毫秒收益。当前运行 build 已确认；日常对照 baseline、同场景 ≥30 样本/≥2 会话与 L3 仍待验证。安装前后日志快照仅本地保留；详见[机会日志](../performance-opportunities.md)。


## 结论与范围

- **L1 已证明**：5000 个 tracked 文件、不同脏基线，终态 Git 子进程 **24→17**，`write-tree` **2→1**，每侧五轮一致。
- **离线 L2 已证明**：mac2 最终同组比较，总收口中位数 **777.59→540.32 ms（降低 30.5%）**。首个 turn Promise 就绪 **424.14→423.90 ms**，视为不变，不宣称屏幕绘制更快。
- **真实 App 功能路径已验证**：隐藏 Electron 的生产 main/preload/renderer，离线受控 Provider。独立读取归档，验证 **7 对共享快照，其中 3 对含文件改动**；UI/IPC 流程、两次重启及 identity 变化检查通过。
- **不是两套架构已交付，也不是 L3**。没有真实账号/Provider、安装、合入、推送或发布；没有证明真实 12 秒能力目录问题已解决。

源码：冻结接缝及计数 `7ad8957`，全字节 verifier 的 V2 测量 `67a8252`，生产 `aff6006`。测量 fixture 的异步等待修正单独提交 `8987f46`。原始样本、源码 SHA、构建产物 SHA 见 [JSON](20261017-terminal-shared-after.json)。构建时源码尚未提交；SHA 与最终生产提交一致，不改写旧的构建 revision。

## 假设与实现

原先 turn 和 session 分别采集当前工作区，再对各自的 before-tree 投影。两个起点不能合并，但兼容范围可以共用一个不可变终点。

```text
turn before ─────────┐
                     ├── 同一个 after-tree ── 两份独立的文件 / patch 结果
session before ──────┘

turn 完成 → 释放自身引用 → turn Promise 可用
                               ↓
                       session 仍持有源对象
                               ↓
                       session 投影 + 最后清理 → 整体完成
```

- 仅 ready、相同 canonical repo/scope、等效 pathspec/exclusion 集合共享。其他情况仍独立采集，不把 turn-only 路径提示当作 session 覆盖。
- 共同采集覆盖两个调用方的结构化提示，并遵从较强的 full-snapshot 请求。两份投影保留各自的 before-tree、patch policy、baseline 来源与失败状态。
- session 以自己的 object store 为 primary，用临时只读 alternates 访问源 after objects。不会把临时依赖写回 baseline。下一轮重新采集工作区。
- 私有的双引用持有覆盖完整源目录，包括 clone 新生成的 objects、index、父基线引用。turn 的 `cleanup: ok` 表示其引用已释放；物理目录由最后的 session 持有者清理，清理失败明确记在 session 快照。
- 原子预留两个 capture 的操作队列；cancel 也进入队列。turn 立即取得 terminal ownership，旧 preview 不会越过封口。main 原有 `sealAll` / `idle`、turn→session 发布和 canonical archive 收敛顺序保留。
- 物理清理没有移到整体返回后；最后清理耗时也计入 session `captureMs`。确定性时钟回归证明这 13ms 不会从诊断中消失。
- `collection.sharedAfter: 'turn'` 表示候选数/采集阶段耗时来自同一 `afterAt` 的 turn 采集，不是另一次扫描。现有 strategy/evidence 枚举不改，normalizer 保留来源标记。
- filter/hook 禁用仍在共同采集前重新加载。没有新 IPC、持久缓存、依赖或权限能力；recorder core 仍只依赖平台标准能力。

## 固定负载与可证伪条件

负载标签：`tracked-files=5000;dirty-distinct-anchors=2;turn-paths=4;session-paths=2`。

建立真实 Git 仓库，保留会话前用户脏改动；在 turn 前制造另一锚点。终态含修改、删除、新建以及把上一轮内容恢复到原值。分别核对 turn 的 4 个路径和 session 的 2 个路径、patch 内容、完整真实 index 字节、源目录删除及 session baseline 存活。

旧的 8 / 11 Git 门禁负载与断言不变。新场景没有替换 `source-control.service.status-diff`；后者仍未覆盖真实 `Service.diff` 的两次 revision 校验。

V1 使用断言框架对 index Buffer 做逐字节对象比较，把约数百毫秒校验开销计入总时长。V2 改用 `Buffer.equals`，仍比较所有字节。修改先单独提交，并在旧生产代码上重跑：**全部 7 个原始计数序列一致**。仅比较同版本 verifier 的前后数据，不用 V1→V2 差值冒充产品收益。

## mac2 测量

Apple M1、8 核、Darwin 25.3.0、Node 24.18.0、Git 2.50.1。同机、同 dependency installation / lockfile / collector。每侧 5 个独立仓库，baseline→candidate 串行；全样本保留，无失败重试或挑选 warmup。

最终通过 `timing-run.mjs mac2-terminal-pair-final` 加锁。负载 **2.89→5.02 / 8 核**，`highLoad=false`，不是完全空闲机器。仅对下面这个受控服务级路径作 L2 结论。

| 项目 | baseline | candidate | 判断 |
|---|---:|---:|---|
| Git 子进程 / 整体子进程 | 24 / 24 | 17 / 17 | 各减 7，五轮稳定 |
| after-tree 写树 | 2 | 1 | 只采一次共同终点 |
| 总完成 p50 | 777.59 ms | 540.32 ms | -237.27 ms / -30.5% |
| 首个 turn Promise p50 | 424.14 ms | 423.90 ms | 不变；不作微小改善结论 |

时窗从终态 pair 调用开始，到两份投影、最后清理以及内容/index/存活断言完成；不含初始基线建立和仓库造数。减少的是第二次 config/status/定向 add/write-tree 等工作，不是把清理或验证移出时窗。它不等于完整模型轮次、屏幕出现 diff 的时间或日常 p95。

### 保留的失败与中间结果

1. 首版按词法作用域同时等待两份投影再释放源。V1 总完成 1211.57→885.12ms，但首个 turn 422.13→456.54ms，**晚 34.41ms**。用户明确选择继续消除首次延迟；这版被拒绝，不用总收益抵消首次回归。
2. 引用持有版 V2 初次为 803.99→545.20ms，首个 turn 442.75→428.17ms。自审随后补齐清理的诊断计时与确定性回归，再对最终源码重测，使用上表最终组；中间样本仍在 JSON。
3. mac2 首次全量：3273 断言通过，但有一个 `[vitest-worker]: Timeout calling onTaskUpdate`，**exit 1，不能算通过**。测量比较测试同步运行 CLI 60184ms，阻塞 worker 处理 RPC。改为 `await execFile`，保留同一 argv、完整 collector、全部断言和原 120000ms 上限。修正后全量 3273/4 通过；新增清理计时回归后的最终结果为 3274/4 通过。不追认此前本机旧 worker 失败的完整归因。
4. mac2 初始准备在 `git check-ignore node_modules` 停止：目录模式不匹配 symlink，尚未执行测试。只给隔离仓库的 `.git/info/exclude` 增加该 symlink 后建立 snapshot HEAD；没有改变测试范围。
5. 一次性 App 归档检查器前两次误用 `type` / `kind`，而事件实际以 `stage` 区分 diff，读出断言失败。核对生产 schema 后改为 `stage`，保留失败日志；生产代码未因此修改。修正后及最终构建重放均通过。

## 实际验证

| 检查 | 结果与覆盖 |
|---|---|
| `npm run test:unit -- src/main/git-terminal-pair.test.ts` | 最终 10 通过：阻塞 peer 时 turn 已可用、源对象存活、cancel、外部写入/下一轮更新、clone、scope/exclusion、双向失败、patch policy、filter/hook、共同超时、清理失败及清理计时 |
| 首版实现负对照 | 阻塞 peer 时 `turnSeen === true` 确定性失败；不是靠 sleep 或扩大 timeout |
| mac2 `npm run test:unit` | 最终 268 文件通过，3274 断言通过；4 个既有 opt-in skipped，无 unhandled error |
| `npm run typecheck` / `npm run build` / `npm run build:cli` | 最终源码通过；未打包、安装或升版本 |
| 当前构建隐藏真实 App | 原统一对话 fixture + 临时 Git 初始提交；3 个主对话 turn、10 次受控 Provider invocation、2 次重启；独立核对 7 对共享归档，3 对含真实临时文件变化 |
| `npm run performance:measure` | 36 observations；收紧前 3 better、31 unchanged、2 gating pass；另 3 个 macOS CPU 指令 candidate missing，无 worse |
| ratchet / feedback 测试及 ledger guard | 24 通过；只下调三个 candidate 的 darwin-arm64 基线至 17 / 1 / 17，不升门禁、不放宽 |

mac2 依赖安装禁用 native build scripts，其 unit 中的 SQLite 降级警告不等于真实数据库验收。本机另跑了真实 Electron SQLite counter fixture；App 功能验收也与 unit 分开报告。未跑真实 Provider 探针、手机、L3、Node20/22 CLI 分发或完整发布 gate。

## 留存与下一步

- 本地原始证据：`/tmp/scry-terminal-pair-results/`，含全部三个比较组、首轮失败、负对照、最终 App 归档检查与一次性 harness / patch。
- mac2 原始 bundle SHA256：`a1d1b7aae76f875149ebbbd13a8a4b3d051239fd5bf36dc915775cc531e17216`。源码 9 个相关文件与本地逐一匹配；远端仅剩自身 worktree 后，已移除整个 owned 临时根。
- App fixture 通过既有 `stopOwnedApp` 收敛；本地保留构建产物及 fixture 截图，不代表已安装。
- 下一轮 agent 先为真实 `Service.diff` 的双 revision 检查冻结独立负载。合入/安装需用户确认；之后同场景 ≥30 个日常样本、≥2 会话才可补 L3。candidate 升门禁还需维护者确认，不自动升级。
