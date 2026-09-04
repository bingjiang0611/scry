# scry-turn-recorder

Scry 的独立本地轮次记录 CLI。Provider 的生命周期 hook 调用它,把每个顶层用户轮次写成 `.scry/` 下的一个 JSON 文件。

- **不上传任何数据**,不依赖 Electron 或原生模块。
- **不是沙箱**:它记录发生了什么,不限制 Agent 能做什么。
- 支持 Node 20 / 22 / 24,macOS 与 Linux。Windows 不在支持范围。

## 安装与接入

```bash
npm install -g scry-turn-recorder@0.2.32 \
  --registry=https://registry.npmjs.org

cd /path/to/project      # 必须是 Git 仓库根目录
scry init                # 自动检测 claude / codex / qoder / opencode
```

`init` 创建 `scry.config.json` 与 `.scry/provider-hook.sh`,并把 hook 合并进各 Provider 的项目配置;已有 hook 会保留,重复执行不会重复添加。可用 `--providers claude,codex` 明确指定。Pi 是用户级扩展,另外执行 `scry integrations install-pi`。

接入后必须做两件事,CLI 无法代替:

1. **重启 Provider**,否则新 hook 不会加载。
2. **Codex 还要在项目里执行 `/hooks` 并信任项目 Hook。**

然后跑一轮真实任务来验证 —— `init` 的自检只能证明配置和本地存储可用:

```bash
scry status --workspace "$PWD"    # 退出 0 表示确实采到了
```

等待采集就绪的写法(`status` 退出码:0 在采集 / 2 未启用 / 3 已配置但未采到):

```bash
i=0; until scry status >/dev/null 2>&1; do i=$((i+1)); [ "$i" -ge 30 ] && break; sleep 2; done
```

`init` 只开启本地记录,不安装任何 uploader、审计或业务 Hook。

停止新增记录:创建 `.scry-disabled` 或设置 `SCRY_RECORDER_ENABLED=0`;已有数据仍可只读查询。彻底卸载用 `scry integrations uninstall --yes`。

## 日常命令

| 命令 | 用途 |
|---|---|
| `scry status` | 逐 Provider 六阶段:是否在采集、卡在哪一环 |
| `scry doctor` | store 完整性、health 计数、孤儿轮次、生效的采集配置 |
| `scry turns list` | 轮次列表(含 `modelTiming`、compaction 计数) |
| `scry turns show <序号\|recordId>` | 单轮完整记录 |
| `scry turns timeline <序号\|recordId>` | 模型文字与 Tool / Skill / MCP / 子 Agent 交错时间线 |
| `scry turns summary [sessionId\|--all]` | 会话或整个 workspace 的聚合 |
| `scry turns export --after 0 --limit 100` | 游标分页导出 |
| `scry turns verify` | 序号连续性与记录完整性 |
| `scry records archive --before 30d` | 归档旧记录(见「容量与归档」) |
| `scry support-bundle create` | 脱敏排障包 |
| `scry recorder status\|stop\|restart\|recover\|notify-drain` | daemon 与恢复 |
| `scry integrations diff\|repair\|uninstall` | 托管 hook 的漂移检查与修复 |
| `scry upgrade [--check]` | 升级 CLI |

所有命令都接受 `--workspace <root>` 或 `--workspace=<root>`,输出为 JSON。未知参数直接报错。

`status` 的三个阶段不可互相代替:`configured` 只证明配置写入,`hookSeen` 证明 hook 真的到达 recorder,`recordSeen` 才证明轮次已提交。`trusted` 永远是 `unknown` —— Codex 需要交互式确认,其余 Provider 不向 CLI 暴露信任状态;写 `n/a` 等于声称"不需要信任"。

`openTurnsPending`(未收敛的 open turn)与 `notifyBacklog`(commit hook 未 ACK 数)是两个不同指标,不要混用。

Agent、skill 与提示词不应主动调用这些命令。

## 采集什么

默认全开,每项都可在 `scry.config.json` 里关闭:

```json
{
  "capture": {
    "prompt": true,
    "assistant": true,
    "toolOutput": "summary",
    "diff": true,
    "hooks": true,
    "patchExcludeBasenames": []
  }
}
```

`scry doctor` 输出的 `capture` 是解析后的生效值,包含配置里省略的默认值。

关闭某项后对应证据段记为 `disabled` 并带 `omissionReason: ... disabled by config`,与 Provider 不支持的 `unavailable`、以及"真的没发生"的空数组是三个不同状态 —— 记录自己就能解释当时采了什么。

