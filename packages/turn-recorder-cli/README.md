# scry-turn-recorder

Scry 的独立本地轮次记录 CLI。Provider 的生命周期 hook 调用它,把每个顶层用户轮次写成 `.scry/` 下的一个 JSON 文件。

- **不上传任何数据**,不依赖 Electron 或原生模块。
- **不是沙箱**:它记录发生了什么,不限制 Agent 能做什么。
- 支持 Node 20 / 22 / 24,macOS 与 Linux。Windows 不在支持范围。

## 安装与接入

```bash
npm install -g scry-turn-recorder@0.2.51

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
| `scry turns export --after 0 --limit 100` | 游标分页导出记录 JSON（正文保留引用） |
| `scry turns export-bundle <目录>` | 原子导出全部记录与引用的正文 blob |
| `scry turns content <记录> <正文路径...> --offset 0 --limit 65536` | 按字节分页读取 tool/model/diff/transcript 正文 |
| `scry turns verify` | 序号连续性与记录完整性 |
| `scry records archive --before 30d` | 归档旧记录（见[容量与归档](docs/storage-and-performance.md#容量与归档)） |
| `scry records maintain [--apply]` | 检查 quota/retention，安全回收孤立正文与压缩轮转日志 |
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
    "toolOutput": "full",
    "diff": true,
    "hooks": true,
    "patchExcludeBasenames": []
  }
}
```

`scry doctor` 输出的 `capture` 是解析后的生效值,包含配置里省略的默认值。

关闭某项后对应证据段记为 `disabled` 并带 `omissionReason: ... disabled by config`,与 Provider 不支持的 `unavailable`、以及"真的没发生"的空数组是三个不同状态 —— 记录自己就能解释当时采了什么。

> ⚠️ **关闭正文不等于脱敏。** 即使 `prompt`、`assistant` 关闭且 `toolOutput: "none"`,以下内容仍会落盘:**工具入参**(Bash 命令原文、Edit 的 old/new 字符串)、**文件路径**、**diff patch**(除非 `diff: false`)。当前没有单独关闭工具入参的开关。要求本地不留代码与命令的场景,应设 `diff: false` 并评估工具入参是否可接受,或者干脆不在该仓库启用。

## 详细参考

- [轮次生命周期、恢复与版本记录](docs/lifecycle.md)
- [工具正文、存储容量、归档与性能](docs/storage-and-performance.md)
- [Commit hook、managed 模式、更新与环境变量](docs/integrations-and-updates.md)

## 多仓库覆盖与诊断

以下字段由包含本次可靠性改动的 CLI 写出；历史 record 不回填，缺少字段不能当作零。

- `diff.discovery.requestedRoots`：本轮发现并请求采集的目录清单，数组长度是该清单的数量，不是磁盘上的全部仓库数，也不保证每个目录已解析出有效 Git root。仅在发现阶段有证据时出现。
- `diff.discovery.maxDepth` 与 `depthLimitedDirectories`：本轮使用的深度上限、因该上限未继续下探的目录数。后者不是“漏掉的仓库数”。默认深度仍为 2，上限 5；排除目录及目录符号链接仍不下探。
- `diff.value[]`：逐项查看 `status`（`captured` / `timeout` / `failed` / `unavailable`）及可用的 `reason`。`requestedRoot` 是已知请求目录；`repoRoot` 只在 Git 解析到它时提供。不同仓库即使同时结束也保留独立结果。
- 深度边界只作为 `discovery` 元数据保留，不单独改变 diff 的 status/quality 或增加 `omissionReason`。`available` 表示已纳入清单的快照可用，不证明磁盘上所有仓库都已采集。真实缺失证据仍按原规则降级并写原因；恢复时无法可信归因 diff，仍为 `unavailable`，不补造快照、耗时或成功状态。没有 `diff.value` 不等于发现了零个仓库。

`doctor` 的 `repositories.depth` 只额外查看 depth+1 一层，最多探测 32 个边界目录、128 个目录项。仅在实际发现 `.git` 时 warn、列出路径并提示调整 `repositories.maxDepth` / `repositories.exclude`。没有发现时 pass；即使探测不完整也不告警，但 detail 会明确说明上限或不可读，不能把 pass 当作已确认没有更深仓库。不会自动扩大采集范围。

