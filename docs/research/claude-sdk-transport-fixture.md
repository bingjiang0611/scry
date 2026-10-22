# Claude SDK 离线 transport fixture

```sh
npm run build:cli
npm run test:claude-sdk-transport
```

仅支持 macOS 的 `/usr/bin/sandbox-exec`。不可用时明确失败，不跳过或降级为环境变量“禁网”。当前通过版本：Node 24.18.0 / SDK 0.3.251。生产 Scry 的隔离与权限语义没有改变。

## 验证范围

- 外层创建仅供正对照的 loopback listener；相同连接在外层成功，在 SDK harness 和其假 CLI 中均为 `EPERM`。SDK 只在系统层 `(version 1)(allow default)(deny network*)` 限制的进程内 import。此 profile 只限制网络，不是文件系统沙箱。
- 真实 `query()`、真实 NDJSON/child-process transport，无 SDK mock。直接 SDK 场景的 spawn 回调只做身份断言、登记并调用真实 `spawn`，不替代管道协议。runner 场景使用生产 `runAgent` 自己的 spawn，不替换其 query、归一化或观测代码。
- 所有场景使用绝对 fake executable、独立 HOME/临时工作区、带空格路径、凭据环境清空，拒绝危险跳权限参数，没有真实 CLI fallback。直接 SDK 场景精确断言 argv，并显式设置 default 权限、空 tools/MCP/setting sources；生产 runner 场景按现有代码传 default 权限和空 MCP，不把未显式设置的 tools/setting sources 称为空。假 CLI 不读取配置或执行工具，不能外推真实 CLI 的配置行为。
- SDK 回调使用 initialize 实际提供的 opaque hook ID；不硬编码 SDK 内部回调 ID。
- 原六场景的假 CLI 仅发送 synthetic model/tool/usage 帧，不执行 recorder hooks。新增 recorder 场景仅额外执行冻结的私有 recorder CLI；全部场景均无真实模型、工具或账号操作。`transcript_path` 仍是元数据，不是已写入的 transcript。

| 场景 | 必须证明 |
| --- | --- |
| complete | initialize 精确 request ID、真实 SDK hook 往返与 prompt ID、text/thinking 增量、synthetic tool_use/progress/result、terminal result、SDK 主动 stdin EOF、子进程退出 0 且无信号 |
| interrupt | SDK 消息消费与 interrupt RPC 并行；ACK 返回时迭代尚未完成，wire 中尚无 terminal。原子文件 gate 显式释放后才产生错误终态，再 EOF/退出；不把 ACK 当收敛 |
| negative | 故意发送未注册的 hook ID，真实 SDK 必须返回 control error 且不调用合法 hook；后续 synthetic error result 是预期负对照，不是模型成功 |
| runner-complete | 生产 runAgent + 实际 SDK，原生 session/prompt ID、7 条 native 记录、4 条 trace、text/thinking/tool_activity/tool_returned 共 4 条诊断、真实 tracker 计数及 completed |
| runner-interrupt | 等生产 runner 实际观测到 tool_activity 后才 interrupt；假 CLI ACK 后 handle.promise 仍 pending，无 terminal，释放 gate 后才 interrupted、EOF/exit0；不调用 forceKill |
| runner-plain | 同样的生产路径但关闭观测；trace/native 内容与 runner-complete 一致，只剔除 trace id/ts/runId、native 帧 uuid 和 init cwd，保留工具/消息 ID、输入输出、用量及结果 |
| recorder-complete | 真实 adapter / 私有 CLI Start+Stop / 聚合器 / prepare+commit，Stop 不写 canonical、commit 写一条且重复不增；独立 CLI verify 与零 pending |
| recorder-interrupt | 观察到真实 native tool_activity 后发 interrupt；peer 发 ACK 时 promise 未完成、Stop 未执行且 records0/open；释放 gate 后实际 interrupted、Stop/EOF/exit0，随后落盘 interrupted |
| recorder-failed | 私有 Stop 后 SDK 错误终态；进程正常退出0不等于业务成功，实际 failed、canonical failed；原生/归一化诊断保留 |

每个新场景期限仍为 8 秒，不重试、不加时。临时目录和失败日志保留；只有登记进程的 PID/出生时间/用户/命令及源 hash 都重验后才允许失败清理，不做 pkill。正常成功必须是 EOF + exit 0，SIGTERM 不算成功。macOS 禁止沙箱内 `ps`，OS 出生身份由外层 owner 获取；假 CLI 在外层登记完成前用文件事件 gate 保持存活，再进行握手，避免快速退出与身份采集竞态。runner 的身份采集返回未知时仍只测试 cooperative interrupt，不使用 forceKill 或放宽 profile。

