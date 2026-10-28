# App runtime 拆分：M2 的前置工作，不是 M2 完成

本页记录 `feat/workflow-m0`、HEAD `c9386b60` 上未提交的源码。没有实现 TaskSubmission、off/manual/auto、一次 routing/planning 或工具禁用 authoring；没有新增执行器、调度器或 SDK 循环。生产运行仍走原有 App executor。

## 已移动的职责

- `src/main/workflow-app-runtime.ts`：App-owned Workflow Store、模板、slots、System host、capability in-flight 合并、原 planner/executor/stop 回调。原三个 IPC 注册、renderer 发送、同一 service 的关闭路径仍由 main 显式组合。
- `src/main/app-run-start.ts`：原 run-start options 和 terminal result 类型，无运行逻辑。
- `src/main/conversation-app-runtime.ts`：原 lazy ConversationStore/Service 和共享 adoption reservation Set。Provider registry、userData 保留实际调用时读取；不在 registry 初始化前求值。
- `src/main/conversation-app-ipc.ts`：原 12 个 conversation IPC 与 adoption/deletion 辅助函数。仍使用 main 的生产 trusted wrapper；原生删除、fork、context admission 和项目 authority 均由原函数注入。`prepareConversationDeletion` 返回给旧 session 删除路径，避免第二套删除合同。

启动恢复注入的是读取当前 `startupManagedRecovery` 的 getter，不是启动时的旧 Promise。Service 也必须保持 getter；不能提前构造或把 getter 当 service 对象。

## 实际检查

日志位于 `/tmp/scry-workflow-template-editor.ZnkC6L/`。

| 检查 | 结果 | 证据 |
|---|---|---|
| Workflow 迁移结构核对 | 14 项通过；保留的 264 个运行语句和顺序一致 | `m2-workflow-bridge-equivalence.json` |
| Conversation 迁移结构核对 | 46 项通过；12 个 handler、保留的 245 个运行语句和顺序一致 | `m2-conversation-equivalence.json` |
| 类型与 Workflow focused | Node/web 通过；6 文件 108 测试通过 | `m2-workflow-bridge-focused.log` |
| 类型与 Conversation focused | Node/web 通过；8 文件 93 测试通过 | `m2-conversation-runtime-focused.log` |
| 生产 conversation IPC/App | ownership 拒绝与正控、unknown 冷恢复、发送/历史/fork/删除、模板/修订/owned-copy Recorder 既有场景通过 | `m2-conversation-runtime-app.log` |
| 当前构建节点控制与 inspection | 两个离线 Agent、一个真实本机 Node 停止、两文件 TAP；原有 trusted input/焦点/430px 桌面视口、账本预算不变、冷重传无重发通过 | `m2-runtime-frame-and-counter-gates.log` |
| 既有计数门禁 | `workflow.sequence-completion/io.parent-frame.publications` 五样本均 3，ratchet 通过；collector 8 测试通过 | `m2-runtime-sequence-measure/measure.json` |

结构核对比较 TypeScript 擦除后的 JavaScript AST、字面量和控制流。只规范化明确注入的同名依赖、getter 和回调，并分别核对 main 注入表达式。两阶段源码 hash 串联。它不是运行、费用或 SDK 证明；运行证据单列。计数检查沿用原 workload，没有新增 profiler、实验或毫秒提速结论。

### 首败保留

`m2-conversation-first-node.log` 暴露 getter 被声明为 service 对象及重复的 `SessionDeletionRequest`；`m2-conversation-lazy-service.log` 随后暴露遗留未使用 import。父会话修复了 lazy getter 的所有调用、移除重复类型和 unused import，未删断言或改期限。未把 worker 的 source inspection 当验收。

## 本拆分 checkpoint 产物与限制

本拆分 checkpoint 的隔离 App 为 Scry 0.2.210 / Electron 42.10.1，Node 24.18.0。main SHA-256 为 `cba2f2a1643b1b2b65312c4f6488fa4e3bdef52b273d1d71969a4d8fe651ea6e`。现场：`scry-workflow-node-stop-app-M5Iyx6`；统一会话 UI 现场：`scry-unified-rendering-Yh0FYV`，均位于系统临时目录。节点场景记录两次 `tracked:4` closure，只证明登记资源，不证明 escaped descendants 或远端 effect。未调用真实账号或付费 Provider。

后续[并行失败策略](parallel-failure-status.md)和[目录扫描修复](catalogue-scan-status.md)保留更新的代码与验证证据；本页的构建 hash 只对应此前机械拆分，不冒充当前 App。

这不是可提交的完整拆分：`index.ts` 仍为 243,916 bytes，高于 20,000-byte authored blob 上限；四个新模块分别为 9,344 / 1,334 / 3,078 / 15,389 bytes。不能因新文件合规而绕过旧大文件的 hook。约 83KB `startAppRun` 及其他大文件仍需真实领域拆分，不能用 global、bootstrap、巨型可变 context 或手工分割提交冒充。

最近默认完整 unit 仍是 `m5-frame-lexical-all-unit.log` 的 4,068 pass / 1 fail / 4 opt-in skip；原 legacy SystemStep 用例命中 5,000ms，尚未关闭。它早于本次机械拆分；当前 focused/App 通过不替代完整 gate，也不证明该失败无关。`providers.catalog` collector 仍 unavailable，不记 0。

本次没有 staging、commit、push、安装、日常 App 重启或版本更新。下一步仍由实现者完成入口 authority 和其必要的领域拆分，以及 M3–M6 的未完成项；所有最终验收缺口继续保留在总台账。
