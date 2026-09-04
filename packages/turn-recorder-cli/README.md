# scry-turn-recorder

Scry 的独立本地轮次记录 CLI。它由 Provider 生命周期 hook 调用，在工作区的 `.scry/` 下写入顶层用户轮次记录；CLI 本身不上传数据，也不依赖 Electron 或原生模块。

支持 Node.js 20、22、24，运行平台为 macOS / Linux。Windows 原生当前不在支持范围。

```bash
npm install -g scry-turn-recorder@0.2.31 \
  --registry=https://registry.npmjs.org
```

安装后，在要采集的 Git 项目根目录初始化：

```bash
cd /path/to/project
scry init
```

`scry init` 会自动检测 Claude Code、Codex、Qoder 和 OpenCode，也可以明确指定：

```bash
scry init --providers claude,codex,qoder,opencode
```

它会创建 `scry.config.json` 和 `.scry/provider-hook.sh`，并把 Recorder Hook 合并到各 Provider 的项目配置中；已有 Hook 会保留，重复执行不会重复添加。命令只接受 Git 项目根目录，不会自动执行 `git init`。Pi 使用全局 lifecycle 扩展，仍单独运行 `scry integrations install-pi`。

初始化后要重启 Provider。Codex 还需要在项目中执行 `/hooks` 并信任项目 Hook；CLI 不能代替用户完成这一步。`init` 自带的检查只能证明配置和本地 Store 可用，执行一轮真实任务后 `scry turns list --workspace "$PWD"` 出现新记录，才说明 Hook 已经真正加载。

初始化只开启本地记录，不会安装 rate-native 的 uploader、审计或业务 Hook，也不会上传数据。

独立 npm 安装默认不后台联网。设置 `SCRY_AUTO_UPDATE=1` 后，`scry` 才会在交互式命令结束后检查兼容更新；后台任务只检查、不安装，升级仍需前台运行 `scry upgrade`。检查至多每天一次，失败后 6 小时再试。桌面 App 内置 CLI、recorder、daemon 和 CI 不触发后台检查。

```bash
scry upgrade --check  # 只检查
scry upgrade          # 立即升级到 registry 的 latest
```

直接运行 Pi CLI 需要安装随 recorder 发布的 lifecycle 扩展；安装器会幂等写入受管 loader，且拒绝覆盖用户同名扩展：

```bash
scry integrations install-pi
scry integrations status-pi
scry integrations diff --workspace "$PWD"
scry integrations repair --yes --workspace "$PWD"       # 按 handler id 重写托管 hook
scry integrations uninstall --workspace "$PWD"          # 只打印计划
scry integrations uninstall --yes --workspace "$PWD"    # 执行
```

扩展把 Pi 的顶层 prompt、工具、assistant、usage 和模型响应区间按顺序投递到同一 workspace recorder；失败始终 fail-open，不阻断 Pi。

设置 `SCRY_NO_UPDATE_CHECK=1` 或传入 `--no-update-check` 可关闭已启用的后台检查；私有 registry 可通过 `SCRY_CLI_REGISTRY` 覆盖，但必须使用 HTTPS。自动安装禁用 package lifecycle scripts。

```bash
scry doctor --workspace "$PWD"
scry status --workspace "$PWD"
scry verify-capture --workspace "$PWD" --timeout 120
scry commit-hook status --workspace "$PWD"
scry turns list --workspace "$PWD"
scry turns show <sequence|recordId> --workspace "$PWD"
scry turns timeline <sequence|recordId> --workspace "$PWD"
scry turns summary --workspace "$PWD"
scry turns summary <sessionId> --workspace "$PWD"
scry turns summary --all --workspace "$PWD"
scry turns export --workspace "$PWD" --after 0 --limit 100
scry --help
```

`scry status` 逐 Provider 输出六个阶段：detected、configured（workspace / global / no）、trusted、hookSeen、recordSeen、state。`configured` 只证明配置已写入，`hookSeen` 证明 lifecycle hook 真的到达了 recorder，`recordSeen` 才证明轮次已提交；三者不可互相代替。`trusted` 永远是 `unknown`（原因在报告级 `trustEvidence` 里说明一次）：Codex 要求交互式 `/hooks` 确认，其余 Provider 不向 CLI 暴露信任状态，写成 `n/a` 等于声称“不需要信任”。退出码：0 至少一个 Provider 正在采集，2 recorder 未启用或没有已配置 Provider，3 已配置但还没有真实事件或 record。Pi 单独标为 `global`，因为它是用户级 lifecycle 扩展而不是项目 hook。

