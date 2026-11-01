# Scry uploader：公开脱敏审阅快照

> **仅供代码审阅，不是可安装、可发布或可接入真实服务的发行包。** 名称与地址已替换；不要连接占位服务，也不要发布此包。

本目录补充 [AI Trace / Scry CLI 对比](../../ai-trace-vs-scry-cli-20261030.md)。维护者授权修复 uploader 后，先修改并验证源任务分支，再同步生成此脱敏副本。

## 来源与覆盖

- 源版本：`0.2.5`；源任务分支 revision：`3e2ae9cd80041772bd5827c23f2a3c3bc59e783f`。
- 包含该 revision 的 **53 个 Git 跟踪文件**：源码、测试、合成 fixture、包元数据、锁文件、TypeScript 配置、上游说明及许可证。
- 源仓库只做本地提交，未推送其远端。公开仓库不包含源 Git 历史或私有名称映射。
- 保留 MIT 许可证及原有公开版权署名。
- 不包含 `node_modules`、`dist`、tarball、本机配置、真实 records、身份、凭据或数据库。
- `UPSTREAM-README.md` 是同步替换后的上游说明，不是本快照的部署手册。
- [SNAPSHOT.json](SNAPSHOT.json) 固定版本、验证范围及公开文件 SHA-256；清单不计算自身 hash。
- 先前 `0.2.0` / 27 文件 / 44 测试的审阅基线保留在 PR 历史中。本次不沿用旧单体文件的大小检查豁免。

## 本次修复

| 领域 | 行为与边界 | 阅读入口 |
| --- | --- | --- |
| 批次与坏记录 | 按最终参数 JSON 的 UTF-8 字节数限制 512 KiB；单条超限保留死信；确定性 400/413 拆批隔离 | `src/uploader-worker.ts`、`src/uploader-batch.ts` |
| 传输与预算 | timeout、429、网络/5xx 冷却并保留未知远端结果；共享 Retry-After；正常进度不消耗永久失败次数 | `src/retry.ts`、`src/admission.ts` |
| worker 与锁 | 唤醒合并、lost-wakeup 握手、竞争失败退出；每仓一个 worker、每用户最多两个上传配额；稳定 inode 内核租约 | `src/queue.ts`、`src/locks.ts` |
| 发现与游标 | 先发已托管数据，再做 export；仅隔离 pinned recorder 明确拒绝且身份可核对的记录；未知错误不盲跳 | `src/uploader-custody.ts`、`src/scry.ts` |
| 关闭与重新开启 | 持久关闭；重新开启以安全高水位为界，只允许新记录；历史逐条显式 release；丢失通知时仍尊重 recorder 的 opt-out | `src/uploader.ts`、`src/uploader-state.ts` |
| 多仓恢复 | 仅恢复显式登记路径；逐仓校验和错误隔离；保留退避与会话上下文，但不从旧队列恢复 executable、安装身份或状态目录 authority | `src/scheduler.ts`、`src/queue.ts` |
| 数据保留 | export 先接管 canonical 字节再推进游标；旧无 receipt outbox 先托管再发送；缺少 custody 禁止完成终态；legacy ACK 保留实际提交副本。只有 ACK 满 30 天的副本可清理，保留去重 receipt，不删除 canonical、held、未确认或死信正文 | `src/custody/receipts.ts`、`src/custody/index.ts` |
| 协议与身份 | 等待进程 close 并读取完整协议 stdout；认证文件原子替换使缓存失效；仓库身份保留 host/namespace，不带 URL 凭据、query 或 fragment | `src/util.ts`、`src/transport.ts` |

`0.2.3` 补齐原 P2 健康状态遗漏：同一 held receipt 不再因是否另有 outbox 副本而在 `healthy` / `held_disabled` 之间变化。状态依据 receipt，held 索引只在升级时扫描一次历史，后续读到首条 held 即停止，不读取 held 正文；索引清理在单记录锁内重验，保留并发状态变更。见 `src/custody/receipts.ts`、`src/uploader.ts` 和 `test/held-health.test.mjs`。

原审查对应：P0 的毒批次、worker 堆积；P1 的超时分类、预算续传、导出隔离、闲置仓恢复、跨仓限流；P2 的 stdout close、锁竞态/EPERM、保留与扫描成本、仓库身份、错误诊断、关闭/重开及 held 健康状态均有对应处理。关闭历史的行为遵循维护者后续决定：不自动补传，而非恢复全部积压。

第二轮审查补充（`0.2.4`）：

