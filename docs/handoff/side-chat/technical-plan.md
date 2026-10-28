# 侧边会话 · 技术方案

状态：待评审的实现方案。这里的现状来自本次定向代码阅读；未运行真实 Provider，不把已有 API 等同于端到端能力。

## 1. 结论与主要风险

**扩展已有 Conversation + 右侧工作面板，不建立第二套 Agent runtime。** 侧聊是带来源关系和冻结消息快照的持久 Conversation；消息快照不是现有原生 `fork`。

这不是纯 UI 功能。工作主要集中在：

1. 一份可独立保存、可验证、可有界读取的消息快照。
2. Qoder / OpenCode 接入现有统一对话和历史输入合同。
3. 同工作区、不同 Conversation 并行，且发送/停止/审批/归档都不会串线。
4. 两个聊天实例并存，工具面板、草稿、历史、审批都指向正确会话。

首版完成标准仍是五个 Provider 的完整侧聊与并行；分阶段开发不代表可以把未接入的 Provider 宣称已支持。

## 2. 已验证的代码事实

| 现状 | 路径 | 对方案的影响 |
| --- | --- | --- |
| 右侧只有六种固定工具，`openIds` 与 `activeId` 都是工具 kind | `src/renderer/right-surface.ts`、`components/RightSurfacePanel.tsx` | 不能把多个侧聊都塞进一个 kind；需要实例 ID |
| 右侧已有按 scope 保存的状态、宽度与终端保留逻辑 | `src/renderer/hooks/useSessionRightSurfaces.ts`、`app-shell.tsx` | 扩展现有状态，不另建平行面板系统 |
| `ConversationView` 自己读历史/预览/发送，但接收 App 的 `chatProps`，并向外投射当前会话 | `src/renderer/components/ConversationView.tsx`、`ConversationViewBody.tsx`、`app-chat-props.ts` | 不能直接复制渲染两个实例；必须拆分会话级输入与全局展示依赖 |
| 统一对话已有 revision、commandId、continuationKey、分页 read、unknown 语义 | `src/shared/conversation-api.ts`、`src/main/conversation-service.ts` | 复用发送与恢复合同；快照创建也要幂等 |
| `parseTarget` 当前仅接受 Claude / Codex / Pi；legacy adoption 类型也仅三者 | `src/main/conversation-service.ts`、`src/shared/conversation-api.ts` | Qoder / OpenCode 是首版必须补齐的接入，不是改下拉框 |
| Claude / Codex / Pi 声明 historicalContext；前两者有 historyReader，Pi 随扩展路径启用 | `src/main/providers/{claude,codex,pi}.ts` | 能否省略并检索历史要按当前 runtime 能力判断 |
| Qoder / OpenCode 尚未声明上述历史输入能力 | `src/main/providers/{qoder,opencode}.ts` | 新增真实输入转换与合同测试；没有检索器时必须完整带入或明确拒绝超预算 |
| 已有 native fork 复制来源前缀，并保存独立 fork receipt | `src/main/conversation-store.ts`、`conversation-service.ts`、`bootstrap/run-fork.ts` | 可复用持久化模式，不复用其「原生上下文已分支」语义 |
| 统一对话的 admission 会拒绝同 Provider/profile/cwd 的任意未收口运行 | `src/main/bootstrap/run-admission.ts` | 并行要修改正确的执行边界，不能仅解锁发送按钮 |
| managed run 已显式传 resumeSessionId；`run-session.ts` 不把 managed run 写回旧 UI 的全局 session 指针 | `src/main/bootstrap/run-admission.ts`、`run-session.ts`、`run-startup.ts` | 已有隔离基础，保留并补相邻路径回归，不重写全部 runtime |
| Codex 有共享 client 的活动计数，并明确 forceKill 会影响其并发运行 | `src/main/providers/codex.ts` | 停止、historyReader shutdown、通知分发都必须按真实 client/session 所有权审核 |
| 历史交接已有完整正文提取、内容 hash、预算与受限 reader | `src/main/conversation-history.ts`、`conversation-history-reader.ts`、`conversation-handoff-budget.ts` | 复用，不从 renderer 当前已加载的 40 轮或 DOM 拼快照 |
| turn/session diff 使用工作区基线 | `src/main/bootstrap/run-diff.ts` | 并行时无法据此证明独占归因；证据层与 UI 同时标注 |

