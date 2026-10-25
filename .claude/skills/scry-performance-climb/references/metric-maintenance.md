# 指标维护

台账入口：`scripts/performance-ratchet.json`；定义按领域放在 `scripts/performance-ratchet/*.json`。工具用 `scripts/performance-ledger.mjs` 的 `readLedger` 展开，提案写回原领域文件；旧单文件 baseline 仍可读取。不要直接把入口 manifest 当成空台账校验。合同细节以 `docs/performance-loop.md` 为准。

## 日常回归检查

```bash
npm run performance:measure -- --compare <基线提交>   # 默认对比，含 ratchet 检查
npm run performance:measure -- --out /tmp/perf         # 只测当前版本
```

- 门禁项超限 → 命令失败。先查代码为什么多做了工作，不要先改上限。
- candidate 出现 `worse` → 报告顶部列出。判断是有意新增的工作还是意外退步；意外退步当作 bug 修。

## 有意增加工作量

- candidate：不处理，`worse` 会如实保留。要调高基线属于放宽，需要批准。
- 门禁：台账写 `"raise": {"from": a, "to": b, "reason": "…"}`，并取得维护者批准（PR 标签 `performance-raise-approved` 或本地 `SCRY_PERF_RAISE_APPROVED=1`）。`performance-ratchet.mjs guard <旧台账> <新台账>` 必须通过。

## 新增指标

1. collector 放在 `scripts/performance-counters/<名称>.counters.test.ts`（需要 Electron ABI 的用 `.electron.counters.test.ts`）。
2. 直接调用生产代码，固定负载，用 `repeatCounters` 重复，`measured`/`unavailable` 写结果。
3. 附带敏感性测试。
4. 在对应领域文件登记 `candidate`（`ceiling: null`），再运行 `performance:propose --write` 记录当前平台基线。完整入口需要完整门禁观测；只收紧单个领域时，可用既有 `makeProposal` 的 `ledgerPath` 参数指定领域文件，之后仍对完整入口运行 `guard`，不把未覆盖的其它门禁宣称为通过。
5. 负载、单位或层级变化 = 新 key，不能改旧 key 的定义（guard 会拒绝）。

## 升为门禁（三项证据缺一不可，并需用户确认）

| 证据 | 做法 |
|---|---|
| 稳定 | 同一版本多次 collect、`--compare` 两侧、不同负载时间段都一致（或误差已知并写入 tolerance） |
| 敏感 | 在生产代码注入一次多余工作，计数上升；再做负向对照：注入后 `check` 判 `regressed` 失败，恢复后通过 |
| 相关 | `SCRY_PERFORMANCE_CORRELATION_OUT=<file> npx vitest run scripts/performance-correlation.test.ts`（按需扩展该文件），被计数工作占操作耗时比例高 |

把三项证据写进台账 `evidence`，`status: "gating"`，`ceiling` = 当前值。

## 定期复核（建议每月或大改动后）

- **相关性复核**：代码路径变化后，比例可能下降（例如 git 调用变便宜后，瓶颈换到别处）。比例明显下降的门禁要重新评估。
- **Linux 基线**：CI 可用后，在 Linux 上运行 `performance:propose` 补 `linux-x64` 基线；门禁值若与 macOS 不同，按放宽流程或直接收紧处理。
- **CPU 指令数**：只在 Linux 可测，确认不是长期 `unavailable`。
- **日常记录保留**：确认 `performance/` 下归档在增长、没有 `onError` 告警（`[scry:performance] local recording unavailable`），最旧归档的时间是否满足需要。
- **覆盖盲区**：对照 `docs/performance-opportunities.md` 的“覆盖缺口”，每次至少消除一项或说明为何暂不处理。

## 偶尔运行（串行、记录 `uptime`）

| 检查 | 命令 | 时机 |
|---|---|---|
以下命令都经 `node .agents/skills/scry-performance-climb/scripts/timing-run.mjs <标签> -- <命令>` 运行。

| 检查 | 命令 | 时机 |
|---|---|---|
| 真实 App 基准 | 先 `npm run build`，再 `node scripts/performance-native.mjs bench <out.json>` | 改了界面、会话、发送/停止 |
| 内存泄漏（先问用户） | 先 `node scripts/run-electron-builder.mjs`，再 `SCRY_SOAK_CYCLES=8 node scripts/performance-soak.mjs` | 改了长时间运行路径；加 `SCRY_SOAK_LEAK_FIXTURE=1` 做敏感性对照 |
| 受控毫秒基准 | `npm run performance:bench -- <out.json>`，再 `performance:compare` | 宣称 L2 之前 |
