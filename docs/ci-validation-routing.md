# CI 验证分流与故障恢复

维护者在 main 合入 #77 后明确选择沿用 main 的分流合同。PR #63 不再提供 recorder-only 特殊分流或 `recorder_base` 计时 dispatch；保留基础设施恢复、共享 UI readiness 和其他验收链修复。下述路径规则以 main 的 `validation-changes.yml` 为准。

## 路径与必跑检查

`validation-changes.yml` 用真实 Git diff（包括删除与重命名两端）输出 `required`、`desktop`。不在工作流触发器上加 path filter，避免必需的 `Check` 永久 pending。未知路径走完整验证，无法读取 diff 则失败。

| PR / 手动运行的改动范围 | CI 必跑 | 桌面产物 / macOS UI |
| --- | --- | --- |
| 仅 `**/README.md`、`docs/**/*.md` | 路径检测、聚合 Check | 不触发 |
| main 的 App-free 白名单：`*.test.ts(x)`、指定 Agent 指导/PR 模板、`apps/ios/**` 等 | Ubuntu node/build、全部 unit/contract/coverage、CLI Node 20/22/24、clean tarball、Linux App/pacman 均保留 | 仅跳过 macOS 三片与 Performance Native；不冒充已测量 |
| recorder 生产源码、共享合同、workflow、脚本、依赖/锁文件、App 输入及未知路径 | 完整矩阵，包含上述检查及 macOS 三片 UI/打包 | 必跑 |
| 未限定范围的 `workflow_dispatch`（含桌面发布验证） | 完整检查 | 必跑 |

不把 recorder 目录视为独立于 App 的生产边界。App-free 判定沿用 #77：测试后缀和指定非 App 输入可免 macOS，但测试 helper、workflow/action、测量脚本、fixture 和打包输入仍走完整矩阵。没有删除已有测试或缩小 unit/coverage；本 PR 原 recorder-only 场景改为断言 main 的完整验证。`check:cli-runtime` 保留 recorder 单测、CLI 合同、CLI build 和 clean tarball 安装/运行冒烟。Performance 的 Native 条件沿用 main 的 `desktop`；Remote G0 使用其自身分流，不由本 PR 扩大豁免。

聚合 `Check` 根据两个输出逐项核对 success/skipped；需要的检查跳过、取消、失败、缺失或出现未知输出均不通过。

## 所有可执行改动保留桌面消费者单测

“全部 unit/coverage”不是路径子集。`unit` job 只依赖 `required=true`，不依赖 `desktop`；四个分片统一执行 `npm run test:coverage`（`vitest run --coverage`），只按文件分片，没有 recorder 路径过滤。`src/main` 和 `src/renderer` 的单测与覆盖率都保留，包括 managed-turn、conversation-history、transcript-archive、db、git-diff-history 等消费者。`vitest.config.ts` 的 coverage include 为 `src/**/*.{ts,tsx}`；排除的测试文件、声明和 fixture/helper 不是桌面消费者业务源码。它不等于真实桌面 UI 验证，后者仍由桌面矩阵承担。

## 合并 main 后的完整矩阵兜底

CI 监听 `push.branches: [main]`。按 #77，main pushes 共用并发组，新 run 可取消旧 run；PR pushes 各自合并为最新一轮，手动运行不合并。为覆盖被取消 run 的提交，所有 main push（包括文档）与默认手动运行均强制完整验证；不使用 `recorder_base`，不按 PR 路径免除 App 检查。发版若依赖某次提交的 CI 产物，应等该 run 完成再合下一 PR，见 `CONTRIBUTING.md`。

CI 的完整矩阵包含全部 unit/coverage、CLI、桌面 build、macOS 三片和 Linux 打包。Performance 依其现有工作流消费相同的完整输出；Remote G0 不改变。触发不代表取得 runner 或执行成功；排队、平台/API 故障仍须按下节证据分类，不把并发策略取消自动视为基础设施故障。

## 基础设施分类与一次重试

`CI infrastructure recovery` 在 CI、Performance、Remote G0 local contracts 三个门禁工作流完成后读取 job、日志和 check annotations，分类写入其 Actions summary，并发出 `Infrastructure retry (1/1)` notice：

- runner 未启动：必须有明确的 runner 未领取/启动 annotation；没有日志本身不是证据。GitHub 容量分配失败可能以 `cancelled`、`runner_id=0`、无 steps 返回，仍以该 annotation 判定；普通取消或已分配 runner 的取消不自动重试。
- 软件源下载或 DNS 失败：必须发生在依赖安装/runner 准备步骤，并匹配明确的网络失败证据。日志按 GitHub step 起止时间归属，只用唯一属于失败步骤的日志秒；共享边界秒、缺失时间或无时间戳时不猜测，避免成功步骤的 DNS 负对照污染后续错误。
- 测试断言、测试步骤中的 DNS 负对照、依赖合同错误及未知失败：不自动重试，保留原始失败，先调查。整份日志中的断言证据始终否决自动重试，即使断言出现在不能唯一归属的 step 边界秒。