> ⚠️ **关闭正文不等于脱敏。** 即使 `prompt`、`assistant` 关闭且 `toolOutput: "none"`,以下内容仍会落盘:**工具入参**(Bash 命令原文、Edit 的 old/new 字符串)、**文件路径**、**diff patch**(除非 `diff: false`)。当前没有单独关闭工具入参的开关。要求本地不留代码与命令的场景,应设 `diff: false` 并评估工具入参是否可接受,或者干脆不在该仓库启用。

## 未结束的轮次

一轮从 `UserPromptSubmit` 开始、`Stop` 结束。Provider 被 `kill -9`、崩溃或终端被直接关闭时,结束事件永远不会到,这一轮会停在 `.scry/runtime/`。

**同时满足**「超过 24 小时」与「transcript 已停止增长」的轮次判定为不可能再收敛,由 `scry recorder recover`(daemon 空闲时自动跑)收敛为 `interrupted`。两个判据都必需:只看年龄会把跑了 30 小时的长任务误判为中断,而长任务会持续追加 transcript。

```bash
scry doctor            # 退出 5，turns.stale 报出数量与最久时长
scry recorder recover  # {"recovered":1,"pending":0,"expired":1}
```

收敛后的记录:`status` 为 `interrupted`,已观测的证据段降级 `partial` 并说明原因,未观测的段保持 `unavailable`。`diff` 段固定 `unavailable` —— 基线可能是几天前的,发布它等于把之后所有改动(包括别的轮次的工作)算到这一轮头上。

孤儿轮次也是 daemon 长期不退出的原因(有活干时不退场),收敛后它才会正常空闲退出。窗口可用 `SCRY_OPEN_TURN_EXPIRY_MS` 收紧,主要供测试。

## 性能与资源

hook 在 Provider 每个生命周期事件上同步执行,所以这条路径的成本直接决定你是否感觉到卡顿。daemon 已运行时,hook 脚本用 `curl --unix-socket` 直投,省掉每事件一次 Node 启动;daemon 不在、`curl` 缺失、`SCRY_RECORDER_TRANSPORT=direct` 或 HTTP 状态码非 200 时自动回退到 CLI —— stdin 会先读进变量再投递,保证回退能重发,不丢事件。

实测(macOS):

| 场景 | 快路径 | 回退到 CLI |
|---|---|---|
| 单个工具事件 | 83ms | 155ms(经 daemon)/ 476ms(自己落盘) |
| 一轮 · 5 次工具调用 | 2.09s | 8.36s |
| 一轮 · 30 次工具调用 | 5.19s | 32.30s |

- **CPU**:daemon 静置几乎不占 CPU(30 秒窗口:无进行中轮次 0.0%、1 个 0.1%、20 个 1.3%,单核百分比)。
- **内存**:单 daemon 常驻 60–110 MB。GC 后堆稳定回落(40 轮只留 1.7 MB),不是泄漏;RSS 不归还属 V8 高水位。
- **daemon 是每 workspace 一个,没有全局上限** —— 并行多个 worktree 时占用会叠加,只在需要采集的 worktree 执行 `init`。

不想要常驻进程:`export SCRY_RECORDER_TRANSPORT=direct`(行为等价,更慢)。

存量 workspace 升级 CLI 后需要重新生成 hook 脚本才能拿到快路径:`scry integrations repair --yes`(不做也不会错,只是慢)。

## 容量与归档

`.scry/records/` 是 append-only 事实源:一轮一个 JSON,文件名带 20 位序号且必须连续。

| 轮次形态 | 大小 |
|---|---|
| 只有 prompt,无工具无 diff | 约 2.9 KB |
| 5 次 Edit + 5 文件 diff | 6.6–9.9 KB |

按 8 KB/轮、100 轮/天估算约 20 MB/月。主要变量是 diff,已有硬上限(单文件 patch 32 KiB、单轮合计 128 KiB);工具输出只存摘要,单次 input 超 8 KiB 会省略并标 `partial`。

> ⚠️ **不要手动删除单个 record 文件。** 序号空洞会被 `turns verify` 与 `doctor` 判为 store 损坏(退出 4),而不是"已清理"。

```bash
scry records archive --before 30d --workspace "$PWD"          # 只打印计划
scry records archive --before 30d --yes --workspace "$PWD"    # 执行
```

归档把**连续前缀**搬到 `.scry/archive/<cutoff>/`(可用 `--out` 指定),写出带 sha256 的 `manifest.json`,并把 floor 记进 `archive-state.json`。只有被 floor 解释的空洞才被接受,新轮次从 `floor + 1` 继续编号。配置了 commit hook 时,归档拒绝搬走未 ACK 的记录(退出 5),提示先 `notify-drain`;确实要放弃投递才用 `--force`。

