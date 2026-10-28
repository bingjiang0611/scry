# 命令与配置参考

本页说明容量管理、外部投递、退出码、排障、证据口径和更新配置。安装与日常命令见 [根 README](../README.md)。

## 容量与归档

`.scry/records/` 是 append-only 事实源:一轮一个 JSON,文件名带 20 位序号且必须连续。

| 轮次形态 | 大小 |
|---|---|
| 只有 prompt,无工具无 diff | 2.6 KB |
| 5 次 Edit + 5 文件 diff | 6.6–9.9 KB |

存储量取决于实际采集的原文和 diff，不能按 inline 预算估算总磁盘占用。默认 `full` 的单轮工具正文 inline 预算为 128 KiB（可配置到 1 MiB），但 `contentRef` 指向的完整正文不受此预览预算限制；diff patch 不再设置单文件或单轮容量上限，另有元数据、归档和恢复副本。显式 `summary` 仍只保存输出摘要，单次 input 超 8 KiB 会省略并标 `partial`。

可选的 `storage` 配置提供软 quota、retention 候选和孤立文件宽限期：

```json
{ "storage": { "maxBytes": 10737418240, "retentionDays": 90, "orphanGraceHours": 24 } }
```

`maxBytes` 不会通过丢弃引用中的证据强行达标；超过时 maintenance 退出 3 并报告 `overQuotaBytes`。`retentionDays` 只列出候选，仍由 `records archive` 执行可校验的连续前缀归档。孤立 blob/遗留 `.tmp` 必须超过宽限期才可回收。存在 open turn、未完成 archive journal、其他 recorder lock 或近期 temp 时 maintenance fail closed，`--apply` 也不删除。

> ⚠️ **不要手动删除单个 record 文件。** 序号空洞会被 `turns verify` 与 `doctor` 判为 store 损坏(退出 4),而不是"已清理"。

```bash
scry records maintain --workspace "$PWD"                     # 只打印 GC/quota/retention 计划
scry records maintain --apply --workspace "$PWD"             # 回收确认孤立的正文/temp，gzip 轮转日志
scry records archive --before 30d --workspace "$PWD"          # 只打印归档计划
scry records archive --before 30d --yes --workspace "$PWD"    # 执行
```

归档把**连续前缀**搬到 `.scry/archive/<cutoff>/`(可用 `--out` 指定),写出带 sha256 的 `manifest.json`,并把 floor 记进 `archive-state.json`。`--out` 不得与 live `.scry/records/` 重叠；归档和新 record 的序号分配使用同一把锁，避免并发复用序号。跨文件系统复制通过 `.scry/archive-journal.json` 先记账、同步目标文件后再删除 source；中断后用同一个 `--out` 重试会校验 hash 并继续，journal 未收敛前禁止分配新序号。首次执行时 archive target 必须为空，避免覆盖旧 manifest。只有被 floor 解释的空洞才被接受,新轮次从 `floor + 1` 继续编号。配置了 commit hook 时,归档拒绝搬走未 ACK 的记录(退出 5),提示先 `notify-drain`;确实要放弃投递才用 `--force`。

同一 recorder 进程内的 `turns list`、状态与投递 drain 会复用由 records 目录 stamp 校验的可丢弃索引；正式记录与 `archive-state.json` 仍是唯一事实源，`turns verify` 始终绕过索引全量校验。

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

`notifyBacklog` 如实显示积压。需要一次清空:

```bash
scry recorder notify-drain --workspace "$PWD"
```

投递语义是 **at-least-once**,去重键为 `(workspace, recordId)`。

## 退出码

| 命令 | 0 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| `status` | 在采集 | 未启用 / 无已配置 Provider | 已配置但未采到 | — | — |
| `doctor` | healthy | recorder 未启用 | 配置缺失或非法 | store 损坏 | degraded |
| `commit-hook status` | 已自动激活或未配置 | 不可用 | — | — | bundle 非法 |
| `records archive` | 完成 | 不可用 | 待确认 / 无候选 | — | 拒绝(未投递) |
| `turns show/timeline` | 找到 | — | — | store 损坏 | — |

`turns show/timeline` 未找到记录时输出 `{"found": false}` 并退出 1。

## 排障

```bash
scry support-bundle create --workspace "$PWD"           # 输出到 stdout
scry support-bundle create --out ./scry-support.json    # 写文件（0600）
```

只含:CLI/Node/平台版本、Provider 检测与配置状态、hook 事件计数与最近时间、配置指纹与生效 capture、health 与 store 计数、commit hook 激活与 ACK/backlog、脱敏后的最近日志。

不含:record 正文、文件路径列表、环境变量值、workspace 路径与 `workspaceId` 原文(只给哈希)、commit hook entry 内容。日志里的绝对路径替换为 `<workspace>` / `<home>`,产物自带 `omitted` 字段说明边界。

正常运行**不产生日志文件**;`.scry/logs/recorder.log` 只在出错时创建,单文件 1 MiB 轮转、保留一代。

## 证据口径

- 无调用记为 `available + []`;Provider 未暴露的记为 `unavailable`,**不会伪装成 0**。
- `普通工具` / `MCP` / `Skill` / `子 Agent` 四列互斥,总调用等于四列之和。
- Hook 同时报告"处理器实例"与"生命周期事件";文件同时报告结构化证据与 Bash 推断读取,并保留 quality/coverage —— 分母不同不可直接相比。
- Codex 顶层轮次会合并子 Agent rollout,但 token 与最终回复只取顶层权威值;子 rollout 缺失时相关字段降级 `partial`。Codex rollout 不含原生 Hook 事件,Hook 通常为 `unavailable`。
- Pi 的 assistant/tool payload 与 OpenCode 的 assistant payload 超过字节上限时会发送版本化 `scry_capture` 元数据；record 的对应 evidence 段标为 `partial/exact`，不会把截断内容冒充完整证据。OpenCode 未观测到 usage 时不再写 exact zero；升级后需运行 `scry integrations repair --yes` 更新存量插件。
- Codex 无服务端精确 latency,`response_intervals` 是观测区间,可能包含请求构造、调度、传输与重试。
- `modelTiming.cumulativeMs` 累计并行子 Agent 时间,`occupiedMs` 是所有模型区间的并集(用于与整轮墙钟比较)。旧记录缺该字段时保持 `unavailable`。
- `modelSegments` 与 `compactions` 在旧记录缺失时标 `unavailable`,不会误算成 0。
- Recorder 只保证**新生成**记录使用当前口径,不会重写历史记录。

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

`SCRY_NO_UPDATE_CHECK=1` 或 `--no-update-check` 关闭检查;`SCRY_CLI_REGISTRY` 覆盖 registry(必须 HTTPS)。App 内置 CLI、recorder、daemon 与 CI 不触发后台检查。

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
| `SCRY_CLI_REGISTRY` | 覆盖 npm registry(HTTPS) |
