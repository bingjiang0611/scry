# Main-owned TaskSubmission：default-off/direct 子集

本检查点实现普通桌面对话入口的 TaskSubmission，不代表完整 M2 或 M1–M6 交付。没有新增真实模型、账号、费用或 authoring capability。

## 实际接线与事实源

`ConversationView` 的 `window.scry.conversations.send` 经原有 trusted IPC，进入显式组合的 `createDesktopTaskEntry`，再调用同一 ConversationService、ConversationStore 和 App executor。旧 sender/frame/origin、workspace、native ownership 和 repository trust 校验保留。

- Main 解析输入并确定来源；renderer 不能提交 source、policy 或执行回调。这里的 desktop 来源不是物理键盘/人工身份认证。
- App-owned `conversation-submissions-v1/<conversation>/<submission>.json` 保存不可变输入引用、请求控制、上下文和分支状态。输入正文使用既有内容存储和完整性校验分页，保留未裁剪原始 goal、所选引用及图片元数据/摘要，不存任意路径或原始图片正文。
- 所有新提交在 Store admission 前冻结 size；无效 workflow 设置记录为 unavailable，不阻断 off 模式普通发送。旧 durable command 不补造当前设置或 TaskSubmission。
- 同一 Store、同一 admission/ownership state 保护 `captured → dispatch_intent → associated`。本子集仅执行 direct。unknown 可以补充已有 canonical turn 的引用，但不能重开分支或自动重发。
- 关联 run ID 只证明预约/持久化 turn 引用，不证明 Provider 已进入、业务成功、settlement 或物理退出。
- Main 在实际 Provider dispatch markers 和 Registry.run 之前等待私有重验回调。回调重验 canonical workspace/inode、当前 native continuation identity 及最新任务 fence。
- 内存 receipt 只合并重复请求。它不是执行 authority，也不证明当前存活。合并在首次 await 前注册，防止较慢 metadata 读取让后来的 replay 抢占首次 fresh-context acknowledgement。

当前上下文记录请求的 model/effort/permission 等控制及 native continuation key；它不是完整已解析 model、账号、凭据或配置快照。当前 policy 固定为 off，没有模式设置 UI。

## 本轮验证

证据工作目录：`/tmp/scry-workflow-task-entry.V7ObQf`。原 deadline、断言和工作量均未放宽。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Node/web types、相关单测、build | 14 文件、147 测试通过；build 通过 | `ordering-current-gates.log` |
| 并发顺序负控 | 精确恢复旧 controller SHA 后，新增受控读取断言失败：读取 2 次而非 1 次；随后恢复修复 | `ordering-negative.log`；仅过滤此测试，其余 14 项未执行 |
| 实际 Main effect-boundary 负控 | 缺少 Main await 时，已关闭 fence 仍进入一次测试 adapter；不是仅检查回调参数 | `main-boundary-control.log`、`boundary-control-result.json`；保留 qgsIHy 场景 |
| 当前构建隔离 App/生产 IPC | 原 6 个 ownership 拒绝向量、正对照、直接提交、重复提交、无效 size、晚 fence、冷观察通过 | `ordering-current-app.log`；hwzMv7 场景 |
| 真实效果与预约区分 | fenced API 可先返回 created/runId，但实际新增 adapter 调用为 0，canonical delivery 为 not_sent，unknown 不重开 | 同上；普通两条任务各一次 adapter，无额外 routing call |
| 当前产物绑定 | main SHA `d7da937beb6feeaa3b63e3d2f7b20cfe1e2443065a54b067c251de47a61326ee`；preload SHA `84f4e880cdc754535dc69474763d829c873cbd8fc4aadea8fab0d9876be8c27f` | `ordering-current-app-identities.json` |

单测使用真实临时 Store 文件、受控 admission 和模拟 executor；App 使用既有测试 Provider，不是真实 SDK/模型验收。受控案例包括丢失 publication ACK、冷 intent/unknown 不重发、目录 inode/native identity 变化、独立任务、完整大正文分页/损坏拒绝，以及未确认 fresh 请求可显式修正。

App 使用独立 userData 和合成 workspace。原 stopOwnedApp helper 返回已记录；不据此声称 escaped descendants、全机器或远端效果全部闭合。当前 App 证明生产 IPC 路径，不证明人工点击、完整可访问性或所有 workflow UI。

## 保留的首败与限制

- 第一轮 types 的日志目录丢失使 tee 失败；compiler 的原始工具结果单独保留。未为取回输出重跑。旧 `/tmp/scry-workflow-template-editor.ZnkC6L` 消失原因未知，已有冻结 archive 未改写。
- 新测试初次 mimeType 推断导致 types 失败；修正显式请求类型。随后并发测试暴露 fresh acknowledgement 顺序问题；最终以受控首次读取负控证明并修复，未删除断言。
- 初版测试 gate 的 watcher 类型错误已修复。第一次产物 identity 比较误将旧 manifest 未包含的测试路径列入差异预期，断言在 App 启动前失败；修正比较范围，并只为当前测试新增 hash，不重建历史 hash。
- 之前已通过的 UixEkx App 是修复合并顺序前的历史检查点，不替代 hwzMv7 当前构建。
- 先前完整单测 SystemStep 5000ms、两个 expanded recovery 5000ms、实际 App Node TAP 5000ms、ConversationStore unified fixture 的 Node command 2000ms 失败仍开放。此次 ownership-only 验收没有重放 unified/system 全链，也没有证明这些失败无关或已解决。
- `send.codex-fixture` counter collector 仍 unavailable。只补全现有 source catalogue，未改 workload、collector、指标或 ratchet；未做新的性能实验。计时元数据 highLoad=true，不作速度或负载因果结论。

## 后续范围

父会话继续实现 typed command/source authority、真正的 off/manual/auto policy 与数据/费用授权、一次 combined route+plan、production authoring-purpose 和 canonical candidate 消费、workflow/template 分支及生产 UI。不得将固定 off 和 direct 分支 guard 称为这些能力已完成。

用户随后明确要求忽略本机无法使用的 Claude CLI。因此不下载、不升级、不再执行其原生验收；既有失败保留为未通过，不转换成成功，也不作为继续其余离线实现的前提。真实 restricted authoring 的原始 8000ms SDK 探针与后续协议诊断均失败；不得从 option factory、模拟 SDK 或本次测试 Provider 推断 native tools-disabled/StructuredOutput enforcement。原 deadline 和隔离不放宽。其余 M3–M6、完整 gates 与源文件体积限制也未完成；`src/main/index.ts` 仍超过 20,000 bytes。当前不提交、不推送、不安装、不升版本。
