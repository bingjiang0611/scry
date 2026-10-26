# 批次 E 修改记录（待核验）

基线 `01c2c46d`，分支 `reliability/collection`。按 E1 → E2 → E3 完成；M2 按用户最新要求必做，M3 稳定 id 不做。未修改外部 uploader，未合入 main、发布或安装到日常环境。

## 提交与旧实现失败证据

| 项 | 先提交失败测试 | 独立修复 | 红测结果 |
|---|---|---|---|
| E1 / H3 | `fdecff37` | `a8200796` | focused 4 failed；全量 4 failed / 3977 passed / 4 skipped |
| E2 / M4 recorder | `d63ca896` | `5210078f` | focused 3 failed / 147 passed；全量 3 failed / 3981 passed / 4 skipped |
| E3 / M2 | `46c158e7` | `bd39cbfe` | focused 6 failed；全量 6 failed / 3984 passed / 4 skipped |

三次测试提交前均跑过 typecheck 和全量 unit。E3 后续修正了接收端夹具的 dataRoot 来源，生产逻辑仍未修复时再次得到 6 failed；没有用夹具错误替代最后的红测证明。

旧输出节选（去 ANSI 颜色）：

```text
E1 shell fast path pins the starting session env...
- "enabled": null
+ "enabled": "0"
- "url": null
+ "url": "daemon-only-secret"
Tests  4 failed (4)

E2 drain / redeliver binds schema v2 to exact file bytes...
expected { schemaVersion: 1, …(6) } to deeply equal { schemaVersion: 2, …(8) }
recordPath、sha256 缺失
Tests  3 failed | 147 passed (150)

E3 reports the failed sequence...
- failure: { sequence: 1, attempts: 1, reason: 'exit', exitCode: 71 }
+ ackedThrough: null, notifyBacklog: 3
Tests  6 failed (6)
```

日志：`/tmp/scry-E1-before.log`、`/tmp/scry-E1-red-{unit,typecheck}.log`；`/tmp/scry-E2-before.log`、`/tmp/scry-E2-red-{unit,typecheck}.log`；`/tmp/scry-E3-red-receiver-corrected.log`、`/tmp/scry-E3-red-verified-unit.log`、`/tmp/scry-E3-red-typecheck.log`。独立冷启动控制还证明旧 latest-redelivery 会再次调用已死信的最新记录：`/tmp/scry-E3-cold-start-before.log`，1 failed；修复后通过。

## E1：开始环境随轮次持久化，正文不带 env

主要模块：`commit-environment.ts`、recorder 的 start/inbox/finalize 路径、managed handoff、daemon transport、`workspace-hook-sources.ts`、store notification。

- 接受开始事件时冻结上传 allowlist；open、inbox 重放、managed prepare/commit 均保留同一份快照。Stop、恢复进程或 daemon 的环境不覆盖它。
- record 发布前，原子写并 fsync `<dataRoot>/record-environments/<recordId>.json`，权限 0600。重复提交不覆盖既有快照。record、export、support bundle 不包含这些值；执行路径与 trust 指纹不从快照恢复。
- 未设置和空字符串分开保存。allowlist 是当前已有的上传键：`SCRY_TURN_UPLOAD_ENABLED`、`SCRY_INSTALLATION_ID`、`SCRY_INSTALLATION_ID_FILE`、`RATE_NATIVE_ASYNC_QUEUE_DIR`、`TMCP_TRACE_URL`、`SCRY_UPLOAD_DEADLINE_SECONDS`、`SCRY_UPLOAD_LOCK_WAIT_SECONDS`、`SCRY_MANAGED_UPLOAD_WAIT_SECONDS`，不是任意前缀透传。
- daemon 协议升为 2：外层 NUL 分隔环境 + 原始 Provider JSON。接收端限制 8 MiB，拒绝非 allowlist/重复键及非法封装。环境不混进 Provider payload。shell 只使用内建 printf，复用原有 printf→curl 管道，没有新增编码器进程。
- 快路径也传递 `SCRY_RECORDER_ENABLED`，会话关闭采集可覆盖 daemon 的旧值。旧协议拒绝后走已有 fallback，不按 daemon 的 env 假装成功。

证明包括：daemon A 带 `UPLOAD_ENABLED=0`，shell B 不设置该键，B 开始后 Stop 又改 env，最终回调仍收到 B 的未设置状态；引号、反斜杠、换行、Unicode、空字符串；disabled session；持久 inbox；managed handoff；旁路 mode 与正文/export/bundle 无敏感标记。最终 E1 测试 5 项。

**限制**：升级前没有快照的 record/open 无法重建开始环境，保留旧的投递进程 env 行为，不声称已修复其历史环境。旁路不加密、不自动随归档删除；不要分享整个 dataRoot，非默认 dataDir 需自行确保忽略与访问权限。新增 uploader 环境键需显式更新 allowlist。