## 首轮直接 SDK 证据（2026-10-21）

最终成功现场：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-claude-wire-9lTEw2/`。

- complete / interrupt 各实际 SDK 7 帧，negative 2 帧；3 场景全部通过，SDK 和 CLI 网络均 `EPERM`，CLI exit 0 / signal null。
- `scope.json` 绑定 harness、CLI helper 和实际 SDK 文件 hash / 版本；各场景保留 `wire.jsonl`、`harness.jsonl`、`registered.jsonl`、`result.json`。
- 外层审查记录：`/tmp/scry-claude-wire-review.tFzIIq/`。`integrity.json` 确认最终登记的 6 个进程均已退出，旧真实故障现场 16 源 hash 不变。
- `node --check`（两文件）、Node/web typecheck、`npm run build` 和 `git diff --check` 通过。未安装、未推送，未升版本；没有重跑用户延后的全仓门禁。

保留的失败与修正：

1. 未执行的初版存在 response.request_id 层级错误、监听不存在文件、重复协议路径、忙轮询与退出清理缺口。原文保存在审查目录 `unexecuted-worker.mjs`，没有为了复现已知挂起而执行它。
2. `first-run.log`：系统限制使沙箱内 `ps` 返回 EPERM，失败发生在 SDK import 前；改由外层登记出生身份，不放宽限制。
3. `second-run.log`：真实 SDK 将字符串 prompt 编码为 text-block 数组，原夹具字符串假设被拒绝。按实际 wire 精确断言数组，未增加双格式 fallback；该轮 SDK/CLI 均已退出。
4. `third-run.log`、`final-run.log` 是对应修正后的中间成功记录；最终更强 argv/版本/hash 断言后的结果在 `accepted.log`。不以重跑掩盖首轮失败。

## 生产 runner 接缝证据（2026-10-21）

最终现场：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-claude-wire-z0vPlx/`；父会话审查：`/tmp/scry-runner-wire-review.FIhtVT/`。

- 六场景全部通过，SDK harness 和假 CLI 均实际连接外层活跃 loopback 并被系统拒绝 `EPERM`；外层同连接成功。三条 runner 路径均真实 SDK 7 帧、trace 4 条；开启观测时各 4 条诊断，关闭时 0 条。
- 使用现有 esbuild 在外层编译生产 TypeScript 到临时模块，不启动 Vite 服务。SDK 保持绝对路径 external，只在已禁网的 harness 内加载。`bundle.json` / scope 绑定 14 个输入文件、bundle、SDK、harness/helper 的 hash；没有复制或 mock 生产实现，esbuild service 显式停止。
- `runner.json` 保存真实 callback/result/tracker，native/trace 在回调时快照；`noninterference.json` 保存观测开关对照。thinking 原生增量产生诊断和 native 记录，不声称当前 normalizer 会输出 thinking-delta trace。
- `integrity.json` 确认 12 个登记的 harness/fake PID 已退出，所有场景有 stdin EOF、CLI exit0、无 signal，16 份旧真实故障源 hash 未变。未知身份不被伪造为可强杀。
- Node 24.18.0 / SDK 0.3.251；两脚本 node --check、Node/web typecheck、npm run build 通过。未重跑用户延后的全仓门禁，未安装、推送或升版本。

本轮首次失败与修正没有被重跑抹去：

1. 未运行的 worker 初版及 helper 保存在审查目录。父会话先修正 watcher 异步错误被转成超时、缺少取消清理、立即 interrupt 尚未观察活动、误要求 thinking trace、esbuild service 未显式停止等夹具问题；没有为夹具改生产语义。
2. `first-run.log` / 现场 `scry-claude-wire-2Dzz1q`：runner 已写 completed，但 fake 身份未成功登记；错误清理又拒绝命令身份核验，覆盖了原始异常，故不能断言最初异常的精确原因。保留原现场，随后确认 8 个已启动 PID 均退出。修正为 fake 等外层出生身份登记后再握手，并分别持久化原始错误与清理错误；没有放宽身份校验。
3. `registered-gate-run.log` 是五场景中间通过；增加关闭观测的真实对照后，`final-run.log` 六场景通过；把整个启动区纳入 watcher 清理后的 `accepted.log`、采用回调时快照的最终 `accepted-snapshots.log` 亦为六场景通过，期限仍 8 秒。没有扩大超时、隐藏失败或调用 forceKill。

## 生产 adapter + managed recorder 完成路径（父会话已执行）

在原六场景之上新增 `recorder-complete`。Node 24.18.0 / SDK 0.3.251；冻结私有 CLI 0.2.49、入口 SHA256 `1457bd9e30b87e8617571019ea59112182a77fae0f45255ec587bdcbaab6c274`、package 与 43 文件依赖清单。入口按当前 checkout 定位，不使用全局 CLI。CLI/依赖变化须先重新构建、核对来源并显式更新 pin；不自动批准其他二进制。

