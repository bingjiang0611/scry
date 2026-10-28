# ConversationStore 职责拆分：源码与 focused 验证通过，组合 App 验收仍失败

这是 MainTaskSubmission 持久化入口的前置拆分，不是完整 M2。没有新增 submission、policy、route、SDK 调用或调度器。

## 改动与 owner

原 `conversation-store.ts` 43,925 B，冻结为 `m2-conversation-store-before.ts.txt`，SHA-256 `2d020e6ac401b5e194c3da5b9ba81b0ec2bb008e652fb60025d8d30df53c7f20`。

| 文件 | 字节 | 职责 |
| --- | ---: | --- |
| `src/main/conversation-record.ts` | 13,787 | 原 decoder、校验、类型、intent hash |
| `src/main/conversation-store-foundation.ts` | 19,931 | 原 admission、directory、userData、ownership、recoveryFailure；IO、归属、创建、fork、删除、metadata |
| `src/main/conversation-store.ts` | 11,834 | 原 public import path；turn admission、settlement、history、retirement、recovery |

所有方法仍作用于同一个 Store 对象。只有 foundation 初始化一次 `ContextAdmission`，使用原 ownership map 与锁键。没有复制状态或增加第二本持久化账本。新增 `extends`、`super(userData)`、protected 可见性和一个 `recover` 抽象签名；原构造函数 body 位于 foundation。方法在 prototype 链上的位置变化，不声称全部 JavaScript 反射行为相同。受影响的调用合同由类型检查及 focused 测试覆盖。

原 path 的 9 个 public value/type exports 保留。模块没有回引 `conversation-store.ts`；record 的 history 依赖也是原模块已有依赖。

## 实际检查

- `m2-conversation-store-equivalence.cjs/.json`：完整解析冻结原文件和三个当前模块，比较 20 个全局声明、29 个 constructor/method/field AST，包含 literal、operator、变量声明 flags；仅忽略 export 与 private/protected 修饰。验证 constructor 仅 super bridge、唯一 admission、唯一状态 owner 和唯一抽象 recover。内存中将共享 admission 换成每次新建的负控被拒绝，未修改产品文件。
- `m2-conversation-store-public-api.json`：原 9 个 public exports 和 type/value 类别一致。
- 首轮 `m2-conversation-store-focused.log` 停在 Node typecheck：foundation 多余 `planConversationContinuation` import、store 从 record 错引未导出的 `isCommandId`。保留首败。父会话删除多余 import，并恢复从既有 `shared/runtime` 直接导入；没有改校验或运行逻辑。
- `m2-conversation-store-corrected-focused.log`：Node/Web typecheck、11 文件 117 tests 通过。覆盖真实临时文件的并发归属、丢失写入 ACK 后重读、损坏拒绝、重复/unknown、fork、删除、history body 与 reader 撤销。
- `git diff --check` 通过。没有新增 collector、优化实验或门限改动。既有 `send.codex-fixture` collector unavailable，不用别的 collector 冒充此路径证据；不作速度结论。

## 原组合 App gate：失败，不刷绿

`m2-conversation-store-production-app.log` 执行原 `npm run test:conversation:ipc`，包含 build、ownership 与 unified 两个原场景。build 通过；ownership 的 6 个拒绝向量、未归属正控、完成归档/工作区写入及启动失败恢复通过。随后 unified 场景在 `workflow-system-ipc-checks.mjs:35` 得到 `false`，期望 `true`。

原 fixture 在 stopOwnedApp 后删除了 `scry-electron-smoke-Fjc7RZ`。该现场已不可读取，**不能补造其 check state、stdout、PID 或原因**。此失败保留，不能根据另一场景推定它只是超时。

### 一次保留现场的独立诊断

`electron-security-retained-diagnostic.mjs` 是临时副本，不改仓库 fixture。只将相对 imports 改成相同文件的绝对 URL，并在原 `stopOwnedApp` 返回后保留目录。断言、deadline、所有原场景 body、build、ownership + unified 工作量未改。源比对在 `m2-conversation-store-retention-source.json`，不是通过原 gate 的证据。

`m2-conversation-store-retained-diagnostic.log` 再次完成 ownership，保留 `scry-electron-smoke-NcfrPo`。unified 在 `:42` 得到 exitCode null，期望 17；保留 `scry-electron-smoke-4E5g16`。

`m2-conversation-store-check-diagnostic.json` 从后者 canonical records、重新核验 hash 的 immutable stdout/stderr 及 replica marker 得到：

| 同样冻结 2,000 ms 的 check | 记录 | 输出 / marker |
| --- | --- | --- |
| 预期 exit 0 | passed、exit 0、settled | `PRODUCTION-CHECK-OBSERVED` / `1` |
| 预期 exit 17 | timed_out、exit null、SIGKILL、settled | stdout/stderr 均 known empty / marker 缺失 |

后者不能证明已执行到 fixture marker，更不能显示为预期的 failed/17。该次诊断仍失败，不改变原首败。测量时 highLoad=true，但没有因果证据归咎于负载。没有增加 2 秒限制、削弱断言或循环重跑。

原执行顺序先运行 workflow template/SystemStep 检查，再调用 `exerciseUnifiedConversation`；**本次三轮普通对话、其后 cold/restart/identity-change 场景都未开始**。ownership 的真实 App 子集通过不代替它们或完整 App 验收。

两个保留目录的末尾记录证明原 `stopOwnedApp` 已返回；其范围仅是 helper 登记及重验的资源，不证明 escaped descendants 或外部业务全部闭合。

## 剩余范围

- 当前源码已重新 build 并用于上述真实 App 子集；完整组合 gate 未通过。旧成功 App 只是历史 checkpoint。
- 既有 SystemStep/recovery 5 秒、Native SDK 8 秒、Node TAP 5 秒和此处 2 秒失败都保留，不声明互不相关或已解决。
- Native authoring 仍无真正候选/禁宿主工具执行证明，见 `authoring-result-status.md`。额外只读 Mach-O 检查显示选定 executable 为 arm64，不能解释 SIGKILL，也不构成可用 capability。
- parent 下一步负责 Main-owned immutable submission 与 exclusive dispatch，复用该 Store owner 与既有 execution 链；Native 启动及原期限验收仍由 parent 跟进，不为推进代码降低门限或隔离。
- `index.ts` 仍超过 20,000 B，当前不能 stage/统一交付。没有 commit、push、install、升版本、重启日常 App、业务工作区写入或真实账号/模型/Jev 费用。