`doctor` 和 `support-bundle` 的 `userHookSkips` 单独汇总 `${XDG_STATE_HOME:-$HOME/.local/state}/scry/hook-skip.log` 中的 `bridge_not_found`。其 `value.workspaceAttribution` 固定为 `unknown`：日志没有工作区身份，不能加到当前工作区的 `hookSkips` 或失败计数中。`hook.userBridgeSkips` 对非空、截断或不可用的窗口给出 warning，但不改变当前工作区退出码。缺失日志是已观察的空窗口，不证明 Provider 加载过 hook；不可读或受检路径为符号链接则为 `unavailable`，没有伪造的零值。

用户级汇总只读当前日志及 `.1`，各最多读取尾部 1 MiB，不旋转或重写日志。截断时为 `partial`；`count` 是可见保留窗口的行数，`recentCount` 包括近 24 小时及时间不明的行。bundle 不包含原始用户级日志或任意时间文本。OpenCode plugin 不使用 shell bootstrap 的 `bridge_not_found` 日志，不能据此假设 Provider 能力相同。

升级 CLI 后执行 `scry integrations repair --yes` 并重启 Provider，让旧 `provider-hook.sh` 也在入口清除继承的内部 daemon-attempt 标记。daemon 在线 curl 快路径没有新增进程。

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

hook 路径/Node 路径缺失、managed CLI 无效、CLI 非零退出和配置无效会写入工作区固定位置 `.scry/logs/hook-skip.log`（即使配置指定了其他 dataDir）。仅记录 UTC 时间、provider、event、原因码和 CLI 返回码，不含 payload；对 Provider 的返回码仍为 0。时间和目录命令只在失败分支执行，daemon 正常快路径不新增进程。`recorder status`、`doctor` 和 support-bundle 的 `hookSkips` 汇总保留日志窗口的条数、最近时间；不是历史累计数。`doctor` 对近 24 小时或时间不明的工作区 skip 报 `error`（退出 5）；仅有旧事件时为 warning。invalid_config 仍报 `error`（退出 3）；主动禁用仍走原有路径。用户级 `bridge_not_found` 按上节单独显示，不归因到当前工作区。

shell 只追加；CLI 诊断在文件超过 1 MiB 时轮转并保留一代，每代最多读取末尾 1 MiB，截断时 `hookSkips.truncated=true`。只运行失败 hook 而不调用 CLI 诊断时，磁盘日志可暂时超过阈值；这不是硬磁盘配额。目录不可写时无法保证留痕，hook 仍 fail open。修复原因后可由用户保存并移走日志及 `.1` 来清除该窗口的告警。新增 shell 留痕需执行 `scry integrations repair --yes`；仅 invalid_config 和 CLI 诊断改进升级 CLI 即可生效。不增加 CLI 路径自动回退。

无 open turn 的 SessionEnd/进程退出只是两轮之间的正常会话结束；Claude、Codex、Qoder 的 `Stop` 携带布尔 `stop_hook_active:true` 表示同轮续跑。这两类返回 duplicate，不写 orphan、不加 missingStartTerminals。有 open turn 时仍正常处理终态。其他缺少开始事件的终态不会仅凭会话存在就判为 duplicate。无法通过已提交 turn ID 或已提交轮次的明确时间边界（按时间值而非字符串比较）证明重复时，事件保存到 `runtime/<provider>/<session-key>/orphans/<payload-hash>.json`，`health.json` 的 `missingStartTerminals` 和 `orphanEvents` 各加一，并写 `recorder.log`；相同 payload 重放不重复计数。工具 orphan 同样保存 payload。原始 payload 使用 content envelope，受 `toolContentFieldBytes` / `toolContentTurnBytes` 上限约束；只有 prompt、assistant、完整工具采集都启用时才保存正文，否则标明 `capture_policy` 省略。orphan 不是 record，不会猜测 token、轮首时间或 diff。

