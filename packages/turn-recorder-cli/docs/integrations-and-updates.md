# Commit hook、managed 模式与更新

[返回 CLI README](../README.md)

## commit hook:唤醒外部 uploader

需要在 record 落盘后唤醒外部程序时,在 `scry.config.json` 声明 workspace 相对的 `entry` 与完整 `files` 清单。record 持久化且 runtime 清理后,recorder 以 stdin 发送 `schemaVersion: 2` 的 `record-committed` JSON。旧的 `workspace/provider/sessionId/recordId/sequence` 字段含义不变，新增 `recordPath`（相对 dataRoot，如 `records/00000000000000000001-<recordId>.json`）和 `sha256`（该文件原始字节的 64 位小写十六进制 SHA-256）。通知不含正文或环境值；自定义 dataDir 时也必须相对 dataRoot 解析路径，不能直接相对 workspace。drain 与显式 redelivery 都使用同一合同。

**ACK 合同：hook exit 0 表示接收方已接管完整记录**，而不是只排入一份 recordId 通知任务。接收方须先读取并按 sha256 校验、原子持久化完整副本，再返回 0；失败返回非 0。recorder 只观察退出码，无法证明外部 uploader 遵守此合同。旧接收方必须升级支持 schema 2；部署方完成 uploader U1 以前，不可把既有 ACK 当作正文已接管或已上传。只有回调 exit 0 才能作为 ACK；连续 ACK 边界不会越过死信。失败或超时会在下次 hook/recovery 重试，达到下述上限后隔离。

有效的仓库 commit hook bundle 默认自动授权，不显示确认提示；以下命令可查看、刷新或删除授权（`--yes` 为旧脚本兼容参数，不再是必需项）：

```bash
scry commit-hook trust --workspace "$PWD"
scry commit-hook status --workspace "$PWD"
scry commit-hook revoke --workspace "$PWD"
```

授权记录写在仓库之外(默认 `~/.scry/grants/<workspace-hash>.json`,`0600`,可用 `SCRY_GRANT_DIR` 覆盖)，并标记 `source=auto`。每次投递前重新校验 entry 与全部 `files` 的内容指纹；有效 bundle 发生变化时自动更新授权，bundle 非法或路径越界仍 fail closed。`revoke` 只删除当前记录，下次解析有效配置时会重新自动授权。运行中的旧 daemon 需要 `scry recorder restart` 才能加载新代码。

被授权的 entry 以你的权限运行,并能读取全部 record 正文 —— **授权是执行授权,不是脱敏机制**。采集正文默认不脱敏；团队汇总方案需要自行决定上报原文的范围、权限与脱敏，或仅上报 `turns summary` 聚合。

**daemon 在响应 Provider 之后才投递**,所以回调耗时不占 hook 预算。没有 daemon 时(`SCRY_RECORDER_TRANSPORT=direct` 或冷启动)只能同步投递,此时每个事件最多 8 条、预算 1.5s(单条仍以 10s 熔断),剩余保持 pending。实测回调 350ms/条、积压 6 条时:同步 1688ms/事件,移出后 500ms/事件。

`notifyBacklog` 显示当前已激活 hook 身份尚待自动处理的通知数，排除已处理通知与死信；不是所有身份的合计，也不是上传 outbox 的待发数。归档检查仍针对当前命令解析出的 hook 身份，不代表其他 host 身份已经接收；并存使用时，应分别确认各接收方已处理需要保留的记录后再归档。需要清空当前身份的通知积压:

```bash
scry recorder notify-drain --workspace "$PWD"
```

投递语义是 **at-least-once**,去重键为 `(workspace, recordId)`。

### 失败次数与 recorder 死信

