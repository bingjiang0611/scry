# Scry 统一会话内跨 Provider 接续

**用户已选择：统一会话内切换 Provider。** 不采用此前“另开目标会话”的产品方案；旧方案保留在 Git 历史 `09de750`。源码依据见 [T3 核查](t3-provider-handoff-implementation.md)。

**当前进度：身份/覆盖账本与准入基础已实现并做定向测试；尚未接入实际发送和 UI，不是可用的完整接续功能。**

## 1. 用户合同

```text
统一对话 C（同一个侧边栏条目、稳定 conversationId）
  ├─ 第 1–3 轮：Claude / 原生会话 A
  ├─ 第 4–6 轮：Codex / 原生会话 B，接收选定历史
  └─ 第 7 轮：恢复 A，补入 A 尚未收到的历史
```

- 统一的是 App 对话，不是把 A 的 native session ID 交给 B。
- 切回同 Provider、同 Profile、兼容原生上下文时优先恢复其原生会话。不能证明兼容、原生身份已失效或交接结果未知时，不偷偷新建/重发来伪装恢复成功。
- 新建原生上下文需要明确说明和用户确认，但仍属于同一个 App 对话；旧原生绑定和历史不能覆盖掉。
- 暂停、审批、背景工作与进程所有权按实际 Provider 保留。切换不意味着自动终止源任务，也不是安全沙箱。
- 第一版目标为本机桌面、同一工作区。远端/手机、跨工作区迁移和多 Agent 编排不在本项范围。

## 2. 身份与数据权威

| 身份 | 用途 | 不得混用 |
| --- | --- | --- |
| conversationId | App 统一对话、侧边栏、草稿与轮次顺序 | 不作为 Provider resume 参数 |
| bindingId | 某一 Provider/Profile/兼容身份下的一代原生上下文 | 同 Provider 的不同账号/Home 不能据名称合并 |
| nativeSessionId | adapter 对应的真实恢复目标 | 重建后保留旧代，不原地替换其覆盖账本 |
| runId / ordinal | 一次实际尝试 / 在统一对话中的顺序 | runId 保留现有 trace、recorder、计费关联 |
| itemId + contentHash | 实际可见内容的不可变引用 | 同名但不同正文不是同一个已投递条目 |

现有 Provider archive、原生 transcript、`.scry` records 和 usage ledger 继续保留各自权威性。新 conversation store 只持有绑定、轮次引用、选择与投递证据，不复制旧工具事件或用量成目标 Provider 的新工作。

`nativeItems` 和 handoff 覆盖表示**有证据的历史投递/原生输出**。它们不保证模型在原生 compaction 后仍完整保留这些文字，也不保证模型遵循了它们。

## 3. 已落地的第一阶段

### `src/shared/conversation.ts`

- 区分统一对话、原生绑定、已有历史引用与新投递尝试。
- 原生复用必须同时匹配 provider、profile、main/adapter 提供的 continuationKey。
- 规划 fresh/resume/blocked；不以“最近已见 ordinal”代替逐条覆盖。
- 省略项不计入已接收覆盖；切回目标时仍能找出早期遗漏。只消费 confirmed acceptance，不从 pending/unknown 猜测成功。
- 已明确弃用的原生绑定不再被选择为 resume 目标。

### `src/main/conversation-store.ts`

- App userData 下的原子持久化；复用现有原子文件 helper，不使用新数据库或依赖。
- 从已有权威历史接入时只导入引用，不调用 Provider，也不修改其原生历史。
- 每次 begin 持久化 intent、预分配 runId、原生恢复目标、精确选择和省略引用。
- commandId + 冻结请求指纹持久去重；同 ID 不接受不同请求。重复结果返回 `duplicate`，调用方不得再次启动 Provider。
- revision 拒绝陈旧预览；每个对话内写入串行；读回验证身份、轮次、跨引用和状态。
- 恢复只在 startup barrier 内、尚未开放新发送时执行；保留已登记 live run，没有 owner 的 pending 转 unknown，不重放。运行中的结果核查走明确的 settle 证据路径。
- 终态失败也可能有明确 input acceptance：失败状态与已投递覆盖分开保存。反之，能证明未发出的失败不扩张覆盖。
- Provider 返回与 resume 目标不同的 native ID 时拒绝继承覆盖。只有已收敛状态可显式弃用绑定；弃用不能抹掉 unknown 屏障。

