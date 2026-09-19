# Native Agent console 优化：整体复审与交付总结

## 范围与结论

本次复审覆盖 `152707c` 至 `d52dd0d` 的 42 个优化/验收修复提交，沿 recorder、remote、native terminal/provider 三条链路检查实现与调用方，并复核相邻草稿、回放和 iOS 问答状态。

这不是全仓安全审计。仓库原有约 309 项 WIP 不属于本次交付；`managed.ts`、`store.ts` 使用逐 hunk 暂存，保留其无关修改。验证对象为 **HEAD + 本次暂存改动** 的独立快照，不是混入 WIP 的工作树。

结论：正文引用、worker、有界队列、ownership fencing、持久化 intent 与 trust gate 都有真实职责，应保留；删除重复状态与重复实现，不引入统一 Provider 框架或通用 storage/worker 框架。

## 整体优化了什么

| 领域 | 已实现的变化 | 用户收益与边界 |
|---|---|---|
| Agent 生命周期 | 不再凭静默、查询超时或 renderer 消失结束运行；停止等待 Provider 原生终态 | 慢任务不被观测层误杀；中断请求失败不冒充已停止 |
| 完整证据 | 工具、模型、reasoning、diff、transcript 正文落入内容寻址存储，记录保留有界 preview 与完整引用 | 不因展示截断而丢掉已暴露正文；上游未提供的数据仍是 partial/unavailable |
| 原文采集 | 正文默认原文保存 | 不恢复历史已脱敏内容；诊断包及认证信息的独立防泄露处理不取消 |
| 采集与 UI 解耦 | Terminal/remote 写盘移入 worker；队列、分页、缓存有界；终态等待持久化收敛 | 磁盘和渲染慢时不堵住主链路；无法证明写入成功时明确表达缺口，不重放未知写 |
| 恢复与回放 | Terminal 录制、只读历史、renderer 重载接管、epoch fencing | 活跃 Shell 与只读历史区分；旧 renderer 不再能 ACK/控制新 owner |
| 归档和存储 | 归档携带正文依赖；完整导出；授权分页；soft quota、retention 候选、保守 orphan GC；archive 增量索引 | 大正文可检查、可导出；quota 不强删活跃证据，retention 不自动删除正式记录 |
| 原生交互 | 保留各 Provider 的问题、权限、多选、多行 editor 和停止语义 | 不伪造能力一致性；不支持的能力显式报不可用 |
| Remote/mobile | 设备隔离的 intent fencing、ledger checkpoint/compaction、history/catalog 分页、原生问题路由、恢复 checkpoint | Host/客户端重连后可核对已提交运行；未知提交不自动重发 |
| 桌面操作 | 按 Provider/profile/workspace/session 保存草稿；大文件只读分页、目录 snapshot 游标 | 重载后恢复输入；大文件不进入无限编辑缓冲；目录变化不拼接不同快照 |

这轮没有产出可信的“速度提升百分比”或长期无损压力指标，不作此类承诺。

## 本次删除和简化

1. **删除 ledger 的第二份完整 intent map**：重复提交凭现有 RunEntry 元数据生成 receipt；dispatch 后不额外长期持有 prompt/attachment 正文。digest 冲突检查和 recorded 状态的恢复信息保留。
2. **统一导出与归档的内容引用收集**：同样字节允许分别作为 JSON/text 引用；不再因 encoding 标签不同拒绝有效导出。
3. **归档批量 `Promise.all` 改为顺序校验/复制**：不同时物化整个归档的所有完整正文。单个正文仍可能较大，这不是流式大文件处理的无限内存保证。
4. **删除 Codex interrupt failure 的第二条完成竞态**：控制失败作为错误证据展示，运行只由原生终态或 transport 终止收敛。
5. **压缩 Qoder 反复追加的测试样板**：七种真实问句共用一张 fixture 表和一段断言；删除逻辑上冗余的 `hasLease` 条件。不改变授权流程，不扩大真实验收结论。

## 复审发现并修复的正确性问题

