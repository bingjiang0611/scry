# Scry 统一会话内跨 Provider 接续

**用户已选择：统一会话内切换 Provider。** 不采用此前“另开目标会话”的产品方案；旧方案保留在 Git 历史 `09de750`。源码依据见 [T3 核查](t3-provider-handoff-implementation.md)。

**当前进度：Claude/Codex 统一会话的生产 main/preload/UI 主链路已接通，隔离 Electron 已验证 A→B→A、完整正文预览、实际文件效果、归档故障和两次重启不重发。身份验证仍是合成配置/transport；没有真实账号验收。已补受限旧会话迁入、logical rename/pin/archive/restore，以及独占 App 副本删除和部分失败恢复；共享副本保守保留整组。第 6 节的原生 fork、共享副本显式回收及其余相邻动作仍未完成，因此不能宣称整个第 4 项已完整交付。最新证据与限制见第 8–10 节；此前各阶段记录保留当时的验收范围。**

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
| turn.archive | 明确的 App archive sessionId / providerTurnId | 不从 nativeSessionId 猜归档位置；缺少位置时拒绝交接 |
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
- 每次 begin 先准备并完整读回校验非空交接正文，再持久化 intent、预分配 runId、原生恢复目标、精确选择、省略项和正文引用。正文失败不发布 intent。
- commandId + 冻结请求指纹持久去重；同 ID 不接受不同请求。重复结果返回 `duplicate`，调用方不得再次启动 Provider。
- revision 拒绝陈旧预览；每个对话内写入串行；读回验证身份、轮次、跨引用和状态。
- 恢复只在 startup barrier 内、尚未开放新发送时执行；保留已登记 live run，没有 owner 的 pending 转 unknown，不重放。运行中的结果核查走明确的 settle 证据路径。
- 终态失败也可能有明确 input acceptance：失败状态与已投递覆盖分开保存。反之，能证明未发出的失败不扩张覆盖。
- Provider 返回与 resume 目标不同的 native ID 时拒绝继承覆盖。只有已收敛状态可显式弃用绑定；弃用不能抹掉 unknown 屏障。

**边界**：store 接受的 acceptance、nativeItems、source 身份必须由后续 main/adapter 权威调用方证明。当前测试中的证据输入是 fixture，不是真实 Provider 回执；store 自己不证明远端接受，不提供 workspace authorization，也不保证跨进程写锁。

索引仅含元数据与引用，单文件上限 16 MiB，损坏/超限拒绝而非变成空历史。所有写入原子替换；仅支持单个 App main owner。若真实长会话触顶，再迁移为有 manifest 的分轮文件/索引，不自动截历史或仅调大限制。

### `src/main/context-admission.ts`

增加 `runMany()`，一次性登记全部身份的等待链，再等待前序操作。现有 `run()` 共用此实现。反向 A→B / B→A 不采用嵌套单 key 锁，互不相关的会话不被全局锁阻塞。

第一阶段这里只实现了准入 primitive。第 8 节的主链路已实际传入 conversation 与 native owner 身份，并与普通启动共用；它不是跨进程安全沙箱。

## 4. 分阶段接入正常执行，不建立第二个 runner

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

`ProviderRunRequest` 已新增独立的 `historicalContext`，与**原始用户输入** `prompt` 分开。Claude/Codex adapter 在模型输入边界组合历史；Codex 仍先从原始 prompt 解析并核实 Skill。历史中的旧命令不参与本轮原生分派。其他 adapter 尚未接入此合同。

不接收历史的控制命令在有待交接时明确拒绝或要求先完成普通轮次交接，不静默当成普通文字。第一版不假装所有 Provider 支持 native history injection；文本交接也必须标出来源与投递方式。

### 4.3 真正的投递证据

- 新建原生 session 返回 ID 不代表 prompt 已接收。
- `return runId` 只代表 App 建立了尝试；不能据此清除 unknown 或更新覆盖。
- 每个 adapter 必须区分已接收、明确未发出、未知，并与最终归档收敛关联。单纯超时或 promise reject 不代表未发送。
- 现有 `CommandReceipts` 仍处理本进程重复请求；跨重启由 durable conversation intent 约束，不能让其“失败撤销收据”的行为触发第二次外部投递。
- unknown 的普通恢复只读核查原 run/archive/native 证据。第一阶段不提供人工把 unknown 改成成功的入口；后续若提供“已停止后新建上下文继续”，必须分别记录执行已收敛、用户新决定与原投递仍未知，不能删除旧证据。

### 4.4 已实现的 adapter 边界（第二阶段）

`src/main/providers/historical-input.ts` 校验完整历史正文 SHA-256，冻结正文，添加引用包装并限制为 32 KiB UTF-8（含包装）。不截断本轮请求，不从历史提取或执行命令。尝试发送前还验证待发文字确实包含该历史；`textHash` 记录实际发出文字的 hash，不冒充包含图片、Skill 元数据及运行控制的完整请求指纹。

| Provider | 本阶段输入边界 | 接收证据 |
|---|---|---|
| Claude | 普通请求在真实 `runAgent()` 的 SDK query 边界组合历史；交接时斜杠命令明确拒绝 | 当前 query 成功完成且返回匹配的 native session；hook、prompt ID、init、失败或中断均不单独证明接收 |
| Codex | 从原始输入核实 `$skill` / `/skill`，保留 native skill input，再组合 text input；未识别的斜杠命令拒绝 | 归属于本次 `turn/start` 的响应及有效 turn ID；同 thread 的异步通知不能代替该回执 |
| OpenCode / Pi / Qoder | 尚未实现此输入合同 | registry 在调用 adapter 前拒绝带历史的请求；原普通请求不受影响 |

- `getInputReceipt()` 在 promise reject 后仍可读。尝试前为 `not_sent`，尝试后无回执为 `unknown`。Codex 接收后执行失败不撤销接收事实；Claude 失败轮次当前保守保留 `unknown`，需后续增加可归属的原生正文核查才能解除。
- Codex 在投递前核对恢复的原生 session；身份缺失或漂移不发送。Claude 在 query 后才取得身份，漂移只能保持 unknown，不能谎称未发出。
- 等待 Codex Skill catalog 时取消，不再发送 `turn/start`，也不记录虚假的 Skill 调用。
- 回执通过 `runtime:historical_input` 事件提供诊断；这些事件不自动更新覆盖。SDK 同步抛错也可能已尝试投递，不能因未返回 handle 就判断未发送。
- **尚无生产业务调用方传入历史**：没有新增 renderer/IPC 参数。`startAppRun()` 已接入普通输入回执采集和旧入口归属检查（见下节），尚无统一 conversation 启动或新旧模式共享的执行期 writer 准入。正文 artifact 已接入 conversation begin/读取，真实 input receipt 尚未接入 settle；不能仅看 run 的 completed 状态更新覆盖。
- 引用包装不是安全沙箱，也不保证模型保存或遵从历史。真实 CLI/账号尚未验证；本阶段只验证生产 adapter/runner 与模拟 SDK/app-server 的协议边界。

### 4.5 主入口的普通输入回执（第四阶段前置）

原回执只在存在历史时启用，导致首轮 A、以及同 Provider 没有新增历史的轮次缺少可归属接收证据。不能以 completed 单独填补这一缺口。

- main-owned `trackInputReceipt: true` 显式启用无历史输入的回执。`contextHash: null` 表示没有历史正文，不编造空历史 hash，也不插入引用包装。原有历史输入仍使用真实正文 hash。
- `startAppRun()` 为 Claude/Codex 非斜杠输入启用采集；原生斜杠命令维持旧分派，不把控制命令成功冒充模型输入接收。Codex `$skill` 保留原生 Skill/图片输入，`textHash` 仍只覆盖实际出站文字，不覆盖 Skill 元数据或图片。
- 普通输入诊断使用 `runtime:input_receipt`；带历史仍使用 `runtime:historical_input`。尝试诊断发生在原生调用之前，main 不把这两类事件算作首个 Provider 响应。它们都不自动结算 coverage。
- 无历史时仍检查 resumed native session 身份，并保留 not_sent / unknown / accepted 区别。SDK 同步抛错和 RPC 丢失响应不自动重试；Codex 输入确认后执行失败不撤销接收事实。
- registry 对尚未实现合同的 adapter 同时拒绝历史输入和显式回执采集。未 opt-in 的旧 adapter 调用维持原行为。
- 本步骤没有新增 conversation IPC，也没有启用 Provider 切换。不能仅在主入口加私有 conversation 参数：还须让旧模式与新模式共享原生 writer ownership，并确保 unknown 在重启后也不能被旧入口绕过。

