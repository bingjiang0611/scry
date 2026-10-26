# uploader 侧审阅（U1–U4）

审阅对象：uploader 仓库分支 `reliability/uploader`，代码 `53928688`，报告 `8b3bf1b1`（用户 2026-10-25 转来的修复报告）。该仓库不在本会话可访问范围内，**本审阅只基于报告文字，没有读 uploader 代码，也没有复跑**。recorder 侧的事实来自本仓库 `reliability/collection`。

## 结论

方向通过。U1–U4 的语义与 E.md 和用户确认一致：ACK 之前正文和哈希已经落盘；归档后仍能发送；不可重试错误进 dead letter；显式关闭时保留正文，只有显式解除才会发送。先写失败测试再修复的流程完整，基线失败也做了对照，没有拿较早版本的全仓结果冒充最终版本。

**上线前必须处理下面 3 项。** 前两项不处理会直接造成采集停顿或绕过 trust 校验。

## 必改

### R1. 新共享模块必须进入 commit hook bundle 和分发清单

- recorder 的 trust 指纹只覆盖 `scry.config.json` 里 `commitHook.files` 列出的文件（`commit-hook-grant.ts:81-95`），并且就地执行，不会复制。新增的 `.claude/hooks/scry_upload_store.py` 如果没列进去，就会在指纹之外执行：它被改动不会触发重新校验，违反「执行 trust gate 必须 fail closed」。
- 报告里 `sync.py` 的夹具只复制 uploader、不复制共享模块。需要确认这只是夹具问题，真实分发路径也包含新模块。否则在别人机器上 import 会失败，每次 hook 都返回非 0，recorder 就停在第一条（见 R4）。
- 验收：在 `commitHook.files` 中加入新模块，用一份「只有旧清单」的分发副本跑一次，确认缺模块时 hook 非 0，而且原因可查。

### R2. 升级会触发全量重放，要证明不会重复上传

- bundle 内容一变，指纹就变；新指纹没有 ACK 游标，recorder 会从 sequence 1 开始，把 `.scry/records/` 里保留的每一条重新通知一遍（`store.ts:410-428`、`498`）。
- 这次改动本身就会改变指纹，所以每台机器升级后都会发生一次。对新 hook 来说，这些旧记录没有 receipt，会被逐条复制进 custody 并入队。
- 需要补一个验收场景：旧版 uploader 已上传过的记录（只有旧游标，没有 receipt）在新版本下重放时，不会再发一次；或者明确依赖服务端返回 `duplicated`，并说明流量和磁盘的代价（custody 会让本地占用翻倍）。
- 重放受 recorder 每次 hook 最多 8 条、1.5 秒的预算限制，积压主要靠 `recorder recover` 和 `notify-drain` 消化，不会卡住 Provider。

### R3. 非默认 dataDir

- recorder 的 `dataDir` 可以配置（`config.ts:59`），不一定是 `.scry`。现在的通知只有 `workspace`、`recordId`、`sequence`，没有 dataRoot；`recordPath` 要等 E2 才有。
- 报告写的是「按 dataRoot 下的确定路径定位，拒绝不匹配的路径」。需要确认 dataRoot 是从 `scry.config.json` 读出来的，而不是写死 `.scry`。写死的话，配置了其他 dataDir 的工作区会全部返回非 0，被 R4 放大成停顿。

## recorder 侧的连带影响（本仓库处理）

### R4. 新 uploader 让 recorder 的队头阻塞变成现实问题

旧 uploader 几乎总是返回 0，所以 M2 之前被降级。新 uploader 在哈希不符、路径不符、源文件缺失时会持续返回非 0，这是正确的 fail closed，但 recorder 现在遇到非 0 就停在该 sequence，之后所有记录都不再通知（`store.ts:515-521`），日志里只有一行。E3 的 M2 部分因此改为必做，见 E.md。在 E3 落地之前，上线新 uploader 要同时盯 `scry doctor` 的通知积压。

## 建议（不阻塞）

- **保留策略**：建议只自动清理 `status=uploaded` 且超过 N 天（例如 14 天）的 custody 副本；`pending`、`skipped_disabled`、`dead_letter` 一律不自动删除。N 的取值由用户决定。
- **旧测试合同**：`runtime_smoke` 的 callback 夹具还在断言「没有正文也返回 0」，这正是这次有意修改的合同；`sync` 夹具缺新模块，对应 R1。这两处属于有意的合同变更，建议用户授权 uploader 执行方直接更新，并在提交说明里写依据。其余基线就有的失败单列，不在本次范围内。
- **未覆盖的故障**：报告已经如实列出掉电、rename 边界被杀、并发归档与发送这几类没有覆盖的故障。上线前至少在一台真实机器上做一次「真实 Provider → recorder → 新 hook → 真实上传」的受控验收。

## R1–R3 复核（2026-10-25，仍只基于报告摘要）

uploader 代码 `c230f652`，报告 `50b6889d`，17/17 离线验收通过，9 个失败验收已从测试提交重演。

- R1：trust 清单、导入前检查和两条集成复制路径都已补齐，按报告接受。
- R2：旧游标重放依赖服务端返回 `duplicated`，ACK 类型持久化。能否接受取决于服务端是否按 recordId 幂等去重，需要用户确认。代价是每台机器升级时重放一次全部保留记录（流量和 custody 磁盘）。
- R3：接管和 worker 统一读取配置的 dataDir，按报告接受。

上线前仍缺：旧 callback/sync 夹具更新和全仓门禁重跑（需要 uploader 仓库维护者明确授权）、服务端去重确认、一次真实端到端验收、recorder 侧 E3 死信。

## 夹具更新（2026-10-25，按报告摘要）

用户授权后，执行方更新了夹具：失败验收在 `170379d7`，夹具修复在 `fdd20ba7`，报告在 `b164ca50`，19/19 定向验收通过。callback 夹具补齐了配置和完整正文，验证正文接管之后才入队，并保留了「缺正文必须返回非 0」的反例。全量 runtime/sync 门禁剩下的失败都是基线就有的（旧脱敏断言、`ASSIGN_RE` 等），不算本次回归，需要另外处理。仍待：服务端按 recordId 去重的确认、真实端到端验收、recorder E3。

用户 2026-10-25 确认服务端已按 recordId 去重，R2 依赖 `duplicated` 的做法接受。升级时每台机器会重发一次保留的记录，这是一次性的代价。
