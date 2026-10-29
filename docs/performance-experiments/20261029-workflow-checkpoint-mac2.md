# Workflow mac2 低负载复验

2026-10-29 UTC。维护者授权使用 mac2。接续 [A/B 边界与恢复调查](20261029-workflow-checkpoint-boundaries.md)。

**结论：File 共享合同 58/58、SQL 全部 93/93 在低负载通过；File 扩大批次仍为 76/77。stable-map 在低负载单例诊断也触发原 5000ms 超时，不能把全部失败归因于高负载。没有生产修复、接入或推广。**

## 版本与隔离

- 受测提交：`1dacb2ca329a024a622824db452ab97fd2b90e07`；源码树：`7e84b20b4e3c8e327d4e8e8d2003e50c367365d6`。
- 从本机已提交源码导出 Git archive 与原始 commit object。远端创建独立浅快照，验证源码树、原提交及测试后工作区均一致。未复制完整历史、真实 userData、凭据或本机 node_modules。
- mac2：macOS 26.3.2、arm64、8 核；Node v24.18.0 / ABI 137、SQLite 3.53.1。Vitest 3.2.7、TypeScript 5.9.3、esbuild 0.25.12、@types/node 22.20.1 与本机一致。
- 仅在 `/tmp/scry-checkpoint-mac2.pCyZT4` 的快照内执行 `npm ci --ignore-scripts --include=dev`；缓存、工作区、结果均隔离。不启动 App、不调用真实 Provider/Jev，不执行 dependency lifecycle scripts。
- 所有功能计时串行使用原样的 `timing-run.mjs`，锁仍是宿主共享的 `/tmp/scry-performance-timing.lock`。8 核阈值由原脚本计算，没有沿用本机的 10 核阈值。

## 原始结果与最终结果

| 批次 | 通过 / 失败 / 筛选未执行 | 负载前 → 后 | 结果 |
|---|---:|---:|---|
| 首轮 File 恢复 10 项 | 10 / 0 / 0 | 2.84 → 3.00 | 通过 |
| 首轮 SQL 93 项，HOME 在 OS 临时树内 | 92 / 1 / 0 | 3.00 → 6.32 | HOME 拒绝探针的环境前提不成立，保留失败 |
| 校正隔离 HOME 后 File 恢复 10 项 | 10 / 0 / 0 | 3.25 → 6.74 | 通过 |
| 校正隔离 HOME 后 SQL 93 项 | 93 / 0 / 0 | 6.74 → 4.26 | 通过 |
| 扩大 File：共享 58 + revision 19 | 76 / 1 / 0 | 2.31 → 2.37 | stable-map 原 5000ms 超时 |
| File stable-map 既有 meter 单例诊断 | 0 / 1 / 5 | 2.24 → 2.75 | 同一超时复现 |
| SQL stable-map 同一业务单例诊断 | 1 / 0 / 5 | 2.75 → 2.85 | 通过 |

上述七轮全部 `highLoad:false`。最后两行的 5 项未执行均来自既有 `-t 'matches stable map keys'`，不是新增 skip。诊断不是替代全批次门禁。

扩大 File 批次的分组：共享 **58/58**，revision **18/19**。SQL 分组：共享 **58/58**、revision **19/19**、原型 **16/16**。两个后端没有删减业务断言，File 的物理文件/屏障断言仍在。

原先五项超时用例在本轮扩大 File 批次中为 **4 通过 / 1 超时**：loop 3687ms、mixed SystemStep 3965ms、native-definition 3851ms、legacy SystemStep 4050ms；stable-map 5022ms 超时。仅记录本机本批次，不倒推旧失败都是负载问题，也不称生产代码已修复。

## 首轮 HOME 失败：环境校正，不是修改产品来通过测试

`prototype.test.ts` 的拒绝探针把 `TMPDIR` 改成 `homedir()`，验证它不能授权一个原本不属于 OS 临时树的 HOME namespace。`runtime.ts` 只允许 `/tmp` 和限定的 macOS 原生临时树，另要求 `scry` namespace。

首轮我把隔离 HOME 放在 `/tmp/scry-checkpoint-mac2.pCyZT4/home`；它本来就处于获准的 `/tmp/scry…` 树内。该探针期待拒绝，实际得到正常读取，故断言失败。这里没有证明越过真实 HOME 边界，也不能删除断言来豁免失败。

