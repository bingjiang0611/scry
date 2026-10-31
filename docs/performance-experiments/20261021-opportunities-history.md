# 性能机会日志历史：2026-10-20/21

从 [机会索引](../performance-opportunities.md) 原文搬移；仅调整相对链接，历史状态不代表当前安装状态。

## 独立 CLI 多仓库采集（2026-10-21，受控实验；未改生产）

- 独立 CLI 日常样本提示每轮通常采集 18–19 个仓库；不能用 App journal 替代其热点证据。当前优先多仓库采集与通知重复工作，暂缓用户级服务和内容存储重建。
- 固定 19 仓库 × 512 文件、每种调度 4 轮：19/4/1 路峰值子进程为 38/8/2，全部证据断言通过；正常无变化轮均需 190 次 Git。19 路有一轮出现 16 次 discovery_failed fallback、额外 31 次 Git，其他调度本轮没有。
- 测量源码 `3f30987`；10 核机器负载 75.25→45.48，L2 unavailable，不据此改生产并发值或宣布提速。未优化、未合入、未安装、未推送，台账不变。
- 后续：性能 owner 在低负载下重测同一负载，不改变原 workload 或 deadline。范围与原始结果见[实验记录](../performance-experiments/20261021-cli-multirepo-concurrency.md)。

## 零候选快照复用（2026-10-21，L1 已验证，未部署）

- `9391016` 在完整 Git 发现成功且无候选时复用同一不可变基线和 discovery index，不再重建并比较相同快照。没有跨轮缓存，没有缩小采集范围，没有改生产并发。
- 沿用原 19 仓库 × 512 文件负载及 19/4/1 路调度：无变化轮 Git 190→114（−40%）；单仓改动轮 192→120，所有证据及完整 patch 断言通过。峰值仍为 38/8/2。
- 270 项 focused、typecheck、CLI build、3480 项 full unit（4 个既有 opt-in skipped）通过；现有 source-control.diff 计数仍为 8，ratchet 通过。先前全量测试不稳定不据本次通过宣称根治。
- 两次 timing-run 均 highLoad，L2 unavailable、L3 未验证；未安装、合入、推送或发布。性能 owner 在低负载时对同一完整负载补两侧 L2，发布 owner 再确认分发；详见[实验记录](../performance-experiments/20261021-cli-empty-candidates.md)。汇总优化见下节；历史读取优化仍待下一批。

## CLI 汇总按记录分组（2026-10-21，L1 已验证，未部署）

- 测量 `ed5c47f` 与优化 `7e8d481` 分开提交。文件调用只按 record 对象身份分组一次，不再每条记录三次扫描整个时间线；保留 legacy 回退、推断和证据质量。
- 固定 186 轮 / 3348 调用，OrderedCall.record 读取 1,889,376→24,540（−98.70%），完整输出 hash 不变；单轮 156→120。计数不含所有 Map 工作，不等于总 CPU 或耗时比例。只读快照 2181 条记录、全部 531 个 session 的新旧完整汇总 JSON 相等。
- 56 项相关测试、typecheck、CLI build 通过。全量 3481 通过、1 个未改动 Git 查询 timeout、4 个既有 opt-in skipped；两侧定向通过不抹掉首次失败，也没有扩大 timeout。现有 source-control.diff 计数仍为 8，ratchet 通过。
- 两侧计时均 highLoad，单轮原始耗时上升尚不能归因；性能 owner 需在低负载下同时复测 1 / 186 轮，不能以长会话收益抵消小输入风险。未合入、安装、推送或发布，见[实验记录](../performance-experiments/20261021-cli-summary-linear.md)。verify 后续优化已完成，见下节；会话选择性读取尚未实施，不预先建设持久索引。

## CLI verify 单次读取（2026-10-21，受控 L1 / L2 已验证，未部署）