验证（App 0.2.191 / Node 24.18.0，`2c89b30` + 本轮改动）：11 文件、406 项定向测试通过，涵盖五个 Provider、真实 Claude runner / adapters 与模拟传输、registry、ledger 和准入。新增 12 项回归覆盖首轮/恢复的无历史回执、原文与 Skill/图片不改写、身份漂移、SDK 抛错、RPC 丢失响应、执行失败和 unsupported gate。负对照恢复旧的“没有历史就跳过”分支时，新增普通输入测试确实失败（receipt 为 undefined）；恢复后通过。`npm run typecheck`、`npm run build`、`git diff --check` 通过。本轮未重跑全量、未启动真实 App、未调用真实 Provider。检查日志：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-4f4e5b4d1263987e.log`。

### 4.6 持久化归属与旧入口阻断

- 原生归属仍由 conversation ledger 的 bindings 决定，不新增第二个持久化归属文件。`ConversationStore` 在首次访问扫描账本，维护可重建的内存投影；每次原子发布更新投影，发布结果未知时使其失效，下一次检查只读重建，不重放写入。
- adoption 和首个 native binding 的发布共用 store 准入，拒绝两个 conversation 占用相同 provider/profile/canonical cwd/native ID。旧入口无法证明 continuationKey，因此更换该 key 不释放旧归属；退休绑定也仍属于原 conversation，不能用退休来绕过归属。不同 provider/profile/cwd 不混用身份。
- 旧发送、最后一轮编辑/重发、原生 fork 和删除路径接入 `assertLegacyWriteAllowed()`；发送在准备前和真正 Provider 调用前检查，fork 在调用前复验，删除在预约与实际删除前检查。归属检查也识别源 archive session ID 与 run ID，防止用 App 别名删除证据。
- pending 且尚无 native ID，或 unknown 时，对该 provider/profile/cwd 下旧入口的恢复操作保守阻断。已知绑定的 pending 不阻断其他独立 native session；显式新建不同 App 对话仍可继续，不重放原 unknown。未知实际目标核查完成前，可能暂时阻断同作用域的无关恢复操作，这是当前明确限制，不假装目标身份已知。
- `recoverAll()` 只在启动 barrier 调用，把失主 pending 变成 unknown，不发送。损坏账本、重复归属、非普通索引文件均拒绝；若恢复写入失败，保留阻断状态，旧入口（包括 fresh）及新的账本发布均拒绝，直到启动 barrier 显式恢复成功，不能让缓存把失主 pending 当作仍在运行。启动诊断不会删除证据。归属投影是单 main owner 缓存，不支持另一个进程并行改写这些账本；不是系统级 native CLI 写入锁或安全沙箱。
- **尚未完成执行期集成**：目前没有生产 caller 创建或接续 conversation。后续 adoption/新入口必须持有与旧入口相同的 context/native 准入，并核对 RunRegistry 中真实 run 已 settled，再发布归属/注册新 run；本步骤的存储层互斥不能替代进程生命周期独占。回执驱动 settle、逻辑 catalog 与 UI 仍未接通。

验证（App 0.2.191 / Node 24.18.0，共享工作区含持续变化的并行 WIP）：最终新增归属测试 17 项，9 文件、99 项定向测试通过，node/web typecheck、build 与 diff check 通过。首轮类型检查发现新 `readdir` 局部变量的隐式 any，已改为 `Dirent[]`；新增恢复失败测试还曾误断言 seed 轮次，已改为按 run ID 检查新 pending 轮次，没有删除断言。两个负对照成立：保留写入回执丢失后的旧缓存会误阻断独立会话；未保留 startup failure 状态会放行旧入口，新增测试先失败，修复后通过。历史 artifact 跨对话 fixture 改用不同 native ID，以符合新归属合同，原隔离断言不变。

- 中间版本 `npm test`：3164 通过、3 跳过，shell 通过。最终补强后再次全量：3166 通过、1 失败、3 跳过，因 unit 失败未执行该次 shell，不能报告最终全量通过。跳过的是既有 `billing-admin-real`、`p0-integration`、`p1-integration` 真实探针。
- 最终失败来自并行新增的 `src/renderer/remote-workbench.test.ts` 的 Git 操作用例，超过原 5 秒；该调用链不引用本轮 conversation 模块。单项诊断运行 3.64 秒通过，其余 6 项未运行；并发超时根因仍未确认，没有加 timeout、改断言或用单项通过覆盖全量失败。最终全量日志：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-7a526709fb1f4c87.log`。

本阶段初次交付的上述检查仅覆盖存储合同/模拟调用和共享工作区编译；后续生产 IPC 验证见 4.7。真实 Provider 与完整打包发布仍未验收。中间全量日志：`/Users/baobingjiang/.pi/agent/sessions/--Users-baobingjiang-IdeaProjects-vibecoding-scry--/sol-pi/01a13b2e-413e-714c-92ef-a38e81c32f5c/evidence-preserving-reducer/objects/b4/b4b8f46f0f9dd9cf24a8c3430ee17d3d080f6ab39b210a0fffe70cc6b10edbce.txt`。

### 4.7 隔离生产 IPC 验证

新增 `npm run test:conversation:ipc`，复用现有隐藏 Electron fixture，并接入 `test:renderer:ui` 的 macOS gate。使用真实 renderer/preload、生产注册的 trusted IPC 与 `startAppRun()` / fork / delete handlers，仅 Provider 换成原有 smoke adapter。测试专用入口收据记录 adapter 是否真正进入；正常产品不启用此收据或测试 fork facet。没有放宽 renderer sandbox/CSP/IPC 权限。

在 `/tmp/scry-conversation-verify-QaCCax` 冻结 `321b937` 源码并叠加本次验证脚本/fixture，排除共享目录的 remote WIP；复用已有 node_modules。环境为 macOS arm64、Node 24.18.0、Electron 42.10.1、App 0.2.191。验证结果：

- **6 个拒绝场景通过**：已归属原生 resume、fork、按 native ID / run ID / archive ID 删除，以及启动恢复后的 unknown resume。错误来自预期的归属检查；这些请求的 Provider adapter 入口收据增量为 0，源 ledger/archive 文件 hash 不变。
- **3 个正对照通过**：未归属的 fork、删除和普通 resume 均经过相同生产 IPC 成功；adapter 收据恰有 1 次 fork、1 次 run，排除接口未注册或 Provider 被全局禁用导致的假通过。
- **真实启动恢复通过**：遗留 pending 在新进程中变成 unknown，revision 从 1 到 2，已确认归属保持 revision 0。第二次重启将隔离 conversation 目录设为只读，实际原子发布产生 EACCES；fresh start 被拒绝、Provider 调用数不变、磁盘仍为 pending，没有伪报恢复成功。测试结束恢复权限并关闭自有进程、清理临时 userData。
- **两个负对照均失败**：仅在冻结副本中绕过归属 guard，已归属发送错误返回 executed/runId，测试失败；仅忽略 startup recovery failure，fresh start 错误返回 executed/runId，测试失败。恢复源码后重新 build / IPC smoke 通过，并逐文件核对与工作区验证代码 hash 一致。
- `npm run typecheck`、`npm run build`、上述 IPC smoke 与独立 `npm run test:shell` 通过。
- **冻结源码的默认全量仍未通过**：3157 通过、3 失败、3 跳过。失败均为原有 `source-control/service.test.ts` 的 5 秒超时（选定文件提交、push endpoint、PR account/HEAD/base 复核）；因此不能把先前超时仅归因于 remote WIP。该文件独立诊断 27/27 通过，耗时从全量期间约 96.5 秒降至 37.3 秒。结果符合资源争用特征，但具体瓶颈未定位；没有修改 timeout、断言、并发配置或把独立通过当作默认全量通过。

最终类型/build/IPC 与全量日志：`/Users/baobingjiang/.pi/agent/sessions/--Users-baobingjiang-IdeaProjects-vibecoding-scry--/sol-pi/01a13b2e-413e-714c-92ef-a38e81c32f5c/evidence-preserving-reducer/objects/82/82fcecb14604aa51aa0796851c324d92681efe9a545c4e95e5dcc2c3775c4744.txt`。这验证的是归属保护，不是完整 A→B→A，也不是实账号 Provider、已安装 App 或打包发布验收。

### 4.8 超时诊断与真实执行补验

后续诊断及原始资料位置见 [Git 集成测试超时诊断](source-control-timeout-diagnosis.md)。已把超时定位到大量串行原生 Git 调用的启动等待累积，单文件也能触发；未发现单条命令挂死。正式 5 秒时限、并发配置和生产复验均未修改，不把诊断参数下通过当全量门禁通过；宿主启动长尾的更底层归因仍未完成。

在包含当前工作区 WIP 的独立源码副本中，测试 Provider 已走真实 Electron 生产链路：实际写入临时工作区，核对 completed 归档、生产历史投影的输入/模型/工具/result，再重启回读并确认没有重新发送。保留成功事件却去掉真实文件写入的负对照按预期失败，恢复后类型检查、构建及 IPC smoke 通过。首次新增测试误读投影的 status 字段，已按既有合同改为从 archive 核对 status，并从历史投影核对 done/error/errorHint 与成功 result。生产功能没有因此改变，完整 A→B→A 仍未接通。

## 5. 历史选择与预算

- 从 main 权威归档取得可见用户/助手文字、轮次状态及明确来源，不拿 renderer 最近 40 轮缓存冒充全部历史。
- 只提取用户和根助手可见文字，不导出 reasoning、子 Agent/工具协议、approval、背景 task handles、Hook/MCP 或凭据配置。不默认转发旧图片、完整 diff 或原始工具输出。可见文字本身仍可能含敏感信息；当前原始正文策略不提供自动脱敏承诺，发送前的正文预览/确认仍须接入。
- 正文引用只有拿到全文才标完整；不能把 bounded preview 当成全文。delta 与 final shadow 要按真实投影去重。
- 选择以完整条目为单位，保留代码空白、角色和顺序。正文 artifact 已先于 intent 发布并校验；选择和省略项保留在账本。
- 当前上限：选中源轮次 2,000 轮、累计归档文件读取 16 MiB、累计根助手/用户文字读取 4 MiB、实际交接历史 32 KiB UTF-8（含 JSON 和包装）、artifact 256 KiB。任一触顶明确拒绝，不静默截断；UI 的预算选择与省略范围展示尚未实现。
- 这是产品上限，不是 token 数或模型窗口保证。目标容量未知时不编造 128K；当前用户请求绝不为历史让路而被截断。
- 源关键条目放不下时需要用户减少选择或明确补充说明。第一版不调用另一个模型自动“总结并补全”事实。
- 引用 ID 和“打开源轮次”链接仅代表用户可查阅。没有真实 Provider-facing 检索工具时，不承诺 Agent 能找回省略全文。

### 5.1 已实现的正文链路（第三阶段）

- `src/main/conversation-history.ts` 读取明确的 App 归档位置，按 canonical `runId`、可选 provider turn ID、Provider 和 cwd 校验归属。第一版条目为每轮 `user` 与 `assistant`，后者是根助手可见文字投影；不是 native message ID。
- `readTraceArchiveTurnForHistory()` 优先精确分轮文件，只有文件不存在才读取旧 monolith；损坏、错误归属、符号链接、非 UTF-8、未收敛轮次或超限都不能回退成旧证据。相同打开句柄下有界读取，不做目录扫描或最近会话猜测。
- `modelContent` 有引用时读取全部页面并验证内容；预览不能替代全文。不完整 envelope、缺失引用、尚未支持的非 App 内容存储明确拒绝。未选中的助手正文不会被读取，也不计覆盖。旧 inline 事件只表示 App 捕获的可见文字，不保证 Provider 全部原生历史。
- 复用 `appendCoalescedTrace()` 的明确 snapshot replacement，以及从 recorder 抽出的纯 `modelEventBodies()`；保留 message/native item/agent 范围，去除 delta/final shadow，不另造 renderer 摘要解释。准备过程只写最终 artifact，不写无人引用的中间正文副本。
- artifact 位于 `<userData>/conversation-history-v1/<conversation+cwd hash>/content/sha256/...`，复用现有内容寻址和原子发布 helper。保存确切文本、hash、角色、来源、轮次、源终态/投递状态与实际包装前缀，不写 `.scry`，不复制旧执行或计费事件。
- `ConversationStore.begin()` 在对话准入内读取源、冻结正文、发布并校验 artifact，然后发布 pending intent。`history(id, runId)` 只读已封存正文；重启和 duplicate 不重新读取源或重建缺失 artifact。正文损坏/缺失也不能在 settle 时新增 accepted 覆盖。
- 轮次通过 seed/settle 携带明确的 `archive` 位置。不存在归档时允许保留事实账本，但该轮不能被当成可交接的完整正文。旧内部原型的非空 intent 若没有 artifact，会明确拒绝读取，不自动补成“曾经发送过”的证据；这些原型尚无生产调用方，不作真实用户迁移承诺。
- 本轮仍未接 App 历史选择 UI、legacy adoption、统一的源条目生成、运行期 native owner 或 Provider 回执结算。含 Steer（运行中追加用户输入）的源轮次明确拒绝交接，直到实现其用户/助手交错顺序与逐消息引用，不能静默丢掉这些可见用户消息。第一版仅支持 App archive/body；原生 transcript / recorder 内容源接入须增加各自权威解析，不做静默 fallback。
- 上限触发后先要求缩小选择；真实需求需要大 monolith 或更大正文时，再增加有界索引/流式读取与明确部分覆盖合同，而不是默认调大内存上限。