`openTurnsPending`（未收敛的 open turn）与 commit hook 的 `notifyBacklog`（未 ACK 记录数）是两个不同指标，不要混用。完整 health 计数只在 `scry doctor` 输出，`status` 不重复一份。

接入后应用 `scry verify-capture` 真实验一次：它先记下当前最大 sequence，然后等你在 Agent 里跑完一轮，只有出现**新** record 才算成功。失败时给出具体阶段：`missing_config`、`disabled`、`no_hook_event`（detail 区分“从未到达过”与“以前到过但本次没有”）、`pending_open_turn`、`events_without_record`。退出码：0 已采到，2 recorder 不可用，3 超时内未采到。结果为 `ok` 时仍会逐段输出证据状态（如 `usage: unavailable/unavailable`），不会用一个绿色结论掩盖不可观测的部分。`openTurnInFlight`（轮次正在进行）与 `openTurnsPending`（轮次待恢复）是两个独立信号。

commit hook 投递在 Provider lifecycle 关键路径上有界执行：每个 hook 事件最多投递 8 条、预算 1.5s（仅在两条之间检查，单条仍以 10s 熔断）。剩余保持 pending，`status` 的 `notifyBacklog` 会如实显示积压条数；`recorder notify-drain` 的返回值带 `truncated`，投递失败的原因写在 `.scry/logs/recorder.log`。需要一次清空时用：

```bash
scry recorder notify-drain --workspace "$PWD"
```

参数同时支持 `--workspace <root>` 与 `--workspace=<root>`；未知参数或缺少参数值会直接报错。`turns show/timeline` 未找到记录时输出 `{ "found": false }` 并退出 1，退出码 4 只表示 store 损坏。

Provider 集成优先通过 workspace 的 Unix socket 投递事件；socket 不存在时，CLI 会让首事件直接落盘并顺手拉起后台进程，不等待 daemon ready，后续事件自动切到 socket。`--start-daemon` 只保留给旧集成兼容。Agent、skill 和用户提示词不应主动调用这些记录命令。

需要在正式 record 落盘后唤醒外部 uploader 时，`scry.config.json` 的 `commitHook` 必须声明 workspace 相对的 `entry` 与完整 `files` 清单。Scry App 首次使用会展示完整 bundle 指纹；批准后只执行复制到 Scry userData 的冻结副本，入口或任一依赖变化都会重新询问。record 持久化且 runtime 清理后，recorder 以 stdin 发送只含 `workspace/provider/sessionId/recordId/sequence` 的 JSON，并仅在回调 exit 0 后推进 durable ACK；失败、超时或进程中断会在下一次 hook/recovery 重试。

独立 CLI 不会因为仓库里写了 `commitHook` 就执行它——仓库内配置不能自我授权。必须显式授权一次：

```bash
scry commit-hook trust --workspace "$PWD"          # 只打印将被授权的 entry、files 与指纹
scry commit-hook trust --yes --workspace "$PWD"    # 确认授权
scry commit-hook status --workspace "$PWD"
scry commit-hook revoke --workspace "$PWD"
```

授权记录写在仓库之外（默认 `~/.scry/grants/<workspace-hash>.json`，`0600`，可用 `SCRY_GRANT_DIR` 覆盖），只包含 canonical workspace 路径、entry 绝对路径与 bundle 指纹。每次投递前都会重新校验 entry 与全部 `files` 的内容指纹：未授权、指纹不符或 bundle 非法时一律 fail closed，不执行任何程序，record 照常保留待后续投递，原因写入 `.scry/logs/recorder.log`。授权后修改 hook 需重新 `trust`，并执行 `scry recorder restart --workspace <repo>` 让运行中的 daemon 生效。宿主（Scry App）自行设置 `SCRY_RECORDER_COMMIT_HOOK` 时优先生效，CLI 不覆盖。

