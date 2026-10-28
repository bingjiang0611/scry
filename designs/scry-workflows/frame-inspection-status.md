# M5 structural ancestry 与只读控制记录：有界证据

这是 M5 的一个子集，不是 M1–M6 完成交付，也不是完整实例图。源码仍未提交。唯一执行链、根预算与既有权限边界不变。

## 实现范围

- 每个新控制帧保存实际 `parentFrameId`：`null` 是明确根，字符串是实际父帧，缺失是 legacy 未知。不能由 `scopePath` 或 task hash 反推父级，不能将旧记录补写为根。
- sequence 沿用同一个 lexical scope 对象。结构父级在 Interpreter activation 中传递，不复制 lexical scope；branch/parallel/map/loop 仍沿用原有隔离方式。frame ID、语义路径、输入权威和历史引用不改变。
- Agent/System admission intent 记录实际执行帧。live/cold/list 的有界视图从 intent 投影 frame link；旧 Agent intent 只复用真实记录的 `callFrameId`，不猜测。canonical outcome 不增补视图字段。
- `workflow:inspectFrame` 先校验 ID、canonical preview 和 workspace authority，再传入 main 已授权的 preview。一次请求不重复读取 governing root。接口只返回选定 metadata，不返回 bindings、prompt、inputs、outputs、resultRef 或 transcript。
- 生产行入口复用 `ModalFrame`，支持实际父级、复用来源、返回和显式刷新。本次路径最多 32 条；环路和上限明确显示，legacy 未知不显示成根。记录 phase 不代表物理进程收口。

## 当前验证

环境：Scry 0.2.210、Node 24.18.0、Electron 42.10.1、macOS arm64。没有安装或重启日常 App，没有真实 Provider/Jev/账号调用。

日志位于 `/tmp/scry-workflow-template-editor.ZnkC6L/`。

| 检查 | 结果 | 证据 |
|---|---|---|
| Node/web types、11 文件 focused | 96/96；含生产 IPC sender/workspace、System frame、非法 numeric frame ID、metadata、UI context | `m5-frame-system-focused.log` |
| lexical 修正后的 Node/web types、8 文件 focused | 43/43；含真实 FileStore 动态修订、cold authority、不可变历史和实际 ancestry | `m5-lexical-scope-restored.log` |
| 当前 candidate 的 Node/web types、9 文件 focused | 48/48；另含 metadata 的 5 项 renderer context 检查 | `m5-frame-candidate-focused.log` |
| 去掉 parentage 的负控 | 原 ancestry 测试失败；随后按 byte hash 恢复源码 | `m5-parentage-negative.log` |
| scope-copy 负控 | 原有 opaque producer 测试稳定得到 4 而非 6 次 attempt，拒绝错误复用 | `m5-opaque-scope-negative.log` |
| 最近默认完整 unit | **4068 pass / 1 fail / 4 opt-in skip，359 文件** | `m5-frame-lexical-all-unit.log` |
| 当前源码 build + 隔离生产 App | Agent/System 两种记录入口、父级/返回/刷新、Tab/Shift+Tab/Escape、焦点恢复、430px 宽度与文字对比度通过；ledger/budget 不变 | `m5-frame-candidate-app.log` |

最近完整 unit 在随后不改变可达调用行为的 child 参数写法整理前执行；当前 candidate 另经上述 48 项和 App 重验，没有重跑不变失败刷绿。该完整 unit 的失败是 `workflow-system-revision.test.ts:173`：`retains a legacy first SystemStep revision and appends cumulative boundaries on the next revision` 命中原 5000ms。没有提高期限、缩减工作量或重跑不变测试刷绿。该失败未归因，不能声称只是主机负载，也不能把 focused 或 App 通过当成全 gate 通过。M3/M4 先前完整测试在同文件另一 legacy case 的失败仍保留为历史证据。

### 两个已修复的真实回归

1. 最初 `frameChild` 的浅复制虽然保留已存在的 bindings Map，却丢失随后惰性建立的 provenance maps 和 scalar blocked state。第一次 M5 完整测试为 **4067 pass / 2 fail / 4 skip**：dynamic map 超时，opaque producer 的消费者被错误复用。独立 focused 复现后，删除 scope copy，把结构父级移到 activation；原测试及当前完整测试中的这两项通过。没有改它们的断言或期限。
2. 刷新按钮禁用自身时焦点落到 BODY，Escape 无效。首轮 App 在 Escape 关闭处超时；独立负控记录 `tag: BODY, inside: false`。刷新现复用导航的先聚焦标题再请求流程，当前真实 App 回放通过。不是改测试迁就旧行为。

首败日志：`m5-frame-first.log`、`m5-frame-runtime-first.log`、`m5-frame-proven-ancestry.log`、`m5-frame-ancestry-context.log`、`m5-frame-canonical-parentage.log`、`m5-frame-inspector-focused.log`、`m5-frame-inspector-app.log`、`m5-frame-refresh-focus-negative.log`、`m5-frame-all-unit.log`。新夹具错误涉及非法 nested return、loop 父级、branch envelope/skipped marker、legacy frame identity，均按现有合同纠正，未弱化已有测试。

## 当前 App 证据边界

现场：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-workflow-node-stop-app-TQHymV`。

- main SHA-256：`52e406201ba2aca76461fde7e0396fc2b6f5e3a2a5b1970ad1af3051787a4a9c`。
- preload SHA-256：`7401b3749b76a59f9c9aa0ef8b2ed6455dd8377e2197ecdf923267225252843d`。
- `frame-inspection.json`、`frame-refresh-focus.json`、`frame-inspector-430.png` 与 `verification.json` 保存读取、布局和版本证据。
- 仍只有原有两次离线 Agent 调用；单目标停止不影响独立 sibling，预算保持 2。Root 最终 `failed`，不伪装为 completed。
- 原有本机 Node actor 一次执行、SIGKILL、ESRCH；两文件 TAP 为 pass 1 / skip 1 / incomplete，discovery/execution/coverage 仍 unavailable。记录查看没有新增 Agent/native 工作量。
- cold 重开复核 frame parentage、原停止 receipt 和没有重执行；两次登记 App closure 各 tracked 4。这不是 escaped descendants 或远端 effects 的完整审计。
- `29dc…` 的旧 main 对应 scope-copy 修正前，已单独保留为失败版本；不能用它替代当前版本验收。复制的现场仅作证据，不是可恢复执行实例。

## 未完成与后续责任

- 完整 unit 的当前 legacy 5000ms 失败仍 open；父会话保留失败。性能实验额度为 0，不新增 profiler/优化实验，不修改 ratchet；继续其他独立功能。
- 尚无完整实例图、frame/output 内容浏览、完整 Recorder/SQLite 投影。当前只能从公开有界行查看已知 canonical frame，不能宣称遍历全部历史。
- Shell、全 coverage、全 renderer 和发布 gate 尚未完成；`providers.catalog` collector 仍 unavailable，不能写为 0/pass。
- M2 需要显式 main-owned TaskSubmission/entry authority；普通 send、workflow 和 template_edit 尚未统一。只读侦察确认生产接线必须真实分解大文件，不能用 global、monkeypatch 或 bootstrap 绕过 20KB 限制。父会话继续该独立工作，不把本子集当成最终交付。
