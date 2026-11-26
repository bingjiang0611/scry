# Recorder 0.2.93 交接

交接时，内网 `@ali/scry-turn-recorder` 的 `latest` 是 **0.2.93**。Registry 记录的发布时间为 **2026-11-26 12:39:09.159 UTC**。发布的是 #208 原先验证过的候选 tarball，没有重打包；回读的 SHA-1 和完整性与候选包一致。CodeLens 0.2.56 的放行验收曾因 0.2.92 的问题回退到内置 0.2.91。维护者随后明确批准先发布 0.2.93，方便另一台机器从 registry 取包再跑 CodeLens 专项。**交接时尚未收到专项结果**。若专项失败，保留现场，修复发新版本；不撤回 0.2.93。

## 版本记录

`dist.shasum` 均从内网 registry 按确切版本回读。表中“问题”只列本阶段定位过的情况，不表示其他路径已验收。

| 版本 | PR / merge SHA | `dist.shasum` | 改动与后续问题 |
| --- | --- | --- | --- |
| 0.2.89 | [#201](https://github.com/bingjiang0611/scry/pull/201) / `434f4b146` | `94bfeb4a81e0bd368df827a8dd7ce7d73c9f1fea` | Codex 转录读取加 64 MiB 快照和 4 MiB 锚点行限制，失败按会话挂起。修复约 978 MiB 真实转录触发 `ERR_STRING_TOO_LONG` 后反复重试。后续发现仅有限长仍不能复用“未找到本轮”的结果；0.2.90 补持久游标。 |
| 0.2.90 | [#202](https://github.com/bingjiang0611/scry/pull/202) / `2f247cd93` | `fc1e5fb3e21f1d4e4657304744d1317f275a2bfe` | Codex 持久未命中游标、只凭匹配原生 ID 的终态封箱。隔离正式包：静态超窗样本首轮封箱，后 9 次读 0 B；增长对照每轮仅增读 89–153 B。旧机未观察到 0.2.90 进程接管，生产 CPU/RSS 未验收。 |
| 0.2.91 | [#203](https://github.com/bingjiang0611/scry/pull/203) / `c62c8aa93` | `21e08ad21ffec9dcc389e647fd7cb31f5e4625a4` | 显式认领挂载仓库，晚于已观测定向写入又得到空 diff 时用 `baseline_after_write`；允许 Qoder 首问在转录文件尚未出现时认领。新目录首问仍报 `recorder_unavailable`：只允许文件缺失，`realpath(dirname(path))` 遇缺失的项目子目录即 `ENOENT`。到 `PreToolUse` 才可能建基线，diff 成 `partial`。 |
| 0.2.92 | [#205](https://github.com/bingjiang0611/scry/pull/205)、[#206](https://github.com/bingjiang0611/scry/pull/206) / `696da43e7` | `154756347fbd17db4ed2017229857bef5f4644ff` | 顶层 Qoder Stop 按请求号归属；有巡检时才短等转录。新目录认领钉住最近现存祖先的真实路径，最多缺三层，拒绝后来出现的文件或目录符号链接。同步首问成功且转录未落盘时不记晚基线标记；普通中途及排队认领不享受该例外。**后来在 CodeLens 链路看到一个首问封箱两次**：如果转录在入队后、重放前出现，认领被改走 `CaptureStart` 并带合成指纹；紧随的同一 `UserPromptSubmit` 即使载荷相同也被当作替换轮。先写 `interrupted`，后写 `completed`；同一请求号进入旧轮历史还可使 Stop 变成 `unproven`。 |
| 0.2.93 | [#208](https://github.com/bingjiang0611/scry/pull/208) / `266483fd2` | `6c665f7166a0167aaf9dc976048ee11a0f63b11d` | Qoder 首问认领保留原生 `UserPromptSubmit` 和精确载荷指纹，不按同文或仅按请求号放宽去重。修复上述重复开场及其引起的 `unproven`，不削弱 180 秒防护。隔离 Qoder 1.1.93 原生钩子 + recorder 收件箱对照：旧包复现 `interrupted`、`unproven`、另一个轮次待封箱；新包首轮、次轮和独立短问答各只封一条 `completed` 且 `matched`。这不等于 CodeLens 完整专项，结果仍待回传。 |

0.2.92 的隔离 Qoder 1.1.91 直接认领测试中，新目录首问确实返回 `started` 且 Git 基线就绪，写出一条 `completed`、转录和 diff 均 `available`。测试没经过 CodeLens 的认领与事件双入队，因而没有覆盖后来的重复开场。0.2.93 的 [#208 必需 CI](https://github.com/bingjiang0611/scry/actions/runs/45816963931) 与原候选包隔离安装冒烟通过。独立复现解释了 `unproven` 的机制，但没有逐条核证 CodeLens 原验收中那条约 196.5 秒的记录。

## Qoder Stop 现行规则

- 只对同会话的顶层 Stop 核对请求号：`Stop.parent_request_set_id` 精确匹配当前 `UserPromptSubmit.request_set_id` 才能归属。会话持久状态保留最近 **32 轮**请求号，不回扫历史。正文相同、转录父链、时间先后均不用于归属或兜底。
- `matched` 表示仅命中当前请求：免原 180 秒的归属等待，不表示证据齐备。`stale` 表示只命中已知旧轮：拒绝，不刷新当前轮等待。`unproven` 表示字段缺失/无效、未知、不一致或复用冲突：不提前归属，原有防护及 180 秒宽限仍在。子 agent Stop 和 `SubagentStop` 只算活动，不归属、不封箱；未完成后台任务仍走自己的宽限。
- **有巡检才短等**：`serve` 处理中，本轮身份或最终回复尚未落盘，`matched` 可以等 **10 秒**。实际落盘在证据齐备或到期后的首次巡检，不保证恰好 10 秒。始终读不到转录则标为不可用、保留可归属 diff；读到了但没匹配本轮则按身份不匹配降级；身份已匹配但缺回复时标证据不完整，保留可归属 diff。
- **没有巡检者就不等**：direct 不起后台进程；默认传输启动 `serve` 不成而回退本进程时也一样，当前调用按已有证据提交。**下一条提问替换本轮时也不等**：已观测 Stop 的旧轮以 `completed` 收尾，缺失证据写明原因；同一调用开新轮并建基线。
- 另有可疑原生轮次 ID 的路径：先持久保留未确认 Stop；精确匹配才确认，明确不匹配就撤销；直到 closing 过期（最后状态写入后 24 小时）仍无法核实时，以 `interrupted` 降级，不宣称 Stop 已归属。日志 `qoder_stop_attribution` / `qoder_stop_hold` 只有结果、原因、耗时，不写 ID 或正文。

| 原生钩子上的字段 | Qoder 1.1.91 | Qoder 1.1.93 |
| --- | --- | --- |
| `UserPromptSubmit.request_set_id` | 有 | 有 |
| 顶层 `Stop.parent_request_set_id` | 有 | 有 |
| 原生轮次 ID `prompt_id` / `promptId`、事件时间戳 | 当时验证的开场和 Stop 载荷未带 | 本次首轮、次轮和独立短问答的两种钩子均未带 |

1.1.93 的三组请求号均精确配对。**钩子没有时间戳不等于转录里的工具调用没有原生时间戳**，首轮 diff 的证据还要单独查宿主转录。

### 替代样本回放

原 58 组因日志滚动无法按原队列复现。经评审接受的是现存 **59 组 Qoder 1.1.91 的替代回放**，不是实机提交延迟验收。到达 / +1 s / +5 s / +10 s 的「完整且识别最终回复 / pending / 到期降级」为 **0/59/0、57/2/0、57/2/0、57/1/1**。到达时 `stop_reason` 为 `tool_use` 49、缺失 10；其后为 `end_turn` 58、缺失 1。一个到期仍无匹配轮次；另一个还在等后台任务。+1 s 的完整证据为 57/59（96.6%）。详见 [CLI lifecycle](../../packages/turn-recorder-cli/docs/lifecycle.md)。

[固定清单](../performance-experiments/fixtures/qoder-stop-1.1.91.json)只存 SHA-256 样本标识及开场、前缀摘要。不存提示、回复、路径、会话号。从仓库根、已编译的 CLI 和有权读取的留存样本运行：

```bash
set -o pipefail
python3 -B scripts/qoder-replay-sample-input.py \
  | node scripts/replay-qoder-stop-samples.mjs \
      packages/turn-recorder-cli/dist docs/performance-experiments/fixtures/qoder-stop-1.1.91.json
```

不保存管道中间输入；样本已滚动或摘要不符时，让脚本报错，不补样冒充原队列。这 59 组缺每个仓库实际快照完成时间，**不能用来验收下面的首轮 diff 规则**。

## 下一版待做：首轮 diff 的 `partial` 证据规则

`fix/first-capture-baseline-evidence` 已在本地从 #208 合入提交 `266483fd2` 建了干净工作树，**没有独有提交、未提交改动、远端分支或 PR**，没有代码可推。复工从最新 `main` 开始，遇其他会话修改先 merge，不 rebase、不 force push。评审人的最终要求原文如下：

> 去掉 baseline_after_turn_start 必须同时满足：
> 1. 原始开场事件是 UserPromptSubmit。认领入口保留原始开场类型（新增字段），不因为转录已落盘而记成 CaptureStart；中途的 CaptureStart 不适用。
> 2. 这一轮是该会话转录里的第一轮：转录中本轮的用户提问行之前没有任何更早的用户轮次。用这条代替原来的“无遗留后台任务”——第一轮之前没有上一轮，不需要判断后台任务状态。不是第一轮的，一律保留 partial。
> 3. 每个仓库记录 Git 快照完成时间（新增字段，快照初始化完成后写）。任何一个仓库没有这个时间，保留 partial。
> 4. 转录对本轮完整（身份已匹配、complete 为真、子 agent 侧文件齐全），本轮每一次工具调用都有宿主原始时间戳，且最早的一次不早于所有仓库的快照完成时间。本轮没有工具调用也算满足。任何一次工具调用缺原始时间戳，保留 partial。
> 其余情况保留 partial 和原说明。
>
> 零改动盲区一并修：基线晚于本轮首次工具调用或时间不明时，即使 diff 为空也不得报 available。
>
> 验证（现有 59 组样本缺快照完成时间，不能用于回放，如实写明）：
> - 单测：同步认领正例；收件箱重放且基线先完成的正例；基线后完成、非第一轮、转录不完整、工具缺原始时间戳、中途 CaptureStart 各一条反例；零改动盲区一条。
> - 合并前做真实宿主实测，隔离环境、走收件箱路径，Qoder 和 Codex 各做：
>   · 正例至少 5 个新会话的第一轮（含文件修改），报告几个判为 available；
>   · 反例：人为让基线晚于第一次工具调用（延迟后台处理），必须判为 partial；
>   · 反例：第二轮才开始采集的会话，必须保留 partial。
>   报告里列出每个样本的快照完成时间与最早工具时间的差值。
> - 某个宿主的转录拿不到工具原始时间戳，就如实写“该宿主不适用，保留 partial”，不要找替代时间。

#208 已保留 Qoder 首问的开场行为，但没有加完这套证据、更没有改变常开采集的 `partial` 降级规则。现有 `baselineAt` 是初始化前的标记，不是 Git 快照完成时间；归一化后的工具事件时间也不等于可验证的宿主时间。不能用工具钩子到达时间填空，也不能把有界转录中“没看到此前用户行”当作“这是第一轮”。若实测正例大面积 `partial`、反例成 `available`，先停并报告。实现及实测完成后报评审人，**停在合并前**。

## 方案 4：只有合同草案，不开始实现

[`docs/plans/recorder-inbox-v2-contract-draft.md`](../plans/recorder-inbox-v2-contract-draft.md) 经 [#209](https://github.com/bingjiang0611/scry/pull/209) 合入 `f3c4834df8f2e8ad1d525f0f2f87a95577dd431e`。推荐工作区外、仅当前用户可访问的目录，不让旧 recorder 扫描，也不在 Git 仓库中预置有特权的冷启动入口。硬链接只保证序号槽独占发布；仍需证明认领先于后续事件，`attention` 只提示，恢复要扫描。超限保留原文，1 MiB 只是暂定内联阈值；进程状态与构件能力清单都要验证，不能假设新安装已替换旧进程。先做预热/诊断，必要时试点只直写首条且 ACK 后交接，最后再做真正冷启和全会话迁移。提交钩子绝不信任队列里的裸路径。

0.2.92 隔离对照已验证旧消费者没有碰工作区外的 v2 测试槽。原生大小样本为 Qoder 1.1.93 的 14 条 hook，最大 `PostToolUse` 37,228 字节；**Codex、子 agent、受限沙箱、v2 落盘和混版本交接仍未验证**。没有授权实现；等评审人读完修订并明确同意。

## 旧机 recorder / CPU 采样

只读观察，未重启、不主动升级。初测 0.2.87 时，重复读超大 Codex 转录导致 CPU 中位 **45.4%**、RSS 约 **113 MB–1.40 GB**（不是均值）。版本观察看到 CodeLens 从 0.2.53 到 0.2.54 再到 0.2.55；0.2.54 切入时运行中 recorder 仍是 0.2.88，后一次只读观察见 **CodeLens 0.2.55 / recorder 0.2.91** 实际接管。没有观测到 recorder 0.2.90 接管。等待精确 `0.2.54 / 0.2.90` 的采样器以 `upgrade_wait_expired` 结束，只有 4 条版本观察和 1 条终止，不是 30 分钟 CPU/RSS 采样。此后生产版本不明，不能把此处历史观察当成机器现况。

接手者先只读核对当前 runtime 和实际 socket owner 版本。获授权的新版真实接管后，至少连续观察 30 分钟，覆盖活动与空闲；分别报 CPU/RSS 均值与峰值、`ERR_STRING_TOO_LONG` 新增、持久游标建立/截断轮次封箱/失败暂停及 `health.json` 计数变化。CPU 仍高只定位，不在旧机现场改动。不处理原有 `managed_replaced` 隔离项、不回填或重传历史用量。

## 操作约定与其他会话边界

- “报给我再合”就是先报，停在合并前。必需 CI 绿不是批准；发布也需要单独授权。跟进 `main` 用 merge，不 rebase、不 force push、不绕过推送预检。只在本次授权范围内合并。
- 认领、开场、Stop 归属有变更：默认先让门禁用目标构件跑 **CodeLens 完整链路**的 Qoder 专项。用验收机器实际安装的 Qoder 版本。覆盖全新目录首问恰好一条记录、紧接的第二轮正常开场和封箱、独立无工具短问答的正文、用量、Stop 归属及提交时间；只跑本机 recorder 或旧宿主不替代专项。0.2.93 先发后验是此次明确的例外，不自动延续。
- 跨机交接候选构件用 registry 和确切版本/校验值，发包前保留并校验原候选字节，发布及回读记版本、`latest`、`dist.shasum`、时间。临时路径不是跨机证据；直接贴脱敏结果、命令和适用范围，不贴原文、会话或请求号。内网 registry 登录由用户手动做，不索要或转存凭据。测试不调用真实发布、不改真实宿主配置。
- “记录器移出 App”的 A 段是另一个规划会话的工作。0.2.93 发布后可以开始走评审，但其 PR **由评审人读过再合**。与 recorder 文件冲突时以远端 `main` 为准，先核对对方变更，不借本交接合入其代码。

## 分支与 PR 状态（交接时）

| 分支 / PR | 状态与下一步 |
| --- | --- |
| `fix/first-capture-baseline-evidence` | 只有本地分支名，历史已在远端 `main`；没有需保存的独有提交。后继按上面的证据规则实现。 |
| `docs/recorder-0.2.93-handoff` | 本交接的纯文档分支，交付以 `origin/main` 上这份文档为准。 |
| `fix/recorder-legacy-managed-turns` / [#210](https://github.com/bingjiang0611/scry/pull/210) | 另一个会话的 recorder PR，仍 OPEN；不由交接会话接管或合入。 |
| `fix/recorder-daemon-version-owner` / [#211](https://github.com/bingjiang0611/scry/pull/211) | 另一个会话的 daemon 版本 PR，仍 OPEN；不由交接会话接管或合入。 |
| `docs/recorder-inbox-v2-draft` / #209；`docs/qoder-first-capture-baseline` / [#207](https://github.com/bingjiang0611/scry/pull/207) | 已推送、已合并的文档分支；前者只是草案，不是实现许可。 |
| `fix/transcript-window-limit`、`fix/codex-transcript-recovery`、`fix/recorder-linked-repositories`、`fix/qoder-stop-evidence`、`fix/qoder-pending-transcript-directories`、`fix/qoder-first-claim-replay` | 已推送、已合并，对应上表的 #201、#202、#203、#205、#206、#208。没有要从本机补推的提交。 |

规划会话的 A 段以它自己的评审交接为准，不能用上述 OPEN PR 猜测它的 PR 编号。审计了本会话的相关 worktree：无未提交的 recorder 实现或未推送的独有提交。构建目录、离线包副本、合成样本、一次性复测脚本和日志不作源代码交付；隔离宿主状态、其他会话的本地草稿与真实数据不推送。