只调用失败的基础设施 job 的 rerun API（及 GitHub 自动安排的依赖聚合 job），不用重跑全部失败 job 的 API，因此不顺带重跑失败断言。每个完成事件最多请求一个 job；下一次完成后继续处理尚未重试的基础设施 job，避免并发 rerun 冲突。读取所有历史 attempts，按唯一 job 名（含 matrix 坐标）限制每个 job 最多一次。GitHub 会复制未重跑 job 到后续 attempt，生成新 ID 却保留原执行时间；以各 attempt 的 `run_started_at` 排除这些副本，读取真实执行的日志/annotation，向最新 job ID 请求重试。人工真正重跑同一 job 也消耗额度；执行历史不能确认时标为 unknown、不重试。重复/过期事件、重名有歧义时不重试。对 push run，在 rerun 前读取可信的当前 branch ref，与原 run 的 head SHA 比较；已被新 push 替代则不重试，避免旧 main run 取消新 run。ref 查询失败则不发起 mutation；查询与 rerun 不是原子操作，不能保证两次 API 之间没有新 push。不取消或覆盖首轮日志。

观察工作流仅在合入默认分支后自动生效。它固定 checkout **默认分支**，从不执行 PR head 代码或下载 PR artifact；token 只有 `contents:read`、`checks:read`、`actions:write`。观察工作流本身或 GitHub API 不可用时不能保证自动恢复，应由维护者查看原始结果；不会伪装成功。

Ubuntu 保持 `ubuntu-latest`。`packaged-linux` 已优先加入 kernel.org Ubuntu 镜像，并保留 npm、Electron 和打包工具缓存；不固定 Ubuntu runner 版本来掩盖源问题。

## 桌面 UI 就绪与崩溃证据

`scripts/ui-ready.mjs` 提供同一个被动等待：文档/正文加载、面板实际可见、目标会话匹配可组合在同一断言中；reload/restart 可同时要求不同的 `performance.timeOrigin`。它复用各 harness 原有 deadline，不重试失败、不增加超时、不点击或重建目标。CDP reload 先等 `Page.loadEventFired`，避免在旧 execution context 中等待一个不可能改变的文档 epoch；加载和就绪共用原 deadline，保留 crash 事件失败。

桌面远程场景统一从该等待进入；正文历史、右面板与 host reload，以及本机 side-chat 的面板、正文、theme reload、restart/workbench 和统一对话的进入、reload、正文底部跟随共用此函数。缩放后的滚动就绪检查等待实际底部位置，不用固定帧数，不代替产品执行滚动；原有 overflow/底部跟随/用户滚离后的定位断言保留。专门验证 loading/preview 的用例不强制等到 authoritative，以免跳过要测试的中间状态。恢复检查在读持久化状态前不打开 child/history 来“修复”现场。

Workspace/picker、reference-only diff、diff pressure、activity history 和 terminal adoption 的旧 reload 路径也共用此函数。所有托管 CDP reload 只由 `reloadUi` 发出，源码回归禁止其他 `.mjs` 绕过它。Activity 保留 10 秒、terminal 保留 15 秒，其余保留原 20 秒预算；workspace 的 wait 接收 reload 剩余预算。Terminal 不再吞掉所有求值异常，崩溃和 API 失败会保留为原始失败；就绪后仍独立断言原 PTY 存活。

现有 Node/Electron 子进程失败仍输出退出码或 signal 与 stderr 尾部；回归测试覆盖 `-11`、`SIGSEGV` 与 Python 栈文本不会被改成成功或重试。CI 设置 `PYTHONFAULTHANDLER=1`，让 Python 子进程在 signal 11 崩溃时输出栈。仓库中没有找到旧的 Python `-11` 专用诊断实现，因此不能声称已验证某个 Python 调用链；不删除或替换已有诊断。

## 历史计时与当前验收

先前 recorder-only 试验 run `43182723761` 成功，墙钟 290 秒；其严格 base/head、原工作量和各 job 结果保留于 PR #63。维护者随后选择 main #77 的分流方案，因此撤回该特殊通道和计时输入。这个数字只描述历史 artifact，不代表当前 recorder 生产改动的 CI 耗时，也不能代替最新完整门禁。

当前所有普通事件使用必需 `Check`；没有发布相同 SHA、同名但不同范围的计时结果。报告最新运行的 head、base、链接与墙钟时间；保留排队时间，不把并行 job 时长相加。