这些是针对相关函数/小节的阅读，不是全仓库审计。

## 3. 数据模型：在 Conversation 上增加 sideChat

下列为拟议合同，命名以实现时复用既有类型为准：

```ts
type SideChatOrigin = {
  parentConversationId: string
  parentTitleAtCapture: string
  snapshot: {
    sourceRevision: number
    throughOrdinal: number
    throughRunId: string
    capturedAt: number
    manifest: ContentRef // 复用内容寻址引用；正文/清单由子对话持有
  }
}

// Conversation 新增可选 sideChat: SideChatOrigin
// 不复用 fork 字段：fork 表示 Provider 已确认的原生分支。
```

快照 manifest 至少包含：有序消息 ref、角色、原始 run/binding/provider、正文 hash、源 item ref、完整/缺失状态、包含/排除数量和明确的内容类型范围。正文由已有内容存储封存，子对话拥有引用与保留责任；不能仅引用会随父会话删除的 archive 路径。

区别两类证据：

- **snapshot**：创建时冻结的消息事实，全量保存到子对话有界内容存储。
- **delivery coverage**：某次向 Provider 实际内联哪些消息、哪些可通过 reader 检索、哪些没有送达。复用现有 handoff/coverage 合同，不在首轮 UI 中假装 snapshot 全部已进入模型。

继承消息是只读背景，不生成新的 runId、不重复计费/usage、不算侧聊执行轮次。通过历史输入合同交付；新的 Provider sessionId 必须不同于父会话绑定。来源快照不会因为切模型、重新打开、主聊后续完成而重新捕获。

列表继续以 Conversation 为事实源：摘要增加 `sideChat` 来源与状态；查询支持按 parentConversationId 分页。父会话侧栏只取摘要计数，不为每个子侧聊加载 transcript。默认每页 40 项，沿用会话历史分页尺度；具体阈值由现有负载测量复核。

### 旧 Provider 会话

首版把既有 legacy 会话通过现有 adoption 流程获得稳定 Conversation 身份：已有统一对话无额外步骤；旧会话第一次使用侧聊时显示现有接管预览/确认，不静默夺取原生 session 的写权限。扩展 Qoder / OpenCode 的 adoption、continuation identity 和归档读取合同，覆盖空会话、缺归档、原生分支变化。

运行中的 legacy 会话不能在 ownership 尚未安全转移时强行接管。首次接管需要等待其收口；这是一次性迁移限制，UI 必须解释。接管完成后的主聊运行中创建侧聊必须可用。若评审要求历史 legacy 运行中也零等待，应追加稳定源身份映射设计，而不是绕过 ownership 检查。

## 4. 快照创建与首次发送

扩展现有 typed `ConversationApi`，不开放任意路径/命令 IPC：

```text
previewSideChat(parentId, requestedBoundary?)
  -> 已完成边界、sourceRevision、manifestFingerprint、覆盖预览、可用目标

createSideChat(parentId, boundary, manifestFingerprint, commandId)
  -> 持久 child summary（created 或同意图 duplicate）

现有 read / preview / send / update / delete
  -> 操作 childConversationId
```

预览与创建不是两个 Provider 写操作；创建只保存本地事实，首次 `send` 才启动 Agent。

### 创建事务