## E2：schema 2 绑定原始文件字节

- `store-notifications.ts` 统一构造通知；drain 和 latest-redelivery 均新增相对 **dataRoot** 的 `recordPath` 与原始文件字节 SHA-256。旧字段含义不变，通知 schemaVersion=2，record schema 仍为 1。
- 文件读一次、parse 一次；`store-index.ts` 的 `parseRecordFile` 复用既有校验。哈希不是对 normalize 后的对象或重新 stringify 的 JSON 计算。
- 测试使用自定义 dataDir，并给 JSON 添加空白，证明路径基准及 raw-byte 哈希；保留“通知没有正文”与“显式 redelivery 不推进 ACK”的断言。
- CLI 文档明确：exit 0 应表示接收方已校验并原子持久化完整记录。此合同依赖 uploader U1；recorder 只能观察退出码，不能证明真实接管或远端上传。旧接收端须支持 schema 2。
- 归档文档补充：U1 完成前人工确认 outbox 覆盖；旧 uploader 即使已有副本仍可能因回源失败被归档阻断，需 U2 或先确认上传完成。

## E3：M2 必做，死信不等于 ACK

主要模块：`commit-delivery-state.ts`、`store-notifications.ts`、`doctor-command.ts`。

1. 有序 drain 按 `(fingerprint, sequence)` 记录次数、recordId、时间和受限错误分类。每次 drain 对未耗尽的失败队头只尝试一次，不紧循环。正文/环境旁路不可读、callback 非 ACK 都可计入；全局 trust、执行配置或锁拒绝不计入某条记录。
2. 第 **5** 次失败先持久化计数，再 fsync recorder 死信元数据，最后推进处理游标并继续。死信在 `notifications/dead-letters/<fingerprint-hash>/<sequence>-<recordId>.json`。canonical record 不搬走、不删除，避免制造 sequence gap；正文和 env 仍在原位置。
3. `processedThrough` 包括已交付/已隔离；`ackedThrough` 仍是保守的连续 ACK 前缀，不能越过死信。后续成功可继续，但不伪装成整个前缀成功。普通归档仍拒绝未 ACK 前缀。
4. `notifyBacklog` 为当前身份尚待自动处理的队列，死信单列。`notify-drain` 退出 0 只证明自动队列清空，死信仍使 doctor 退出 5，不表示全部上传成功。
5. `doctor` 新增 `commitHook.delivery`，显示阻塞 sequence/次数及死信；重试中 warn，死信 fail。总数按死信文件名统计，详情只读最新 20 条。状态损坏显示 unavailable，不清零、不执行回调。
6. 已持久化第五次失败时，崩溃恢复完成隔离，不调用第六次。已知失败文件后来消失仍保留为待处理项，耗尽后继续后面。既有每事件 8 项/1.5s 预算保留，死信也占处理项；单 callback 10s 熔断不变。
7. 冷启动 latest-redelivery 也跳过已耗尽/已死信的最新记录；其原有额外唤醒不修改有序队列计数或 ACK。旧 legacy ACK 只读迁移及指纹隔离保留。

10 个 E3 测试覆盖：真实本地 receiver 的持续 hash mismatch 非 0、跨调用计数、后续正文交付、ACK/归档拒绝、第二个失败 sequence 从 1 计数、成功重试清除失败、指纹隔离、已知源文件缺失、死信发布后/游标发布前故障恢复、冷启动防重复、损坏 counter/null/身份拒绝、trust 拒绝不执行且不消耗次数。没有持久化 callback stderr、env、argv 或错误消息正文。

**M3 不做**：用户已确认指纹变化导致重复校验而非正文重传。稳定 id 还需设计既有 ACK、失败与死信身份迁移，当前不是必做的数据可靠性缺口；保持原指纹隔离和 trust 校验。只有重复校验被测为主要瓶颈时，再单独评估稳定 id 与迁移合同，不预留空配置。

**恢复限制**：没有单条死信重放命令。先修复根因；真实修复后的有效 bundle 若产生新指纹，会重新投递全部仍保留记录，旧身份死信留作历史。仅外部条件恢复但指纹不变时，不自动重放死信。不能靠删/伪造 ACK 或修改 sequence 来清队列。旧二进制不识别新状态，须升级并重启对应 daemon/使用方；本轮不声称已更新用户正在运行的版本。

## 20 KB 门禁与必要拆分

全程正常 pre-commit，没有 hooks 豁免、放宽阈值或删除证据注释。

