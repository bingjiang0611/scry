# Commit hook、managed 模式与更新

[返回 CLI README](../README.md)

## commit hook:唤醒外部 uploader

需要在 record 落盘后唤醒外部程序时,在 `scry.config.json` 声明 workspace 相对的 `entry` 与完整 `files` 清单。record 持久化且 runtime 清理后,recorder 以 stdin 发送只含 `workspace/provider/sessionId/recordId/sequence` 的 JSON,**仅在回调 exit 0 后**推进 durable ACK;失败或超时会在下次 hook/recovery 重试。

有效的仓库 commit hook bundle 默认自动授权，不显示确认提示；以下命令可查看、刷新或删除授权（`--yes` 为旧脚本兼容参数，不再是必需项）：

```bash
scry commit-hook trust --workspace "$PWD"
scry commit-hook status --workspace "$PWD"
scry commit-hook revoke --workspace "$PWD"
```

授权记录写在仓库之外(默认 `~/.scry/grants/<workspace-hash>.json`,`0600`,可用 `SCRY_GRANT_DIR` 覆盖)，并标记 `source=auto`。每次投递前重新校验 entry 与全部 `files` 的内容指纹；有效 bundle 发生变化时自动更新授权，bundle 非法或路径越界仍 fail closed。`revoke` 只删除当前记录，下次解析有效配置时会重新自动授权。运行中的旧 daemon 需要 `scry recorder restart` 才能加载新代码。

被授权的 entry 以你的权限运行,并能读取全部 record 正文 —— **授权是执行授权,不是脱敏机制**。采集正文默认不脱敏；团队汇总方案需要自行决定上报原文的范围、权限与脱敏，或仅上报 `turns summary` 聚合。

**daemon 在响应 Provider 之后才投递**,所以回调耗时不占 hook 预算。没有 daemon 时(`SCRY_RECORDER_TRANSPORT=direct` 或冷启动)只能同步投递,此时每个事件最多 8 条、预算 1.5s(单条仍以 10s 熔断),剩余保持 pending。实测回调 350ms/条、积压 6 条时:同步 1688ms/事件,移出后 500ms/事件。

`notifyBacklog` 显示当前已激活 hook 身份的积压，不是所有身份的合计，也不是上传 outbox 的待发数。归档检查仍针对当前命令解析出的 hook 身份，不代表其他 host 身份已经接收；并存使用时，应分别确认各接收方已处理需要保留的记录后再归档。需要清空当前身份的通知积压:

```bash
scry recorder notify-drain --workspace "$PWD"
```

投递语义是 **at-least-once**,去重键为 `(workspace, recordId)`。

### 每轮上传环境

开始事件把上传 allowlist 快照进 private `open.json`；inbox 重放和 managed 两阶段提交也保留这份快照。record 发布前，先原子写入并 fsync `<dataRoot>/record-environments/<recordId>.json`（0600）。快照包含 `SCRY_TURN_UPLOAD_ENABLED`、`SCRY_INSTALLATION_ID`、`SCRY_INSTALLATION_ID_FILE`、`RATE_NATIVE_ASYNC_QUEUE_DIR`、`TMCP_TRACE_URL`，以及当前 allowlist 的 `SCRY_UPLOAD_DEADLINE_SECONDS`、`SCRY_UPLOAD_LOCK_WAIT_SECONDS`、`SCRY_MANAGED_UPLOAD_WAIT_SECONDS`。未设置与空字符串分开保存；投递和显式重投都使用开始时的值，而不是 Stop/recovery/daemon 的值。

这些值可能敏感，不进入 record 正文、record export 或 support bundle；旁路文件不加密，勿原样分享。旁路按 recordId 保留，当前不会随归档自动删除。升级前的 record/open turn 没有快照，无法重建原会话环境，继续采用旧的投递进程环境；不要将其解释成已验证的逐轮快照。执行路径、trust 指纹及非上传环境不从旁路恢复。

daemon hook 协议升为 2。shell 仅用内建 `printf` 发送 NUL 分隔环境和原始 Provider JSON，不增加编码器进程；会话的 `SCRY_RECORDER_ENABLED=0` 也传到 daemon。旧协议被拒绝后走现有持久化 fallback，不会按 daemon 环境假装处理成功。升级后须 `scry integrations repair --yes` 更新脚本，并 `scry recorder restart` 重启该 workspace 的 daemon。

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