最终现场 `scry-claude-wire-ukSCQN`：七场景全部通过。新增路径使用真实 `createClaudeAdapter().run()`、真实 SDK、生产归一化/聚合器与 managed prepare/commit。先在新临时 HOME/带空格 Git 根中调用生产初始化器，再由 fake peer 用实际 Node 子进程执行固定私有 CLI 的 UserPromptSubmit / Stop（`--managed --verbose`）；不是直接调用 hook API 替代 CLI。private CLI 子进程实际返回 0 / signal null，JSON status 分别 started / pending。fake peer 按真实子进程的开始/结束发送 SDK 类型规定的 hook_started / hook_response，非预置成功；合法 SDK JS hook_callback 仍是独立调用。

- 新路径真实 SDK native 11 条、trace 8 条，canonical hooks 两条、tools 一条；原六场景继续通过。私有 Hook 完成后才发 terminal result，随后 stdin EOF、fake exit0。SDK harness/fake 实测 loopback EPERM、外层同连接成功；私有 CLI 通过真实 fork/exec 继承系统网络限制，未声称在其内部另做连接探针。profile 不是文件系统沙箱。
- Start/Stop 后 canonical records 仍为 0、生命周期 pending；冻结真实 recorder config 的 full-tool-content policy，经生产聚合器保护输入输出。写入真实 standalone `archive.json`，再从落盘 JSON 读取 evidence 并计算 fingerprint；它不是 App archive。prepare 不生成记录；commit 实际落盘一条，重复 commit 为 duplicate，记录内容未变，pending 清零。
- `runner-bundle.mjs` 绑定 51 个实际输入，SDK 保持 external。scope 绑定 SDK/helper/harness/bundle/CLI 的 hash。16 个登记 harness/fake 与 Hook PID 均确认退出，Hook 未使用停止升级或自定义提交回调。未运行真实模型/工具/账号。
- 独立实际私有 CLI 在同样系统禁网/fresh HOME 下执行 turns verify：ok=true、records=1、errors=[]、openTurnsPending=0。model / role / taskLink 仍为 legacy_unset advisories；结构完整不冒充元数据完整。
- 两脚本 node --check、67 条 focused unit（managed 44 + Claude 23）、Node/web typecheck、App build、diff check 通过。未重跑用户延后的全仓门禁；Scry App/私有 CLI 未升版本、未安装或推送。

私有只读归档：`~/.local/state/rotom/verification-evidence/scry-managed-JGARFz/`。`case-ukSCQN/` 是接受现场快照；`review/` 有 integrity、独立 CLI verify、检查日志；`private-cli-snapshot/` 和 `sdk-snapshot/` 保留本轮确切字节，`FILES.json` 绑定归档 hash。归档仅供检查，不是被搬迁/重新授权的工作区或可恢复 execution store，不能执行其中的旧任务。临时原现场仍保留。

失败/中间结果未覆盖：

1. 未执行 worker 版本保存在 review/unexecuted-*。父会话先修复终态遗漏、Stop 顺序、Hook argv 与启动/退出记录错配、quiet 掩盖 CLI 状态、未初始化、manifest 把换行写成字面转义等夹具问题，没有削弱生产合同。
2. first-run（BEnKC9）在真实初始化器拒绝非 Git 根处失败，adapter 尚未启动；13 登记 PID 退出。加入仅临时目录的 git init，并隔离 system/global Git 配置。
3. git-root-run（j014nK）真实私有 CLI 返回 started，而夹具错误要求 recorded；修正为唯一真实合同，不加双格式 fallback。15 登记/Hook PID 退出；该现场 pending 保留。
4. started-contract-run（xHVZJ4）被生产 full managed input 的 bounded-content guard 拒绝，这是拒绝原始未保护 payload 的实际负对照。改用真实冻结 policy 与生产聚合器保护，不改生产断言或降为 metadata policy；16 PID 退出，旧 pending 现场不清除。
5. protected-policy-run（mkncAl）已落盘一条，但内存 reasoningTokens:undefined 与 JSON 省略字段直接 deepEqual 导致夹具比较失败。改为从已持久化 archive 读取规范 JSON evidence 后交付；不补 0、不删有意义字段。原记录/hash 与 16 PID 关闭证据保留。
6. serialized-archive-run（fI3lJm）是初步七场景成功；自审发现 fake 未发送实际 Hook 的 SDK 生命周期帧，不能把 canonical hooks 的 exact 空数组当作完整 Hook 覆盖。补充由真实子进程结果生成的 native Hook 帧及两条 Hook 断言后，hook-evidence-run（ukSCQN）为接受版本。旧记录不重写。每场景期限仍8秒，无重试/忙轮询/加时。