被授权的 entry 以你自己的权限运行，并且能读取数据目录下的全部 record 正文。授权是执行授权，不是脱敏机制。

如果 uploader 只需要统计口径，应让它消费投影而不是 record：

```bash
scry turns project <sequence|recordId> --policy team-metadata@1 --workspace "$PWD"
```

`team-metadata@1` 只输出：provider/model、session/record 标识与序号、时间与状态、token 与 cost、模型占用时间、tool/skill/MCP/agent/hook/file 计数、人工介入计数与等待时间、危险操作分级与分类原因、compaction 与 error 计数、diff 行数统计、逐段 evidence 状态、`policyVersion`。

明确不输出：prompt 与回复正文及其 hash、thinking、工具入参与输出、文件路径、patch、repo remote、workspace 路径与 `workspaceId` 原文（只给 `sha256:` 哈希）、环境变量值。不可观测的数值输出 `null` 并在 `evidence` 说明，绝不写成 `0`。危险操作的 `reason` 是分类器产出的固定分类（如「sudo 提权」），不含命令原文。

这样 uploader 可以只被授予调用 CLI 的能力，而完全不需要 `.scry/records` 的读权限——脱敏逻辑留在被评审的 CLI 代码里，而不是散落在各团队脚本中。

`commit-hook status` 退出码：0 已激活或未配置，2 配置/存储不可用，3 待授权，4 指纹不符，5 bundle 非法。未激活时 `notifyBacklog` 显式为 `null` 且标注 `unavailable`，不会伪装成 0。

Scry 启动且启用精确记录的 Claude、Codex、Qoder、OpenCode 会设置 `SCRY_RECORDER_MANAGED=1`。此时 lifecycle hook 只建立轮次
身份，Scry App 在 result、Hook 与 diff 全部收齐后，把 trace archive 使用的同一份
canonical evidence 两阶段提交到 CLI record；managed turn 禁止回退 rollout 近似重建。

如果 Provider 启动器会改写 `PATH`，应先从用户原始环境解析 `scry` 的绝对路径并通过 `SCRY_CLI_PATH` 传给 hook。hook 在该变量存在时只能执行指定路径；路径失效时应 fail-open 跳过本次记录，不能回退到改写后的 `PATH`。未设置该变量的旧集成可继续使用 `command -v scry`。

后台 recorder 不依赖 Scry App 常开，每个 workspace 独立运行，空闲 30 分钟自动退出：

```bash
scry recorder status --workspace "$PWD"
scry recorder start --workspace "$PWD"
scry recorder stop --workspace "$PWD"
scry recorder restart --workspace "$PWD"
```

正常使用无需手动启动。深路径 workspace 会自动把 socket 放到系统临时目录。若 daemon transport 出现兼容问题，可设置 `SCRY_RECORDER_TRANSPORT=direct` 临时切回逐 Hook 同步 CLI；`.scry-disabled` 和 `SCRY_RECORDER_ENABLED=0` 仍用于完全停止记录。

