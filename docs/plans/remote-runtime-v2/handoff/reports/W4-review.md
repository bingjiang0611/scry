结论：需修改（不阻塞 W5 的修复，但合并前要做完）

# W4（P4-0）核验（核验方，2026-11-19）

提交：`89a8af6e`、`fd82c0ea`、`1d27d8bf`（报告 `d1c63ad0`、`6ecefa66`）。

## 符合设计

独立迁移执行器（拒绝更高 `user_version`、不调 v16 钩子）；WAL / FULL / EXCLUSIVE 的设置顺序（因此不产生 `-shm`）；单事务 `execute`；除校验错误外一律 fence；回执永不裁剪；`resolveIntent` 墓碑（`orchestrator.ts:154-169`）；黏性与可重试拒绝，可重试不写回执；正文存储（16 KiB 边界、内容寻址、删会话清除）；R1–R12 预留列；Recorder 导入测试带负对照。数据库目录先设 0700 再建库，`-wal` 继承库文件权限，实际无竞态。

复跑（Linux）：`npx tsc --noEmit -p tsconfig.node.json` 通过；`src/host-runtime` + `src/daemon` + `scripts/performance-feedback.test.ts` 238 个用例通过；`npm run check:cli-runtime` 通过（未碰 CLI）。

## 需修改（执行方 C）

1. **转移表是复制，不是抽取**：`run-transitions.ts:6-12` 复制了 `session-ledger.ts:102-108` 未导出的 `NEXT`，测试只拿表和自己的查找函数比（`orchestrator-policy.test.ts:50-57`），发现不了漂移。改为从 H1 导出同一张表（或加一条逐项对比 H1 的测试）。另有语义差异：`session_bound`、`finalized`、`content_gap` 在 run 仍为 `recorded` 时被接受（`orchestrator-handlers.ts:231-241`、`285-310`），H1 只在 `dispatched` 接受进度；对齐或写明理由。
2. **证据不能凭空写 exact**：没有给 outcome 时，决策器默认 `{status:'available', quality:'exact', source:[]}`（`orchestrator-handlers.ts:319-323`）。应为 `unavailable` 加原因。用量数字的守卫只在 `run.provider_settled` 上运行（`canonical-json.ts:79`），设计 data §3.3 要求任何事件都不带用量。
3. **未提交维护者决定的设计偏离**：NFS 检测只在 Linux 上做，macOS 恒返回 false（`db.ts:24-32`）；`fsyncDirectory` 吞掉所有错误（`body-store.ts:20-30`）。修掉，或写进报告「需要维护者决定」（报告现写「无」）。
4. **边界测试偏弱**：Recorder Core 的导入检查不是传递的（`orchestration-boundaries.test.ts:120-135`）；main 的导入图遍历漏掉 `.js` 后缀和 `export … from`；`-wal`/`-shm` 的 0600 断言只在文件存在时执行（`db-and-body.test.ts:77-82`），`-shm` 在 EXCLUSIVE 下从不存在，等于空断言。
5. **缺负面测试**：提交时真实 I/O 失败（如用 RLIMIT_FSIZE 制造 `SQLITE_FULL`），而不只是事务内的 JS 钩子（`event-sink.test.ts:135-138`）。
6. **可选**：热路径上每次 `db.prepare`（`event-sink.ts:100-116`、`projection.ts`）改为预编译；`enforceModes` 每次提交 6 个系统调用（`event-sink.ts:273`）；`session.created/forked/imported` 的 `INSERT OR REPLACE` 会清掉 `active_run_id` 与 `pending_questions`（`projection.ts:345-351`、`392-398`）；`output_seq NOT NULL DEFAULT 0`（`schema.ts:102`）以后会把「未知」显示成 0；R10 的 `task-result:` 未预留。