较早 `/tmp/scry-workflow-pending-audit.../source-manifest.json` 与 legacy 临时工作区在本轮复核时已不存在，原因未知；无法重验旧16源 hash，不能把历史核对升级为本轮核对。未重建、清除或重发旧 unknown/pending。新受控现场已另外只读归档，避免只依赖易清理的临时路径。

## Managed 中断、失败与恢复拒绝（九场景）

接受现场 `scry-claude-wire-576UgZ`；只读归档 `~/.local/state/rotom/verification-evidence/scry-managed-control-j_a614s7/`，735文件 + FILES.json。仅两份测试脚本及说明变动，不改生产 adapter、recorder、选项、依赖或版本。Node24.18.0 / SDK0.3.251 / 冻结私有 CLI0.2.49；原七场景加两个新场景全部通过，每场景仍8秒。

三个 managed 场景各真实落盘一条，分别 completed / interrupted / failed，重复 commit 都为 duplicate 且记录不变。分别独立调用固定私有 CLI turns verify，均 exit0 / signal-null、结构完整、records1 / pending0；这不表示 failed 运行变为成功。24登记 harness/fake/Hook PID均确认不存在；本次四轮中88个登记/Hook PID也逐一确认退出，未声称所有未登记后代或全机器闭包。CLI验证三个 PID未留存，不编造 PID核验；首个 verifier 已同步观察各自 native exit0，修正审查断言后直接消费保留结果，没有重发命令。

每个 managed 场景额外核验四个负输入/停留状态，共12项：

- Stop后尚未 prepare，调用真实 core recover：recovered0 / pending1，records0、health.pendingCount1，原始生命周期字节不变。
- prepare后但未确认 archive commit，recover仍为0 / 1，不自动完成或写 canonical；handoff与生命周期字节不变。
- 错误 providerTurnId 的 prepare 必须拒绝；错误 archive fingerprint 的 commit 必须拒绝；不推进状态、不写 canonical。
- 字节快照仅检查本次 session，最多128条目录项、1MiB内容；明确区分可重建的 provider-turn-index 派生缓存。被拒绝的 lookup 允许建立空缓存，但必须验证其 count0/maxSequence0/空映射，不得虚构已提交事实。

中断 ACK 检查观测的是 fake peer 已发送 ACK，adapter没有单独暴露 SDK ACK消费回执；不升级为完成证据。随后必须真实收到 terminal、Stop CLI返回pending、stdin EOF / exit0，才进入 prepare/commit。恢复检查是同一独立 harness 在 SDK结束后调用 core文件恢复 API，不是 App冷启动或 archive_committed 崩溃窗口恢复。

自审保留两类首败：first-run / Sd2X4F 的 blanket目录快照把合法派生索引当作不可变事实，按 managed.ts明确缓存合同修正并加空索引真实性断言，原 pending现场不清除；首个独立 verifier 错把 Provider失败等同于普通errors容器非空。aggregate.test.ts的既有合同只计失败tool_result，故本场景工具成功、普通errors=[]正确；Provider诊断保留在native SDK errors / harness result，canonical.status仍failed。保留first-verifier.mjs和三份独立CLI结果，不改生产逻辑迁就错误断言。

独立 integrity 核对51个 bundle输入和43个私有CLI文件；focused managed44+Claude23、aggregate30，共97单测通过，Node/web types、App build、两脚本语法和diff check通过。未跑延后的全仓门禁、未安装/推送或真实账号操作。

## 明确不能证明

这不是实际 Claude CLI/模型、账号、工具授权/执行、完整 App workflow 或 App archive/SQLite/canonical 跨存储原子收敛验收。当前证明独立 completed/interrupted/failed 路径各真实落盘一条 core canonical record及恢复拒绝；尚未覆盖 managed native进程异常丢失、archive_committed崩溃窗口或App冷启动恢复。SDK `hook_callback` 成功本身不表示私有 recorder CLI 已执行，本轮额外 CLI PID/退出/落盘证据才证明它执行。synthetic usage 零不表示真实费用为零。

本检查目前是独立手动命令，未声称 CI 已执行。扩大到 Linux/Windows 前，先提供等价系统禁网和进程身份保证，不静默降低本检查。

下一步由维护 Agent 核验 archive_committed 崩溃窗口的独立恢复与幂等边界，再评估完整 App 接缝与真实 native transcript。当前 prompt ID 来自原生 Hook；transcript_path 仍是元数据，没有声称覆盖 transcript fallback。实际账号探针仍须用户先指定账号、模型并授权费用。
