# 独立 CLI 0.2.50：按 hook 身份隔离 ACK

后续于[在线调查](20261021-cli-callback-online.md)。用户选择继续修复，允许迁移与并发验证后只部署独立 CLI，兼容仍运行的旧 App；不手工复用 ACK、不清理队列、不更新 App。

## 实现与合同

源码提交：`6d4b62c7ae9a1e410d2ceb3464d1d17f63ff5a9f`。

- `src/core/turn-recorder/store.ts` 将 checkpoint 写入 `notifications/commit-hooks/<stableHash(fingerprint)>.json`。文件名是固定长度 hash，不把 opaque fingerprint 当路径。
- 旧 `notifications/commit-hook-state.json` 保持只读，留给旧 App。读取时只接受 schemaVersion、指纹与非负安全整数均有效的 ACK；同一身份的旧、新游标取较大值。
- 投递在原有全局通知锁内迁移与更新。即使没有 backlog，也先把同身份的旧 ACK 持久化到独立文件，防止随后被另一个旧写者覆盖。只读查询不迁移。
- 没有合并两个指纹，没有复制其他身份的 ACK，没有改 trust/fingerprint 校验、回调权限、超时或 canonical records。
- 每个曾确认投递的身份保留一个小文件，不自动淘汰；常规读取只定位当前身份和一个旧文件，不扫描历史身份。新增的第二次小文件读取是兼容旧写者所需的工作，不声称此处 I/O 数下降。
- 归档仍按当前命令解析出的 hook 身份检查 ACK，并不保证其他 host 身份均已接收。README 明确这一既有边界；并存使用时分别确认接收方后再归档，没有引入未定义的“活跃身份注册表”。

## 验证

| 检查 | 当前版本结果 |
| --- | --- |
| 三个关键新回归的旧实现对照 | 3/3 失败：成功交替投递擦除 ACK、旧写者覆盖迁移进度、同身份进度回退 |
| 五个受影响测试文件 | 功能修复阶段、升版本前 270/270 通过；0.2.50 结果见下两项 |
| `npm run check:cli-release` | typecheck、601 项测试、CLI build、安装包 smoke 通过 |
| 安装包多进程 | 三个真实 CLI 进程处理两个身份、两条记录，投递数 `[0,2,2]`；旧游标保持原字节 |
| 真实旧、新版本兼容 | 复制本机未修改的 0.2.49，与 0.2.50 在临时 Git 工作区运行；Node 22.23.1 下交替迁移和三个进程并发通过，每身份每序号一次；旧版本能读取新记录 |
| 完整 unit | **3471 通过、7 失败、4 个既有 opt-in 跳过**；不能报告全绿 |
| 全量失败的定向对照 | 同样 7 项在干净 `2c5d381` 和候选版分别通过；这不抹掉 full-suite 失败，也不能证明其根因已解决 |
| 性能计数 | `performance:measure -- --scenario source-control.diff`：5 次均 Git / total 子进程 8，ratchet 通过；没有改门限，没有 L2/L3 提速结论 |
| 分发完整性 | 两个实际 CLI 入口的 45 个包文件均与已验证产物逐一 SHA-256 相等，版本读取均为 0.2.50 |

八个新增 unit 用例覆盖独立身份、只读查询、旧格式迁移、同身份单调合并、同/不同身份并发、回调失败不推进、三个无效 checkpoint。现有落盘断言改为检查新位置，没有删除断言；归档拒绝测试增加另一身份已 ACK 的反例。

全量失败位于 `runtime-evidence.counters.test.ts`、`catalog-performance.test.ts`、`codex-app-server.test.ts`、`pi.test.ts`：包括超时、错误归因/终态断言和一个 Node `uv__close` SIGABRT。失败后机器为 10 核、load average 约 50/68/55；不能仅据负载断言因果。Pi/Codex App Provider 实现不在该 CLI 产物中。本次部署依据通过的独立 CLI 分发门禁，不交付新的 App；全量不稳定问题留待单独调查。

独立兼容脚本最初三次 fixture 失败分别是缺少 Git 初始化、使用了错误 config 字段、错误 CLI hook 参数。按真实合同改为临时 Git 项目、`capture.diff`、`--provider/--event`，并要求 stderr 为空；没有放宽生产校验或成功断言。全程使用临时 HOME/工作区、假通知回调，没有真实 Provider、uploader 或网络调用。

