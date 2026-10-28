# Claude SDK 配置来源转发与职责拆分检查点

这是 M2 的局部前置修复，不是 tools-disabled authoring 或 M1–M6 完成。工作树为 `scry-workflow-m0` / `feat/workflow-m0`，基线 `c9386b60`；未提交、安装、推送、升版本或调用真实 SDK/账号。

## 修复及边界

旧实现使用 `if (opts.settingSources?.length)`，把显式 `[]` 丢弃。已安装 SDK 的 `Options.settingSources` 合同区分两种情况：省略时加载默认文件配置来源，`[]` 明确关闭这些文件配置来源。现在只在值为 `undefined` 时省略，其余合法数组原样转发。

该修复只保留调用方已指定的配置来源语义。它不是文件读写沙箱，也不单独禁用 host tools、Scry 注入的 MCP、history reader、SDK 回调或其他能力。没有据此发布新的 authoring capability，没有放宽权限或 trust/fingerprint gate。真实 SDK/CLI 是否执行这一选项仍未验收。

同时完成真实职责拆分：

| 文件 | 职责 | 字节 |
|---|---|---:|
| `agent-runner.ts` | 运行状态、输入准入、stream、停止与结果 | 13658 |
| `agent-runner-options.ts` | SDK 参数与审批映射 | 7574 |
| `agent-runner-transcript.ts` | 有界 transcript/Provider turn 身份提取 | 4919 |
| `agent-runner-observation.ts` | 原生 workflow 活动证据投影 | 2428 |

SDK 参数模块只接收该运行所需的五项绑定。运行状态、子进程句柄、身份与版本仍由原 owner 持有；没有新增全局可变状态、scheduler、worker、cache 或依赖。父级复核恢复了原来的“先登记子进程句柄，再采样身份”顺序，并将实际始终提供的 prompt 回调设为必需字段，不静默跳过。

## 已执行检查

证据目录：`/tmp/scry-workflow-template-editor.ZnkC6L/`。

| 检查 | 结果 | 证据 |
|---|---|---|
| 新回归首败 | 旧 guard 下显式空数组丢失：1 失败、2 通过 | `m2-claude-empty-settings-negative.log` |
| 类型与 focused 测试 | Node/web 通过；4 文件、101 测试通过 | `m2-claude-settings-focused.log` |
| 结构比较 | 14 项函数/公共类型/重建运行体检查通过；唯一许可逻辑差异是配置来源 guard | `m2-claude-runner-fixed-equivalence.json` |
| 当前构建与独立 App | 既有 workflow stop/native/TAP/frame/policy/size 场景通过；仍为四次离线 Provider 调用 | `m2-claude-current-production-app.log` |
| Catalogue/反馈/既有 baseline | 3 文件、17 测试通过 | `m2-claude-catalogue-source-gate.log` |

新测试覆盖省略、显式空数组、有序非空数组，且要求默认审批不带 dangerous-skip 标志。它 mock 了 `query()`，证明生产 builder 的参数转发，不证明真实 SDK/CLI 执行效果。

AST 比较在明确的 typed callback 投影下重建旧运行体，并比较 literal、operator 与声明可变性。最初跨文件 printer 的排版差异使文本比较失败；该日志保留。随后改为结构比较，不忽略这些语义字段。它不证明 microtask 时序或物理进程行为。

当前 App main SHA-256 为 `91b86e1e10a845db201724f4697fe2a2cf5c4c0292aebaca59bbe618d0c55808`，现场为 macOS 临时目录中的 `scry-workflow-node-stop-app-pmp0PH`。三次登记资源 closure 均 tracked 4，不代表 escaped descendants 或远程效果收敛。App 使用离线 adapter，不能替代 Claude SDK 验收。

## 仍未关闭

- `npm run performance:measure -- --scenario send.codex-fixture` 返回 1：`No counter collector matches send.codex-fixture`。`controls.stop-lifecycle` 的 collector 查询同样为空。这里是 unavailable，不是 0 或门禁通过。现有实验额度为 0，不新增 collector、workload 或放宽 ratchet；不据其他路径的计数声称 SDK 更快。
- 既有默认 SystemStep 5000 ms 失败，以及 size 扩大验证中的两个 native recovery 5000 ms 失败仍保留。没有在本次重跑这些失败或扩大期限。
- `index.ts` 仍为 229879 B，尚不能暂存完整候选。TaskSubmission、组合 routing/planning、完整 authoring 与其他 M1–M6 项目继续开放。
- 没有真实 SDK、Provider、账号、Jev 或费用验收。物理停止、真实配置加载与真实历史格式仍需要相应授权和独立场景，不能由 mock 或构建代替。

前一检查点见 [Session history 拆分](session-history-extraction-status.md)。本检查点保留首败和 unavailable；旧 archive 不修改。checksum 不是签名，合成现场不是可移植执行授权。
