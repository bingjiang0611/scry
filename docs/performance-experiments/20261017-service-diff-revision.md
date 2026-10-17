# 真实 Service.diff：保留双 revision 校验，避免重复面板元数据查询

## 当前交付状态（2026-10-17 集成更新）

- 优化源码 `06a3f41` 已随 `89e4465` 合入 main；保留 main 的原生会话 fork 与较完整的旧日志迁移逻辑。
- 验证构建：App **0.2.196**，完整 build ID `1d7585fc0e27063072cc5fc0975b074a3a192800dedb1d68cf4888da9710b2e1`。这是源码/依赖配置指纹，不是安装回执或包二进制哈希。
- 构建验收：unit/shell、CLI、开发构建与隐藏 App/UI 通过；打包运行校验中私有 CLI 收到 SIGKILL，未通过。深度签名校验通过，终止来源未知；用户明确批准只合入源码，不安装、不放宽门禁。
- 安装/生效：本次未安装；宿主实际版本/build、安装/首次生效时间及日常 baseline→candidate 映射仍为 `unknown`，L3 待验证。
- 下文 L2 数据属于原实验源码。集成版仅重验了功能与 L1，没有把旧毫秒样本改标成新构建收益。集成验收与首轮失败见[机会日志](../performance-opportunities.md)。


**已验证 L1 + 受控 L2**：Git 子进程 24→18，双 status 校验仍为 2；有效同机组 p50 507.64→382.85ms（-24.6%）。不是完整 App、打开面板或日常 L3 收益。原始样本与源码 SHA 见 [JSON](20261017-service-diff-revision.json)。测量独立提交 `8514551`，生产 `06a3f41`。

## 冻结基线（优化前）

生产基线 `e62f99e`。已有 `source-control.service.status-diff` 仅调用 ScGit.status + diff，仍原样保留，不能当成真实 Service.diff。

新负载：`tracked-files=5001;dirty-paths=4;remotes=1;diff-requests=1;staged=false;primed-ui-revision=true`。真实临时 Git / SourceControlService / ScProcess：一个文件部分暂存、一个工作区修改、一个暂存 rename、一个 untracked 中文文件。面板初始 read 在时窗前，与实际点击 diff 的调用链相同；终态检查完整 index 字节未变、patch 只含工作区层、不含已暂存层。每侧固定五轮，不缩小旧负载。

优化前 collector 六个测试通过，新增四序列均稳定：

| 指标 | 五轮结果 |
|---|---|
| Git / 整体子进程 | 24 / 24 |
| 原生 status 校验 | 2 |
| remote 查询 | 6 |

## 发散与选择

| 视角 | 想法 | 本轮判断 |
|---|---|---|
| 需求 | 校验是否真的需要完整 remotes 展示 | 可立即实验：revision 哈希不含展开后的 remotes 数组 |
| 调用链 | 合并前后两次 revision 检查 | 否决：丢失 diff 期间变化的拒绝能力 |
| 进程 | 常驻 Git worker / cat-file | 需用户决定；本轮不引入常驻进程 |
| I/O | 并行 dirty 文件 stat | 需另测；保持现有 fingerprint 顺序与来源 |
| CPU | 减少 index hash | 否决：它属于 revision 合同 |
| 缓存 | 缓存配置或 hooks | 需用户决定及失效合同；本轮不缓存 |
| 并发 | 合并两个检查的共同请求 | 否决跨 diff 合并；两个时间点必须重新取证 |
| 证据 | 为校验提供不含展示 remotes 的内部投影 | 选中：完整保留 identity、filter、status、config、文件/index、hooks/blockers 取证 |
| 安全 | 去掉 filter/hook 扫描 | 否决：原有 trust/read 安全边界不变 |
| UI | 懒加载 diff 或改变点击反馈 | 本轮不改 UI/IPC，避免把等待藏到别处 |

假设：仅为 Service.diff 的两个校验选择内部 revision 投影，可省去 6 个 remotes 子进程。普通面板 read、写入预期检查及 remote/PR/传输路径仍取完整 status；不改变 revision 公式与查询顺序。目标 24→18，两个 status 保持 2。

## 最小实现与安全边界

- `ScGit.readStatus` / `revisionState` 复用原有完整 revision 取证。公式、identity 重验、filter 防护、status、config、index hash、文件 fingerprint、hook/action blockers 全部保留。
- `ScGit.revisionSnapshot` 返回不含 remotes 的内部投影。没有假造 `remotes: []`，没有增加缓存、进程池、协议或依赖。
- 普通 `ScGit.status` 仍按原顺序获取真实 remotes，再完成 revision；UI read、写入、PR 和传输检查仍走完整路径。remote URL 的凭据 redaction 不变。
- 只有 `SourceControlService.diff` 在前后两次检查中选择内部投影。共享的 revision 比较条件与错误文案保持原合同，发生期间变化时不返回已读到的 patch。
- 减少的六次查询是本机 `git remote` / `get-url` 子进程，不是网络请求。它们既不参与 revision 哈希，也不供该 API 的 diff 结果使用，因而直接不做。初始面板 read 未改，也没有把工作移到时窗外。

