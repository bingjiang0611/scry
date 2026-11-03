# B2-P3a 抽出宿主组装层

返回[批量状态](../STATUS-BATCH2.md)。P3 设计 §9 第 1 步。

## 改动

- 新模块 `src/host-runtime/`：
  - `host-runtime-types.ts`：`RemoteHostRuntime`（原来在 `src/main/bootstrap/remote-host.ts` 里定义）与新增的 `HostRuntimeInputs`——只由 Electron main 能产出的那几项（`stateDirectory`、`userDataDir`、`relay`、`gatewayLabel`、`shellEnvironment`、`openPath`、`trashItem`、`historyHandlers`、`toolPanels`）。
  - `host-runtime.ts`：`createHostRuntime(inputs)` 承担原来内联在 `startRemoteHostIfEnabled` 里的整段依赖组装与 `RemoteHostService.create(...)`：workbench、desktop reader、目录选择、run binding、providers/commands、session 动作与删除、tool panels 接线、`listSessions`、`readSessionStatus`、`macRuns`。
- `src/main/bootstrap/remote-host.ts`：从 18 KB 降到 113 行，只剩 Electron 侧职责——`app.isPackaged` / `SCRY_REMOTE_HOST` 判定、`app.getPath('userData')`、`resolveRemoteRelay`、15 s Provider 快照刷新定时器、`shellEnv`/`warmShellEnv`、`shell.trashItem`、`createRemoteHistoryHandlers`、`usageAnalyticsWithCreditsQuery` 与 MCP 面板，以及 IPC handler 注册。类型也从 `host-runtime-types` 重新导出，调用方无需改动。
- 行为不变：main 仍在同一进程内调用 `createHostRuntime`，宿主装配顺序、传入的回调与原来逐项一致（唯一的形式差异是把 `stateDirectory.replace(...)` 这类路径推导换成显式 `userDataDir` 输入）。

## 验收证据

- `src/host-runtime/host-runtime-imports.test.ts`：从 `host-runtime.ts` 出发沿相对 **值导入** 图遍历（195 个文件），断言没有任何文件值导入 `electron`。类型导入不计入——它们在编译期被擦除，不会把 Electron 带进 daemon；注释里的路径也会先剥掉，否则注释会被当成依赖边。同一测试带自检：对 `src/main/bootstrap/remote-host.ts` 运行同一检查必须命中，证明检查器能失败。
- 现有 `src/main/remote`、`src/main/bootstrap`、`src/host-runtime` 测试全绿（89 files / 604 tests）。
- `node scripts/desktop-remote-ui-smoke.mjs` 在 S1 提交后跑过（组装层改动不涉及 renderer）；完整 `test:desktop-remote` 见交付验证。

## 未做（留给 P3b/后续）

- 组装层仍在 main 进程内调用；daemon 复用它、以及把 ledger/pairing 状态目录切到 daemon 自己的目录，属于 P3b。
- `toolPanels`、history readers 仍由 main 提供，因为它们依赖 `electron`（`app.getPath('userData')`、`db.ts` 顶层 `app`）。P3b 的 daemon 若需要这些能力，需要先把 `db.ts` 的 userData 注入化。