**边界**：store 接受的 acceptance、nativeItems、source 身份必须由后续 main/adapter 权威调用方证明。当前测试中的证据输入是 fixture，不是真实 Provider 回执；store 自己不证明远端接受，不提供 workspace authorization，也不保证跨进程写锁。

索引仅含元数据与引用，单文件上限 16 MiB，损坏/超限拒绝而非变成空历史。所有写入原子替换；仅支持单个 App main owner。若真实长会话触顶，再迁移为有 manifest 的分轮文件/索引，不自动截历史或仅调大限制。

### `src/main/context-admission.ts`

增加 `runMany()`，一次性登记全部身份的等待链，再等待前序操作。现有 `run()` 共用此实现。反向 A→B / B→A 不采用嵌套单 key 锁，互不相关的会话不被全局锁阻塞。

这只是准入 primitive。后续主链路必须实际传入 conversation 和 native binding 身份，并与普通启动共用；尚不能宣称统一会话已经获得运行期互斥。

## 4. 下一步：接入正常执行，不建立第二个 runner

### 4.1 显式目标替代全局“最近 session”

当前 `sessionByContext` 以 Provider/Profile/cwd 为 key。不同统一对话可能在同一工作区使用相同 Provider，不能从这里猜 resume。

新增统一会话请求需要携带 conversationId 与预览 revision；main 从账本解析具体 binding/native ID。请求的 resume 目标与 Provider 返回身份都要重验。legacy 单 Provider 请求仍沿用现有合同，不通过清空全局 context 去偷偷抢占其他对话。

同一 conversation 只允许一个未收敛普通轮次；原生 writer 也须独占。采用 conversation + scoped native owner 的多 key admission，并复用现有 provider operation gate、run registry、Git 写互斥、shutdown 与 trust/fingerprint。

仅释放 session transport 或收到 unsubscribe acknowledgment 不是原生 writer 已释放的证据。共享进程、后代任务与停止范围由 adapter 决定，不能粗暴杀掉同一 Provider 的其他对话。

### 4.2 原始用户请求与历史上下文分开

已检查到下列真实分派路径，不能统一在 prompt 前面拼历史就结束：

- Codex 从原始 prompt 识别显式 Skill，再构造 native input。
- OpenCode 将 `/command` 分派到 command API，普通文本走 prompt API。
- Pi 有原生 extension command 与 prompt 分流。
- Qoder 有 `/plugins reload` 和项目命令展开。

因此应在 `ProviderRunRequest` 中分开**原始用户输入**与**已确认历史上下文**。adapter 先按原始输入识别命令/Skill，再在支持接收历史的模型输入边界组合；不能让历史中的旧命令被再次执行，也不能破坏本轮真实命令的语义。

不接收历史的控制命令在有待交接时明确拒绝或要求先完成普通轮次交接，不静默当成普通文字。第一版不假装所有 Provider 支持 native history injection；文本交接也必须标出来源与投递方式。

### 4.3 真正的投递证据

- 新建原生 session 返回 ID 不代表 prompt 已接收。
- `return runId` 只代表 App 建立了尝试；不能据此清除 unknown 或更新覆盖。
- 每个 adapter 必须区分已接收、明确未发出、未知，并与最终归档收敛关联。单纯超时或 promise reject 不代表未发送。
- 现有 `CommandReceipts` 仍处理本进程重复请求；跨重启由 durable conversation intent 约束，不能让其“失败撤销收据”的行为触发第二次外部投递。
- unknown 的普通恢复只读核查原 run/archive/native 证据。第一阶段不提供人工把 unknown 改成成功的入口；后续若提供“已停止后新建上下文继续”，必须分别记录执行已收敛、用户新决定与原投递仍未知，不能删除旧证据。

## 5. 历史选择与预算