1. main 验证 sender/frame/origin、项目授权、父 Conversation 可读、请求 schema、父子关系。来源内容始终是数据，不是授权。
2. main 选最近一个 **Provider 已完成、且归档与 managed 证据已收敛** 的成功轮次。主聊正在运行时选择它之前的稳定前缀；不停止主聊、不等待当前轮完成。首版不以失败/中断轮作为默认快照边界。
3. 从权威正文提取用户/助手消息；并非只读当前分页窗口。复用完整读取校验与限额：目前源读取预算 16 MiB、正文预算 4 MiB、2000 轮、单个 handoff artifact 256 KiB。它们是不同层的上限，不能把 4 MiB 塞进单个 256 KiB artifact；用现有内容存储持有正文与有界 manifest/页面，超限明确拒绝，不放宽已有上限。
4. 保存不可变 manifest / 内容引用，再以原子写提交 child + sideChat 来源 + 创建 receipt。只有两者完整可读才发布 child。孤立的未发布内容由现有内容保留/回收机制处理，不自行引入后台扫描器。
5. 幂等键为 commandId + intent hash。同 commandId、不同来源或边界拒绝；重复请求返回原 child。IPC 回执丢失先按 commandId 只读核对，不创建第二个 child。
6. 主聊从 revision 8 增到 9 不应导致既定第 8 轮快照无法创建。对 **冻结前缀 fingerprint** 重验，而非要求最新 revision 一直相等；父会话删除、来源前缀变更或权限撤回必须拒绝。
7. 无已完成边界、正文缺失或预算不足：返回可解释失败，不自动建空侧聊。缩小范围必须让用户确认新的覆盖预览，不能复用旧 fingerprint。

### 首次发送与后续轮次

- `send` 复用 expectedRevision / expectedContinuationKey / commandId；sideChat 首次没有父 nativeSessionId，只能新建自己的绑定。
- 默认 target 复制创建时来源配置，但发送前重新解析当前能力、权限与 fingerprint。Pi 的 full_access 规则、仓库 MCP/Hook/plugin trust、认证互斥均不变。
- 快照通过 `ProviderHistoricalContext` 输入一次。resume 后不能每轮把整份快照再拼进 prompt；切换 Provider 时沿用现有 coverage planner 补齐应交接内容。
- 历史正文带明确角色和来源边界，不能伪装成 system instructions；不含原生工具回放、附件字节或隐藏推理。原始历史里的命令不会被 Scry 自动执行。
- 无 historyReader 的 Provider：能完整带入才发送；超预算给出原因与重新选择范围的入口，不静默降级成空上下文。支持 reader 时 token 只允许访问该 child 冻结的消息集合，不允许读父会话未来新增内容。

## 5. 并行运行：缩小冲突域，不删除保护

```text
现有：Provider + profile + cwd 下有未收口 run => 统一对话全阻塞
目标：相同 Conversation 或相同 native session => 继续串行
      同 cwd 的不同 Conversation / native session => 可以并行
      身份未确定 => 先登记 child + run reservation，不能抢用全局 resume
```

### 必须检查的调用链

`ConversationService.send → run-frontdoor → run-execution → run-admission → run-startup → run-provider / adapter → run-session → run-completion / run-settlement / managed-turn-commit`

1. Conversation mutex 保留到派发意图登记完成；native session 写入使用 `(provider, profile, canonical cwd, nativeSessionId)` 唯一所有权。同一个原生 session 被两个逻辑对话别名指向时仍拒绝并发。
2. context admission 的工作区锁只覆盖必须原子的检查/登记，不覆盖完整 Agent 执行。不能直接删掉 `contextRuns.length` 后假装并行已安全；认证、删除、工作区切换/准备、trust、session ownership 仍要分别保护。
3. 发送目标从 immutable run context 来，不能读取当前选中页签、当前 Provider 或旧 `sessionByContext`。审查 startup、恢复、失败、完成路径，保留已有 managed run 不更新全局旧会话指针的行为。
4. client / process 复用按能力检查，尤其 Codex：事件按 thread/turn/run 路由；一个 run 取消不能关闭其他 run 共用的 client。不能确认安全复用时，给每个独立运行建立其自有 transport，不能用重试掩盖串线。清理 historyReader/client 必须等自己的所有者释放。
5. 停止、权限应答、用户问答都携带 runId 与请求 ID，并由 main 重验归属。页签切换后原审批仍属于原 run；同 Provider 也不能「顺手批准另一个侧聊」。
6. App 自己的 source-control destructive 操作继续遵守现有 commonDir reservation；不承诺拦截 Provider 在 shell 里自行执行的 Git 写操作。UI 只说明风险，不展示虚假的文件锁。
7. 每个 run 的 recorder 两阶段提交继续等待它自己的 Provider result/hook/diff 收敛。主聊完成不能提前完成侧聊；侧聊失败不能把主聊的 record 改成失败。