`turns list`、`doctor` 与投递 drain 都会扫描整个 records 目录,长期不清理会同时看到磁盘增长和命令变慢。

## commit hook:唤醒外部 uploader

需要在 record 落盘后唤醒外部程序时,在 `scry.config.json` 声明 workspace 相对的 `entry` 与完整 `files` 清单。record 持久化且 runtime 清理后,recorder 以 stdin 发送只含 `workspace/provider/sessionId/recordId/sequence` 的 JSON,**仅在回调 exit 0 后**推进 durable ACK;失败或超时会在下次 hook/recovery 重试。

**仓库内配置不能自我授权**,必须显式批准一次:

```bash
scry commit-hook trust --workspace "$PWD"          # 只打印 entry、files 与指纹
scry commit-hook trust --yes --workspace "$PWD"    # 确认授权
scry commit-hook status --workspace "$PWD"
scry commit-hook revoke --workspace "$PWD"
```

授权记录写在仓库之外(默认 `~/.scry/grants/<workspace-hash>.json`,`0600`,可用 `SCRY_GRANT_DIR` 覆盖)。每次投递前重新校验 entry 与全部 `files` 的内容指纹:未授权、指纹不符或 bundle 非法一律 fail closed,不执行任何程序,record 照常保留待后续投递,原因写入 `.scry/logs/recorder.log`。改过 hook 后需重新 `trust`,并 `scry recorder restart` 让运行中的 daemon 生效。

被授权的 entry 以你的权限运行,并能读取全部 record 正文 —— **授权是执行授权,不是脱敏机制**。团队汇总方案必须自己承担脱敏(例如只上报 `turns summary` 的聚合结果);CLI 不提供内建脱敏投影。

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
| `commit-hook status` | 已激活或未配置 | 不可用 | 待授权 | 指纹不符 | bundle 非法 |
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
- Codex 无服务端精确 latency,`response_intervals` 是观测区间,可能包含请求构造、调度、传输与重试。
- `modelTiming.cumulativeMs` 累计并行子 Agent 时间,`occupiedMs` 是所有模型区间的并集(用于与整轮墙钟比较)。旧记录缺该字段时保持 `unavailable`。
- `modelSegments` 与 `compactions` 在旧记录缺失时标 `unavailable`,不会误算成 0。
- Recorder 只保证**新生成**记录使用当前口径,不会重写历史记录。

## managed 模式与更新

Scry App 启动 Provider 时设置 `SCRY_RECORDER_MANAGED=1`:此时 lifecycle hook 只建立轮次身份,App 在 result、Hook 与 diff 全部收齐后两阶段提交 canonical evidence;managed turn 禁止回退到 rollout 近似重建。

若 Provider 启动器会改写 `PATH`,应先解析 `scry` 绝对路径并通过 `SCRY_CLI_PATH` 传入;该变量存在时 hook 只执行指定路径,路径失效则 fail-open 跳过本次记录,不回退到改写后的 `PATH`。

独立安装**默认不后台联网**。设置 `SCRY_AUTO_UPDATE=1` 后,交互式命令结束时会拉起一个后台任务:它**会直接安装同一个 major 内的更新**(包括跨 minor),装完在下一次命令开头提示一次 `Scry CLI 已自动更新:X → Y`。检查至多每天一次,失败后 6 小时再试,安装禁用 package lifecycle scripts。

跨 major(如 `0.x → 1.0.0`)永远不自动安装,只报告可用 —— **破坏性变更靠升 major 表达**,不再用 0.x 的 minor 当边界。

```bash
scry upgrade --check    # 只检查
scry upgrade            # 前台升级到 registry latest（不受 major 边界限制）
```

真正容易踩的坑不是"没自动升",而是**同一台机器有多份安装**:hook 通过 `SCRY_CLI_PATH` 或 `.scry/cli-path` 固定用某一份,而你在 shell 里 `scry upgrade` 升的是 `PATH` 里的另一份。`doctor` 会直接指出来:

```json
{ "recorderVersions": { "thisCli": "0.2.32", "lastRecord": "0.2.30" } }
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
| `SCRY_OPEN_TURN_EXPIRY_MS` | 未结束轮次的过期窗口(默认 24 小时) |
| `SCRY_CLI_PATH` | hook 必须使用的 CLI 绝对路径 |
| `SCRY_GRANT_DIR` | commit hook 授权记录目录 |
| `SCRY_AUTO_UPDATE=1` / `SCRY_NO_UPDATE_CHECK=1` | 开启 / 关闭后台更新检查 |
| `SCRY_CLI_REGISTRY` | 覆盖 npm registry(HTTPS) |
