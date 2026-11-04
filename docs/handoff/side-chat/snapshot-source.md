# 侧聊来源与消息快照合同

状态：已按用户确认改为只读来源，不要求迁移主会话；以下为待实现合同。参见 [技术方案](./technical-plan.md)。

## 1. 不接管主会话

无论主会话由 Scry Conversation 管理，还是直接关联 Provider 原生 session，创建侧聊都只读取它的已完成消息。不调用 `previewAdoption/adopt`，不创建父 Conversation，不改变父 session 的 ownership、resume 指针或正在运行的控制对象。

例如：主聊第 9 轮运行中，侧聊冻结截至第 8 轮的已完成消息；主聊第 9 轮继续走原执行链路，侧聊首次发送创建自己的 Provider session。两者的后续消息不自动同步。

已有 adoption 的等待与写权限保护保持原样；侧聊不走该写入操作，而不是绕过它。Qoder / OpenCode 仍要补齐子对话 target、历史输入与来源读取，不再为侧聊扩展父会话 adoption。

## 2. 来源标识

以下为拟议 shared 合同，复用现有 ProviderId、profile 与原生 session scope 字段校验；不从 shared 引用 main 类型：

```ts
type SideChatSource =
  | { kind: 'conversation'; conversationId: string }
  | {
      kind: 'native-session'
      providerId: ProviderId
      agentProfileId?: string
      cwd: string
      nativeSessionId: string
    }

type SideChatOrigin = {
  source: SideChatSource
  parentTitleAtCapture: string
  snapshot: {
    prefixFingerprint: string
    throughOrdinal: number
    throughRunId: string
    capturedAt: number
    manifest: ContentRef
  }
}

// Conversation 新增可选 sideChat: SideChatOrigin。
// 不复用 fork 字段；fork 表示 Provider 已确认的原生分支。
```

main 验证来源存在、项目可读权限及 Provider/profile 归属，并将 cwd canonical 化。原生来源的稳定查询键复用 `(providerId, agentProfileId, canonical cwd, nativeSessionId)` 身份规则；不能只用 cwd、标题、当前选中项或运行中的临时 runId。来源 ref 是定位信息，不自行授予读取权限。

已有统一对话以 conversationId 为父 scope；原生来源以校验后的复合身份为父 scope。侧栏、页签恢复和子侧聊分页使用同一个来源解析规则。已有 session alias 由 main 解析；如果用户以后独立执行 adoption，查询复用现有 ownership/binding 关联聚合旧侧聊，不建立第二份身份映射表，也不重写其冻结快照。身份无法确定时返回 unavailable，不猜测或自动接管。

主会话无需提供 Conversation revision。统一对话的 revision 可以记录为来源证据，但创建重验的是已冻结前缀 fingerprint；后续轮次追加不改变既定快照。原生来源也使用同一前缀重验规则。

## 3. 稳定消息与持久化

- 从权威归档读取已完成、且适用的 recorder 证据已提交的稳定前缀。复用正文提取/完整性检查，不直接调用要求整份归档收敛的 adoption 函数，也不从当前 DOM 或历史分页窗口拼接。
- 读取与主聊追加并发时，只重验选定前缀。不等后续轮次结束，不自动刷新边界。前缀本身变化、删除或权限撤回则拒绝创建，不循环重试。
- 若来源只有正在生成的首轮、缺稳定 session 身份或没有可验证的已完成正文，明确显示快照不可用；不自动迁移、不把流式半成品标为完整。
- manifest 保存有序消息 ref、角色、原始 run/provider（有 binding 时一并记录）、正文 hash、原始消息定位信息、包含/排除数量及内容范围。来源消息的读取权限不能被扩大为父会话未来消息的读取权限。
- 正文通过现有内容存储封存，由子对话持有引用与保留责任。不能只引用会随父删除的 archive 路径。快照内容不要求注册成父 Conversation 的 items 才能保存。
- 子侧聊继续复用 Conversation 持久化；摘要包含来源。按来源分页查询，默认每页 40 项；侧栏只读摘要/计数，不逐个加载 transcript。

区分两类证据：**snapshot** 是冻结并保存的消息；**delivery coverage** 是某次实际内联或可经 reader 检索的消息。复用 handoff/coverage 合同，不把「已保存」显示成「全部已进入模型」。

继承消息是只读背景，不生成新的 runId、不重复计 usage、不算子侧聊执行轮次。首次发送不能 resume 父 session；新 session 与父会话不同。创建、重启、切模型都不重新捕获来源，父删除也不级联删除子快照。

## 4. 必须验证的差异

1. 两种来源各运行第 9 轮时，都能立即冻结前 8 轮；父原生 session ID、ownership、resume 指针、审批/停止归属不变。
2. 创建期间新增第 9 轮完成记录，child 的前缀 hash 仍不变；首轮未完成、缺正文、前缀变化分别明确拒绝。
3. 生产创建链路不调用 adoption、不创建父 Conversation；不能仅靠 mock 返回成功证明“不迁移”。
4. 同 Provider/cwd、不同 profile 或原生 session 的侧聊不混组；重启、alias 解析、以后独立 adoption 后仍可找回原侧聊。
5. 父 legacy run 与 child managed run 同时执行时，回复、审批、停止、归档不串线；释放 workspace-wide admission 后，相同原生 session 的并发写保护仍生效。
6. 删除原生来源或父 Conversation 后，子快照仍可读；伪造源身份、越权 cwd、跨 profile ref 由生产 IPC wrapper 拒绝。
