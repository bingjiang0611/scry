# Conversation 请求解码与派发协议拆分

## 边界

这是 M2 主入口的前置职责拆分，不是 TaskSubmission、off/manual/auto 或组合路由已经完成。仍保持原调用链：trusted IPC → ConversationService → 同一个 ConversationStore / App executor。未增加 SDK loop、调度器、全局状态或新的 IPC。

当前工作区基线为 `c9386b60c8487b0886a0d2c6594d51c050169d58`，分支 `feat/workflow-m0`。本节描述未提交候选的有界验收，不是发布记录。

| 文件 | 职责 | 字节 |
| --- | --- | ---: |
| `src/main/conversation-service.ts` | 对话 authority、target、preview、fork、读取与 Service-owned active Set | 15652 |
| `src/main/conversation-request.ts` | 原 request/target/send 解码；公开复用同一 `parseConversationSend` | 4244 |
| `src/main/conversation-send.ts` | 原 reservation、handoff、receipt、dispatch、terminal 与异常收敛协议 | 12019 |

`sendConversation` 取得原 Store、能力查询函数、App executor、绑定原 Service 的 target resolver，以及原 active Set。没有复制 Set，没有重新创建 Store，没有把运行状态移入模块级变量。`parseConversationTarget` 的原 Service 导出保留。普通发送仍在 reservation 前拒绝 slash-leading prompt；这次没有偷偷加入命令或路由解释。

`send.sources` 纳入两个迁出文件。未改 metric、operation、benchmark、工作量、基线或 ratchet。

## 实际验证

所有检查在当前工作区执行；真实 App 检查使用独立 userData 和合成工作区，没有安装或重启日常 App。

| 检查 | 结果 | 可读证据（临时证据根内） |
| --- | --- | --- |
| Node / Web 类型检查 | 通过 | `m2-conversation-service-first-types.log` |
| 原 Convo focused tests，11 文件 | 117 通过 | `m2-conversation-service-focused.log` |
| AST 结构等价，含完整 send body 和原 owner 注入 | 22 项通过 | `m2-conversation-service-equivalence.cjs` / `.json` |
| 负控：仅在临时副本把 active Set 换成 clone | 等价检查按 owner 断言失败；当前源文件未改 | `m2-conversation-cloned-active-negative.log` |
| 生产 conversation ownership / unified fixture，含构建 | 通过；阻断 6 个 ownership 场景；unified 为 3 轮、21 次离线 Provider invocation | `m2-conversation-service-production-gates.log` |
| 当前构建的 workflow App 原场景 | 通过；仍为 4 次离线调用；停止、原生检查、TAP、frame、policy、size 与冷观察保留 | 同上；当前 scene 的 `verification.json` |
| performance catalogue / feedback，2 文件 | 15 通过 | 同上 |

源码等价检查明确投影 `this.deps → deps`、`this.active → active`、`this.target → resolveTarget`，以及原 decoder 名称。还核对 Service wrapper 的真实注入和其他保留方法。它不是额外 async 边界的计时证明，也不是 SDK 执行或 IPC trust 的替代证据。

当前 App scene：

`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-workflow-node-stop-app-C3stLu`

- main SHA-256：`2ea1634aa7d48bcb5eaa989c8f1decb3b08a590a461994faf09f3e18c246482f`
- preload SHA-256：`84f4e880cdc754535dc69474763d829c873cbd8fc4aadea8fab0d9876be8c27f`
- workflow fixture 的三个 registered-resource closure 各报告 tracked 4；不代表 escaped descendants 或远程业务 effect 的完整闭合。
- size 场景前后离线调用数仍为 4；没有为读取或改偏好多调用规划器。

日志根：`/tmp/scry-workflow-template-editor.ZnkC6L/`。首次静态目录查询曾有临时 Node 命令括号语法错误；修正后只读取 catalogue，没有重放业务动作。没有修改生产源码来迁就该查询。

## 未关闭事项

- 这次没有真实 SDK、Provider 账号或费用验收。离线 App 结果不能证明真实 Provider transport。
- `send.codex-fixture` 仍没有 counter collector。先前实际命令返回 `No counter collector matches send.codex-fixture`；本次没有改 collector 或重试同一缺口。不可记为 0 或计数通过。这里没有速度声明。
- 先前默认完整 unit 的原 SystemStep 5000 ms 失败，以及扩展 M2 检查的两项 native recovery 5000 ms 失败仍开放。没有重跑它们刷绿；本次 117 tests 不是完整 gate。
- `src/main/index.ts` 仍为 229879 字节，不能满足 authored blob 20000 字节约束。本次不是 staging-ready 或完整 M2 交付。
- main-owned TaskSubmission、命令 source、独占 durable dispatch、组合 route+plan、明确的数据/费用授权与真实 tools-disabled authoring capability 仍需实现和验收。不得从本次 decoder 导出或前次 SDK `settingSources: []` 修复推断这些能力已存在。

源码、负控和实际 App 证据应冻结到新的 failure-aware checkpoint；既有 [Claude checkpoint](claude-settings-source-status.md)、[size checkpoint](size-guideline-status.md) 及其 archive 保持不变。
