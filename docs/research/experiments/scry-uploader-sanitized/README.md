# Scry uploader：公开脱敏审阅快照

> **仅供代码审阅，不是可安装、可发布或可接入真实服务的发行包。** 名称与地址已替换；不要连接占位服务，也不要发布此包。

本目录补充 [AI Trace / Scry CLI 对比](../../ai-trace-vs-scry-cli-20261030.md)。维护者授权修复 uploader 后，先修改并验证源任务分支，再同步生成此脱敏副本。

## 来源与覆盖

- 源版本：`0.2.8`；源任务分支 revision：`271ab07d8d34d664fd983d78df5a8c598e793075`。
- 包含该 revision 的 **64 个 Git 跟踪文件**：源码、测试、合成 fixture、包元数据、锁文件、TypeScript 配置、上游说明及许可证。
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
| 正文保管 | `recorder-content-v1` 引用先接管正文并写入 `contentSha256`；能力未声明时 fail closed，成功 ACK 必须回报精确摘要 | `src/content.ts`、`src/custody/receipts.ts`、`src/uploader-worker.ts` |

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

第四轮补充（`0.2.6`/`0.2.7`，用户复核发现的六个缺陷）：

- 从未记录过开关状态的工作区执行首次 `enable`，旧实现把它当成状态切换：写关闭策略、暂停已排队的 custody、把关闭高水位推高，pending 记录永久 `skipped_disabled`。现在首次开启只补字段，不暂停、不移动高水位；已经明确关闭过的记录仍保持 held，`enable` 不释放它们。
- 关闭期重放的提交通知之前会为已经 `uploaded` 或 `dead_letter` 的 receipt 追加一条 `skipped_disabled` 事件，与 receipt 自相矛盾。现在只有真正处于（或变成）held 的记录才写该事件。
- `init` 之前把 runtime launcher、`commitHook.entry` 和 doctor 检查写死为 `.scry/upload/runtime`，忽略配置的 `dataDir`；`dataDir` 指向新目录时非递归 `mkdir` 还会报 `ENOENT`。现在三者都从 `uploadRoot(workspace)` 推导，旧版本写入的 `.scry/upload/runtime/record-committed` 会在再次 `init` 时改指向。runtime 路径来自用户配置，因此以单引号变量传入 hook 脚本，不再拼进双引号命令字；`dataDir` 含 `$()` 或反引号时旧实现会真的执行（新回归在旧实现下创建了 `PWNED` 文件）。
- `withRecordLock` 之前遇到并发立刻抛通用错误，重复的 hook 通知直接丢失。现在有限等待（默认 15 秒、20–60ms jitter），超时抛带 `record_lock_busy` 的可重试错误；非竞争错误不吞。可选索引清理用零等待，读者不会被活跃写者拖住。
- 恢复测试 fixture 在 `existsSync` 与 `watch` 之间被删除 gate 文件时同步抛 `ENOENT` 崩溃；现在只有 `ENOENT` 视为已释放，其他错误照旧抛出，并以“gate 一直关闭时请求保持等待”作对照。
- 失败诊断的脱敏正则要求关键词后直接跟 `:` 或 `=`，因此 `Authorization: Bearer abc123` 只替换了方案名，`abc123` 仍留在消息里；JSON 形式的 `"token":"abc"` 完全不匹配。现在统一为 `redactDiagnostic`：接受带引号的键与分隔符，保留 `Bearer`/`Basic`/`Digest` 方案名后再替换密钥，覆盖 `cookie`/`password`/`passwd`/`api-key`，仍限制 512 字符；原先 `src/transport.ts` 与 `src/scry.ts` 两处副本合并到 `src/util.ts`。新回归在旧正则下 `abc123` 与 `"abc"` 都会留在输出中。
- 同轮收紧三条新回归自身的有效性：`Promise.withResolvers` 是 Node 22+ API，而包声明支持 Node ≥20，改为本地 deferred；held-gate 测试不再用固定 400ms 判断“仍在等待”，由 fixture 在真正驻留前先写 `gate-wait` 信号，并对子进程退出加 30 秒上限；hook 断言改为比较调用前后的任务 `generation` 并要求 hook 退出码为 0——`init` 自己就会排队一个 recovery wakeup，且 wrapper 用 `|| true`，旧的“存在 wakeup 任务”断言在 hook 根本没调用时也会通过（移除该调用的对照现在会以 `bounded wait expired` 失败）。


第五轮补充（`0.2.8`）：并入经校验的正文保管