## 6. 混合历史、迁移与现有动作

- legacy 单 Provider 对话惰性接入为一个 logical conversation + 一个 native binding，保留原 session/run ID。先写可恢复的接入记录，再切换 catalog 引用；失败保留原入口，不能消失或出现两个可独立写入同一 native session 的假副本。
- conversationId 成为侧边栏与 composer draft 的稳定身份；切 Provider 不切到另一个侧边栏条目。
- 每轮 provider/profile 来自该轮 binding，而不是顶部当前选择。分页按统一 ordinal，正文仍由各 Provider archive 加载。
- stop、retry、fork、文件证据、后台任务和诊断均按真实 run/owner 路由。不能把旧 Claude 轮次的 fork 交给当前 Codex adapter。
- 汇总以唯一 runId 连接现有 usage；不能为统一 UI 复制原生记录或再次记账。
- 归档/删除统一对话必须涵盖它的全部绑定与尝试，遵守现有 active-run 和 partial deletion 合同；删除 App 副本不等于删除 Provider 原件。
- rename/pin/archive 等会话级操作迁到 logical identity。未完成这些相邻路径前，不解锁 Provider 切换作为交付。

## 7. 验证记录与后续 gate

第一阶段已执行：

- 新 conversation 测试覆盖：A→B→A、遗漏项再次补齐、Profile/兼容身份隔离、内容 hash、持久双击去重、陈旧预览、并发写入、重启 unknown、落盘后回执丢失、明确拒绝与已接收失败的区别、原生 ID 漂移、显式弃用与重建、损坏日志、调用方引用隔离。
- 准入测试覆盖：反向多 key、单 key owner 与多 key waiter 的顺序、独立对话并行、拒绝后全部释放、重复 key、空 key 拒绝。
- 已做真实负对照：临时移除 provider/profile/continuation identity 中的后两项保护，身份隔离测试确实失败；随后恢复生产保护。
- 第一轮另有一个测试 fixture 失败：`structuredClone` 保留 `items/nativeItems` 的共享引用，错误注入同时改了两处。已改为只替换 nativeItems 的引用，保留原拒绝断言；不是调整实现来接受坏证据。

最终定向检查：`npm run test:unit -- src/main/conversation-store.test.ts src/main/context-admission.test.ts src/main/session-fork.test.ts src/main/command-receipts.test.ts`，**4 文件、43 测试通过**；`npm run typecheck` 的 node/web 均通过，`npm run build` 通过。负对照曾使身份隔离用例按预期失败，恢复保护后重新通过。

第二阶段新增检查：历史正文/hash/UTF-8 边界、真实 runner/adapter 的精确输入、原生 Skill 与附件、fresh/resume、身份漂移、原生回执丢失、同步 SDK 抛错、接收后执行失败、Skill 解析期间取消及未支持 adapter 零调用。定向范围包括上述两个新测试文件、registry、五个 Provider、agent-runner-options、conversation-store 和 context-admission；共 **11 文件、394 测试通过**。`npm run typecheck` 的 node/web 和 `npm run build` 通过。

负对照：临时移除 Codex Skill 解析后的取消检查，取消回归确实失败（出现本不应发送的 `turn/start`）；恢复检查后重新通过。负对照单测筛选跳过了其余用例，不是放宽最终测试范围。

第三阶段验证：首轮基线为 `f65b1ff` / App 0.2.190；最终定向检查为并行提交后的 `585fae6` / App 0.2.191 + 本轮改动，Node 24.18.0 / Vitest 3.2.7。本轮未修改版本文件。