- 从 main 权威归档取得可见用户/助手文字、轮次状态及明确来源，不拿 renderer 最近 40 轮缓存冒充全部历史。
- 不导出 reasoning、原生工具协议、approval、背景 task handles、Hook/MCP 配置或凭据。不默认转发旧图片、完整 diff 或原始工具输出。
- 正文引用只有拿到全文才标完整；不能把 bounded preview 当成全文。delta 与 final shadow 要按真实投影去重。
- 选择以完整条目为单位，保留代码空白、角色和顺序。实际正文、hash、字节数及省略项先持久化，再产生引用它的 intent；本阶段账本尚未实现正文 artifact。
- 初始载荷建议上限 32 KiB UTF-8（含包装）；读取上限建议 2,000 轮或 4 MiB 提取文字。触顶显示未读/省略范围，不能伪造完整或精确 omitted 数量。
- 这是产品上限，不是 token 数或模型窗口保证。目标容量未知时不编造 128K；当前用户请求绝不为历史让路而被截断。
- 源关键条目放不下时需要用户减少选择或明确补充说明。第一版不调用另一个模型自动“总结并补全”事实。
- 引用 ID 和“打开源轮次”链接仅代表用户可查阅。没有真实 Provider-facing 检索工具时，不承诺 Agent 能找回省略全文。

## 6. 混合历史、迁移与现有动作

- legacy 单 Provider 对话惰性接入为一个 logical conversation + 一个 native binding，保留原 session/run ID。先写可恢复的接入记录，再切换 catalog 引用；失败保留原入口，不能消失或出现两个可独立写入同一 native session 的假副本。
- conversationId 成为侧边栏与 composer draft 的稳定身份；切 Provider 不切到另一个侧边栏条目。
- 每轮 provider/profile 来自该轮 binding，而不是顶部当前选择。分页按统一 ordinal，正文仍由各 Provider archive 加载。
- stop、retry、fork、文件证据、后台任务和诊断均按真实 run/owner 路由。不能把旧 Claude 轮次的 fork 交给当前 Codex adapter。
- 汇总以唯一 runId 连接现有 usage；不能为统一 UI 复制原生记录或再次记账。
- 归档/删除统一对话必须涵盖它的全部绑定与尝试，遵守现有 active-run 和 partial deletion 合同；删除 App 副本不等于删除 Provider 原件。
- rename/pin/archive 等会话级操作迁到 logical identity。未完成这些相邻路径前，不解锁 Provider 切换作为交付。

## 7. 验证记录与后续 gate

当前已执行：

- 新 conversation 测试覆盖：A→B→A、遗漏项再次补齐、Profile/兼容身份隔离、内容 hash、持久双击去重、陈旧预览、并发写入、重启 unknown、落盘后回执丢失、明确拒绝与已接收失败的区别、原生 ID 漂移、显式弃用与重建、损坏日志、调用方引用隔离。
- 准入测试覆盖：反向多 key、单 key owner 与多 key waiter 的顺序、独立对话并行、拒绝后全部释放、重复 key、空 key 拒绝。
- 已做真实负对照：临时移除 provider/profile/continuation identity 中的后两项保护，身份隔离测试确实失败；随后恢复生产保护。
- 第一轮另有一个测试 fixture 失败：`structuredClone` 保留 `items/nativeItems` 的共享引用，错误注入同时改了两处。已改为只替换 nativeItems 的引用，保留原拒绝断言；不是调整实现来接受坏证据。

最终定向检查：`npm run test:unit -- src/main/conversation-store.test.ts src/main/context-admission.test.ts src/main/session-fork.test.ts src/main/command-receipts.test.ts`，**4 文件、43 测试通过**；`npm run typecheck` 的 node/web 均通过，`npm run build` 通过。负对照曾使身份隔离用例按预期失败，恢复保护后重新通过。

当前无 UI、真实 Provider 或真实用户数据验收。除现有单 key 准入共用新 primitive 外，conversation store 尚无生产调用方；build 不代表这些新模块已进入可用功能。以上检查只证明本阶段模块及相邻准入不回归，不证明整个跨 Provider 工作流。

后续至少要验证：

1. 实际 main/preload 请求下，A→B→A 的 provider/resume/prompt/历史正文精确匹配，取消和预览零启动。
2. slash/Skill 分派不被历史前缀改变，旧命令不重放。
3. 双击、原生 ID 漂移、接收后失联、重启恢复、共享 writer 未释放及旧确认失效。
4. 生产 IPC wrapper 拒绝跨项目/伪造身份/错误 sender/frame，特权 listener 未执行。
5. 混合历史重开、分页、停止、fork、草稿、统计和删除使用真实 owner，来源与费用不双计。
6. 隔离真实 App 原生输入 fixture；经账号/费用授权后再验证 Claude↔Codex 与实验性 Provider。不能以 mock transport 冒充真实外部能力。

接入跨 IPC、Provider 与持久化主链路后运行仓库完整 gate；本阶段不构建安装包、不升版本、不启动真实 Provider。
