结论：通过（第二轮）；`output_seq` 的 schema 处理随 W5 一起做

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

## 复核（第二轮，2026-11-19，修复提交 `7a18cc3a`）

1–5 项全部修好，新测试放到修复前的代码上会失败：转移表改为共用 H1 导出的 `RUN_LIFECYCLE_NEXT`（H1 行为不变，18 个台账测试通过），进度类事件只在 `dispatched` 接受；缺省 outcome 改为 `unavailable / outcome_evidence_absent`，用量守卫覆盖所有事件；macOS 网络盘检测用 `df -T nfs,smbfs,afpfs,webdav,autofs`（BSD 的 `-T` 是类型过滤，用法正确，macOS 上未由核验方实跑）；`fsyncDirectory` 只容忍 `EINVAL/EBADF/EROFS/EPERM`，真实 I/O 错误上抛；边界测试改为传递检查并覆盖 `.js` 与 `export … from`；`-wal` 必须存在且 0600、`-shm` 断言不存在；`max_page_count` 制造真实 `SQLITE_FULL`，验证回滚、fence 与停止放行。

随 W5 一起处理：`output_seq` 在 v1 内改成可空而没有升版本，旧代码建的开发库之后每个新 run 都报 `NOT NULL`，影子静默失效（只影响开发库）——升 schema 版本，或写明「删除开发用 orchestration.db」。

可选：检测失败按「本地」处理的方向写进文档；用 `/bin/df`；FUSE/sshfs 类型；`projection.ts` 仍每个事件 `db.prepare` 29 次；边界测试未扫描动态 `import()`；共用转移表 `Object.freeze`；`fsyncDirectory` 错误分支补测试。