- 最终定向 **11 文件、177 测试通过**：conversation history/store、historical input/Provider 边界、transcript archive、session history、live trace、trace content、managed commit、recorder tool/content store。新增 20 项回归，包括 Steer 不静默遗漏、全部 content-ref 页、UTF-8、真实临时归档、正文先于 intent、封存后源变化、blob 损坏/跨会话、拒绝不完整正文、message scope、无中间正文副本。
- `npm run typecheck`、`npm run build`、`npm run build:cli`、独立 `npm run test:shell` 通过。
- 负对照：移除 final shadow 去重后，纯投影测试得到 `abab` 而不是 `ab`，按预期失败；恢复后本次测试通过。
- 首轮 9 项旧 store 测试因 fixture 使用 macOS `/var` 路径、而账本 canonical cwd 为 `/private/var` 导致归档定位失败。fixture 已改用创建后返回的 canonical cwd，未放宽路径校验或断言。
- 全量 `npm test`：**3121 passed / 2 failed / 3 skipped**；因此不是全绿。3 个真实账号/费用探针保持关闭。unit 失败使复合命令未进入 shell，之后单独执行 shell 通过。全量检查在最终 UTF-8 严格读取及 Steer 拒绝补强前执行；最终版本重新跑上述 177 项、类型与构建，不声称全量门禁通过。
- Qoder 明细渲染断言在不含本轮修改的 `git archive f65b1ff` 对照副本仍失败，属于当时的基线问题。随后并行提交 `585fae6` 修正了该 fixture，本轮对当前版本筛选复验该用例通过（其余 239 项未运行）。这不替代全量检查；本轮没有修改该断言或实现。
- Git push-endpoint fixture 全量执行时超过原 5 秒上限。检查后测试进程已退出；同一用例在基线副本约 4.1 秒、本工作区单独执行约 3.0 秒通过。并发超时原因尚未确认，不用定向通过抹掉首轮失败，也不增加超时。
- 全量日志：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-ea71f33dbe6d97a0.log`。基线副本保留于 `/tmp/scry-handoff-baseline-Ot6B8V`，只运行上述两项筛选检查（265 项未运行）；复用 node_modules，不是可分发安装包。

截至第三阶段，尚无 UI 或生产业务入口验收。该阶段检查只证明模块、正文/账本链路和 adapter 协议边界。生产入口与 UI 的后续证据见第 8 节；真实 Provider 和真实用户数据仍未验收。

后续至少要验证：

1. 实际 main/preload 请求下，A→B→A 的 provider/resume/prompt/历史正文精确匹配，取消和预览零启动。
2. slash/Skill 分派不被历史前缀改变，旧命令不重放。
3. 双击、原生 ID 漂移、接收后失联、重启恢复、共享 writer 未释放及旧确认失效。
4. 生产 IPC wrapper 拒绝跨项目/伪造身份/错误 sender/frame，特权 listener 未执行。
5. 混合历史重开、分页、停止、fork、草稿、统计和删除使用真实 owner，来源与费用不双计。
6. 隔离真实 App 原生输入 fixture；经账号/费用授权后再验证 Claude↔Codex 与实验性 Provider。不能以 mock transport 冒充真实外部能力。

接入跨 IPC、Provider 与持久化主链路后运行仓库完整 gate。第三阶段没有构建安装包、升版本或启动真实 Provider；第 8 节只增加开发目录包验证，不授权安装或发行。

## 8. 生产入口与隔离桌面验收（2026-10-16）

### 已实现

- `conversation-service.ts`、`conversation-api.ts` 与固定 preload IPC 复用 `startAppRun()`、RunRegistry、workspace/trust gate 和原子账本。renderer 不提供 native ID 或历史正文；重复命令先返回原 run，不因身份变化而再启动。
- 同一 conversationId、侧边栏条目和独立草稿支持 Claude→Codex→Claude；按引用精确补齐，省略项继续保持缺失。取消、切换与重载不发送。每页最多 40 轮，不复制工具事件或用量为新工作。
- 预览可按需读取每项完整 user/root assistant 正文。`readItem` 只接受当前账本拥有的 run/item/hash，复用封存时的全文投影与预算；不接受路径或任意字段，不调用 Provider，不在预览时写正文 artifact。读取失败显示错误，不以摘要冒充全文。
- main 准备后及 adapter 输入边界复验 continuation identity；冻结实际纯文本 hash，Codex `$skill` 等改写在 `turn/start` 前拒绝。Claude 使用实际 execution env/HOME/config root；Codex 区分 planned 与已物化 private home，缺失实际 auth 不回退借用 source。interrupt 仍指向原 transport。
- 只有相互匹配的接收回执与已提交权威 archive 才更新 coverage。归档失败后持久化 unknown，不能跨 Provider/key 绕过，也不自动重发。live managed writer 阻断 legacy start/adopt/Steer。
- 时间线复用原生聊天滚动 helper：跟随新输出；原生滚轮离开底部后保留阅读位置；显式发送回到最新输出。待回答问题在 composer 留有入口，仍走正式 question IPC。

### 实际验证

环境：macOS arm64、Node 24.18.0、npm 12.2.0、Electron 42.10.1、App 0.2.191、CLI 0.2.49；在 `1c30b76` 加本任务工作区改动上执行，保留 `bd60826` 的 remote/workbench 成果。

| 检查 | 结果与范围 |
| --- | --- |
| `npm run typecheck`、`npm run build` | node/web 与当前 main/preload/renderer 通过 |
| `npm test` | 254 文件通过、3 文件跳过；3193 测试通过、3 跳过；shell PASS。真实账号/费用探针保持关闭 |
| `npm run test:renderer:ui` | 最终完整运行通过，包含 Credits、原生会话缓存/控制、remote/workbench、ownership 与 unified smoke |
| unified 生产 UI/IPC | 主对话 3 轮、总计 6 次测试 Provider 调用、两次 App 重启；精确输入/coverage、真实文件、身份变化 fresh、草稿、问题回答与归档故障均有断言 |
| UI 负对照 | 860px 桌面宽度下旧布局右边界为 994.22px，检查失败；增加 grid item `min-width: 0` 后通过。不能只检查 document.scrollWidth，因为祖先会裁切溢出 |
| 滚动回归 | 发送后的 composer 高度变化使历史 viewport 490→440px，旧程序化滚动被误认成用户离开底部；保持 opening intent 到 React 布局提交后修复。原生滚轮退出跟随、缩放布局和再次发送均通过 |
| `npm run check:cli-release` | 32 文件、586 测试通过；本地 tarball 临时安装 smoke 通过。修复 npm 12 `pack --json` 对象格式，仍核对唯一包及包名 |
| `npm run pack:artifact` | 开发目录包及 packaged security/workbench/crash-recovery smoke 通过；298667927 bytes。没有 Developer ID 签名、公证、安装或发布 |

首轮完整 UI gate 的 `session-cache` 曾返回泛化的 `Script failed to execute`。没有扩大时限、删除断言或增加自动重试；仅补充 renderer 异常透传。随后 cache-only 和完整 gate 通过，**不能据此宣称首轮异常根因已修复**。若复现，由本任务维护者使用新增 stack 和首轮日志继续定位。

- unit 首轮日志：`/Users/baobingjiang/.pi/agent/sessions/--Users-baobingjiang-IdeaProjects-vibecoding-scry--/sol-pi/01a13b2e-413e-714c-92ef-a38e81c32f5c/evidence-preserving-reducer/objects/43/43d9a67af99a6eddde4be967238cba1531c31c993c517721e5a5870b26449580.txt`
- 最终完整 UI、CLI、artifact 日志：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-7de9e98b4acfcb81.log`
- UI 证据：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-unified-rendering-c4Bzai/verification.json`，包含当前 main/preload/renderer JS/CSS hashes；同目录保存深浅色、1280px 与 860px 桌面视口的 8 张截图。人工检查了宽浅色/窄深色预览、窄浅色/宽深色时间线：主操作可见、文字可读、无横向裁切；不据此宣称完整无障碍验收。

### 仍未完成与下一责任动作

1. **维护者授权后再执行**真实 Claude/Codex OAuth/API-key 三轮验收，使用临时工作区与最小凭据范围，不输出凭据。当前 Claude OAuth 依据稳定 account/org 配置，不等于已核验 keychain 或实时登录账户；动态 helper/cloud 不能证明时 fail closed。
2. **本任务后续实现**第 6 节的 delete/fork 与相邻动作；受限 legacy 迁入及 logical rename/pin/archive/restore 的后续进度见第 9 节，不用局部绿灯替代完整交付条件。
3. 当前 UI 限 Claude/Codex 默认 profile、纯文本、默认模型/审批；附件、原生命令、Steer、其他 Provider 和长会话性能尚未接入完整合同。扩展时先补逐 Provider 的输入、receipt、身份和历史顺序证明，不静默放宽。
4. 远端/手机接续、真实前台交互、Node 20/22 兼容矩阵、正式签名公证与用户安装未验证。packaged remote/workbench 本地 fixture 通过不等于手机或远端接续通过。

## 9. 受限旧会话迁入与逻辑元数据（2026-10-16）

### 本轮实现

- 旧 Claude/Codex 默认 profile 的会话操作菜单增加“迁入已捕获历史”。只读预览核对 App 完整归档，明确不代表全部原生历史；没有可证明的原生接续身份时，旧绑定退休、`nativeItems: []`，后续必须明确新建原生上下文。
- `conversation-adoption.ts` 复用权威全文投影，保留原 run/native/archive 身份和源文件。只接收 completed、纯文本、无 Steer 的捕获；预算为 2000 轮、16 MiB 归档，超限或损坏拒绝，不静默截断。需要扩大范围时，先实现对应 Provider 的完整读取和身份合同，再扩展预算或输入类型。
- 来源、归档正文和源元数据参与确认指纹；迁入前在原 context admission 内阻断活跃/未收敛运行及删除，且在异步读取前预留源别名。先原子发布 ledger，再派生 catalog 隐藏旧别名；失败保留旧入口。同指纹只返回已发布的原 logical ID，不能借该指纹接入另一个 native binding。
- 统一对话支持重命名、跨项目置顶、存档和恢复；使用 revision 和现有名称校验。存档保留草稿、历史、归属与用量，侧边栏提供已存档分组；禁止存档未收敛/unknown 投递，main 同时检查 RunRegistry 尚未完成的证据保存。旧 native/run 别名不能绕过逻辑管理入口。
- 修正新管理通知缺少 payload 的问题，增加 `conversation_changed` typed envelope，不伪造 runId；全局 catalog 和会话缓存按正确事件更新。

### 验证与失败记录

| 检查 | 实际结果与范围 |
| --- | --- |
| typecheck / build | 最终源码通过；无升版本，App 0.2.191 / CLI 0.2.49，macOS arm64、Node 24.18.0 |
| 新增 unit | `conversation-management.test.ts` 9 项：原子迁入/失败保留、指纹变化、重复提交、损坏归档、读取预算、unsupported/未收敛源、元数据与持久化、pending/unknown 存档阻断、严格 API 字段 |
| 负对照 | 移除损坏分段拒绝条件后，`-t 'corrupt sibling'` 必须失败；恢复后 7 文件 / 327 测试通过。不是仅证明有效源可读取 |
| 生产 IPC / 隐藏 UI | `npm run test:conversation:ipc` 最终通过。迁入真实 fixture 运行产生的归档，核对源字节、SQLite totals 不变、旧别名阻断、原生点击/Enter/菜单键盘导航、取消、草稿、存档恢复，以及迁入后明确新上下文发送和两次重启无重发。共 8 次合成 Provider 调用，无真实账号 |
| 全量 unit | 本轮前一轮 255 文件 / 3202 测试通过、3 跳过；后续全量出现 Pi fork 与 remote workspace Git diff 两项 5 秒超时（3200 通过、3 跳过）。相关实现/测试未改；focused 连同本次相关检查 9 文件 / 420 测试通过。保留首轮失败，未证明 OS/资源长尾根因解决 |
| 完整 renderer UI | 最终 `npm run test:renderer:ui` 通过，包含 Credits、remote/workbench、ownership 和 unified；随后最后一处 migration fingerprint/绑定核对加固再次通过 production IPC/UI。不是前台 OS/真实账号验收 |
| CLI / shell | `check:cli-release` 32 文件 / 586 测试、本地 tarball 临时安装 smoke 通过；`test:shell` PASS |
| 开发目录包 | 最终 `pack:artifact` 通过，298689930 bytes；包含 packaged security / crash recovery / remote workbench。关闭签名自动发现并清除发布凭据，未正式签名、公证或安装 |

- 新 UI fixture 首轮重命名/菜单 Enter 未触发：输入驱动缺少 Enter 的 `text: '\r'`。补真实字符事件后验证 Enter 保存及菜单操作；悬浮菜单先发送原生 mouseMoved 并检查 hit target，未用程序化 click 绕过命中。迁移读预览等待实际 runtime settlement，而非只看 `activeRuns` 消失；未重试写请求。
- 缓存 fixture 再现 `Deletion invalidation left a pending cached page visible`：native input dispatch 尚未等待 React commit，而失败后的 DOM 已是无缓存加载状态。改为等待既有加载状态再执行原无轮次断言，仍使用原 5 秒上限。故意移除 `setSessionCacheVisible(false)` 时，测试在原预算内失败并保留旧正文；恢复后 targeted/full 通过。未删除后续 stale-response 断言。
- 通用 `Script failed to execute` 不应再一律归因到 cache：runner 在 Meta Prompts 独立窗口失败时原来仍打印 cache 窗口。已修正诊断窗口并透传 Meta Prompts renderer stack。单项及完整 suite 随后通过，但通用异常未重新取得具体栈，根因仍未知；如复现，由本任务后续使用新诊断继续定位，不用重跑通过宣称已修复。

证据（本地临时目录，不是发布产物）：

- 前一轮全量通过：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-32a90fb7d4f66427.log`
- 后续全量两项超时：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-5c7619c47a4e2769.log`
- focused 420 项与缓存断言失败现场：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-5f38fcb042b8210a.log`
- 最终完整 UI、CLI、shell：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-43d7abf01dfdae82.log`
- 最终 migration/ownership UI：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-unified-rendering-6qytPj/verification.json`，16 张深浅色截图，包含窄窗口迁入和存档界面；hash 覆盖 8 个 main/preload/renderer 构建文件，并与最终开发包构建后的文件复核一致。人工检查了窄浅色迁入与窄深色存档图，文字和主操作可见；其余截图不冒充逐张人工验收。
- 最终开发包检查：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-07900a6d6686e193.log`

### 下一责任动作

本任务继续实现 logical delete/fork 的全 binding/attempt 范围、共享归档保留、活动运行阻断与部分删除恢复；不能把当前 rename/pin/archive/restore 当成完整管理闭环。真实账号仍等待维护者明确授权；本轮不推送、不安装、不发布。后续删除进度见第 10 节。

## 10. 独占副本删除与部分失败恢复（2026-10-16）

### 本次实现和明确保留

- 新增 `conversation:previewDeletion/delete`，renderer 只提交 logical ID 和确认指纹。main 从全部 bindings/attempts、catalog、SQLite 真实归属生成范围；在原 context admission 内复验 revision、共享引用和运行收敛，先原子发布 pending 删除围栏，再复用 `deleteOneSession/deleteOwnedSessionData`。没有旁路删除器或 Provider 调用。
- 仅允许已存档、投递已收敛的会话。未知投递、活跃运行和未完成证据保存仍阻断。物理存储不按 profile 分隔：旧删除入口不能通过伪造另一 profile 绕过逻辑归属；普通 Native 运行身份仍按 profile 隔离。
- Native ID、archive alias 与 run ID 分开。SQLite 的实际归属决定哪个目标清理 run 附件/恢复记录；未能确定或跨 scope 冲突时拒绝，不把别名当作权威。
- 部分失败保留可重新预览的入口和回执。已开始删除不能恢复发送；旧 fingerprint 不自动继续，也不声称此前没有副作用。完成后隐藏条目、移除标题，并保留 ID/hash/归属及删除回执，防止旧命令、旧 Native 入口或重新迁入复活。
- 私有交接正文只清理当前 conversation 的受控普通目录，拒绝目录符号链接。工作区文件、`.scry/`、Provider 原生历史、未归属计费聚合和未发送草稿保留；当前已删除页面仍可复制草稿。
- **共享限制**：发现任一共享引用时，保留该逻辑会话整组原生 App 副本，只清理它独占的交接正文与逻辑入口。之后引用消失也不自动回收，目前没有单独回收入口；确认框明确说明。需要精确回收时，随 fork 引入显式引用回收计划，不能把本阶段算作共享数据的彻底物理删除。
- UI 复用 ModalFrame。默认聚焦取消；结果聚焦关闭；删除触发按钮移除后回到“刷新证据”。部分失败显示“继续清理”，不把不可用正文显示为空历史。

### 实际验证与版本

开发从 `934e22c` 开始；期间并行工作合入 `eb67c3d` / App **0.2.194**，保留 `bd60826` 及其后续 remote/performance 成果。本次没有改版本。最终检查使用 macOS arm64、Node 24.18.0、Electron 42.10.1、CLI 0.2.49。

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| typecheck / build | 通过 | 最终 node/web 检查及生产构建；8 个产物 hash 与最终 UI 证据匹配 |
| focused unit | 12 文件 / 128 测试通过 | 含 14 项删除测试、真实临时 SQLite 别名路由、归属、迁入、历史、preload、identity 和 remote 边界 |
| 隐藏生产 IPC/UI | 通过 | 全部场景共 10 次合成 Provider 调用、2 次重启；删除自身不调用 Provider。真实清理 Claude/Codex 两份归档、SQLite 恰少 2 轮；工作区文件及 `.scry` 哨兵不变 |
| 部分失败和拒绝 | 通过 | 真实私有目录换为符号链接后拒绝删除其目标、保留 pending；显式修复后重新预览并完成。取消、陈旧指纹、伪造 profile、旧命令和旧删除入口均受检验 |
| 重启 | 通过 | 完成状态、回执、归属阻断与不重发通过两次完整 App 重启；pending 删除冷加载恢复另由 store 单测验证，不冒充完整 App 中途崩溃恢复 |
| 负对照 | 按预期失败 | 隔离副本去掉目录校验后两项拒绝断言失败；错误按 Native 别名分配 run 后真实 SQLite 路由断言失败 |
| 完整 renderer UI | 最终通过 | 含 Credits、remote workbench、source control 与统一会话；仍不是前台 OS、手机或真实账号验收 |
| 最新全量 unit | **未全绿** | 新基线 3252 通过、1 失败、4 跳过，另有 Vitest `onTaskUpdate` worker 超时。失败为未改动的 `remote-workspace` 5 秒 Git diff 用例；focused 通过不抹掉此结果 |
| CLI / shell / 开发包 | 通过 | CLI 32 文件 / 587 测试、临时 tarball smoke、shell；开发包 298718180 bytes，packaged security/crash/remote smoke 通过；无正式签名、公证、安装或发布 |

### 保留的失败与诊断

- 首次新增删除 smoke 误读不存在的 `remote-effect.txt`；真实 fixture 写 `remote-first.txt`。改为先读取已存在的工作区文件，再比较删除前后内容，没有删减文件副作用断言。
- identity 测试同时 `mkdir(home)` 与递归创建 `home/.claude`，实测触发 `EEXIST`。只移除冗余父目录创建；在隔离副本强制子目录先完成，旧设置失败、修复后同序通过，所有认证断言不变。
- `remote-workbench` 5 秒失败在隔离全量中复现，并采集真实 Git 时序；详见 [Git 超时诊断](source-control-timeout-diagnosis.md#统一会话删除期间的-remote-workbench-复现2026-10-16)。当前合入的 `18d8471` 已给同一用例采用既有 15 秒真实 Git 预算；本次不重复修改该文件，不宣称宿主启动长尾消失。
- 较早全量的 Pi `unrelated/later-toolUse` 两项 5 秒超时保留；4 项相关 focused 场景通过，未改 Pi 生产代码、断言或预算，不宣称已定位其时序根因。
- Meta Prompts 曾在搜索 `not found` 时得到空搜索值而非零结果。随后未重现；保留现有焦点/值读回，补充最近 40 条原生搜索事件和焦点诊断。最终 full UI 通过，不证明首轮或更早泛化异常的根因已解决。

### 可读证据

- 最终 focused / CLI / shell / package：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-c92f7408de647099.log`
- 最终 UI 与 hash：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-unified-rendering-YHv4A1/verification.json`；人工检查窄浅色确认框及深色部分失败截图，不冒充逐张检查。
- 最新全量失败：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-0b5fc4fe9c60d02b.log`
- 原始 identity / remote 失败：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-f9915b62d783d653.log`；Pi 失败：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-b15f0139690eb51b.log`；Meta Prompts 失败：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-eff2a7fbfec8dabf.log`
- 负对照、identity 可控顺序及 focused Git 时序：`/tmp/scry-delete-control-1DKj3Z/`；完整 Git 诊断副本：`/tmp/scry-delete-full-diagnostic-654NUf/`。副本与日志保留；测试执行已结束，破坏性场景只使用临时数据。

### 下一责任动作

本任务接着实现按被选轮次的真实 owner/provider 路由的原生 fork、外部结果 unknown 围栏及共享引用显式回收；不能用纯 App 历史复制冒充原生 fork。维护者/本任务后续在可复现负载下补采 `remote-workspace`、Pi 和 worker 超时的时序；Meta Prompts 若再失败，使用本次事件记录定位。真实账号、手机及前台系统验收仍需授权。第 4 项尚未完整交付，本次不推送、不安装、不发布。

## 11. 用户授权重新构建并安装（2026-10-16）

用户随后明确要求重新构建、安装，并自行重启。仅桌面版本升为 **0.2.195**，CLI 保持 0.2.49；没有追加功能变更。

- `check:cli-release`：32 文件 / 587 测试、CLI tarball smoke 通过。
- `install:mac:dev` 完整执行：typecheck、全量 unit **3253 通过 / 4 跳过**、shell、重新打包、packaged security/crash/remote smoke 及原子安装通过。此次没有 worker error，但不以本次通过宣称前述偶发超时根因已解决。
- 已安装 `/Applications/Scry.app`，读回版本为 0.2.195；`app.asar` 与本次已验证构建逐字节一致。旧 0.2.194 保留于 `/Applications/.Scry.app.backup`。
- 构建移除发布凭据并关闭签名身份自动发现，是开发安装，不是正式 Developer ID 签名、公证或发布。未主动退出或启动用户的 Scry，重启留给用户；未推送。
- 安装日志：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-b2db0b77e2b2d703.log`。

