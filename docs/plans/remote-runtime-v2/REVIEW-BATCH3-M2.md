# Batch 3 核验（M1-2、M2-1 ~ M2-4）

核验对象：`19b1e6d..e2c80cb`。提交身份全部正确。

## 结论

M1-2、M2-2、M2-3 接受。M2-4 的装配搬迁本身是行为不变的：`startAppRun` 与 `remoteStartReceipts` 原样搬进 `createRunPipeline`，`createSessionCatalog` 改成延迟调用，`remoteRunIds`/`remoteRunLedgerIds` 上移，这几处顺序调整都正确。
但 **M2 还没有真正把运行管线和窗口分开**，进 P1 前要补一段 M2-5。

## M2-5 必做：run 管线仍直接调用 `getWindow()?.webContents.send`

导入图检查只看值导入，`BrowserWindow` 只作为类型出现，所以检查通过了。但运行管线仍然拿着窗口对象，绕过 M2-1 的 `RunRendererSink` 直接发事件：

| 文件 | 直接发送 |
|---|---|
| `run-completion.ts` | `agent:error` ×4、`agent:turnDone` ×2 |
| `run-failure.ts` | `agent:error` ×6、`agent:turnDone` ×2 |
| `run-execution.ts` | `agent:error` |
| `run-live-state.ts` | `agent:dataUpdated`、`agent:backgroundWork`、`agent:session` ×2 |
| `run-remote-state.ts`、`run-session.ts` | `getWindow()?.isFocused()`（dock 判定） |

`createRunPipeline` 的输入里也还有 `getWindow: () => BrowserWindow | null`。daemon 里只能传 `() => null`，这些事件会被静默丢掉。现在不出错，是因为 daemon 还没有 renderer；但 Batch 4 的 App 经 daemon 运行时，**错误、turnDone、session 绑定**全都到不了界面，而且没有任何测试会失败。设计 §2、§4 要求 trace 和**状态事件**都走 sink。

修法：
- 这些发送全部改成 `renderer.send(channel, payload)`，focus 判定改成 `renderer.isFocused()`。
- `RunPipelineInputs` 和 `startRun` 的依赖里删掉 `getWindow`。
- `run-pipeline-seams.test.ts` 增加禁止模式：管线模块里不得出现 `webContents`、`getWindow`、`BrowserWindow`（类型也不行）。先证明这条在当前代码上失败。
- 验证：`src/main` 全绿；`trace-runtime` / `run-completion` 等现有测试里的假窗口改用 sink，**断言内容不变**；完整 `test:desktop-remote`；`--dev` security smoke。

## 小问题（顺手修）

- `create-run-pipeline.ts` 函数体从 `const traceRuntime` 到 `remoteStartReceipts` 是顶格的，没有缩进，与文件其余部分不一致。
- 返回值同时展开了 `...traceRuntime` 又逐个列出同名成员，二选一即可。