### 证据与 diff

- tool call / usage / cost / native session evidence 用 run/session 身份归属，快照来源不重复计入子侧聊。
- before/after diff 表示工作区变化，不天然是某 run 的独占改动。记录同 canonical cwd 的重叠 run IDs 与观测时间区间；重叠关系从开始基线到证据捕获结束计算，不只比较文字流结束时间。
- 沿用证据 provenance/envelope，加入工作区并行提示。可精确记录「观察到哪些变更」，但作者归因只能 partial/inferred；没有证据时 unavailable，不能自动断言冲突或无冲突。
- 外部编辑器、用户命令不在 Scry run registry 中；即使没有已知重叠 run，也不能因此宣称独占归因。恢复后缺重叠区间记录则标 unknown。
- 不能用暂停 recorder 或跳过 diff 换取并行；新增证据字段需兼容旧档案并保持 Recorder Core 无 Electron/SQLite/SDK。

## 6. Renderer 与右侧面板

扩展已有 `RightSurfaceState` 的页签标识为工具 ID 或 Conversation 实例 ID；保留工具定义注册表，不为侧聊另建通用插件框架。

```ts
type RightSurfaceTab =
  | { type: 'tool'; kind: RightSurfaceKind }
  | { type: 'side-chat'; conversationId: string }
```

- 稳定 ID 持久化，renderer 只存布局与活动页签，不存第二份会话正文。
- 旧保存状态迁移：固定 kind 转 tool tab；非法/已删除 child 丢弃并回到邻近有效页签，不创建幽灵会话。
- scope 使用父 Conversation ID，不能按 cwd 合并两个不同主会话；已有工作区/终端 scope 迁移逻辑保留。
- 一次最多恢复 8 个打开页签，更多侧聊走分页历史入口。持久会话不受此展示上限删除。只挂载活动侧聊正文；父主聊仍挂载。已有终端 retain 逻辑不受影响。
- 从 `ConversationView` 拆出确有复用需求的会话级 props / controller：target、draft、history window、run、send/stop/approval、selected turn 都属于 conversationId。不要把整个 App store 复制两份。
- `onProjection` 不让侧聊覆盖主聊的全局投影。文件引用应送到明确选定的 composer；右侧工具页签固定指向主聊的纵览/diff，侧聊证据在自身 turn 中查看并标标题。避免切到工具页签时悄悄换上下文。
- 活动 child 的少量 trace 订阅按帧合并；不活跃 child 只消费摘要/待处理状态，不把所有 transcript 常驻 DOM。卸载正文不停止运行，草稿在现有 ComposerDraftStore 中按 child id 留存。
- 当前运行只由主进程登记；render busy 不能来自「本工作区是否有任意 run」。关闭/切换只是视图动作，停止是独立操作。
- UI 文案加入 `src/renderer/constants/copy.ts` 或该模块的既有字典；Lucide 图标与当前组件沿用，不加新 UI/状态/分栏依赖。
- 新 IPC 使用 handleTrusted，补 `scripts/performance-paths.json` 分类。纯布局切换不得触发 Provider 重连、重新读整份归档或捕获新快照。

## 7. 保存、删除、恢复

1. 创建后的空侧聊也持久化；标题与 archive 沿用 Conversation metadata。
2. 关闭页签不写删除状态；退出 App 不抹除侧聊。重启恢复页签和草稿，原 run 通过既有恢复判定，不把崩溃前 running 直接恢复为 running/成功，也不自动发送。
3. 删除父会话默认不级联子会话。子快照继续可读；来源链接显示「来源会话已删除」与冻结标题。历史侧聊入口能检索这些独立保留的 child，不能因为父行消失就不可达。
4. 删除子会话按已有 deletion preview / fingerprint / sharedWith 计算资源引用；其他 child 或主会话使用的内容不可删。缺引用信息则拒绝回收，不能猜测。
5. 未知发送回执、创建回执与 native session 绑定沿用可核对状态。恢复只读核对，用户明确的新意图才生成新 commandId。