校正方法：在用户目录下新建一个**只供本轮测试使用、位于 OS 临时树外的空 HOME**，TMPDIR 仍指向原隔离临时树。重新运行完整的原 10 / 93 项，不改 Runtime、测试源码、断言、负载或 timeout。探针通过，未创建 `scry-forbidden-prototype-*`；最终该隔离 HOME 为空，已用 `rmdir` 删除。没有使用或清理日常 HOME 内容。

首轮 92/1 的 JSON、日志、脚本以及它在第一个临时 HOME 内创建的合成 namespace 均保留，不把后续通过改写成首轮成功。

## stable-map：低负载仍存在的 File 路径问题

业务用例在 `workflow-dynamic-revisions.test.ts`，包含原始三条 map 项、重排/修改一项及后续 consumer prompt revision。固定派发与复用断言均未改变。

- 扩大批次在约 5022ms 超时；单例 meter 诊断约 5013ms 超时。两次 CPU 负载都低于 8 核阈值。
- 单例截止前，File meter 记录 planning 4、root 39、frame 111、artifact 114 次 `atomicText` 调用；JS 层已完成 267 次 flushed write、385 次显式 sync，创建 155 个 lock directory。
- SQL 单例在约 2816ms 完成；对应 planning 4、root 40、frame 112、artifact 114 次调用，Worker 记录 156 次成功 SQL COMMIT。工作并未消失或变成零成本。
- **File 样本未完成，不能把两侧计数当作完整等负载数据计算降幅或加速比。** meter 时间是 inclusive 方法时间，不能直接相加后当关键路径，也没有完整分解锁等待、读/校验、目录操作、调度及设备 flush 的耗时。
- JS flush/sync 不是全部 OS fsync；SQLite 原生 fsync、设备累计写入字节仍为 `unavailable`。本轮也没有跨机器“更快”的结论。

因此，已排除“所有剩余失败都只需换低负载机器”的解释，但尚未证明唯一系统根因。现有证据继续指向频繁持久化与其周边工作；不能为过门禁合并 native fact A / terminal frame B、删屏障、降低 CAS/epoch/ownership 或放宽 5000ms。

## 类型、资源与未覆盖范围

- `npm run typecheck`：Node、Web 均通过。
- `tsc --noEmit -p experiments/workflow-checkpoint/tsconfig.json`：通过。
- 生成 Store 使用原 Node tsconfig、虚拟 rootDirs 及同版本类型依赖独立检查：通过。
- 最终 SQL 93 份 namespace 报告全部 `openNamespaces:0`；File 恢复测试的登记 fixture 清理通过。只证明登记资源，不是整机进程审计，没有按旧 PID 发信号。
- 本轮没有重跑完整生产 unit，没有 Electron/better-sqlite3、真实 App、断电、迁移/回滚、生产接管或跨 Provider 验收。Node 的 SQL 合同绿色不能替代这些门禁。
- 本轮代码和测试源码零改动，只有报告/复现说明更新；两台机器均未安装或替换 Scry App，未 push、未升版本。

## 证据与下一步

持久证据：`/Users/baobingjiang/.local/state/rotom/verification-evidence/workflow-checkpoint-mac2-20261029.WMMvmm`。

- `remote/logs/`：首轮失败、校正后全批次、扩大 File、单例诊断、类型与最终远端 receipt。
- `inputs/source.tar`、`inputs/source.commit`：受测源码与原 commit object；`input-hashes.json` 记录输入 SHA-256。
- `remote/sql/build/`：实际生成 Store、Worker、生成 manifest；`remote/tmp/` 保留合成 fixture/编译输入。
- `summary.json`：从原始 JSON 按明确文件列表统计分组；`manifest.json` / `final-state.json` 保存文件哈希与最终交付状态。
- 远端独立快照、依赖与临时证据仍保留在上述 `/tmp` 目录，供复盘；空隔离 HOME 已删除。未部署到日常项目。

**下一阶段由我负责提出 File stable-map 的持久化阶段诊断与最小修复方案。涉及生产持久化实现改动时需维护者确认；当前不接入生产 SQLite，不迁移数据，不放宽 timeout。** 完整项目仍未完成；本轮完成的是 mac2 低负载复验及其证据交付。