- 测量 `aec4a47`、实现 `2a99eb6`、追加冷进程计时 `1643c23` 分开提交。复用 canonical 校验读取，仅计算身份覆盖；不再第二次读取/解析或构造无关汇总。完整性失败仍退出 4，坏记录身份仍为 unknown。
- 固定 64 条、每条 prompt 64 KiB：读取 / parse 128→64，字节 8,614,000→4,307,000；保留 schema 校验，tools 属性读取 1,024→64。完整输出相同。
- 真实 CLI 新进程、文件缓存已热，3 预热 / 9 样本：p50 103.264→78.285ms（−24.19%），p95 106.763→80.276ms。10 核 load1 7.35 / 8.28，timing-run 两侧均非 highLoad；只覆盖此固定负载，不是日常 L3 或其他规模结论。
- 62 项 focused、609 项 CLI gate、临时 package smoke、typecheck / build 通过；全量 3488 通过、4 项既有 opt-in 跳过。旧实现新测试负对照 4 项失败；未削弱断言或门限。旧快照 2181 条记录前后 CLI 输出和退出码相等，均保留原有 120 处序号缺口；后续[只读调查](../performance-experiments/20261022-cli-sequence-gaps.md)确认这覆盖 230 个缺号，源目录也缺失，无正常归档凭证；具体移除来源仍 unknown。数据维护者需提供历史备份或清理记录再定位，不能补造记录。
- 未合入、安装、推送或发布。性能 owner 后续评估会话选择性读取，若需持久索引先征求架构授权；此前两项优化的 L2 仍按原记录补齐。详见[实验记录](../performance-experiments/20261021-cli-verify-once.md)。

## 通知身份隔离（2026-10-21，已部署独立 CLI 0.2.50）

- 经另行在线授权，发现 App 与 CLI 不同指纹共用一个 ACK 文件，成功投递仍反复擦除另一身份进度。项目 bridge 合成 override 的问题已修复，但不是完整根因；没有改变 host 优先级或把两个指纹强行归一。
- `6d4b62c` 按指纹持久保存 ACK、只读兼容旧文件。601 项 CLI 门禁与真实双版本进程并发通过，已更新两个实际独立 CLI 入口和 daemon，App 未更新。后续自然新增记录 2435 来自旧版本；App 身份旧文件为 ACK 15，新 CLI 独立文件为 ACK 2435、backlog 0，未互相覆盖。这是有限场景正确性证据，不是 L2/L3 提速证据。
- 通知任务数不等于未上传记录数，也不把 CLI backlog 0 当作所有身份均已清空。已有队列保留，历史上传死信未重投；测试维护者后续需按全量执行顺序调查 7 项不稳定失败，本次不扩大到 App 修复。详见[交付记录](../performance-experiments/20261021-cli-ack-isolation.md)。

## 0.2.216 安装进度（2026-10-21，包启动仍受阻）