## 12. 普通聊天 Agent 菜单接续（0.2.195 开发代码，未安装）

本节更新前述独立统一对话页面的交互，不改变 ledger、ownership、回执和删除合同。

### 用户路径与实现

- 在正常 composer 的 Agent 菜单切换 Claude、Codex、已登记的 Pi Profile。选择只改变下一条消息的目标，不提交消息、不启动 Agent 任务（能力/模型查询沿用原菜单）。新建会话仍走原生路径；已有会话首次切换时迁入稳定的逻辑对话。
- `ConversationView` 只负责逻辑状态，复用 `SessionChatView`、Agent/model/permission 控件、草稿和右侧工作台。移除侧栏独立的“新建统一对话”入口；迁入保留原标题和未保存的 surface DOM，不重新挂载终端/文件面板。
- 发送时自动规划并补齐目标 binding 缺失的全部可见文字；不再要求逐项勾选和逐次预览确认。仍不转发工具协议、reasoning、usage 或子代理执行。切换后沿用目标 Provider 的权限合同，Pi 仍必须明确选择本机完全访问。
- 迁入前只读核验源与目标的接续能力及完整历史包装预算。超出 **32 KiB** 时拒绝切换并保留原生入口；不先退役源会话再让用户卡在无法发送的逻辑对话中。不静默截断历史。
- 迁入不冒充恢复：旧原生 binding 仍 retired。第一次接续说明将从文字历史建立新上下文。后续 A→B→A 使用各 binding 自身的已接收覆盖，避免重复导入。
- 迁入 IPC 回包丢失后，只读 `previewAdoption` 返回已存在的原始 ownership 和 fingerprint；匹配才迁移草稿/面板，不重发写操作。未知投递即使 composer 为空也持续显示，不能被 completed 的表面状态掩盖。读取也失败时显示 unknown，保留草稿，由用户恢复连接后核对。发送失败不自动重发；显式“核对 / 继续原发送”复用同一不可变命令，宿主尚未收到时可能首次发送。

### Pi / Rotom 边界

- Pi Profile 必须精确匹配 `pi:<16 hex>`，不能用显示名、默认别名或另一个 Profile 的覆盖记录。
- 接续 key 包含已知 launcher、实际 Node/runtime、配置/认证 namespace、项目配置及清洗后的启动环境；配置每次重读，二进制摘要采用有界 stat-key 缓存。投递 prompt 前再核对，pool 也按该身份隔离。
- Rotom 公开 `bin/rotom` 与直接 `bin/rotom-launcher` 均支持；采用已审阅 **0.1.25** 的两个 shell 入口内容 hash，而非仅信文件名或字符串 marker。入口内容变化时明确 unavailable：升级路径是重新审阅启动/环境/配置合同并更新 hash 与回归证据，不自动放宽。
- 在本机已安装的 Rotom 0.1.25 **源码**上做过只读验证：临时 HOME/config、合成 auth，两个入口均解析出 identity，未启动 Provider、未读取真实凭据。证据：`/tmp/scry-agent-switch-rotom-contract.json`。真实账号的模型调用仍未验收。
- accepted 要求实际持久化 JSONL 的 session header、native session ID 与完整 user 文本匹配；RPC ack 或启动成功不算输入回执。错误 session、改写输入、缺失持久化记录都不能扩展覆盖。

### 验证与证据

所有 Electron 操作使用隐藏窗口、临时 userData/workspace 和合成 Provider；没有安装、版本提升、真实账号调用或发布。

| 检查 | 结果 / 范围 | 证据 |
|---|---|---|
| `npm run typecheck` | node / web 通过 | `/tmp/scry-agent-switch-typecheck-delivery.log` |
| focused unit | 15 文件、499 测试通过；涵盖 Pi 输入/身份、adoption、ledger、preload、草稿/面板及共享 composer。最后补充发送准备期锁定与空草稿 unknown 提示后，另跑 renderer/handoff 244 测试及完整 UI gate 通过 | `/tmp/scry-agent-switch-related-delivery.log` |
| 负对照 | 故意禁用迁入回包丢失后的只读恢复，新增测试失败；恢复实现后 4/4 通过 | `/tmp/scry-agent-switch-readback-negative.log`、`/tmp/scry-agent-switch-readback-positive.log` |
| `npm run test:renderer:ui` | 正常菜单迁入、切换不发送、草稿/右侧 DOM 保留、Claude↔Codex、合成 Pi Profile↔Claude、多轮返回原 binding、重启/身份变化、管理/删除与 ownership 拒绝均通过 | `/tmp/scry-agent-switch-renderer-delivery.log` |
| 当前 UI/IPC artifact | 8 个构建文件 hash 与最终构建一致；浅/深色、窄屏及迁入状态截图留存 | `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-unified-rendering-3YQbjP/verification.json` |
| shell / CLI | shell 通过；CLI 32 文件、587 测试及 tarball smoke 通过，后续没有修改对应源码 | `/tmp/scry-agent-switch-shell.log`、`/tmp/scry-agent-switch-cli.log` |
| `npm run pack:artifact` | 开发包及 packaged security/crash/remote smoke 通过；298,729,000 bytes，未安装 | `/tmp/scry-agent-switch-package-delivery.log` |
| `npm run performance:measure` | L1 ratchet 通过；25 项 unchanged、2 项 pass；3 个 CPU instruction candidate 缺失，没有 worse。不代表切换延迟或真实日常 L2/L3 结论 | `/tmp/scry-agent-switch-performance-final/measure.json` |