OpenCode 插件对同一实例内已投递的 `session.idle` 去重；新 chat.message 或 busy/retry 状态会重置。只记住最近 128 个 idle session；首次、重载或淘汰后无法归属的 idle 仍交给 recorder，不用“没有活动轮”猜测重复。已知投递失败不会抑制后续 idle。此插件更新需要 `scry integrations repair --yes`；上述核心终态判定只需升级 CLI。若实际并发/交错会话超过 128 并造成误报，应先测量重载及淘汰频率，再考虑持久化终态身份，而不是无限扩充内存缓存。

开始 hook 首次发布 `open.json` / `session.json`，以及终态钉住 `closing` 时，均等待原子写的文件和父目录 fsync；中间工具状态仍不增加 fsync。这保证调用了持久化屏障，不等同于验证所有文件系统上的断电恢复。

### Retry quarantined hooks

`runtime/<provider>/<session-key>/inbox-failed/<entry>.json` 保留失败事件原文；同名追加 `.failure.json` 的 sidecar 保存尝试次数与最近错误。可重试条目由 `scry recorder recover` 重放，累计 5 次失败后不再自动尝试。sidecar 损坏或不可读时，replay 同样跳过，不猜测或重置计数。

已耗尽和 sidecar 不可读的条目仍计入 `pendingCount`，使 doctor 的 `turns.pending` 为 warn；它们本身不阻止 daemon 空闲退出。其他可重试条目或 open turn 仍按原规则保活。升级 CLI 后已有 daemon 需要 `scry recorder restart` 才能加载新逻辑；不需要 `integrations repair`。

人工重试只针对确认过的单个事件：

1. 先结束使用此工作区的 Provider，停止 recorder daemon，并通过 `recorder status` 确认它已停止，避免与新 hook 或其他 recover 并发。
2. 查看该 sidecar 与 recorder 日志，修好失败原因（例如权限、磁盘或已定位的应用逻辑错误）。损坏/不可读的 sidecar 必须先恢复到能原样备份的状态；不要覆盖原事件、猜造字段或直接把计数写成 0。事件本体已损坏且缺少权威恢复来源时，应保留证据，不靠反复重置计数期待自愈。
3. 备份事件与 sidecar 到 dataDir 之外，再仅删除对应 sidecar。缺少 sidecar 表示重新开始一轮最多 5 次的尝试，不需要搬动事件。
4. 执行 recover，读回状态与目标文件。recover 退出 0 不代表该事件已成功；成功应用后原队列事件会清理，若失败则重新生成 sidecar。开始事件可能只打开一轮，不会立刻产生 record。

以下以默认 dataDir 为例；按 doctor 的 dataRoot 和实际文件名逐项替换占位值。若之前隔离移动失败、原事件仍在 `inbox/`，只把 EVENT 改为那份实际文件的路径；SIDECAR 仍在 `inbox-failed/`。不要用通配符批量删除：

```bash
WORKSPACE='/absolute/path/to/workspace'
scry recorder stop --workspace "$WORKSPACE"
scry recorder status --workspace "$WORKSPACE"
```

仅在确认输出 `running=false` 且 Provider 已退出后，在同一终端继续：

```bash
DATA_ROOT="$WORKSPACE/.scry"                    # 自定义 dataDir 时改为实际 dataRoot
SESSION_DIR="$DATA_ROOT/runtime/<provider>/<session-key>"
NAME='<实际事件文件名>.json'
EVENT="$SESSION_DIR/inbox-failed/$NAME"
SIDECAR="$SESSION_DIR/inbox-failed/$NAME.failure.json"
BACKUP="$(mktemp -d)"                           # 保留此备份，供后续核验
printf 'Backup: %s\n' "$BACKUP"
cp "$EVENT" "$SIDECAR" "$BACKUP/" &&
  rm -- "$SIDECAR" &&
  scry recorder recover --workspace "$WORKSPACE"
scry recorder status --workspace "$WORKSPACE"
scry doctor --workspace "$WORKSPACE"
```

不要删除 event、records 或 health.json 来清告警。重试成功不会扣除历史 droppedEvents；其他 pending/lastError 也可能仍让 doctor 告警。重放可能晚于后续事件，不保证严格 FIFO 或 exactly-once；确认事件身份及失败原因后再重试。恢复日常使用前按需启动 recorder/Provider。

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
