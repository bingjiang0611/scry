# Claude SDK 离线 transport fixture

```sh
npm run test:claude-sdk-transport
```

仅支持 macOS 的 `/usr/bin/sandbox-exec`。不可用时明确失败，不跳过或降级为环境变量“禁网”。当前通过版本：Node 24.18.0 / SDK 0.3.251。生产 Scry 的隔离与权限语义没有改变。

## 验证范围

- 外层创建仅供正对照的 loopback listener；相同连接在外层成功，在 SDK harness 和其假 CLI 中均为 `EPERM`。SDK 只在系统层 `(version 1)(allow default)(deny network*)` 限制的进程内 import。此 profile 只限制网络，不是文件系统沙箱。
- 真实 `query()`、真实 NDJSON/child-process transport，无 SDK mock。直接 SDK 场景的 spawn 回调只做身份断言、登记并调用真实 `spawn`，不替代管道协议。runner 场景使用生产 `runAgent` 自己的 spawn，不替换其 query、归一化或观测代码。
- 所有场景使用绝对 fake executable、独立 HOME/临时工作区、带空格路径、凭据环境清空，拒绝危险跳权限参数，没有真实 CLI fallback。直接 SDK 场景精确断言 argv，并显式设置 default 权限、空 tools/MCP/setting sources；生产 runner 场景按现有代码传 default 权限和空 MCP，不把未显式设置的 tools/setting sources 称为空。假 CLI 不读取配置或执行工具，不能外推真实 CLI 的配置行为。
- SDK 回调使用 initialize 实际提供的 opaque hook ID；不硬编码 SDK 内部回调 ID。
- 假 CLI 仅发送 synthetic model/tool/usage 帧，不执行工具、模型、外部 recorder hooks 或账号操作。其 `transcript_path` 是元数据，不是已写入的 transcript。

| 场景 | 必须证明 |
| --- | --- |
| complete | initialize 精确 request ID、真实 SDK hook 往返与 prompt ID、text/thinking 增量、synthetic tool_use/progress/result、terminal result、SDK 主动 stdin EOF、子进程退出 0 且无信号 |
| interrupt | SDK 消息消费与 interrupt RPC 并行；ACK 返回时迭代尚未完成，wire 中尚无 terminal。原子文件 gate 显式释放后才产生错误终态，再 EOF/退出；不把 ACK 当收敛 |
| negative | 故意发送未注册的 hook ID，真实 SDK 必须返回 control error 且不调用合法 hook；后续 synthetic error result 是预期负对照，不是模型成功 |
| runner-complete | 生产 runAgent + 实际 SDK，原生 session/prompt ID、7 条 native 记录、4 条 trace、text/thinking/tool_activity/tool_returned 共 4 条诊断、真实 tracker 计数及 completed |
| runner-interrupt | 等生产 runner 实际观测到 tool_activity 后才 interrupt；假 CLI ACK 后 handle.promise 仍 pending，无 terminal，释放 gate 后才 interrupted、EOF/exit0；不调用 forceKill |
| runner-plain | 同样的生产路径但关闭观测；trace/native 内容与 runner-complete 一致，只剔除 trace id/ts/runId、native 帧 uuid 和 init cwd，保留工具/消息 ID、输入输出、用量及结果 |

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

## 明确不能证明

这不是实际 Claude 模型、账号、工具授权/执行、完整 App workflow 或 `.scry` canonical recording 验收。SDK `hook_callback` 成功不表示 recorder 私有 CLI 已执行，synthetic usage 零不表示真实费用为零。

本检查目前是独立手动命令，未声称 CI 已执行。扩大到 Linux/Windows 前，先提供等价系统禁网和进程身份保证，不静默降低本检查。

下一步由维护 Agent 核对完整 App 的最小离线接缝、真实写入的 native transcript 与 managed recorder 生命周期；本轮 recordNative 回调不是 canonical recorder。实际账号探针仍须用户先指定账号、模型并授权费用。
