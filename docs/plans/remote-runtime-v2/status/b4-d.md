# B4-D 设计补全

返回[批量状态](../STATUS-BATCH4.md)。任务书第 54-77 行。

## 交付物

| 文件 | 性质 |
|---|---|
| [P3-daemon-design.md §13](../P3-daemon-design.md) | 设计正文：矩阵结论、入网、生命周期、trace 预算、badge 事件 |
| [P3-ipc-matrix.md](../P3-ipc-matrix.md) | 生成：119 个 channel 的去向 |
| [P3-ipc-ops.md](../P3-ipc-ops.md) | 生成：17 个新增 op 的请求/响应/授权 |
| [P3b-local-runtime-design.md §8](../P3b-local-runtime-design.md) | 迁移进度表按 Batch 4 任务细化 |
| `scripts/daemon-ipc-routing.json` / `scripts/daemon-ipc-ops.json` | 判定与新 op schema（手工维护，按职责拆成两个文件以过 20 KB 门禁） |
| `scripts/daemon-ipc-matrix.mjs` | 生成器 + `--check` 模式 |
| `scripts/daemon-ipc-matrix.test.ts` | 7 条守卫测试 |

## 矩阵怎么来的

`collectChannels()` 扫描 `src/main/**`（排除 `*.test.ts`）里的 `handleTrusted('<channel>'`，去重并记录注册文件；`protocolOps()` 从 `inner-mtls-dispatch*.ts` 的 `request.op === '…'` 分支读设备协议词汇；`workbenchMethods()` 解析 `DESKTOP_WORKBENCH_METHODS`；`performancePaths()` 读 `scripts/performance-paths.json`。三者与 `daemon-ipc-routing.json` 逐行 join，产出矩阵，同时收集所有缺陷。

结果：119 个 channel → 留在 main **27**、转发到现有 op **39**、需要新增 op **53**（由 **17** 个新 op 承载）。

## 守卫测试覆盖

| 测试 | 会失败的情形 |
|---|---|
| `classifies every privileged channel…` | 有 channel 没判定（空缺陷断言） |
| `fails when a new channel has no routing decision` | 新增 channel 未判定 → 报错含注册文件 |
| `fails when a routed channel is deleted or a forward op…` | 判定残留已删 channel / `forward` 的 op 不在 dispatch 词汇里 / `main` 行没有理由 |
| `fails when a new op drifts from its channel…` | method ≠ channel 最后一段、op 缺 schema 字段、path 不在 performance-paths |
| `reads its own inputs instead of trusting an empty scan` | 解析器静默返回空集（自检 `submit` 在、`steer` 不在、terminal/workspace method 在） |
| `keeps both generated documents up to date` | 生成文档与源码漂移 |
| `documents every new op next to its channels` | 新增 op 数量或清单不一致 |

**反例已实测**：临时新增 `src/main/zz-scratch.ts` 注册 `agent:scratchChannel` 后，3 条测试失败并报 `` `agent:scratchChannel`：no routing decision (registered in src/main/zz-scratch.ts) ``；删除该文件后 7 passed。日志 `/tmp/b4d-guard.log`。

## 设计结论（需要维护者看的部分）

1. **新增 op 用 surface/method 聚合**，不为 53 个 channel 造 53 个顶层 op（沿用 `desktopWorkbench` 约定：一个授权边界一个 op）。
2. **同一份 userData 只能有一个写者**：开关打开后 `projectStore`、usage JSONL、SQLite 由 daemon 提供；`agent:recentFolders` 留在 main，因为它是窗口侧最近列表，与 daemon 的目录投影分开存储。
3. **`runTraces:*` 与 `agent:traceAck`/`traceResynchronized` 留在 main**：它们是 renderer 投递桥的订阅与回执，源改到 daemon 但合批与背压不变。
4. **`workspace:readKnown`/`readPageKnown`/`openKnownExternal`/`resolveFile` 留在 main**：用户目录外单文件只读引用由 main 签发，daemon 不持有该引用表。
5. **本机入网（§13.2）需要确认授权语义**：daemon 首启写一次性 secret，App 同 uid 读取换 `scope: local` grant；该 grant 只对 unix socket 有效。
6. **trace 预算（§13.4）**：先沿用 `watch` + `traceDelta`，P95 相对进程内 ≤ +10 ms；超预算再单独提 push 订阅。

## 门禁

| 检查 | 结果 |
|---|---|
| `npx vitest run scripts/daemon-ipc-matrix.test.ts scripts/performance-feedback.test.ts` | 21 passed |
| `node scripts/daemon-ipc-matrix.mjs`（`--check`） | `IPC matrix up to date (119 channels)` |
| `npm run typecheck` | 通过 |
| 反例（临时未判定 channel） | 3 failed，报错含注册文件；移除后 7 passed |

## 未验证

- 矩阵只是判定与协议设计，没有任何 op 被实现；`forward` 行是否真能跑通要等 B4-L3/L4 的对应测试。
- 文档级路径引用（`P3-ipc-*.md`）已用 `git diff --check` 与生成器 `--check` 校验，未渲染 Markdown 预览。