完整 CLI gate 588 项、App unit 3463 项（另 4 opt-in skipped）、shell、类型检查和构建已通过；源码冻结 `a868251`。构建目录的签名包在私有 CLI/GUI 启动时收到 SIGKILL，尚未完成 packaged smoke，未执行安装。相同字节诊断副本与已安装 0.2.215 的对照结果、首次失败及日志见[实验记录](../performance-experiments/20261021-desktop-ui-fluidity.md#0216-发布验证续跑2026-10-21)。下一步由发布/系统诊断 owner 定位该启动问题，不再重复全量测试碰运气；不修改系统防护或直接安装未通过门禁的包。

## Mac UI 流畅性续轮（2026-10-21，Pi 历史打开重复归档读取）

- 固定调用链复核确认：Pi 历史打开先用 `readTraceArchivePageAsync` 读取最近页；若同时存在 Pi 原生历史，随后无条件再次 `readTraceArchiveAsync` 以做 ID 对账。最近页已是 complete（`hasOlder=false`）时，这次完整读取是重复工作；超过 40 轮的 partial 页仍必须完整读取，不能把分页证据当成全量证据。
- 最小修复：native-history 对账复用已证明 complete 的首个 archive page；partial 页保留权威完整读取。不会改变 native/Scry ID 对账、cwd/provider/session 栅栏、附件 hydration 或错误状态。
- 证据：`src/main/session-history.test.ts` 新增 callback 负对照，complete page 不调用 full-read，partial page 调用一次；31 项通过。Pi 原生历史隔离 Electron 验收通过，验证 41 轮分页、archive reconciliation、无 Provider 执行。`npm run typecheck` 与 `npm run build` 通过。
- 性能级别：L1 代码路径/读取次数推导；本轮未做高负载下毫秒结论，也没有 L3 日常收益结论。减少的工作是 complete archive 的第二次读取，未移到后台、未缓存过期证据、未改变 workload。
- 限制与下一步：partial/legacy archive 仍可能读取完整源；需在并行工作冻结且机器负载正常时，以现有 history-opening native fixture 记录 archive read count 与点击→首个可用历史分段，再决定是否继续改动。`performance:measure --scenario navigation.catalog` 仍因无匹配 collector 不作为本轮证据。

## Mac UI 流畅性首轮（2026-10-21，源码已验证；首轮安装门禁受阻）

- 固定 277 会话原生 UI fixture：切换行执行 **555 → 2**，hover **280 → 5**；20 次流式更新仍不重绘 Sidebar。存档 277 行两次渲染的新建日期格式化器 **554 → 0**（复用模块实例）。均为 **L1**，不等于用户日常端到端耗时下降。
- 保留视觉与交互；取消 hover owner 的列表级 context 广播，memo 隔离无关行；减少动态效果时真正禁用 transition。完整 renderer UI、typecheck、build 通过。
- 两轮安装门禁的 unit 分别有 1/13 个失败（高负载下后端超时、清理失败及一个 Codex fixture SIGABRT）；未绕过门禁，未安装、未替换用户实例。修改隔离在分支，不混入主工作区并行 WIP。已安装 0.2.215 与当时源码 0.2.214 的版本差异本身不是阻碍；安装策略要求从已提交源码构建，后续恢复已确认 repair commit 已在提交树中。
- 下一优先：集成 owner 在并行工作冻结、负载正常后重验安装；性能 owner 单独测历史打开与 Provider 能力加载，现有等待不能靠动画修复。iPhone 留待真机轮次。
- 固定负载、负对照、首次失败和限制见 [实验记录](../performance-experiments/20261021-desktop-ui-fluidity.md)。

## 目录观测与传输修复交付（2026-10-20，已安装、待手动重启）

[0.2.211交付记录](../performance-experiments/20261020-catalog-observation-0211.json)已冻结本次范围：原样迁移此前 `ee782b4` 的最小脱敏目录观测，并将当前WIP中已有的Mac1连接元数据剥离修复纳入安装包。不实现按需刷新，不改变冷发现、进程退出、模型/权限或Owner/trust语义。

- App **0.2.211**、CLI仍为 **0.2.49**；安装build `f6c2a4d279d7a731369907876e52976cd717638cdd7cf541d6d75fd340e00dc1`，已按 `npm run install:mac:dev` 安装 `/Applications/Scry.app`，源码build与安装包嵌入值一致。已核对编译后的元数据剥离逻辑、三个registry观测入口及两个Pi观测名称。
- 验证：完整typecheck、3486 unit（4项既有opt-in跳过）、shell、587 CLI release、完整renderer UI（含Credits）、packaged resource/ABI/security/remote-host门禁通过。Pi工作量对照均不变：RPC进程1→1、响应4→4、grace expiry 0→0、环境Node进程1→1；无worse，不报毫秒或提速。
- 保留首轮聚焦合并命令120秒超时；拆分用例和最终全量通过，未放宽断言或测试超时。安装取证先后修正了VM缺少原生 `structuredClone`、把动态registry事件名误当完整字面量的工具假设；这些不是产品故障。
- 安装基于 `be907ef` + 已冻结的既有WIP基线 `b1df508a…` 及本次迁移/版本变更。72项既有脏路径已逐项验哈希，package原有脚本修改保留。既有remote/iOS工作不混入本次源码提交；不能声称仅凭新提交即可复现整个WIP安装包。
- **尚未生效/未验收**：用户进程PID14356仍运行0.2.209/build `6bd35f8c…`，未被自动重启。需用户手动退出并重开Scry后，由我确认运行build及gateway绑定，再在已获准的iPhone13重放Mac2文件夹/Provider/模型路径。修复版真机结果、完整首次目录/relay可见耗时仍未验证；不把安装成功当作手机错误已修复。