- 无法识别的失败（`success:false` 且无状态码）不再让整轮失败并原地卡死。它落到记录级重试状态，jitter 冷却递增；同批连续三次无法识别则拆批，拆到单条仍失败才进死信。旧实现运行新回归直接抛 `transport_reportAgentTurns`。
- 任务拆成两个计数器：`failures` 每次失败递增并驱动退避，`attempts` 只在真实失败时消耗。旧实现让所有可重试错误都不计 `attempts`，退避停在第一档、约每秒重试；`invalid_mcp_response` 由约 1 秒变为逐次翻倍（上限 60 秒）。
- 新增工作区级熔断：传输、协议与发现阶段失败累加 `transportFailures` 并写入 `transportCooldownUntilMs`；冷却期内新的 hook 唤醒不发请求，只按冷却时间重排。显式 `flush` 不受该冷却限制。旧实现断网时每次都拿新批次试探。
- 超时不再被误判成登录失败：只在明确 401/403 或未登录文案时包装登录提示；分类顺序改为结构化 code、HTTP 状态、超时码、网络码、文案。旧实现把 `whoami` 超时归为 `auth` 并停 15 分钟。
- `scheduler-install` 写文件后直接激活并校验：macOS `launchctl bootstrap gui/<uid>` 加 `print`，Linux `systemctl --user daemon-reload`、`enable --now scry-uploader.timer` 加 `is-active`；未激活即报错。`scheduler-status` 报告实际观测状态；Linux 未开 linger 时提示 `loginctl enable-linger`。`init` 不自动安装该服务。
- 锁 helper 改为按 `PATH` 查找并允许常见绝对路径回落，缺失时报明确错误并 fail closed；租约意外丢失时先在 `health.json` 记录 `lock_lease_lost` 再退出。
- 名额不足不再停住 worker：后台唤醒最多等 1 秒，拿不到就持久化延迟并退出，由队列按递增间隔重排；名额争用不算端点失败、不消耗永久失败预算。旧实现等待上限为整个运行预算，实测同一场景 4 次里有 3 次留下的 worker 进程超过 5 秒仍未收敛（回归 `R4 lost wakeup`）。显式 `flush` 是用户主动操作，会一直等到拿到名额或本轮预算用尽；`0.2.5` 起文档与该行为一致，不再声称 5 秒上限。
- README 增补发布注意：仓库身份改为 `host/namespace/repo` 后，服务端按 repo 聚合的历史统计会与旧数据分成两组，升级前需与服务端对齐或做旧名映射。下述外部验证限制仍成立。

第三轮审查补充（`0.2.5`）：

- 死信不再只看“同一批连续失败”。无法识别的失败（`success:false`、无状态码的“服务繁忙”）在整段故障期会把完好记录逐条送进死信：一次运行内就可以把 5 条拆成 3 条、2 条、1 条，绕过工作区熔断。现在记录级预算、拆批与死信都需要证据证明端点确实工作过——本轮上传成功过，或该记录首次失败之后本工作区有过真实 ACK；没有证据只累加工作区熔断、保持记录待发，并对另一半最多探测一次。旧实现在新回归 `R8` 下 5 条记录中 2 条被死信；修复后 0 条。
- 剩余预算不足 20 秒时不发起新的上报请求，直接按已完成部分返回并重新排队。旧实现带着 2 秒预算发出请求，被本地 deadline 杀掉后按 `report_timeout` 记在每条记录上，并把健康的服务判成熔断。
- 熔断只在真实 ACK（`inserted`/`duplicated`）时清零，`lastSuccessAt` 同样只在 ACK 时推进；某轮只是跳过仍在退避期的记录，不能算端点恢复。此前“没有端点失败”就清零，让一次空轮抹掉了断网证据。
- 本地 `permission denied`（EACCES）不再被当成登录失效而停 15 分钟：鉴权只认明确拒绝。
- 新增 `scry-upload redrive [--record-id <id>] [--reason <text>]`，把保留中的死信放回队列。回放前要求 payload 正是该记录自己的 custody 文件（拒绝 `..` 逃逸与其他记录），并在记录锁内用 custody receipt 重验状态、序号与摘要；legacy 保留副本用它自己的摘要校验。原元数据移入 `dead-letter/redriven/` 作为审计副本。

发现游标不是远端 ACK，也不是关闭权限边界。旧 `enqueuedThrough` 较大不能使未确认的 custody 消失。内核锁、持久状态和指纹检查也不构成安全沙箱。

## 脱敏改变了什么

| 类别 | 公开形式 |
| --- | --- |
| 包命名空间 | `@review/*` |
| 传输 CLI、文件、函数和环境键 | `transport`、`TRANSPORT_*`、`fake-transport.mjs` |
| 服务、方法和 Skill | `agent-trace-service`、`submitTurns`、`agent-trace-skill` |
| 身份协议 | `userId`、`actorUserId`、`subject_id`、`--sso` |
| 宿主集成 | `host-app`、`HOST_*`、`REMOTE_TRACE_*` |
| 安装脚本和 registry | `https://installer.invalid/...`、`https://registry.invalid/...` |
| 发布保护 | `package.json` 增加 `private: true` |

替换一致应用于 import、调用、测试、命令模板及包元数据；锁文件 integrity 保持不变。脱敏步骤不另改分支、限额、断言或失败语义。修复发生在源任务分支，而不是只修公开副本。

**源码公开脱敏不等于运行时数据脱敏。** `REDACTION_VERSION` 仍为 `none`。私有安装版可能托管并发送完整 record；本快照没有真实正文，不代表运行时会过滤敏感内容。