## 部署与当前证据

- 包版本 0.2.50，tarball SHA-256：`6bbed2b609e977f0edfd04171398b90eb24ecb90a0a254e0f890ea3bf799ee88`。安装前 registry 最新仍为 0.2.49；**本次仅本地分发，未发布 npm**。
- 使用同一 tarball，以标准 npm global install 的 `--offline --ignore-scripts --no-audit --no-fund` 安装到两个实际入口：项目调用的 `~/.local/bin/scry`，以及当前 PATH 默认的 `~/.nvm/versions/node/v24.18.0/bin/scry`。旧包分别保留备份。没有遍历修改其他 Node 安装，也没有修改 PATH。
- QA 期间正常 hook 曾自动启动旧 daemon 49516，重复任务继续增长；不是先前诊断 daemon 87281 没有停掉。部署时重新核对 owner token、进程参数、可执行路径、环境与 bundle 指纹，再通过正常 stop/start 切换。
- 新 daemon PID 16154，Node 24.18.0，0.2.50，启动时间 `2026-10-21T15:55:46.545Z`。本次进程使用 `SCRY_AUTO_UPDATE=0` 固定诊断版本，没有改持久更新配置。
- 启动时旧文件仍属于 CLI 配置身份、ACK 为 2434。新代码自动迁移到独立 checkpoint，没有手工填写或恢复历史 ACK。
- `15:57:14–15:59:14 UTC` 只读观察：新、旧文件均维持 CLI 身份 ACK 2434，CLI notifyBacklog 0，读取错误和回退均为 0。
- **该窗口未观察到旧 App 新写入**；只证明当前迁移与空积压保持，不能称为再次完成了真实 App 双写重放，也不能拿它与此前活跃双写窗口比较性能。双写兼容的直接证据来自临时目录中的真实双版本进程测试。
- 后续 `16:20–16:22 UTC` 已观察到一次自然新记录后的真实共存：新记录 sequence 2435 来自 recorder 0.2.49；旧文件换回 App 指纹、ACK 为 15（mtime 16:19:54），独立 CLI 文件仍是配置指纹、ACK 为 2435（mtime 16:14:20），CLI backlog 0。旧身份写入没有擦除 CLI 进度。新 daemon 仍为 0.2.50，用户 App 56135 仍在运行。
- 没有停止、重启、构建安装用户 App，也没有替换它的私有 CLI。没有启动真实 Provider 来制造验收事件；上述是实际自然写入，不代表所有 Provider / Profile 的完整验收。

## 队列、限制与后续 owner

- `15:49 UTC` 的 async callback queue 为 15,075 个任务；修复后的 `15:59 UTC` 快照为 14,692。已有任务保留，worker 继续处理；这个数量不是未上传记录数，也不据两点采样推算清空时间。
- 上传 outbox 待发 0，health healthy，enqueuedThrough 2434。三个历史上传死信仍保留，未重投或删除。不能说所有历史上传均已成功。
- 历史 callback 不 ACK 的退出原因仍未复现；新 CLI 保留有界失败分类，旧 App 的诊断能力没有随之升级。
- 已补到一次自然旧版本写入后的共存观察，用户无需为本次 CLI 安装重启 App。旧 App 自己的历史 backlog 仍按原有预算推进，不把 CLI backlog 0 表述成所有身份均已清空。其他 Provider / Profile 未追加真实探针。
- 全量测试不稳定和历史超限上传死信是后续独立事项；本次不扩大修复、删队列、放宽测试或 payload 上限。

本机证据位于 `/tmp/scry-cli-multirepo.AVEdj0/delivery-0.2.50/`：`deployment.json`、`default-cli-deployment.json`、`online-watch.json`、`live-coexistence.json`、`final-status.json`、两个游标的只读副本、`pack.json`、两个安装日志和原 tarball。实际旧版本兼容结果在 `../compatibility/coexist-result.json`；性能计数在 `../ack-counters/measure.json`。源分支仅本地提交，未推送；主 Scry 工作区的并行 WIP 没有合入本包。