| 原文件 | 按现有职责拆分 | 核对 |
|---|---|---|
| `store.ts`（49 KB） | store / index / notifications / archive | 79 个原声明与注释在纯移动阶段一致 |
| `daemon.ts`（25 KB） | daemon / transport / owner | 39 个原声明与注释一致 |
| `managed.ts`（约 40 KB） | managed / evidence / index / recovery | 43 个原声明与注释一致 |
| `daemon.test.ts` | 前 4 个 transport 测试独立 | 原测试保留；协议预期按需求 1→2 |
| `recorder.test.ts`（190 KB） | 原入口 + recorder-tests 注册片段/共享夹具 | 修改 v2 预期前，124 个原测试定义逐字一致，148 个展开测试仍通过 |
| `managed-turn-commit.test.ts`（50 KB） | 原入口 + managed-turn-tests 注册片段/共享夹具 | 修改 v2 预期前，37 个原定义逐字一致，42 个展开测试保留 |

后两套仍由原文件单 collector、原顺序注册；vitest 仅排除片段的独立重复发现，不减少断言、执行次数或 coverage 源码范围。片段/夹具仍是 `*.test.ts`。本轮未测覆盖率百分比。

纯移动证据 `/tmp/scry-E-split-audit.log`；E1 完成时的声明差异核对 `/tmp/scry-E1-final-audit.log`（150 个无关声明/注释不变；列出的变化限于 E1 合同）。这不是对后续 E2/E3 的“不变”声明。测试拆分证据 `/tmp/scry-E2-tests-audit.log` 及保留的 `/tmp/scry-E2-original-*.test.ts`、split 脚本。最终另用 Git 基线复查 managed 37 个定义：36 个逐字不变，唯一差异是 schema 2/path/hash 预期，见 `/tmp/scry-E-managed-current-audit.log`。所有提交触及的 authored 文件均通过正常大小门禁。

## 实际验证

macOS arm64、Node 24.18.0、Vitest 3.2.7。当前 CLI 包仍为 0.2.51（开发分支产物，未发布）。全量原有 4 个 skip：performance-correlation、billing-admin-real、P0、P1；未启用真实付费探针。

| 检查 | 结果 | 日志 |
|---|---|---|
| E1 最终 focused | 43 文件、554 passed | `/tmp/scry-E1-final-focused.log` |
| E1 修复前后全量 | 红测 4→修复后 3981 passed / 1 既有超时 / 4 skipped；超时定向 10 passed | `/tmp/scry-E1-final-unit.log`、`/tmp/scry-E1-size-recheck.log` |
| E2 focused / managed | 150 + 44 passed | `/tmp/scry-E2-after.log`、`/tmp/scry-E2-verified-main-focused.log` |
| E2 最终全量 | 3984 passed / 4 skipped | `/tmp/scry-E2-verified-unit.log` |
| E3 广域 focused | 46 文件、605 passed（当时 E3 为 7 项） | `/tmp/scry-E3-focused.log` |
| 最后 E3 / recorder / doctor focused | 3 文件、165 passed（E3 10 项） | `/tmp/scry-E3-final-focused.log` |
| 实际 startup/trust 测试文件 | 2 文件、17 passed | `/tmp/scry-E3-startup-trust.log` |
| `npm run typecheck` | node/web 通过 | `/tmp/scry-E3-final-typecheck.log` |
| `npm run build:cli` | 通过 | `/tmp/scry-E3-build.log` |
| 修复提交前 `npm run test:unit` | **3994 passed / 4 skipped**，340 文件通过 | `/tmp/scry-E3-unit.log` |
| `npm run test:shell` | PASS setup-scry-workspace | `/tmp/scry-E-shell.log` |
| `npm run smoke:cli-package` | 临时 npm 包 bin/init/hook/doctor/通知隔离/旧 cursor 通过 | `/tmp/scry-E-package-smoke.log` |
| `npm run performance:measure -- --scenario source-control.diff --compare 01c2c46d --out /tmp/scry-E-final-performance` | git/total 子进程均 8→8，无 worse，ratchet 通过 | `/tmp/scry-E-final-performance.log`、对应 measure.json |

上述 L1 只覆盖相邻 diff workload，不证明通知/冷启动 L2/L3。逐轮环境 fsync、失败计数与死信持久化是本次必须新增的工作，不宣称提速。

### 首次与中途失败，没有被后续通过抹去

- E1 夹具曾用通用词 `private` 检查泄露，误中 macOS `/private` 路径；改成唯一秘密标记。旁路最初放在 notifications 子目录，破坏旧目录合同，已移到独立 `record-environments`，未弱化原断言。E1 全量既有超时为 `check-staged-file-size.test.ts > installs a repository-local pre-commit hook and enforces the gate during real commits`，5 秒；相关测试/超时未改，定向复查 10 通过，最后全量也通过，不声称本次修复了该超时。
- E2 测试拆分第一次漏换行导致 transform error，修正后原 148 项通过；managed 首轮全量仍断言 schema 1，依新合同改成 2 并增加 path/hash 断言，trust 断言未删。
- E3 测试夹具曾误用不存在的 `notification.dataRoot`，改为夹具已知 dataRoot，补 exitCode=71；在生产修复前重新证实 6 failed。首次实现漏掉旧日志的 acknowledged/PID 字段，已恢复；typecheck 发现缺少 env 参数，已修正。旧“失败不落状态文件/状态只有两字段/失败时文件字节全不变”与新持久计数合同冲突，改为验证计数，同时保留 ACK 不推进和 legacy 文件不改的检查。
- 首次独立 CLI probe 误以为 pending 时 notify-drain 退出 0，实际合同是 3；只修正 probe 的退出码预期后重新验收。一次 focused 命令误列不存在的 startup 测试名，实际只跑 3 文件；随后定位并补跑真正的 `commit-hook-trust` 两个文件，17 通过。

