# Scry 跨 Provider 接续：技术方案

**状态：待确认产品范围，尚未实现。** 依据：[T3 源码核查](t3-provider-handoff-implementation.md)。本项不提前实施 Agent 编排或历史/文件回退。

## 1. 先确定产品语义

| 方案 | 用户体验 | 底层影响 |
| --- | --- | --- |
| **新会话交接，推荐第一版** | 源会话保留；预览要转交的资料；进入目标 Provider 的新会话，并能回到来源 | 复用现有单 Provider session、真实启动、历史与计费；新增交接材料及来源关联 |
| 同一会话内切换 Provider | 一个聊天里包含多 Provider；切回时寻找旧原生线程并补齐 delta | 需要 app-thread 身份、多条 native session、覆盖账本、混合历史与分支/恢复/删除/计费规则 |

两者不是同一个功能的两种皮肤。后者不能通过去掉 `agentLocked` 完成，也不是推荐方案已经具备的能力。

以下是推荐方案的完整第一版合同。若用户选择统一会话模型，应先另行设计底层身份迁移，不按本文偷换需求。

## 2. 用户路径

```text
已结束的本机源会话
  → 选择“交给其他 Provider”
  → 选择目标 Provider / Profile / 模型
  → main 读取归档并生成预览：实际正文、来源、状态、省略项、限制
  → 用户确认，准备目标新会话草稿（不启动、不发送）
  → 用户填写本轮请求并点击发送
  → 重新验证源边界、目标能力、工作区与 trust
  → 走正常 startAppRun；目标产生自己的原生 session
```

- 第一版只支持本机桌面、当前项目、App-owned 可验证归档，以及不同 Provider 的新会话。五种 Provider 各按现有 availability/实验性状态展示，不据此宣称能力一致。
- 源会话保持原样；原草稿与待发队列不迁移、不静默删除或发送。需要用户先处理会阻碍安全离开的队列/运行。
- 已失败或 interrupted 的轮次也可提供有明确状态的部分资料；前提是 Scry 管理范围内的执行已收敛，归档已稳定。缺少原生 session ID 不等于文字交接必然不可用。
- 源 run、待审批、已知背景工作或停止结果不明时，不自动杀进程换 Provider。先等待/停止并核实；不承诺能发现逃逸到 Scry 观测之外的进程。
- 原生-only、身份无法确认或尚未稳定归档的历史显示 unavailable，不暗中启动源 Provider 生成总结。
- 不复制、回退或 checkout 文件。目标使用发送时的真实工作区；历史测试成功不代表当前文件仍通过。
- 第一次交接发送后，后续轮次正常 resume **目标自己的** session，不重复注入旧交接材料。切回源 Provider仍是打开原会话；第一版不向旧 native session 补 delta。

## 3. 材料合同：原文摘选，不伪装智能总结

第一版采用本地确定性选择，不产生额外总结调用或费用：

- 用户原文、可恢复的可见助手正文、轮次状态与错误，以及来源引用。
- 保留消息角色、顺序、run ID 和来源 Provider；被选消息正文不截半、不折叠代码块空白。
- 不迁移 thinking/reasoning、工具调用协议、未决 approvals、后台 task handles、原生会话文件、Hook/MCP 配置或凭据。
- 不默认携带旧图片/附件、完整 diff 或原始工具输出。预览明确列出排除范围；新附件仍走目标 Provider 的正常附件入口。
- 不拼接 `text_delta`、最终 text 与 result shadow 造成重复。实现时复用已核实的文本/内容存储投影，补“最终文本替代 delta”用例；不可直接套用 renderer 最近一页的字符串。
- 若助手正文只有 bounded preview 或 content ref，先按现有授权读取完整正文；无法取得则标明 unavailable/partial，不能把预览称为原文全文。
- “目标、决定、下一步”等推断不由本地算法编造。用户可补充独立的交接说明，并明确标成用户新增内容，不冒充归档事实。

### 有界实现

初始建议：交接正文及来源包装最多 **32 KiB UTF-8**；该值是产品载荷限制，不是模型 token 数或容量保证。当前用户请求、新附件与 Provider 自身指令另计，绝不截短当前请求来塞入历史。