- 新记录不再只有 canonical JSON：`recorder-content-v1` 引用指向 recorder 的 CAS 正文（diff patch、被截断的工具输出）。`0.2.7` 及更早实现把引用原样上传，远端拿到的是一个指向从未上传过的正文的引用——记录结构完整，正文永久缺失，而且两端都不会报错。现在发送前先接管正文并写入 receipt 的 `contentSha256`，`queryAgentTurnUploadCapabilities` 确认接收端声明同名协议后才发送；成功 item 必须回报精确的 `contentSha256` 才能标记 uploaded，缺失、损坏或尺寸不符一律保持 pending。
- 接收端未提供该能力时 **fail closed**：整轮不发送，记录保持 pending，不降级成“只传预览”。正文最多 512 个唯一 blob、解码信封最多 16 MiB、编码后单条最多 9 MiB；超限明确阻断，不截断后冒充完整。
- 传输阶段失败的消息之前只有 `contentCapabilities failed (Error)`，看不出是能力缺失、鉴权还是网络故障。现在附加脱敏后的原因文本（上限 200 字符），`stage`/`statusCode`/`exitCode`/`stderr` 等结构化字段不变。
- 合并时按语义解冲突：一个 `callUploadTool` 同时承载结构化失败字段与脱敏诊断；custody 侧保留 receipt/held 索引与终态守卫，并接上正文接管；worker 在分支移出的循环里用**实际发送的 wire 字节**做能力探测与正文 ACK 校验。
- 一条既有回归断言“丢失响应会抛错”。未知结果现在落到记录级冷却而不是整轮失败，因此该回归改为等待 receipt 记录的冷却截止时间，再断言重放字节完全一致。

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
- 更早轮次（`0.2.1`–`0.2.6`）的验证记录移到 [HISTORY.md](HISTORY.md)，不再混入当前版本结论。
- 原版与脱敏副本各自运行 `npm run check`：构建、**128/128 测试，0 skipped**、`npm pack --dry-run` 均通过。原版额外的 TypeScript unused 检查通过。
- 同步后逐文件核对冻结源 revision 的确定性替换结果；源码/测试不使用旧单体文件大小豁免。合并把 `test/reliability.test.mjs` 推到 24 KB 后按主题拆成三个文件并抽出共享 fixture（`test/fixtures/reliability-helpers.mjs`），只移动 import，断言未改。
- 私有安装版 `0.2.7` 已部署：tarball 共 75 个文件，其中 74 个与两处全局前缀逐字节一致（`package.json` 只核对版本号），无缺失、无差异、无多余文件。真实 launchd 服务保持 `loaded`；合成 hook 记录经真实 recorder 与真实传输提交，取得 `inserted` ACK，远端结构化内容与 canonical 记录一致，`uploaderVersion` 为 `scry-uploader/0.2.7`。（事后核对：该记录含 1 个 `recorder-content-v1` 引用，`0.2.7` 并未上传对应正文，即“远端结构化内容一致”成立于记录层，正文实际缺失；这是 `0.2.8` 修正的问题。）`redrive` 在无死信的工作区返回空结果，在 2210 条真实死信的工作区带不存在的 `--record-id` 时为 no-op，死信数量不变；主工作区保持开启，历史高水位未变。`0.2.6` 及更早的部署证据保留为历史，不混入本轮计数。
- 私有安装版 `0.2.8` 已部署：tarball 共 78 个文件，其中 77 个与两处全局前缀逐字节一致（`package.json` 只核对版本号），无缺失、无差异、无多余文件。真实 launchd 服务保持 `loaded`；合成 hook 记录经真实 recorder 与真实传输提交，取得 `inserted` ACK，`uploaderVersion` 为 `scry-uploader/0.2.8`，远端结构化内容与 canonical 记录一致；该记录**不含正文引用**，走的是旧格式路径。另建一条带 diff patch 的记录（1 个引用、正文 215 字节）验证新路径：接收端尚未声明正文协议，上传按设计 fail closed——receipt 保持 `pending` 且带 `contentSha256`，远端查询该会话不存在，运行以非零退出并给出 `unknown tool` 原因，没有死信、没有截断上传。因此“带正文档的记录端到端送达”在本版本**尚未验证**，取决于接收端补齐能力；主工作区仍开启，2210 条真实死信与历史高水位不变。
- 上述部署与远端结论（`inserted` ACK、远端查询一致、死信数量等）均为**维护者在私有环境中自报的验收结果，本仓库没有留存可复核的证据**。验收使用合成 hook 记录、真实 recorder 与真实传输，不是实际 Provider 会话验收。公开占位版未连接真实服务；不附部署路径、正文、身份、凭据或原始响应。

## 可运行性与未验证边界

- 测试使用临时 workspace/HOME、fake transport 和本地进程；不能证明所有真实网关错误、服务端大小限制或并发凭据刷新行为。
- macOS 内核锁和真实子进程已覆盖；Linux `flock`、systemd 实际运行尚未验收。服务定义的字符串检查不等于 Linux 部署成功。
- **公共读者不能直接 `npm ci` 复现。** `@review/scry-turn-recorder@0.2.53` 是占位名称。测试复用本机已获授权的同版本依赖，只在不提交的 `node_modules` 中建立别名；未发布该依赖或符号链接。
- 对比文章固定的 Scry CLI 为 `0.2.52`，此 uploader 使用 `0.2.53`；两者验证范围不同。
- 本目录仍在 `experiments` 排除范围，不进入 Scry App 的测试发现或发布依赖；本任务不构建、安装桌面 App。

审阅时请给出文件/行号、失败链路、测试覆盖及最小修复建议。不要把公开别名当真实端点，也不要为复核恢复私人正文或开启生产上传。