## 8. 实施顺序与验收门槛

| 阶段 | 交付 | 门槛 |
| --- | --- | --- |
| A 快照与持久化 | sideChat 合同、冻结正文、幂等创建、父子生命周期 | 主聊继续追加仍不改变快照；删除父会话后 child 正文仍在；创建回执丢失不重复 |
| B 五 Provider 历史输入 | Qoder / OpenCode target/adoption/input 接入，五者 coverage | 本地 adapter contract 验证真实入参而非 capability 布尔值；完整输入/预算拒绝都覆盖 |
| C 并行执行边界 | 精确 admission、transport/session 隔离、单 run 控制、证据范围 | 两个真实本地测试进程交错事件仍不串线，同 session 并发拒绝；杀/停一个不影响另一个 |
| D 双聊天与页签 | 右侧多实例、scope 恢复、独立草稿、审批/错误/窄屏 | 当前构建的独立 Electron test 实例中重放双输入框与真实坐标交互 |
| E 集成与交付 | 五 Provider 验收记录、性能测量、打包安装 | 不用模拟 Provider 的通过记录代替真实 Provider 验收；明确成本/账号授权后再跑真实探针 |

### 必须留下的最小回归集

- **快照稳定**：第 8 轮作为边界，第 9 轮运行中创建；第 9 轮后来完成、父正文分页/切换后，child 的 hash/消息集合不变。
- **完整性**：消息在未加载的历史页中仍被纳入；附件、推理、工具状态不伪装已复制；缺正文/超限不产生看似完整的空会话。
- **幂等**：同创建/发送 commandId 回执丢失；只读恢复到同 child/run；intent 改变拒绝。
- **隔离**：同 Provider、同 cwd，父与两个 child 各自 session；交错响应、审批、停止、失败、完成、hook/record 不串线；原生 session alias 冲突仍拒绝。
- **生命周期**：关闭运行中页签不中止；切换父会话/Provider 后保留正确 draft/审批；重启不自动续发；父删除不破坏子快照。
- **预算与安全**：伪造 child ownership、source ref、path、revision、reader token；生产 IPC wrapper 拒绝且特权 listener 未执行；新 Provider trust gate 不退化。
- **证据**：两个 run 重叠修改工作区，UI 与持久记录不标独占归因；快照历史 usage 不双计；未收敛不得提前保存成功。
- **交互**：键盘页签/焦点恢复/中文 IME、长标题、40+历史侧聊、滚动不互相抢焦点、400 px 右栏、窄窗、浅深主题。

负向对照：保留旧 workspace-wide admission 时，双会话启动测试必须失败；故意把 child resume 改为 parent session 时，身份/响应隔离测试必须失败；故意只保存来源 archive 路径时，删父保子测试必须失败。测试不能只断言 UI 出现两个面板。

### 实现时执行的现有命令（本轮未运行）

- `npm run test:unit -- <本次新增及受影响测试文件>`，选定真实文件后执行，不把占位参数直接交给 shell。
- `npm run typecheck`、`npm run build`。
- `npm run test:conversation:ipc`；受影响 renderer fixture 与 `npm run test:renderer:ui` 按跨边界范围执行。
- 修改热路径后 `npm run performance:measure`；毫秒测量按仓库 timing-run 锁串行执行，逐项解释 worse，不手调门限。
- Provider 探针默认关闭；获明确账号/费用授权后，在临时 workspace/HOME/userData 中逐一验证五 Provider，最后确认进程收敛。
- App 实现通过验证后按仓库约定 `npm run install:mac:dev`；本轮只是独立设计稿，不安装或替换 App。

本轮原型验证与待评审事项统一记录在 [设计说明第 8–9 节](./README.md)，不代表上述 App 实现或真实 Provider 验收已完成。