### 独立当前构建 CLI 读回

`/tmp/scry-E-built-probe.mjs` 使用临时 HOME/workspace、自定义 dataDir、合成 Pi lifecycle、本地 receiver，每次 CLI 调用是独立进程；不调用真实 Provider 或网络 uploader。

`/tmp/scry-E-built-probe-final.log` 证明：3 份 record；旁路 0600；正文无 env 秘密标记；回调收到每轮开始时的 0/未设置/1，而不是 Stop 或投递进程的值；7 次通知都是 schema 2 且 raw SHA 匹配；sequence 1 失败 5 次后死信，2/3 接收到与源文件逐字节相同的正文；processedThrough=3、ACK=0、backlog=0、dead=1；再次 drain 不重试；普通归档拒绝且原 3 个文件仍在。

最初失败日志 `/tmp/scry-E-built-probe.log` 保留。probe 与临时 npm prefix/cache 已清理，包 smoke stop 后无匹配测试进程；保留 `/tmp/scry-E*` 日志/脚本及忽略的构建产物供复核。

## 用户手验（OpenCode / Qoder / Codex 分别执行）

沿用 [USER-VERIFY](../USER-VERIFY.md) 的隔离与证据规则；使用本分支构建 CLI 的绝对路径，不全局安装，不操作日常 workspace。真实账号/费用由用户先授权；本轮执行方未运行真实 Provider。

| 场景 | 操作与预期 |
|---|---|
| E-U1 每轮环境 | 在临时 workspace repair 脚本并 restart daemon，以 A 的 `SCRY_TURN_UPLOAD_ENABLED=0` 启动 daemon；分别用新 OpenCode/Qoder/Codex 原生进程启动 B（unset 此键）。完成一轮并等 canonical record 后检查回调的键是否设置/测试标记，B 不得继承 A 的 0。再测 B 显式 0、1、空值及 Stop 改值；最终仍以开始环境为准。关闭采集的 session 不应提交新轮次。不要输出真实 URL/凭据。 |
| E-U2 字节接管 | 各 Provider 完成一轮；receiver 按通知 recordPath 相对实际 dataRoot 读取，独立计算 SHA-256，对比通知，校验并持久化完整副本后再 exit 0。recordId、sequence、provider/session 需一致。archive 前由 uploader 负责人确认 outbox 的完整副本及 U2，不把 ACK 当作服务端上传成功。 |
| E-U3 poison 不中断后续 | 只在临时 receiver 中让某 sequence 固定返回非 0，并产生后续记录。连续运行 notify-drain：前 4 次 pending 可退出 3；第 5 次应隔离并继续后续。doctor 显示失败 sequence/5 次，退出 5；后续正文须真实到 receiver，不能只看 backlog=0。原 record 保留，普通 archive 拒绝。 |
| E-U4 trust 与恢复 | 把临时 bundle 改成路径越界/不可校验，确认 callback 未执行、次数不增加，doctor 报不可用。恢复合法 bundle 后按新指纹规则检查投递。切勿通过删状态或伪造 ACK 让测试变绿。 |

升级/repair/restart 是未来部署动作，不是本轮已执行的日常操作。原生 Provider 的结束、宽限、会话恢复按已核验 B/C 合同观察；组件夹具不能替代原生链路。

## 交付边界与下一步

- H3、M2、M4 的 recorder 部分改为待核验；M3 明确暂不实现，未改 uploader 行及其核验结论。
- 审查方负责核验本分支 E1/E2/E3。用户与 uploader 负责人负责实际 U1–U4、真实 Provider/服务端端到端；本仓库未读改外部 uploader 代码，不能用这里的本地 receiver 证明其 ACK/归档合同已兑现。
- 未验证 Linux/Node 20/22、真实断电、真实 Provider、旧新二进制并存或远端上传。故障注入只证明指定持久化边界恢复，不等于断电验收。计数/死信依赖可写存储；存储故障可能阻止计数与隔离，需先修复，不把失败当作 ACK。
- 最终全量通过；没有发布、日常安装、main push 或 PR。只推 `reliability/collection`，等待批次 E 核验。
