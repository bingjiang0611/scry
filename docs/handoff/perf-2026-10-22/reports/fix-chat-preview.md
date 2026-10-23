# chat-preview workspace dirty 回归修复

## 结论与范围

**根因是 fixture 未遵守 Electron 原生输入的焦点/选区前置条件，不是产品 dirty 状态丢失。** 仅修改 `scripts/chat-preview-ui-smoke.mjs`；`src/`、UI 文案、产品保存/重载逻辑、STATUS 均不改。

分支 `fix/chat-preview-workspace-dirty` 从 `main@531e88c` 创建，创建时本地 main 与 origin/main 相同。独立 worktree `/Users/test/vibecoding/scry-fix-chat-preview-workspace-dirty`；未带入 perf/c 分支的只读 Git 改动。未安装 App，未合入 main。

## 原始操作、预期与失败

原命令：`node scripts/chat-preview-ui-smoke.mjs`。

1. 打开 Markdown 预览，展开源码；输入 `# Edited preview`。
2. 折叠/展开确认草稿保留；折叠后点击保存。fixture 暂停 workspaceWrite，确认保存完成前仍 dirty；释放写入后 dirty=false。
3. 再展开源码，点击 textarea、全选、输入 `# Unsaved reload draft`。
4. 预期源码/预览变为第二份草稿且 dirty=true，随后验证取消重载保留草稿、确认重载恢复已保存内容。

本分支修改前，步骤 3 后等待 dirty=true 超时；诊断为：

```text
value:   # Edited preview
heading: Edited preview
dirty:   false
focused: textarea
```

这里的预览仍是**刚保存的第一份内容**，不是第二份草稿已更新却没有 dirty。A/C/D 先前在 bf92d04 的失败与此一致；本次在 main@531e88c 原样再次复现。原始失败 `/tmp/scry-chat-dirty-before.log`。

## 根因证据

- fixture 首次编辑已经等待 textarea 获得焦点，以及 selectionStart=0 / selectionEnd=value.length；第二次编辑却在 `sendInputEvent` 后立即 `selectAll()`、`insertText()`，没有等待两个条件。
- `sendInputEvent` 排队投递原生鼠标事件，不保证返回时 renderer 的焦点/选区已经生效；`insertText` 需要实际焦点。事后看到 textarea 获得焦点，不证明插入当时已获得焦点。
- 临时诊断记录到产品状态 `editor dirty=true → panel dirty=true → 保存后 editor dirty=false → panel dirty=false`。第二次尝试没有产生第二份 content，也没有新 dirty=true。因此产品回调和保存合同成立。
- 只为第二次操作补上首次操作已有的两个前置条件后，宽/窄两个实例都可正常输入第二份草稿并保持 dirty；无产品代码改动。临时诊断代码已全部移除，诊断日志 `/tmp/scry-chat-dirty-debug-events.log`。

## 最小修复与 focused 回归

将两次源码替换合并到本地 `replaceSource(text)`：原生点击 → 等实际 textarea 焦点 → 全选 → 等全选范围 → 原生 `insertText`。不是程序化设置 value，也不人工设置 dirty。

新增 focused 断言：第二次编辑达到 dirty=true 后，源码必须精确等于 `# Unsaved reload draft`，预览标题必须为 `Unsaved reload draft`。输出新增 `reloadDraftApplied: true`，宽/窄分别记录，防止把旧预览或错误目标上的输入误当作成功。

**没有删验收断言、改业务预期或扩大超时。** 首次编辑重复的焦点/选区检查只是移入共享 helper，仍执行；第二次编辑增加相同检查。原有 dirty、保存中的 dirty、草稿折叠保留、取消/确认重载断言全部保留。条件等待仍使用原有 5 秒上限，child 总上限仍为 30 秒；无新增 sleep、自动重试或失败后改绿。

## 实际验证

环境：macOS darwin-arm64，Node 24.18.0，Electron 42.10.1，App 源码版本 0.2.219。复用与锁文件相同的已安装依赖，独立复制到本 worktree；只在此 worktree 使用 Electron ABI SQLite，结束后恢复 Node ABI。无付费 Provider 或外部服务写入。

| 检查 | 结果 | 证据 |
|---|---|---|
| 修复前反对照 | 原脚本复现失败于第二次输入后的 dirty=true | `/tmp/scry-chat-dirty-before.log` |
| `node scripts/chat-preview-ui-smoke.mjs` | **通过**；独立 Electron test 实例中，1000×748 与 560×448 两个实际 viewport 的 `reloadDraftApplied`、dirty/保存/重载/草稿/只读/分页路径均通过 | `/tmp/scry-chat-dirty-focused-fixed.log` |
| `npm run test:unit -- src/renderer/components/render.test.tsx` | **245 pass**；只作相邻组件回归，不替代原生输入验收 | `/tmp/scry-chat-dirty-unit.log` |
| `npm run typecheck` | **通过** | `/tmp/scry-chat-dirty-typecheck.log` |
| **`npm run test:renderer:ui`** | **完整组合入口一次通过（exit 0）**，不是拆开运行或仅重跑失败项 | `/tmp/scry-chat-dirty-renderer-full.log` |
| App build / diff check | 组合入口内 source-control / conversation IPC 的标准 App build 通过；最终 `git diff --check` 通过 | 同上日志与 Git 检查 |

完整组合入口的 16 个顶层阶段均执行：session-opening、session-capability、Credits、chat-preview、session-performance、background、steer、remote-queue、desktop-remote、session-parity、composer-history、remote-settings、session-lifecycle、source-control、conversation IPC、Pi history。保留脚本原有 `&&`，没有跳过阶段。

## 独立重放与交付状态

本次原问题发生在隔离 fixture，因此原始操作在其自己的隐藏 Electron BrowserWindow 重放，使用生产 React/CSS 组件、原生鼠标/键盘/insertText；sandbox/contextIsolation 保持开启，临时 HOME/userData/sessionData，不操作用户日常 App。workspace transport 是内存 fixture，不把这次重放声称为真实文件持久化验收。完整组合入口另覆盖现有生产 App/main/preload 的相邻 source-control 和 conversation 测试。

最终受检脚本 SHA256：`79ccac904173b8c3b6db5d86d8b23f81556397ec2a64af34e7d3a2eb82a03040`。本报告与修复同一提交交付，推送目标仅 `fix/chat-preview-workspace-dirty`。不改 STATUS，不安装、不合入、不升版本。日志保留于上述 `/tmp/scry-chat-dirty-*.log`；独立 worktree 保留供审查，测试进程已退出。

## 核验意见（审查方，2026-10-23）

**已核验。** 只改 `scripts/chat-preview-ui-smoke.mjs`。第二次编辑原来在 `sendInputEvent` 后立刻 `selectAll()`/`insertText()`，第一次编辑等待的焦点与选区条件它都没等；诊断显示失败时预览仍是第一份已保存内容，说明是输入没落进 textarea，而不是产品漏标 dirty。修复把两次编辑统一到同一个 helper，原断言和 5 s/30 s 上限都没动，并新增“草稿与预览都更新为第二份内容”的断言，防止将来再把没生效的输入当成成功。完整 `npm run test:renderer:ui` 一次通过。

这个分支基于 `main@531e88c`、与性能分支互不依赖，可以先于性能分支单独合入 main。合入后各性能分支的 UI gate 就能整条跑通。