全量不能标绿：早期一轮旧 Agent 锁定提示断言失败，已按新的交互合同更新。其后一轮 **3265 通过 / 1 失败 / 4 跳过**，失败为未修改的 `performance-feedback.test.ts` 归档顺序断言。最终全量命令在 240 秒后超时，仍出现同一归档排序失败，没有完整统计，保留日志 `/tmp/scry-agent-switch-full-unit-current.log`。超时后本次 Vitest 进程已退出，没有盲目扩大测试超时重跑。

日志排序缺陷独立复现：原有 `archiveStamp()` 使用毫秒时间戳加随机 UUID 后缀，reader 按文件名排序；同一毫秒轮转会按随机后缀排列，而不是写入顺序。固定一毫秒、使用未修改的 journal/reader，得到 `[6,7,4,5,10,11,8,9,2,3,0,1]`。证据 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-journal-order-control-PaEyJF/diagnosis.json`；本次没有顺带修改采集/排序格式，建议单独修复并补确定性回归。

后续经用户授权的[独立排查](performance-journal-order-diagnosis.md)已修复归档顺序；旧实现的负对照失败，新实现全量 **3274 通过 / 4 跳过**，shell、typecheck、build 通过。前次失败和超时记录保留，不据此宣称所有历史偶发超时已解决。

### 尚未覆盖

- 真实 Claude/Codex/Pi 账号的端到端接续、真实付费调用、前台焦点行为、正式签名/公证和安装均未执行，需另行授权。
- 当前接续仍限纯文本；附件、slash 命令、Steer、原生 fork、共享副本显式回收不在本轮交付内。原生 fork 与回收的后续进度见第 14 节；第 4 项完整路线图仍未全部完成。
- 32 KiB 超限不会隐式总结。若需支持长会话，下一步须单独定义可审阅的压缩/附件交接合同及验收；不能删除上限或静默丢内容。

## 13. 用户授权安装 0.2.196（2026-10-17）

用户明确要求“构建并安装，我来重启”。以 `07b624d`（含 `f21b5b2` 的 composer Agent 切换和日志排序修复）冻结源码，仅将桌面 package/lockfile 升至 **0.2.196**；CLI 仍为 **0.2.49**。

- `check:cli-release`：32 文件 / 587 测试、CLI tarball smoke 通过。日志 `/tmp/scry-install-0.2.196-cli.log`。
- `test:renderer:ui`：隐藏窗口 UI、生产 ownership/统一对话 IPC 等完整通过。日志 `/tmp/scry-install-0.2.196-ui.log`；UI evidence 位于 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-unified-rendering-q75i2D/verification.json`，8 个 artifact hash 均与最终构建一致。
- `install:mac:dev` 完整执行：node/web typecheck、全量 unit **3274 通过 / 4 个原有检查跳过**、shell、App/CLI build、包检查、packaged security/crash/remote smoke 及原子安装通过。日志 `/tmp/scry-install-0.2.196-install.log`。
- 安装后独立读回 `/Applications/Scry.app` 版本 **0.2.196**、内置 CLI **0.2.49**；已安装 `app.asar` 与验证后的开发包逐字节 hash 一致：`144096b49c29713319ca636808833574365ebe91ad45cb740d620d76213a7270`。读回证据 `/tmp/scry-install-0.2.196-verification.json`。
- 原 **0.2.195** 保留在 `/Applications/.Scry.app.backup`，其 `app.asar` hash 与安装前快照一致。
- 清除发布凭据并关闭签名身份自动发现；这是开发安装，不是正式 Developer ID 签名、公证或发布。没有主动退出或重启用户正在使用的 App，重启由用户执行；未调用真实账号、未推送。

## 14. 原生分支与共享副本显式回收（2026-10-17）

### 实现与边界

用户要求继续第④项。发现同一工作区有桌面远程功能并行写入后，按用户选择将本次改动迁入独立 worktree，原工作区只撤回本次对应的 hunks，保留另一任务的修改。分支 `feat/conversation-fork-4bj0ay7k` 基于 `386fb6e`；本节验证不包含随后主分支的远程功能提交，不等于两项功能已合入验收。

- 复用聊天轮次的“在新会话中分支”按钮、原生 Provider fork facet、`verifyForkArchiveBoundary()`、context admission、Provider operation lease、workspace 与 MCP/Hook trust gate。main 从所选轮次推导真正的 binding/provider/profile/native ID，不使用当前 composer Agent 冒充来源。创建分支不发送新消息、不回退工作区文件。
- `conversation:fork` 先持久化 immutable command / pending intent，再执行原生操作。源 revision、输入投递、归档、接续身份均须可证明；在 Provider 效果之前复验身份。Pi 启动可能执行 extension，因此启动前和 fork RPC 前各有一次围栏；从另一 Agent 查看 Pi 历史时，须先明确选择该 Pi Profile 和本机完全访问，不继承另一 Provider 的完全访问选择。Claude SDK helper 的宿主目录与运行时配置不一致时拒绝分支。
- 成功后登记新的 native ID。分支点之前仅共享归档引用，不克隆 usage/trace 数据库行，不转移源 native session 的执行权。继承覆盖只来自所选 binding 已证明的内容；其他 binding 的缺失正文仍在下一次发送时补齐。
- 相同 command 只读回原结果；回执丢失不会自动重建。越过 Provider 效果边界后的错误、原生身份异常、重启后的 pending 均保持 `unknown`，阻断发送、重复创建及不安全删除。界面的“核对 / 继续原分支”明确是同一请求；宿主未收到原请求时，用户点击可能首次执行。
- 共享历史不显示可执行 fork 按钮。界面说明其只读来源，并提供“打开源对话”，保留源草稿。这里沿用既有组件和 tokens，未引入第二套聊天或分支工作台。原始外部合同参考已安装 Claude SDK `sdk.d.ts` 的 `ForkSessionOptions`：按原生 message 边界创建新 session，不把 UI 历史复制视作原生分支。
- 删除仍按整组物理副本保守保留。新删除回执用 `retainedCopies` 标明曾保留共享副本；该只读入口继续出现在已存档区域。用户可重新预览并明确确认回收；main 重验全 binding/attempt、存活引用、SQLite 真实归属和 fingerprint。最后一个引用释放后才清理；旧确认、未知分支、活跃运行不能绕过围栏。只有已完成删除的真实 owner 才释放 catalog 引用，共享只读 binding 不算 owner。旧请求只返回旧回执，不自动执行新回收。

### 验证与证据

环境：macOS arm64、Node **24.18.0**、Electron **42.10.1**。隔离源码仍标桌面 **0.2.196** / CLI **0.2.49**，这是未安装的开发检查产物，不是新发布版本。

| 检查 | 结果 | 可读证据 |
|---|---|---|
| 最终全量 `npm test` | 267 文件 / **3286 通过、4 项原有检查跳过**；shell 通过 | `/tmp/scry-fork-full-final.log` |
| node/web typecheck、`check:cli-release` | 类型检查通过；CLI 32 文件 / **587 测试**及 tarball smoke 通过 | `/tmp/scry-fork-cli.log`；最终类型检查在本节代码冻结后再次通过 |
| 最终 `test:renderer:ui` | 全部通过，包括 Credits、原生所有权生产 IPC、混合历史、分支及共享副本回收 | `/tmp/scry-fork-renderer-final.log` |
| 最终开发 `pack:artifact` | App/CLI build、传递依赖与资源检查、packaged security/crash/file/remote smoke 通过；关闭签名自动发现，无安装 | `/tmp/scry-fork-package-final.log` |
| L1 工作量计数 | 30 项：25 unchanged、2 pass、3 CPU instruction candidate missing；无 worse | `/tmp/scry-fork-performance-final/measure.json`、`ratchet.md` |

新增 backend 用例覆盖不同 Provider 的选中轮次路由与前缀、缺失覆盖、长标题保留分支标记、命令幂等、身份变化、unknown/restart/旧入口围栏、拒绝无效来源及共享副本显式回收。三个 adapter 增加效果前围栏回归，Pi 用真实临时 RPC 子进程证明拒绝启动时没有进程收据、第二次拒绝时没有 fork/clone RPC。删除实际效果与未知 IPC 回执恢复走现有隐藏 Electron fixture，不以 SSR 或程序化 `.click()` 替代交互。

隐藏 App 在当前选择 Claude 时点击 Codex 轮次：仅产生 **1 次原生 fork**，没有新增 prompt；故意在原生结果及 durable commit 后丢失 IPC 回执，点击核对仍只有这一次 fork。新分支下一条消息 resume 新 native ID，不重复交接已继承历史；源草稿保留，“打开源对话”真实导航成功。删除源 owner 后，共享归档字节不变且分支可读；最后引用释放后归档被清理，旧回收确认被拒绝，显式重新确认后不再显示保留入口。两次宿主重启没有重建分支。