默认优先首个用户目标、最近用户请求和最近可见回复，再按近到远填入完整消息，最终保持原顺序。关键默认条目放不下时要求用户减少选择或填写明确的独立说明，不悄悄省掉目标后显示“完整”。

归档读取同样有独立上限：优先利用 archive 版本/分页入口；扫描上限初定 2,000 轮或 4 MiB 提取文本。触顶时明确未遍历范围，不把未读取内容计成已检查。无法稳定计算的省略数量用 unknown，不显示 0。超大单条在完整读取前先判断存储长度。

已知的目标容量只能来自该目标模型的可信 capability/telemetry；估算与准确值分开显示。容量未知不虚构 128K，不保证 Provider 一定接受。若提供可靠的小窗口限制，应进一步缩小预算或拒绝；目标拒绝时保留草稿，不自动换模型或重发。

**升级触发条件**：真实会话经常超出上述范围、用户确需全历史，或目标需要自主找回省略项。届时先实现有 source/session/item 授权、分页及内容引用的 Provider-facing 检索能力，再增加预算；不在第一版声称内部 run ID 就是 Agent 可用的读取工具。

## 4. main-owned 身份与持久化

拟新增小型 `src/shared/provider-handoff.ts` 与 `src/main/provider-handoff.ts`，不建立通用编排平台或插件注册表。具体结构在实现时以现有类型可复用程度收敛。

交接材料至少包含：

- 版本、opaque handoff ID、创建时间。
- source：canonical cwd、provider/profile、source session/run 边界、归档版本/指纹。
- target：provider/profile/model 选择；不保存或复用源原生 session handle。
- 实际冻结的历史正文、角色/来源引用、正文 hash、字节数、选择/省略/不可用说明。
- 用户新增说明与归档正文分开；修改选择或目标后生成新确认版本。
- 投递 attempt：请求 hash、commandId、预分配 runId、绑定的目标 session（取得后）、结果证据与 unknown 状态。

材料放 App userData，复用现有原子 JSON 写入模式。renderer 只提交身份、选择与确认 hash；不能提交任意文件路径、历史权威正文或私有 `providerPrompt`。

不能用 `cloneForkArchiveTurns()` 把旧 Provider 的工具事件、用量、执行状态复制成目标的新事实。目标首轮只关联交接材料；历史区显示“来自何处、实际发送了什么”，旧工具记录仍归源 Provider，费用也不能双计。

`displayPrompt` 保持用户本轮请求；main 的私有 `providerPrompt` 拼入经过确认的参考上下文。归档必须能显示两者的区别与实际附加正文/hash，不能让用户误以为 Provider 只收到了短请求。`.scry` 的用户输入仍是用户请求；本阶段不改 recorder core 为 Electron 专用存储。

### 删除与保留

- 尚未发送的材料依附于源草稿，取消/删除按明确草稿规则清理。
- 已尝试投递的材料依附于目标 attempt，源会话删除不能抹掉 unknown 标记。
- 删除源会话不能撤回已发送给目标的历史副本；删除提示必须说明。来源删除后链接显示不可用，而不是自动重新扫描用户全部原生历史。
- 删除目标会话时按现有活动执行/归档清理合同删除其交接副本；不能因此删除源会话或 Provider 原件。

## 5. 发送与竞态

1. 通过现有 trusted IPC 验证 sender/frame/origin；运行时校验 source、target、选择及 hash。
2. main 从 App catalog/归档验证 source 身份和已稳定边界；不能信任 renderer 当前显示的轮次或最近 40 轮缓存。
3. 用户发送时，在 source + target 的 admission 内重验归档版本、源执行状态、目标 runtime/profile/model 与 canonical workspace。源在预览后有新轮次或改写，要求重新预览。
4. 现有 `ContextAdmission` 只有单 key。应在该共享层增加有序/原子多 key 准入，并让普通启动与之共用；不另建一套仅交接入口认识的锁，也不反序嵌套两个单 key 锁。
5. 写入发送 intent 和预分配 runId，再走现有 `startAppRun()`。明确 `expectedExternalSessionId: null`，不得借用目标 context 中之前缓存的 session；源 resume ID 不进入目标请求。
6. 目标自己的 permission/run controls 重新加载。源 `full_access`、approval 或 MCP/plugin 状态不迁移；目标现有 trust/fingerprint、operation gate、Git 写互斥与运行注册都照常执行。
7. 历史以有来源标记的低优先级参考文字随正常 prompt 发送，不升级为 system/developer 指令。不宣称文字包装能彻底消除 prompt injection。
8. return runId 只证明 App 已建立尝试，不证明 Provider 已接受或执行了交接。结合真实 native/terminal 证据更新状态，UI 文案区分“已准备”“已发起”“已关联目标会话”“结果未知”。