- GC 扫描后新 session 可复用旧孤立 blob：增加短暂的 maintenance admission gate。GC 要么看到 session lock 而拒绝清理，要么先完成清理，writer 随后重新落盘；不把整轮操作串行化。待恢复的 `pending-open.json` 也阻止回收。
- 已截断 preview 被再次当成原文持久化：已有 envelope 优先，不为只有前缀的数据发布“完整”引用，保留历史 redaction/provenance。
- Remote 写盘期间新产生的 overflow marker 被前一批完成回调清掉：marker 在本批派发前领取，后续缺口不被覆盖。
- Remote worker 在 close ACK 前退出造成永久等待：退出始终拒绝未完成请求；未知正文不重试。
- Terminal worker 在空队列时死亡未通知活跃录制：按活跃 recording ID 通知一次丢失，Shell 仍 fail open。
- 接管回放最小读取 4 bytes，可能越过仅剩 2 bytes 的 checkpoint：按 UTF-16 checkpoint 裁剪输出，含 surrogate 边界回归。
- 草稿写入返回成功，但读取时会丢掉超限附件/正文：读写复用 eligibility，任何截断/省略都返回未完整持久化，保留内存草稿。
- iOS 旧问题回答晚于新问题 polling 到达，可卡住后续提交：问题切换重置 answering；旧回调及旧 session polling 不改写新问题状态。该竞态本轮仅做源码复核与 Simulator 编译，未做真机交互验证。

## 当前修订验证

独立快照：`/tmp/scry-overall-clean-RWE7Ed`。

- `npm run typecheck`：通过。
- `npm run test:unit -- --maxWorkers=1`：**176 files / 2209 tests passed，3 skipped**。
- `npm run test:shell`：通过。
- `npm run check:cli-release`：**32 files / 553 tests passed**；CLI build/package smoke 通过。
- App/CLI build、electron-builder 产物生成：通过。
- `npm run check:packaged-app`：通过，App 约 284 MB，私有 CLI `0.2.44`。
- `npm run smoke:electron`：通过真实打包 App 的 Terminal、重载接管、stale-owner fence、历史重启回放、只读权限及 renderer 安全检查。
- Swift package：4 tests passed；ScryRemote iOS Simulator unsigned build：通过。
- Qoder watcher self-test 与 `git diff --check`：通过。

首次并行执行 unit/打包/Swift 构建出现测试及打包 CLI `--version` 超时；所有相关进程退出后改为分开执行，上述检查通过，未放宽测试超时。最初 GC 回归的 ESM spy 写法也已修正并验证。

日志：`/tmp/scry-overall-unit-serial.log`、`/tmp/scry-overall-cli.log`、`/tmp/scry-overall-pack-check.log`、`/tmp/scry-overall-electron.log`、`/tmp/scry-overall-swift.log`、`/tmp/scry-overall-ios.log`。

## 真实 Provider 证据与未验证项

以下是**此前冻结版本**的三轮结果，不冒充本次修订重新执行的端到端验收。各现场的 `lifecycle.json` 与 `turn-evidence-parity.json` 已回读：均为 PASS，3 archive turns 对齐 3 CLI records。

- Codex：`~/.local/state/validate-scry-rate-workflow/validate-scry-rate-workflow-8h4fXv`
- OpenCode：`~/.local/state/validate-scry-rate-workflow/validate-scry-rate-workflow-6qvx3n`
- Pi：`~/.local/state/validate-scry-rate-workflow/validate-scry-rate-workflow-9Bm56l`

三个 PASS 现场保持 `RETAINED_FOR_REVIEW`，未在本次复审清理。

- **Qoder：按用户决定跳过，不算 PASS。** 最后现场 `IrgdGv` 已停止并标记放弃；此前清理检测到 `.claude/.flush-cursor.json` 重建，未证明槽位已释放。本次未重跑、未继续清理。
- Claude 不在此前四 Provider 验收范围内。
- 未重新执行真实 Provider 付费三轮；未验证手机实机的断线/重连/Host restart；未完成长时大输出压力与每个 rename/fsync 崩溃点注入。
- 草稿重载与 iOS 回答竞态没有当前版本人工 UI 重放，不能用 unit/build 替代。
- Advisor 无 API key，未把它记为通过。
- 本次不升版本、不安装到 `/Applications`、不推送、不发布。