drain 按 `(hook fingerprint, sequence)` 持久化次数和最后失败时间。连续失败后的等待间隔为 **1、5、15、60 分钟**；首次失败后的四次重试合计至少 81 分钟，第 **5** 次失败才隔离。重复快速 drain 不增加次数。等待期间跳过该项、继续后续记录，不忙等、不额外启动定时进程。到期时间是最早允许时间，不承诺准点执行；由下一次 hook/recover/notify-drain 触发。hook 路径仍最多调用 8 次、预算 1.5s；每次 callback 的 10 秒熔断不变。全局执行配置、trust 或锁失败不计入单条次数；正文/环境旁路不可读及 callback 非 ACK 按该条计数。

检查点位于 `<dataRoot>/notifications/commit-hooks/<fingerprint-hash>.json`。逐 sequence 的失败、重放请求和缺口之后的成功凭据在 `notifications/delivery-outcomes/<fingerprint-hash>/`；死信在 `notifications/dead-letters/<fingerprint-hash>/<sequence>-<recordId>.json`。元数据不复制正文、env 或 stderr。canonical record 与上传环境旁路不因隔离而删除。计数/凭据损坏时 unavailable，不清零、不把缺失的成功凭据当作 ACK。

`processedThrough` 是已遍历位置，包含退避和死信，**不是 ACK**。`ackedThrough` 只沿连续成功证据前进；重试项或死信之前的 ACK 缺口会阻止普通归档。后续成功保留独立凭据，前面的重放成功后才能补齐 ACK。`notifyBacklog` 包含退避项、不含死信。`notify-drain` 有待重试项时退出 3；退出 0 仅表示自动队列为空，不能证明没有死信。`doctor` 报出次数和 `nextRetryAt`：退避 warn、死信 fail、证据不可读 fail，均退出 5。重试详情最多显示最前 20 项、死信详情最多显示最新 20 项；内部遍历逐条读取，不将全部正文放进诊断输出。

修复原因后，明确选择单条或全部当前身份的死信：

```bash
scry recorder notify-retry --sequence 42 --workspace "$PWD"
scry recorder notify-retry --all-dead --workspace "$PWD"
```

命令先验证配置与 trust，再将原死信诊断保存到 `notifications/dead-letter-history/<fingerprint-hash>/`，持久化重放请求后移出当前死信、清零计数并正常 drain。原始 record 与原会话环境仍复用。中断后，已持久化的单条请求由 drain 恢复；尚未持久化的条目仍是死信，需查看状态再明确选择，不猜测整批是否完成。若再次失败，从第 1 次和 1 分钟间隔重新开始；没有真实成功就不推进 ACK。指定的 sequence 必须是当前身份的活动死信。`--all-dead` 无活动死信时不制造重放；命令也可处理其他已到期的普通积压，但不会提前执行仍在退避的项。不要编辑 ACK 或删除队列元数据来绕过保护。

冷启动的“最新记录唤醒”跳过已有重试/死信；尚未 ACK 的最新记录首次失败也进入同一退避状态。已经 ACK 的唤醒不倒退 ACK，不能代替外部 uploader 的 outbox 重试。指纹变化仍是独立身份：新身份按既有规则重投全部仍保留记录，旧身份的死信不被悄悄清除；`notify-retry` 不跨身份操作。稳定 `commitHook.id` 未引入，trust/内容指纹校验不变。

旧 E 检查点在投递锁内迁移，已有次数和死信保留，不伪造历史等待间隔。旧的 5 次失败/死信需用上述命令显式重放。升级时重启对应 workspace 的 daemon；不要让旧 CLI/daemon 与新队列格式并发运行或降级写入。`delivery-outcomes` 的成功凭据和死信历史目前不会自动回收；有大量历史缺口时目录扫描会增加，需评估增量索引/分段回收，而不是删除未 ACK 的证据。

### 每轮上传环境