最终 UI 证据：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-unified-rendering-A9Ythp/verification.json`。其中 **8/8 artifact hash** 与最终构建一致；`native-fork-*`、`shared-copy-reclaim-*` 保存深浅色截图。本次查看了深色分支页与浅色回收框，复用了既有布局，无独立新主题。

负对照 `/tmp/scry-fork-identity-negative.log`：故意移除最后一次身份围栏，新用例检测到不应发生的 native effect（1 而不是 0）并失败；恢复后通过。所有首次失败保留：新测试最初有未使用变量、preload 调用计数漏加新操作、非 canonical fixture cwd 与随机加载顺序导致错误文案断言过窄，均修正 fixture/断言合同而非放宽保护；前两次 UI 检查分别在跨会话返回后的清理/重命名按钮尚未就绪时失败，补了明确 enabled-state 等待，未加 sleep、重试或扩大超时。首次打包因 `node_modules` 指向原工作区导致传递依赖漏打包；改为独立依赖副本后完整重验通过，没有删除包完整性检查。

最终全套串行计时锁记录：`/tmp/scry-fork-final-gate.log`，10 核，load 2.09→5.45、`highLoad:false`。此耗时只是验证执行记录；未测量真实账号 fork 延迟，不宣称 L2/L3 性能提升。

### 尚未验证与下一责任动作

- 真实 Claude/Codex/Pi 账号、付费调用、前台系统焦点未验收，需要维护者单独授权。全局安装、重启、正式签名/公证、发布、push 均未执行。
- fork 仅开放当前可证明原生执行归属和稳定归档边界的轮次。共享前缀须通过“打开源对话”回到真正 owner；不猜测 fork 后重写的原生 entry ID。若要在副本内直接从共享轮次再次 fork，须先增加各 Provider 可证明的原生 ID 映射与回执验收。
- 回收是整组引用释放后的显式清理，不是逐轮 GC。旧版已删除记录没有 `retainedCopies` typed 标记时，不从自由文本回执猜测迁移，也不自动修改真实用户数据。
- 第④仍有真实账号验收和长历史/附件/命令/Steer 合同待完成；32 KiB 纯文本接续上限不变。本阶段下一步是经维护者确认后合入主分支，并重跑合入态检查；实际合入验证见第 15 节，不把隔离分支的结果冒充集成结果。第⑥、⑦未在本次开展。

## 15. 用户授权合入 main 与集成验证（2026-10-17）

用户明确要求“合并到 main 分支”。合并前 main 工作区与暂存区均干净，HEAD 为远程功能提交 `3d3bc25`。以非快进合并引入 `feat/conversation-fork-4bj0ay7k` / `584d0a1`，保留两个提交的历史，无文本冲突；检查 main/preload/聊天组件的重叠路径后，在合并态重新执行验证，没有改动产品实现或放宽检查。

| 合并态检查 | 结果 | 证据 |
|---|---|---|
| node/web typecheck | 通过 | `/tmp/scry-fork-main-typecheck.log` |
| `npm test` | 268 文件、**3300 通过 / 4 项原有跳过**；shell 通过 | `/tmp/scry-fork-main-test.log` |
| `check:cli-release` | 32 文件、587 测试与 tarball smoke 通过 | `/tmp/scry-fork-main-cli.log` |
| `test:renderer:ui` | 通过，包含远程 session parity、Credits、ownership、原生分支与回收生产 IPC | `/tmp/scry-fork-main-ui.log` |
| 开发 `pack:artifact` | App/CLI build、包完整性、packaged security/crash/file/remote smoke 通过 | `/tmp/scry-fork-main-package.log` |
| L1 工作量计数 | 25 unchanged、2 pass、3 CPU instruction candidate missing，无 worse | `/tmp/scry-fork-main-performance/ratchet.md` |

合并态 UI 证据：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-unified-rendering-ID0GGS/verification.json`，8/8 artifact hash 与最终构建匹配。原生分支回执丢失后的核对仍仅产生 1 次 fork，共享副本回收及两次宿主重启检查通过。

整套检查使用 timing lock 串行运行，记录 `/tmp/scry-fork-main-gate.log`。10 核、load 2.92→10.60、`highLoad:true`；不据此宣称延迟或日常性能改善。没有修改单项测试超时、增加重试或跳过新失败。

本次仅本地合入：未升版本、未推送、未安装或重启用户 App。开发打包关闭签名自动发现并移除发布凭据；不代表正式签名/公证或真实 Provider 账号验收。隔离分支、worktree 与本地验证日志保留。

## 16. 真实账号验收：局部通过、用量失败与环境阻塞（2026-10-17）

用户明确授权 Claude、Codex、Pi/Rotom 使用已有登录状态，在临时工作区验证接续和原生分支，允许测试消息产生模型费用；不安装、不推送、不操作真实项目。本次经生产 preload/main IPC 驱动隐藏的真实 App，没有替换 Provider adapter。只复制所需认证文件/环境项到私有临时 HOME，不复制用户 hooks、MCP、plugins 或项目内容。

### 冻结范围与实际执行

验收准备期间 main 已推进到 `81e2979`，包含另一轮性能合入。本次没有重建或混入其产物：复制第 15 节构建，main/preload/renderer 的 8 项 hash 与 `scry-unified-rendering-ID0GGS/verification.json` 全部一致。冻结的 `app.asar` SHA256 为 `7fbcbf030d74884c151586253a6d3b5321ec2f9f5c4c019aa3e1aefb400efe47`。这不是最新 main 的真实账号验收。

| 项目 | 结果 | 决定性证据 |
|---|---|---|
| Codex 新会话及宿主重启后接续 | 功能通过 | CLI `0.160.1`、模型 `gpt-6.1-sol`；第一轮记住随机 A，重启后第二轮返回 A、B；两轮均有 accepted 回执、completed outcome 和已提交归档，原生 session ID 相同 |
| Codex 从第一轮创建原生分支 | 功能通过 | 分支获得不同原生 session ID；第三条测试消息只返回 A，不含源会话后续 B；源会话仍保留原两轮；相同 fork command 返回同一分支，原生目录共两个会话文件 |
| Codex 每轮用量 | **失败，确认重复计数** | 第二轮原生单次调用为输入 14,105、输出 26、缓存读取 13,824；Scry archive、`usage.jsonl`、SQLite `usage_ledger`/`model_usage` 却记录会话累计 28,124 / 40 / 25,216，恰好多计第一轮 |
| Claude | **发送前受阻** | 默认 `2.1.226` 和已安装 npm 入口执行 `--version` 均被 SIGKILL；macOS AppleSystemPolicy 日志分别报告无法建立 provenance sandbox、security policy 不允许进程；默认入口静态 codesign 校验通过，不能据此认定二进制损坏 |
| Pi / Rotom | **发送前受阻** | 精确 Rotom `0.1.25` Profile 的能力探测提前退出；独立的只读 RPC 复现收到内置 Computer Use 的 macOS 权限选择请求，尚未返回 `get_state` 就以 code 0 退出。未授予屏幕录制权限、未选择打开系统设置、未替换成另一个 Profile 冒充通过 |

实际仅发送 **3 条 Codex 消息**，没有向 Claude 或 Pi 发送测试消息。三次原生调用合计输入 **42,197**、输出 **54**，其中缓存读取 **36,608**（已包含在输入中，不能再相加）。Provider 没有返回金额，成本为 **unavailable，不是 0**。

### 失败保留与核对方式

- 第一次 Codex 调用真实成功后，临时验收脚本错误断言不存在的 `history.status`，首次失败保存在 `result-first.json`。按实际合同改为检查 `delivery.outcome === completed` 和 `history.done`；重启后只读核对原 run 的归档，再继续第二轮，**没有重发第一条消息**。
- `/tmp/scry-real-codex-HQKSeT/probe.mjs --resume-after-fixture-error` 的功能检查 exit 0；这只证明接续/分支功能，不代表用量通过。
- `python3 /tmp/scry-real-codex-HQKSeT/verify-native-usage.py` 以原生 `task_started.turn_id` 对齐 Scry `providerTurnId`，逐轮比较原生 JSONL 与只读 SQLite。每轮恰好一个 `token_count`；检查 exit 1，三轮中仅第二轮不一致，详细结果在 `usage-evidence.json`。
- 当时初步将用量缺陷归因于首条 `total + last` 通知的取值。第 17 节的原生事件与回归更正了这一解释：恢复阶段的 `last` 本身也是上一轮历史用量，旧实现把这份快照计入新轮，而不是简单地直接选了 `total`。当时 main 的 adapter 与冻结构建源码无差异；本轮仅记录，没有修改产品实现。

### 证据、清理与剩余工作

- Codex：`/tmp/scry-real-codex-HQKSeT/`，保留 `result.json`、首次失败、发送/分支请求及回执、归档投影、原生 transcript、SQLite 和用量核对脚本。
- Claude：`/tmp/scry-real-handoff-BNSSoA/`，保留发送前失败和 `claude-system-diagnostic.log`；后者包含本次 CLI PID 对应的系统策略记录。
- Pi：`/tmp/scry-real-handoff-two-kO3zNr/`，保留能力失败。Rotom 自动初始化了临时 HOME 下的 Computer Use helper；它脱离父进程后另行按精确路径、PID 和启动时间登记并复验终止，记录在 `helper-cleanup.json`。最终定向进程检查无上述测试目录的存活进程；复制的认证文件及其有效/悬空链接均已移除，不把普通父进程退出冒充 helper 已退出。
- 临时工作区没有初始化 recorder 配置，因此没有 `.scry/records`；本次不声称验证了 workspace recorder/CLI overview、完整菜单点击流程、跨 Provider 切换、共享副本回收或长历史/附件/命令/Steer。
- **④仍未完成**。以上是修复前的验收状态。后续用户授权修复 Codex 与 Pi/Rotom，并明确不处理 Claude；修复与复验见第 17 节。涉及本机安装或系统权限变更仍须另行确认，不绕过系统安全策略。

## 17. Codex 用量与 Rotom RPC 启动修复（2026-10-17）

用户授权同时修改 Scry 与 Rotom 源码并隔离验证；**不处理 Claude、不安装、不推送、不授予 macOS 权限**。Scry 基于 `2adcfdb` 修改；Rotom 使用维护仓 `dev-agent` 的隔离分支 `fix/rpc-startup-ui`，提交 `42b68a1`，尚未合入原维护工作区（当前为 `pi-1.3-merge` 分支、`6719405`）。日常安装没有更新。

### 修复与负对照

- `src/main/providers/codex.ts`：`turn/start` 请求前的用量只建立累计基线；获得当前 turn ID 后，忽略其他 turn 的迟到通知。启动响应之前到达的新轮通知仍正常累计。真实 CLI `0.160.1` 的恢复通知携带旧 turn ID、`total` 和 `last`；这份旧快照不是新模型调用。
- Codex 回归同时覆盖旧快照、启动响应前的新用量、迟到旧通知、多请求累计及重复通知去重。旧实现的有效负对照得到 `28144 / 45 / 25216`，正确值应为 `14125 / 31 / 13824`（输入 / 输出 / 缓存读取）；修复后通过。保留 `/tmp/scry-resume-usage-negative-final.log`。
- `src/main/providers/pi.ts`：没有交互所有者的能力/会话查询显式发送 `extension_ui_response` 的 `cancelled: true`，不选择设置动作、不批准权限、不发送 prompt。旧实现对应负对照失败，见 `/tmp/scry-pi-startup-negative.log`。
- Rotom 的 `packages/rotom-pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts`：先连接 stdin，再初始化扩展；启动 UI 回执不等待初始化，普通命令仍等待。初始化失败时移除输入及信号监听。旧实现回归直接失败于 stdin reader 尚未连接，不依赖扩大超时。
- Rotom 官方 `build:pi` 门禁加入启动 UI、prompt response 与 JSONL 回归；重新生成七个私有 Pi 归档。runtime lock 仅七个本地归档 integrity 改变，没有更新第三方依赖。

### 实际验证