## L1 / L2 结果

| 项目 | baseline | candidate | 判断 |
|---|---:|---:|---|
| Git / 所有子进程 | 24 / 24 | 18 / 18 | 各减 6，五轮稳定 |
| 原生 status 校验 | 2 | 2 | 两个时间点仍独立重读 |
| remote 展示查询 | 6 | 0 | 不执行，不是缓存命中 |
| 有效组 API p50 | 507.64ms | 382.85ms | -124.79ms / -24.6% |

mac2：Apple M1、8 核、Darwin 25.3.0、Node 24.18.0、Git 2.50.1。同机、同 dependency installation / lockfile / 冻结 collector，baseline→candidate 串行，每侧 5 个全新仓库。包在 `timing-run.mjs` 锁内，所有样本保留，包括最慢的首样本。

首组负载从最初观察的 1.58 突然升高；正式测量记录 **12.92→17.63 / 8 核、highLoad=true**，所得 525.03→393.49ms **不用于 L2 收益结论**。不停止别人的进程，不改负载或超时。完成约五分钟功能验证后，观察到外部负载恢复到 2.35；重新在锁内取完整同机比较组，记录 **3.03→3.86、highLoad=false**，使用上表结果。两组及其日志均留存，不合并或挑选样本。

计时从真实 `Service.diff` 调用开始，包含授权/identity、前后完整 revision 观察、patch、完整 index 字节断言。已有面板 read 与仓库造数同样在两侧时窗之前。没有退出后后台清理或延迟计算。每条 ScProcess 命令仍等待其登记 child 的 close；最后的 service dispose 只关闭已空的 fixture。

## 实际验证

| 检查 | 结果 |
|---|---|
| `npm run test:unit -- src/main/source-control/service.test.ts` | 36 通过；新增 9 项验收：投影等价/不伪造空 remotes、三种 diff 层与 index 不变、期间工作区/index/HEAD/remote-config/hook 变化、late filter、过期前置 revision |
| 破坏保护的负对照 | 只去掉 post-diff 检查时，5 个期间变化用例均失败，错误是把 stale diff 返回为 available；恢复保护后通过 |
| mac2 `npm run test:unit` | 268 文件、3284 断言通过，4 个既有 opt-in skipped；没有新 skip 或 timeout 扩大 |
| `npm run typecheck` / App build | 当前源码通过；没有改 recorder core 或 CLI 分发 |
| `npm run test:source-control:ui` | 隐藏真实 App、生产 main/preload/renderer、真实临时 Git；打开真实 diff、暂存/显式取消暂存、部分 index、候选选择、完整 index + 选中文件提交、本地 bare remote push、hook 拒绝边界及草稿恢复通过；无 Provider、凭据查询或 GitHub 写入 |
| `npm run performance:measure` | 40 obs；收紧前 3 better、35 unchanged、2 gating pass；另 3 个 macOS CPU 指令 candidate missing，无 worse |
| ratchet/feedback + ledger guard | 24 测试通过；只降低三个 candidate 平台基线：24→18、24→18、6→0；双 status 的 2 保持不变，不升门禁 |

既有 8 / 11 Git 门禁及 terminal pair 的 17 个 Git / 1 次写树不变。mac2 依赖安装禁用 native build scripts，SQLite 降级警告不是原生 DB 证据；本机 Electron SQLite counter 和真实 App 检查另列。已有 measurement fixture 的异步等待允许完整比较 81689ms 而不阻塞 worker RPC，本次未改其 argv、断言或 120000ms deadline。

## 限制、留存与下一步

- 只覆盖一个 remote、5001 个 tracked / 4 个 dirty 路径的服务级场景；不把 5 样本 p50 当日常 p95，也不回推原始日常热点的收益。
- 现有 1000 dirty 文件上限、diff 文本预算及所有权限/trust 限制不变；无真实 Provider、L3、安装、合入或推送。
- 原始证据在 `/tmp/scry-service-diff-results/`，含高负载组、恢复后组、全部 counter、负对照、UI 日志和源码 manifest。远端 bundle SHA256：`31b575801ec2dee028d18b15915b65ac54530e74300a6bf13c6306736f0fc8db`。五个相关源码文件逐一匹配；远端 owned 临时根已移除。
- App fixture 通过既有 stopOwnedApp 收敛；本地保留构建产物和 fixture 截图，不代表安装。构建时源码未提交，manifest 与生产提交相同，不改写构建 revision。
- 后续建议先由用户确认合入/安装，再采同场景 ≥30 样本、≥2 会话的 L3，判断真实优先级；不能为了进一步降调用数删除任何 revision/trust 校验。candidate 升门禁仍需维护者确认。