工作区根目录需要显式配置，缺少配置时 fail closed，不创建数据目录：

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "workspaceId": "my-workspace",
  "dataDir": ".scry",
  "commitHook": {
    "entry": ".claude/hooks/scry-record-committed.py",
    "files": [
      ".claude/hooks/scry-record-committed.py",
      ".claude/hooks/scry_turn_uploader.py",
      ".claude/hooks/flush.py",
      ".claude/hooks/session_identity.py",
      ".claude/workflow/archive_snapshot.py",
      "agent-adapters/shims/run-hook-async.py",
      "agent-adapters/scripts/generate.py"
    ]
  },
  "repositories": { "mode": "discover-nested-git", "maxDepth": 2 },
  "capture": {
    "prompt": true,
    "assistant": true,
    "toolOutput": "summary",
    "diff": true,
    "hooks": true,
    "patchExcludeBasenames": [".factorypath"]
  }
}
```

创建 `.scry-disabled` 或设置 `SCRY_RECORDER_ENABLED=0` 可停止新增记录；`turns list/show/timeline/summary/export/verify` 仍可只读已有数据。

## 采集范围

默认全部开启；每一项都可以在 `scry.config.json` 里显式关闭：

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

```bash
scry capture show --workspace "$PWD"    # 看解析后的生效值（含配置省略掉的默认）
```

关闭某项后，对应证据段记为 `disabled` 并带 `omissionReason: ... disabled by config`，与 Provider 不支持导致的 `unavailable`、以及“真的没有发生”的空数组是三个不同状态。因此**不需要**额外的 policy 字段来事后解释某条记录采了什么——记录自己就说明了。

**注意关闭正文并不等于脱敏。** 即使 `prompt`、`assistant` 关闭、`toolOutput` 设为 `none`，以下内容仍会写入记录：

- 工具入参（Bash 命令原文、Edit 的 old/new 字符串等）
- 文件路径
- diff patch（除非同时 `diff: false`）

当前没有单独关闭工具入参的开关。如果你的场景要求本地不留任何代码与命令，应设 `diff: false` 并评估工具入参是否可接受，或者不要在该仓库启用 Recorder。

## 未结束的轮次

一轮从 `UserPromptSubmit` 开始、`Stop` 结束。如果 Provider 被 `kill -9`、崩溃或终端被直接关闭,结束事件永远不会到,这一轮就停在 `.scry/runtime/` 里。

超过 **24 小时**且 **transcript 已停止增长**的这类轮次会被判定为不可能再收敛,由 `scry recorder recover`(daemon 空闲时也会自动跑)收敛为 `interrupted`:

```bash
scry doctor            # 退出 5，turns.stale 报出数量与最久时长
scry recorder recover  # {"recovered":1,"pending":0,"expired":1}
```

两个判据必须同时满足:只看轮次年龄会把跑了 30 小时的长任务误判为中断,而长任务会持续往 transcript 追加内容。

收敛后的记录 `status` 为 `interrupted`,已观测到的证据段降级为 `partial`,原因为 `turn never received a terminal event and its transcript stopped changing before the expiry window`;完全没观测到的段仍是 `unavailable`。**不会**把未观测当作"没有发生"。

`diff` 段固定为 `unavailable`:这一轮的 diff 基线可能是几天前建立的,发布它就等于把之后所有改动(包括别的轮次的工作)算到这一轮头上。所以过期收敛只释放基线、不发布归因。

窗口可用 `SCRY_OPEN_TURN_EXPIRY_MS` 收紧(主要供测试),下限 1 秒、上限 30 天。

顺带说明:daemon 在有未结束轮次时不会因空闲退出 —— 这是防止它在有活干时退场。因此孤儿轮次也是 daemon 长期不退出的原因,收敛之后它才会正常退出。

## 容量与保留

`.scry/records/` 是 append-only 的事实源：一轮一个 JSON，文件名带 20 位序号且必须连续。当前版本**没有自动清理或归档**，容量由使用者自己控制。

实测单条体积（macOS，CLI 0.2.31）：

| 轮次形态 | 大小 |
|---|---|
| 只有 prompt，无工具、无 diff | 约 2.9 KB |
| 5 次 Edit + 5 个文件 diff | 约 6.6–9.9 KB（其中 diff 约 5.4 KB、tools 约 2.2 KB） |

粗估：以平均 8 KB/轮、每人每天 100 轮计，约 0.8 MB/天、约 20 MB/月。主要变量是 diff，已有硬上限（单文件 patch 32 KiB、单轮合计 128 KiB）；工具输出只存摘要，单次 input 超 8 KiB 会省略并标 `partial`。想进一步降低占用可把 `capture.diff` 或 `capture.toolOutput` 关掉。

**不要手动删除单个 record 文件。** `turns verify` 与 `doctor` 会把序号空洞当作 store 损坏（`doctor` 退出 4），而不是当作“已清理”。需要释放空间时用归档：

```bash
scry records archive --before 30d --workspace "$PWD"          # 只打印计划
scry records archive --before 30d --yes --workspace "$PWD"    # 执行
```

归档把**连续前缀**搬到 `.scry/archive/<cutoff>/`（可用 `--out` 指定），写出带 sha256 的 `manifest.json`，并把 floor 记进 `archive-state.json`（只有 `archivedThrough` 一个字段；被搬走的内容由 manifest 说明，不再重复记一份历史列表）。`turns verify` 与 `doctor` 只接受被 floor 解释的空洞——手动删除仍然是损坏。新轮次从 `floor + 1` 继续编号，不会与已发出的序号冲突。

若配置了 commit hook，归档会**拒绝**搬走尚未 ACK 的记录（退出 5），提示先 `scry recorder notify-drain`；确实要放弃投递时才用 `--force`。

另注意：`listRecords`、`turns list`、`doctor`、commit 通知 drain 都会扫描整个 records 目录，所以长期不清理的仓库会同时看到磁盘增长和命令变慢。

## 排障

```bash
scry support-bundle create --workspace "$PWD"                 # 输出到 stdout
scry support-bundle create --out ./scry-support.json           # 写文件（0600）
```

支持包只含：CLI/Node/平台版本、Provider 检测与配置状态、hook 事件计数与最近事件时间、配置指纹与 `capturePolicy`、health 计数、store 计数与 `archivedThrough`、commit hook 激活状态与 ACK/backlog、脱敏后的最近 recorder 日志。

明确不含：record 正文、文件路径列表、环境变量值、workspace 路径与 `workspaceId` 原文（只给哈希）、commit hook entry 内容。日志与错误里的绝对路径会被替换为 `<workspace>` / `<home>`。产物自带 `omitted` 字段说明边界。

## 数据口径

- `turns summary` 默认汇总最新 session，与 Scry 当前会话纵览使用同一公开口径；`--all` 才汇总整个 workspace。
- 新记录的 `modelSegments` 按原始事件顺序保留可见过程文字和 Provider 明文暴露的 thinking；`turns timeline` 将它们与 Tool、Skill、MCP、子 Agent 的开始/结果交错输出。旧记录缺少该字段时明确标为 `unavailable`。
- 新记录的 `compactions` 保存每轮上下文压缩事件；`turns list` 输出逐轮次数，`turns summary` 汇总总数及 auto/manual 触发方式。旧记录缺少该字段时保持 `unavailable`，不会误算成 0。
- patch 正文每文件最多 32 KiB、每条 record 合计最多 128 KiB；超过上限或命中 `patchExcludeBasenames` 时仍保留增删计数，并把 diff evidence 标为 `partial` 及对应原因。工具调用骨架全部保留；单次 input 超过 8 KiB 或调用详情合计超过 128 KiB 时只省略详情并标为 `partial`。
- `普通工具`、`MCP`、`Skill`、`子 Agent` 是四个互斥列；总调用等于四列之和，同一次 MCP 或子 Agent 不会再重复计入普通工具。
- Hook 同时报告“处理器实例”和“生命周期事件”；文件同时报告结构化文件证据与 Bash 推断读取，并保留 quality/coverage，不能拿不同分母直接比较。
- Codex 的顶层轮次会合并其子 Agent rollout，但 Token 和最终回复只取顶层权威值，避免重复累计。
- 无调用记为 `available + []`；Provider 未暴露的数据记为 `unavailable`，不会伪装成 0。Codex rollout 不包含原生 Hook 运行时事件，因此 Hook 通常为 `unavailable`。
- Codex 会从 rollout 恢复 slash prompt、Usage、文件修改及常见并行工具调用；若子 Agent rollout 缺失，相关字段降级为 `partial`。
- `turns list` 会为每轮输出紧凑的 `modelTiming`；`turns summary [sessionId]` 除纵览调用、Hook、文件、用量、错误和 diff 外，也汇总人工介入次数/问题数/等待时间、模型累计耗时、去重占用耗时、根/子 Agent 累计值和覆盖率。
- Codex 当前没有上报服务端精确 latency。新记录的 `response_intervals` 是从同一 Agent 线程的 turn start 或上一段工具/Hook 完成，到 `rawResponse/completed` 的观测区间；它适合定位流程等待，但可能包含请求构造、调度、传输和重试。
- `cumulativeMs` 会累计并行子 Agent 的模型时间；`occupiedMs` 是所有已观测模型区间的并集，用来与整轮墙钟比较。旧记录缺少 `modelTiming` 时保持 `unavailable`，不会被解释为 0。
- Recorder 只保证新生成记录使用当前口径；已经上传的旧版本记录不会被自动重写。
