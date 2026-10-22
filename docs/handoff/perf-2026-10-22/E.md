# 批次 E：桌面远程 trace 增量化（#6b）

分支：`perf/e-remote-delta`。**批次 A 核验通过后由审查方从 `perf/handoff` 切出**（A3 也改 `RemoteChat.tsx`，避免冲突）。先读 [README.md](README.md)、[review.md](review.md) #6，以及 `docs/desktop-remote.md`、`docs/remote-reliability.md`、`docs/performance-experiments/20261019-remote-session-opening.md`。

范围仅限 Mac→Mac 桌面远程（`desktop-client` / `desktop-host-reader` / `RemoteChat`）。iOS 客户端走另一套传输，不在本批。

## 现状

- 客户端：`RemoteChat.tsx:472` 每 1.5 s `api.trace`；`desktop-client.ts:521` 发 `{ kind: 'trace', runId }`，校验并映射全部 items（上限 `MAX_ITEMS = 10_000`，`:30`）。
- 宿主：`desktop-host-reader.ts:147-156` 每次返回整个 `run`。
- 协议类型：`src/shared/desktop-remote.ts:162`（query）、`:168`（result）。
- 能力协商先例：`DesktopRemoteCatalog` 的可选能力字段（`providerDiscovery`、`workbench`、`sessionFork` 等，`desktop-remote.ts:125-140`）。

## 先测（单独提交）

受控场景：一轮持续输出到 1000 / 5000 items，记录每次轮询的响应字节、客户端校验/映射耗时、renderer 提交耗时，以及整轮累计字节（L1；能做 L2 更好）。

## 改法方向

1. 协议增加游标：query 带 `afterSeq`（或等价的单调序号/事件数）与宿主返回的 `revision`，result 返回 `{ items: 新增或被替换的事件, revision, reset?: true }`。宿主无法提供增量（run 被替换、序号不连续、items 被 `result_superseded` 删除等）时返回 `reset` 全量。
2. 新能力字段（例如 `traceDelta?: 1`）放进 catalog；**旧宿主不声明时继续走现有全量路径**，不得报错或显示为空。
3. 客户端在 `RemoteChat` 侧用与本地相同的增量合并（`applyTraceBatch` 语义）合入，而不是整体替换 `activeRun`。
4. 有活动时保持现有间隔；无新事件时退避（例如 1.5 s → 5 s 封顶），有新事件或状态变化立即恢复。

## 红线

- 证据完整：客户端检测到序号缺口、revision 不连续或宿主返回 reset 时，必须全量重取，不能拼出一份缺事件的轮次。
- 授权检查（`run_context_mismatch` 等，`desktop-host-reader.ts:149-153`）在增量路径上同样执行。
- 宿主端增量状态有上限（每连接/每 run），断连后释放。
- 附件/图片的现有 `knownAttachmentCount` 逻辑保持。
- 新旧版本四种组合（新客户端×旧宿主、旧客户端×新宿主等）都要有测试。

## 测试

`desktop-client.test.ts`、`desktop-host-reader.test.ts`、`desktop-transport.test.ts`、`src/renderer/remote-workbench.test.ts`；`npm run test:desktop-remote`；提交前 `npm run test:renderer:ui`。

## 完成后

写 `reports/E.md`，push `perf/e-remote-delta`。不改 STATUS.md。