开始事件把上传 allowlist 快照进 private `open.json`；inbox 重放和 managed 两阶段提交也保留这份快照。record 发布前，先原子写入并 fsync `<dataRoot>/record-environments/<recordId>.json`（0600）。快照包含 `SCRY_TURN_UPLOAD_ENABLED`、`SCRY_INSTALLATION_ID`、`SCRY_INSTALLATION_ID_FILE`、`RATE_NATIVE_ASYNC_QUEUE_DIR`、`TMCP_TRACE_URL`，以及当前 allowlist 的 `SCRY_UPLOAD_DEADLINE_SECONDS`、`SCRY_UPLOAD_LOCK_WAIT_SECONDS`、`SCRY_MANAGED_UPLOAD_WAIT_SECONDS`。未设置与空字符串分开保存；投递和显式重投都使用开始时的值，而不是 Stop/recovery/daemon 的值。

这些值可能敏感，不进入 record 正文、record export 或 support bundle；旁路文件不加密，勿原样分享。旁路按 recordId 保留，当前不会随归档自动删除。升级前的 record/open turn 没有快照，无法重建原会话环境，继续采用旧的投递进程环境；不要将其解释成已验证的逐轮快照。执行路径、trust 指纹及非上传环境不从旁路恢复。

daemon hook 协议升为 2。shell 仅用内建 `printf` 发送 NUL 分隔环境和原始 Provider JSON，不增加编码器进程；会话的 `SCRY_RECORDER_ENABLED=0` 也传到 daemon。curl rc=0 且 HTTP 4xx 表示 apply 前拒绝，清除内部尝试标记，让 CLI 用自己的协议重试或直写；连接失败同样处理。超时、断连或 5xx 保留结果未知标记，走持久化 fallback，不假定未送达。升级后须 `scry integrations repair --yes` 更新脚本，并 `scry recorder restart` 重启该 workspace 的 daemon。

## managed 模式与更新

Scry App 启动 Provider 时设置 `SCRY_RECORDER_MANAGED=1`:此时 lifecycle hook 只建立轮次身份,App 在 result、Hook 与 diff 全部收齐后两阶段提交 canonical evidence;managed turn 禁止回退到 rollout 近似重建。

若 Provider 启动器会改写 `PATH`,应先解析 `scry` 绝对路径并通过 `SCRY_CLI_PATH` 传入;该变量存在时 hook 只执行指定路径,路径失效则 fail-open 跳过本次记录,不回退到改写后的 `PATH`。

升级只换 CLI,**不会改动 workspace 里的 hook 脚本** —— `.scry/provider-hook.sh` 由 `scry init` / `integrations repair` 写入,升级后仍是旧版本内容,采集不会出错但拿不到新版本的加速。`doctor` 会明说:

```json
{ "hookScript": "outdated",
  "checks": [{ "id": "hook.script", "status": "warn",
               "detail": "managed hook script was written by an older CLI",
               "remediation": "run `scry integrations repair --yes`" }] }
```

`hookScript` 四种取值:`current`(与本 CLI 一致)、`outdated`(受管但由旧版本写入)、`unmanaged`(团队自建桥接,Scry 不碰)、`absent`。只有 `outdated` 报 `warn`,且**不改变退出码** —— 旧脚本仍在正确采集。

```bash
scry integrations repair --yes    # 重写受管脚本与 Provider 配置条目
```

独立安装**默认自动更新**:同一个 major 内的新版本会被直接安装(包括跨 minor),装完在下一次命令开头提示一次 `Scry CLI 已自动更新:X → Y(关闭:SCRY_AUTO_UPDATE=0)` —— 默认开意味着没人显式同意过,所以证明它确实装了的这一行同时给出关闭方法。检查至多每天一次,失败后 6 小时再试,安装禁用 package lifecycle scripts。

关闭:

```bash
export SCRY_AUTO_UPDATE=0     # 或 SCRY_NO_UPDATE_CHECK=1（连检查一起关）
```

**这个默认值的代价要写明**:发布出去的版本会在无人值守的情况下,装到运行着 Agent 的机器上,并以本机用户权限运行。选择它是因为 opt-in 只能触达"已经知道这个开关存在"的人 —— 其他人会永久停留在初次安装的版本。约束仍在:永不跨 major、永不从 Provider hook 事件触发、host 钉版本(`SCRY_CLI_BUNDLED`/`SCRY_RECORDER_MANAGED`)时不更新、`CI` 下不更新。需要严格版本控制的团队应显式关闭并自行分发。