| 项目 | 结果 | 证据 |
|---|---|---|
| Scry 定向回归 | 5 文件、204 项通过 | Codex、Pi、conversation fork、历史输入与接续身份；`/tmp/scry-provider-fix-focused.log` |
| Scry 类型与构建 | 通过 | `npm run typecheck`、`npm run build`；`/tmp/scry-provider-fix-{typecheck,build}.log` |
| Rotom RPC / 类型 / 格式 | 16 项通过；类型与 Biome 通过 | coding-agent 包内三组 RPC 测试；`/tmp/rotom-rpc-{focused-final,typecheck-final,lint}.log` |
| Rotom 官方构建 | `build:pi`、`check:pi` 通过 | `/tmp/rotom-rpc-{build-final,check-final}.log` |
| Codex 重启续聊及用量 | **通过** | 两轮同一原生 thread；原生 JSONL、archive、usage 日志和 SQLite 逐轮核对通过。新轮原生与账本均为 `14303 / 30 / 13824`，没有计入第一轮 `14009 / 26 / 11392` |
| Pi 真实消息与原生分支 | **通过所列范围** | 隔离 Rotom Profile 完成一条真实消息，accepted + completed + committed archive；fork 返回不同原生 ID，同 command 返回同分支，源历史不变；没有再次发送分支消息 |
| 性能工作量 | 38 unchanged、2 pass、3 missing，无 worse | timing lock 下 `performance:measure`；`/tmp/scry-provider-fix-performance/ratchet.md`。`highLoad: true`，不作毫秒改善结论 |

Codex 证据位于 `/tmp/scry-provider-fixed-2HAmgY/`；`verify-native-usage.py` 与 `verify-archive-usage-log.py` 均 exit 0，两轮均匹配。archive/SQLite 比对输入、输出及缓存，usage 日志只含输入/输出；初次探索按 run 计所有日志行的断言不适用，因为其中另有独立性能样本，最终按记录类型区分。该次续聊原生事件还记录了旧 turn 的恢复快照，随后才是当前 turn 的用量通知。金额仍 unavailable，不按 0 计算。

Pi 成功证据位于 `/tmp/scry-pi-fixed-YA0P17/`。两组真实测试使用同一 Scry main 产物 SHA256 `2111ae15497ae593ad9dbef53a90265408b7beedc7b4417f8be62384d45c2a59`。其后只修正 Rotom 测试类型并重建；最终源码摘要为 `007105d6ba6dc512a0d0a4a5bf95ede1b476dfc01dd3b05bcc787d912792ae08`，695 个运行时代码/数据文件与真实测试构建逐项 hash 一致，见 `/tmp/rotom-rpc-code-equivalence.json`。最终构建另以无凭据 RPC 验证 `get_state`、EOF 正常退出和已登记进程收敛，见 `/tmp/rotom-rpc-final-smoke-fQG6uw/result.json`；这项检查没有模型调用，也没有出现权限对话框。

### 首次失败、清理与边界

- 首次组合脚本没有处理挂起的 Pi 启动问题而超时；持久化回执明确为 `not_sent`。修正夹具后用新 command 继续，已成功的 Codex 首轮只读恢复，没有重发。第二次 Pi 输入已 accepted，但隔离环境漏带既有代理配置，结果为 WebSocket 连接失败；保留 `result-before-question-fix.json`、`result-pi-network-failure.json` 与对应日志。补齐原有代理环境后的 Pi 成功来自新的独立会话，不冒充原失败轮成功，也不代表双向接续通过。
- 本轮新增 **4 次原生 prompt 尝试**：Codex 成功 2 次，Pi 成功 1 次、连接失败 1 次；另有一次启动阶段 `not_sent`。与第 16 节合计 7 次 prompt 尝试。失败尝试没有独立账单核对，不能宣称免费。
- runtime 的一次全新 `npm ci` 在 600 秒内未完成，已确认进程退出，没有重试或放宽超时。实际隔离运行使用第三方 lock 对齐的已有依赖，并校验/解包七个新本地归档；这是依赖复用验证，**不是 consumer 全新安装通过**。记录保留在 `/tmp/rotom-rpc-fix-vPPzsx/rpc-local-materialization.json`。
- 首轮测试类型检查发现新测试的类型错误，已修正；隔离 SDK 缺少 workspace 内嵌依赖造成的 OpenAI 类型错误，通过按一致 lock 复制对应依赖解决。一次 focused 命令在错误 cwd 执行、一次只读 smoke 在 EOF 后误用存活进程清理 helper，均保留首次日志并修正夹具，没有削弱断言或扩大超时。最后的类型、focused、构建和只读 smoke 均通过。
- 两个测试 App、其已登记子进程及脱离父进程的临时 Computer Use helper 均已按身份关闭。复制的认证、悬空 auth 链接与只读 smoke 生成的空认证文件已移除，见 `/tmp/scry-provider-fix-credential-cleanup.json`。私有证据和 Rotom 隔离 worktree 保留。
- 本次没有回写历史用量账本，没有安装或发布。尚未验证成功的 Codex↔Pi 双向回路、Pi 分支继续发送、完整菜单交互和 workspace recorder/CLI overview；**④仍不能标为全部完成**。当时下一步是确认是否将 Rotom 隔离修复合入原维护工作分支 `pi-1.3-merge`，并确认后续真实调用范围；用户随后授权按顺序执行，结果见第 18 节。Claude 仍不在本轮修复范围内。

## 18. Rotom 合入与 Codex/Pi 双向接续、分支续聊验收（2026-10-17）

用户授权按顺序合入、补验，再另行确认安装。本轮上限为 5 次新 prompt；不处理 Claude、不推送、不授予系统权限，也没有执行安装。

### 源码合入与冻结

- Rotom 维护分支 `pi-1.3-merge` 从 `6719405` fast-forward 至 `42b68a1`，无冲突、无额外实现改动；与隔离分支的 Git tree 一致。合入后 `check:pi`、16 项 RPC 回归、TypeScript 与 2 项构建器测试通过，日志为 `/tmp/rotom-rpc-merge-{check,tests,types,builder-test}.log`。
- Scry 从干净的 `2405d92` 重新构建，冻结 main/preload/renderer 的 13 个文件；main SHA256 仍为 `2111ae15497ae593ad9dbef53a90265408b7beedc7b4417f8be62384d45c2a59`。Rotom 使用与合入提交相同的隔离 runtime，源码摘要 `007105d6ba6dc512a0d0a4a5bf95ede1b476dfc01dd3b05bcc787d912792ae08`；695 个运行时代码/数据文件与已提交归档逐项一致。没有把旧日常安装当成新修复运行。
- 所有真实调用经隐藏 Electron 的生产 preload/main IPC 发起，临时 HOME/userData/workspace 隔离；保留既有代理环境，仅复制 Codex 与 Pi `openai-codex` 所需认证，不复制用户项目、hooks、MCP 或额外插件。

### 五条消息的决定性结果

模型为 Codex `gpt-6.1-sol` 与 Pi/Rotom `openai-codex/gpt-5.6-sol`。A/B/C/D 为本轮生成的独立随机标记；下表使用别名，不是硬编码模型返回。

| 步骤 | 结果 | 接续与历史证据 |
|---|---|---|
| 1. Codex 输入 A | 回复 A | 新原生会话，无缺失历史 |
| 2. 切换 Pi，输入 B | 回复 A、B | 只交接第 1 轮的 user/assistant 两项正文 |
| 3. 关闭测试宿主、重启，再切回 Codex 输入 C | 回复 A、B、C | 恢复同一 Codex 原生 ID；只交接第 2 轮两项正文，不重复交接已覆盖历史 |
| 4. 再切回 Pi，输入 D | 回复 A、B、C、D | 恢复同一 Pi 原生 ID；只交接第 3 轮两项正文 |
| 5. 从第 2 轮 Pi 创建原生分支并续聊 | 仅回复 A、B | 分支有独立原生 ID；续聊明确走 resume、缺失历史为零；原生分支文件保留第 2 轮输入/回答，排除源会话后续的实际 C/D 内容与原生 entry ID |

五轮均有 accepted 投递、completed outcome 和已提交归档。每次 preview 都未改变 conversation revision/轮次数，未启动新 run。重复同一 fork command 返回同一分支；原生文件只有一个 Codex session、两个 Pi session，未发现额外持久化分支。分支续聊后，源对话的 run、binding、投递、user 正文和 assistant 正文保持不变。

### 独立核对与清理

证据目录：`/tmp/scry-handoff-roundtrip-i597ha/`。`probe.mjs` 首次 exit 0；`verify-evidence.py` 独立解析原生 JSONL，按 Codex turn ID / Pi user entry ID 对齐归档，再核对 usage 日志、SQLite `usage_ledger` 和 `model_usage`，exit 0；报告为 `verification.json`。

- 五轮原生用量与各存储层对应字段一致；两张用量表均恰好 5 行。Pi 分支复制的旧 assistant 用量没有重复计入 Scry 账本。
- Codex 两轮输入/输出/缓存分别为 `13999 / 27 / 11392`、`14418 / 33 / 13824`。Pi 三轮分别为 `4389 / 23 / 4736`、`588 / 40 / 8960`、`9188 / 23 / 0`。这些是 **Provider 原生字段**：Codex input 包含 cached input，Pi input 不包含另列的 cacheRead，不把 raw input 跨 Provider 直接相加冒充统一总量。
- Pi 三轮价格表估算合计 **$0.0638584**，账本明确为 estimated；Codex 没有提供金额，所以实际总费用仍 unavailable，不写成零或完整账单。
- `freeze.json`、`rotom-runtime-integrity.json`、请求/回执、`source-before-fork.json` 与 `source-after-fork.json` 保留可复核证据。宿主重启和最终关闭分别追踪 7、8 个进程；另行按身份关闭临时 Computer Use helper。最终 active runs 为空、定向进程检查为零，认证文件及有效/悬空链接均已移除，见 `cleanup-check.json`。私有证据与隔离 worktree 保留。

### 安装状态与剩余范围

验收期间另一项已授权的性能任务安装了 **0.2.197**，并将版本/文档合入 main 至 `06a49e9`。该安装冻结源码为 `313f451`（base `2adcfdb`），**不含 `2405d92` 的本次 Provider 修复**。本轮只读核对安装包：版本 0.2.197、main SHA256 `bf615ca0395475f5f60c9d9e5d9854edb2e9d5e0f0227a765cc8336278c80ac0`，缺少修复构建具备的两处唯一标记；记录在 `installed-scry-observation.json`。这是静态安装文件核对，不替代运行中进程证明。本轮没有覆盖这个安装，也没有升级日常 Rotom。

`2405d92` 到当前 main 的 runtime 源码与 scripts 无差异，仅版本/文档变动；本次真实验收仍按冻结构建报告，不冒充已安装 0.2.197 的验收。**Codex/Pi 的上述纯文本闭环与 Pi 分支续聊已通过**；完整菜单交互、workspace recorder/CLI overview、长历史、附件、原生命令、Steer 仍不在本轮证据范围，不能据此将④全部标为完成。下一步须由用户授权新的本地安装流程；安装涉及当前 Scry 会话时先安排安全交接，不直接终止承载本任务的宿主。
