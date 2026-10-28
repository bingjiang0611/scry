# 并行失败策略：有界实现与验收

这是 M3 的 `parallel` 失败策略子集，不是 M1–M6 交付完成。后续仍需完成聊天入口、其他运行控制、质量程序、完整观察图与真实 Provider/费用验收。

## 实现边界

- `failurePolicy` 可选：缺省沿用 `all_settled`，不向旧程序补字段或改变其冻结内容。显式支持 `all_settled` / `fail_fast`，其他值拒绝。
- `fail_fast` 针对实际 parallel 控制帧及其后代。首次未处理的关键失败同步阻止该作用域继续 admission；不 root-wide `cancelQueued`，不停止独立 outer sibling 或其他根运行。
- 默认关键失败是非 completed 且未被显式部分报告处理的控制结果。已完成 native check 的 `passed:false` 是业务数据，不自动触发策略。已处理的 unknown arm、获准的 partial report 也不冒充未处理异常。
- 自动决策复用 canonical `stopRequests`，保存 `source:auto`、策略、触发节点、实际 enclosing frame 和控制阶段。先确认 scope/target journal 和 generation，再对已确认目标发停止信号。未知发布结果不授权重发。
- 停止 ACK 不证明退出。保留原 Provider/System 结果；未收敛的 scope、容量与副本 lease 不因策略请求而释放。命令重传不重复 signal；冷启动观察不重新派发；公开用户停止 API 拒绝将自动命令重新绑定成用户请求。
- 已确认 target latch 不被后来尚未发布的用户命令降为 false。自动停止行显示来源；用户“再次停止”生成新用户命令。该新命令的未知响应只重试自身 ID，不复用自动策略 ID。
- 同一组已有策略决定后，后到的未处理异常不追加第二个决定。异常内容保留在未知控制帧和根错误中；不会为了向根抛异常而取消独立 outer branch。控制 checkpoint 的 unknown 不被已收集的已知失败 outcome 掩盖。

核心模块：`workflow-parallel-policy.ts`、`workflow-parallel-stop.ts`、`workflow-stop.ts`、`workflow-interpreter*.ts` 及既有 Runner effects/kernel/system。没有新增调度器、执行链、Provider loop 或动态代码执行器。

UI 继续使用既有进度面板。密集 evidence table 独立水平滚动，可键盘聚焦，不挤压节点标识，也不把根控制与来源时间一起卷走。文案保持在现有 copy 模块。

## 当前证据

日志根：`/tmp/scry-workflow-template-editor.ZnkC6L/`。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Node/web 类型 | 通过 | `m3-policy-completion-evidence.log` |
| 异常与 durable 边界 focused | 6 文件、46 测试通过 | 同上；包含两种真实 Service/Runner + 注入 checkpoint 发布失败场景 |
| 当前 workflow 回归范围 | 71 文件、612 测试通过，单 worker | `m3-policy-current-workflow-gates.log`；不是默认完整单测 gate |
| 当前代码生产构建与隔离 App | 通过；沿用原节点停止/native/TAP/inspector 场景，并新增独立策略场景 | 同上；`npm run test:workflow:app` |
| trusted renderer UI | 原用量/命令断言及 narrow table 回归通过 | `m3-policy-scroll-regions.log`；8 个 SSR 测试及原 native-input smoke；没有用 SSR 单独证明布局 |
| UI detector | 未返回问题 | `m3-policy-ui-detector.json`、`m3-policy-table-detector.json`；不是完整无障碍认证 |

最新 App 现场：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-workflow-node-stop-app-F0llhy`。主产物 SHA-256：`b678394edd1845515569c491d73840dc8f3410b8b59eaf994f460c5eb16eca6a`。

生产策略场景实际启动两个离线 Provider actor，经真实 trusted UI 停止其中一个。其控制结果触发策略停止另一个；保留一个用户 receipt、一个自动 scope receipt、一个自动 target receipt，恰好两次 Agent dispatch，无 root stop。原始 Provider 结果均为 stopped；canonical 触发控制阶段为 failed。UI 从真实 main/preload/FileStore 数据显示自动来源，冷观察无 redispatch，并拒绝自动命令的公开 API rebind。不是 renderer 注入自动 provenance 的演示场景。

原 native 场景仍验证一次执行、SIGKILL 后实际进程消失；TAP 场景仍验证真实两文件运行、一 pass 一 skip、结果 incomplete 且 passed:false。三个 App 生命周期均观察 registered resource closure（每次 tracked4）；不扩大为 escaped descendants 或远程效果审计。

### 首败与负控保留

- 首轮候选类型失败及源备份保留，未将 worker 自报完成视为接受。
- `m3-stop-again-late-handle-negative.log`：新 pending 命令覆盖已确认 latch，导致晚到 handle 漏停。
- `m3-policy-exception-negative.log`：先后暴露异常内容丢失、同组重复策略决定。`m3-policy-scoped-exceptions.log` 保留首次修复后继续发现的 unknown 被 known failed 掩盖；slot 断言改为等待 handler 的实际持久化/释放屏障，不把 Provider result resolve 当已释放容量。
- `m3-policy-narrow-node-negative.log`：窄表节点不可读。早期 App 缺 renderer workspace、错误预期控制阶段等首败也保留；未放宽原业务断言或期限。

## 限制与后续责任

- 异常发布回归使用生产 Service/Runner 和注入失败的 MemoryStore；没有宣称实际磁盘故障的生产 App 验收。
- 最新默认完整单测历史仍为 4068 pass / 1 原 SystemStep 5000ms 失败 / 4 skip；本轮单 worker workflow 回归通过，不抹除该 full-suite 首败，也不证明默认并发 gate 已关闭。
- 本策略 checkpoint 冻结后，既有 hot-path counter 和迁出模块的 catalogue 扫描已完成后续验证，见[目录扫描修复](catalogue-scan-status.md)。原 workflow publications 五样本均 3，ratchet 通过；`providers.catalog` 仍 unavailable。没有新增性能实验或改变期限、负载。旧冻结 archive 保留当时的 pending 状态，不回写历史。
- `src/main/index.ts` 仍 243916 bytes，尚不能按 20000-byte authored blob 约束暂存。kernel 已按结果投影职责抽出 root-state 计算，目前 19792 bytes；不是通过压缩代码绕过上限。
- 本轮未执行真实 SDK、账号、Jev、费用、外部写入应用或完整 release gate。M2 TaskSubmission/routing、其 authoring capability 以及其他 M1–M6 缺口仍由后续实现负责。

父会话下一步：继续 M2 生产入口与必要的职责拆分。无需借 Goal mode 扩权。

## 冻结 checkpoint

`/Users/baobingjiang/.local/state/rotom/verification-evidence/workflow-parallel-policy.w0pbik_w`

保留源码、base HEAD、未暂存 patch、首败/负控日志、当前构建与合成现场，以及逐文件 checksum。此前 App runtime / M5 / node-control archives 不修改。Checksum 不是签名；复制的 userData/workspace 是证据，不是可恢复执行权限。当前仍 unstaged/uncommitted；未 push、安装、升版本或重启日常 App。