两个触发点,同一套 env 门(`SCRY_CLI_BUNDLED`、`SCRY_RECORDER_MANAGED`、`SCRY_NO_UPDATE_CHECK`、`CI` 任一开启都不触发):

| 触发点 | 时机 | 覆盖的机器 |
|---|---|---|
| 交互式命令 | 你在终端跑 `scry <命令>` 结束时(需 stderr 是 TTY) | 有人手动用 CLI 的机器 |
| **recorder daemon** | daemon 因空闲而决定退出时 | **只跑 Agent、没人敲 `scry` 的机器** |

**Provider 的 hook 事件永远不触发更新**。两个原因:走 curl 快路径时 hook 里根本不启动 Node,加触发点等于把一次进程启动(实测 79ms)加回最热的路径;而且一轮有 5 类事件、跨度几分钟,在事件之间换掉 CLI 会让同一轮跨两个版本(managed 模式下直接 exit 86)。

daemon 的时机是**它已经决定要退出**之后 —— 进程本来就要结束,换 CLI 不额外花钱,也不可能切断轮次:有 open 轮次时 daemon 根本不会进入退出路径。更新的每一步都有硬超时(查询 8s、安装 120s、校验 8s),失败就放弃,下个空闲窗口再试。装上后 daemon 立即退出,下一个事件启动的就是新版本;daemon.log 会记一行 `idle update installed X -> Y`。

**待投递的轮次不阻止更新** —— 记录本身是持久且带版本的,新版本恢复旧 open 轮次是既有支持路径,`doctor` 也会报版本漂移;反过来若要求"零 pending 才更新",恰恰会在最容易积压的 workspace 上永久关掉更新。

跨 major(如 `0.x → 1.0.0`)永远不自动安装,只报告可用 —— **破坏性变更靠升 major 表达**,不再用 0.x 的 minor 当边界。

```bash
scry upgrade --check    # 只检查
scry upgrade            # 前台升级到 registry latest（不受 major 边界限制）
```

真正容易踩的坑不是"没自动升",而是**同一台机器有多份安装**:hook 通过 `SCRY_CLI_PATH` 或 `.scry/cli-path` 固定用某一份,而你在 shell 里 `scry upgrade` 升的是 `PATH` 里的另一份。`doctor` 会直接指出来:

```json
{ "recorderVersions": { "thisCli": "0.2.42", "lastRecord": "0.2.30" } }
```

对应的 `recorder.version` 检查在两者不一致时报 `warn`(不改变退出码 —— 刚升级完还没记新轮次时本来就会不一致)。看到它就去确认 hook 用的是哪一份,并升级那一份。

`SCRY_NO_UPDATE_CHECK=1` 或 `--no-update-check` 关闭检查;`SCRY_CLI_REGISTRY` 覆盖 registry(必须 HTTPS),未设置时用本机 npm 配置。App 内置 CLI、recorder、daemon 与 CI 不触发后台检查。

## 环境变量

| 变量 | 作用 |
|---|---|
| `SCRY_RECORDER_ENABLED=0` | 停止新增记录 |
| `SCRY_RECORDER_TRANSPORT=direct` | 不使用 daemon,每事件自己落盘 |
| `SCRY_RECORDER_SOCKET` | 覆盖 daemon socket 路径 |
| `SCRY_RECORDER_IDLE_MS` | daemon 空闲退出窗口(默认 30 分钟) |
| `SCRY_CLI_PATH` | hook 必须使用的 CLI 绝对路径 |
| `SCRY_GRANT_DIR` | commit hook 授权记录目录 |
| `SCRY_AUTO_UPDATE` | 未设置即开启;`0`/`false`/`no` 关闭自动安装 |
| `SCRY_NO_UPDATE_CHECK=1` | 连更新检查一起关闭 |
| `SCRY_CLI_REGISTRY` | 覆盖 npm registry(HTTPS);未设置时用本机 npm 配置 |