## 验证

- 环境：macOS arm64、Node `24.18.0`、recorder `0.2.53`。
- 原版与脱敏副本各自运行 `npm run check`：构建、**103/103 测试，0 skipped**、`npm pack --dry-run` 均通过。原版额外的 TypeScript unused 检查通过。
- 同步后逐文件核对冻结源 revision 的确定性替换结果；源码/测试不使用旧单体文件大小豁免。
- 关键回归：60 条记录首轮完成 35 条后保留进度；追加通知与 10 个并发唤醒；三个独立 CLI 的全局并发限制；坏 exporter/不可访问仓库隔离；完整 wire 大小；跨进程关闭与重复 enable；清理中断及重放；队列环境权限隔离。
- 四个独立破坏对照按预期失败：并发槽改为 3、恢复旧环境覆盖、移除旧关闭标记的 enable 保护、用 exit 代替 close。最后一个对照只取得 6 字节，而不是预期的 70,006 字节。
- 真实恢复发现 `0.2.1` 的 export 路径没有持久化 custody/ACK receipt。远端查询确认该记录已保存，未重发。`0.2.2` 修复此路径及旧无 receipt outbox、legacy 提交副本；原先静默完成终态改为明确拒绝。对应旧实现失败对照已复现，原文件保留断言未删除。
- 首轮失败保留记录：曾修正 cutoff、baseline、service 转义与 fixture 假设；升级后还有旧版本字符串/静默终态预期未同步、2 秒子进程 fixture 失败及外层命令超时。最终将独立测试文件串行化，未扩大单项超时，完整检查重新通过。验收脚本也修正了 commitHook 配置和持久锁文件的判断，不把这些脚本错误当产品成功。
- 追问逐项核对时复现 receipt-only held 被误标 `healthy`。旧实现运行新回归按预期失败；补修后的 3 项回归覆盖 outbox 有无、显式释放、旧索引迁移、不再扫描归档 receipt 及并发清理。本地初次交付漏掉此项，不能把之前 84 项通过称为原清单全部完成。
- 私有安装版 `0.2.5` 已部署：75 个 tarball 文件在主前缀与 nvm 前缀两处安装后逐字节一致（无缺失、无差异、无多余文件）。真实 launchd 服务保持 `loaded`；合成 hook 记录经真实 recorder 与真实传输提交，取得 `inserted` ACK，远端结构化内容与 canonical 记录一致，`uploaderVersion` 为 `scry-uploader/0.2.5`。`redrive` 在无死信的工作区返回空结果，在 2208 条真实死信的工作区带不存在的 `--record-id` 时为 no-op，死信数量不变；主工作区保持开启，历史高水位未变。`0.2.4` 及更早的部署证据保留为历史，不混入本轮计数。
- `0.2.5` 的三条新回归都做过破坏对照：把证据门与预算下限改回旧行为后，R8 重新死信 2 条、R3b 重新发出 1 个请求；把 `redrive` 换回旧实现后，逃逸路径与伪造摘要都被当成可回放。
- 私有安装版 `0.2.3` 已部署：72 个包文件与 tarball 一致，99 个 recorder 运行文件与测试依赖一致。真实 launchd 在无通知、无队列任务时恢复 **1 条新记录**，获得 `inserted` ACK；远端查询确认完整结构化内容一致。另 **1 条关闭期间记录**保留 held custody，远端查询不存在；没有 outbox 副本时健康状态仍正确为 `held_disabled`。6 条 canonical 原始字节未变，新记录 custody 字节一致；主工作区保持开启，升级未改变原高水位。此前 `0.2.2` 的两条关闭历史验证保留为历史证据，不混入本轮计数。
- 上述真实验收使用合成 hook 记录、真实 recorder 与真实传输，不是实际 Provider 会话验收。公开占位版未连接真实服务；不附部署路径、正文、身份、凭据或原始响应。

## 可运行性与未验证边界

- 测试使用临时 workspace/HOME、fake transport 和本地进程；不能证明所有真实网关错误、服务端大小限制或并发凭据刷新行为。
- macOS 内核锁和真实子进程已覆盖；Linux `flock`、systemd 实际运行尚未验收。服务定义的字符串检查不等于 Linux 部署成功。
- **公共读者不能直接 `npm ci` 复现。** `@review/scry-turn-recorder@0.2.53` 是占位名称。测试复用本机已获授权的同版本依赖，只在不提交的 `node_modules` 中建立别名；未发布该依赖或符号链接。
- 对比文章固定的 Scry CLI 为 `0.2.52`，此 uploader 使用 `0.2.53`；两者验证范围不同。
- 本目录仍在 `experiments` 排除范围，不进入 Scry App 的测试发现或发布依赖；本任务不构建、安装桌面 App。

审阅时请给出文件/行号、失败链路、测试覆盖及最小修复建议。不要把公开别名当真实端点，也不要为复核恢复私人正文或开启生产上传。