### 双击、失败与重启

复用现有 `commandId` 入口处理本进程重复提交，但不能把 `CommandReceipts` 当作 durable exactly-once：它会丢弃失败收据，也会淘汰旧项。

交接 attempt 必须额外持久化，并绑定请求 hash。仅能证明尚未调用 Provider 的失败可以重新准备；已经尝试调用而结果未知时，重启后只读关联 run/archive/native session 证据，不自动重发。不能因外层 promise reject 就断言“对方没收到”。同一 ID 但内容不同应拒绝。

不为这个功能偷偷改变全部普通发送的失败重试合同。相关持久记录首先约束交接自身；将来若统一普通发送账本，另列迁移。

## 6. 用户须看见的限制

预览必须直接显示：

- 源/目标 Provider、Profile、项目与截止轮次。
- 实际将发送的正文，而非另一份漂亮的概述。
- 完整/部分/不可用、哪些内容没带、哪些内容只是源会话的历史报告。
- **这些文字将发送给目标 Provider/账号，可能包含源码或用户曾粘贴的敏感内容。** 不主动收集凭据不等于能保证对话里没有秘密；不宣称自动脱敏。
- 不包含原生记忆、隐藏推理、工具运行、审批和旧附件；源会话仍可打开。
- 创建草稿不收费、不调用 Provider；用户点击发送后的真实输入可能增加目标 input token 用量。

仅有来源 ID 或“打开源会话”链接时，是用户可查阅，不是目标 Agent 已具有检索能力。

## 7. 验收必须证明什么

| 场景 | 通过标准 |
| --- | --- |
| A→B 的首轮与第二轮 | 首轮目标 request 无 A 的 resume；第二轮只 resume B，历史交接不重复注入 |
| 源失败/中断 | 稳定的部分回复和失败状态可转交；没有原生 ID 也不伪造；未收敛执行拒绝 |
| 长历史和正文引用 | 不把最近 40 轮当全文；取不到全文明确提示；UTF-8 上限含包装；当前请求不截断 |
| 负对照 | 移除 fresh-session 或 stale-boundary 保护时，对应回归必须失败；不能只断言提示文字存在 |
| 预览竞态 | 源继续运行、归档变更、目标/profile/model 切换后，旧确认不可发送；跨 key 准入不死锁 |
| 发送异常 | 双击只起一次；已调用后失联保留 unknown；重启不重复启动；相同 ID 不接受不同内容 |
| 权限与 IPC | 跨工作区/伪造 source/错误 sender 或 frame 被生产 wrapper 拒绝，Provider listener 未执行 |
| 证据与用量 | displayPrompt 与实际附加内容可检查；源事件不冒充目标事件；用量只计真实新 run |
| 本地真实 App | 原生点击选择/预览/取消/准备草稿/显式发送/重新打开；隔离 Provider fixture 记录精确请求，取消路径零启动 |
| 真实 Provider | 经明确账号/费用授权后验证 Claude→Codex 与反向，再扩展实验性 Provider；fixture 通过不替代此项 |

实现跨 IPC、Provider admission、持久化边界，应按仓库完整 gate 执行 typecheck、unit/shell、build、CLI、renderer UI 和 packaged Electron 检查。测试使用临时 workspace/userData；未获授权不运行真实 Provider，不写用户真实会话。

## 8. 实施顺序

1. 确认采用新会话交接还是统一 app thread。
2. 合同与 main 归档提取/预算/保存：先测原文、partial、边界和权限。
3. 接入正常发送与跨 context admission，完成 unknown/重启恢复及来源关联。
4. 现有会话入口、预览、目标草稿与首轮来源展示；做真实 App fixture。
5. 扩大 gate 与授权范围内的真实 Provider 验收，分别报告结果。

不加入 AI 总结服务、自动模型选择、跨设备传送、历史检索 MCP、自动权限迁移或多 Agent 编排。这些都不是当前方案的暗中预留能力。
