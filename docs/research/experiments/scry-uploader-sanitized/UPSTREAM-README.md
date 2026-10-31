# scry-uploader

把 Scry 采集到的 AI Agent 轮次记录上传到 `agent-trace-service::submitTurns`。

它只负责上传，不负责重新采集数据：

```text
Claude / Codex / Qoder / OpenCode / Pi
  → Scry CLI 生成 AgentTurnRecord
  → scry-uploader 接管原始字节并写入本地 custody/outbox
  → transport 调用 submitTurns
```

## 安装

```bash
npm install -g @review/scry-uploader
```

安装包固定使用经过验证的 Scry `0.2.53`，不会覆盖机器上原有的全局 `scry` 命令。默认使用随包安装的 Scry；宿主可通过 `SCRY_CLI_PATH` 显式固定自己的 CLI，不依赖 PATH 中的全局 `scry`。

`scry-upload init` 会检查机器上是否有 `transport`。如果没有，会通过 transport 官方内网安装脚本自动安装最新版；如果已经安装，不会重复安装或强制升级。SSO 登录仍需用户本人完成：

```bash
transport auth login --sso
```

## 初始化项目

进入要采集数据的 Git 项目根目录执行：

```bash
scry-upload init
```

它会配置 Scry Provider Hook、创建 runtime/队列和上传状态，并保留已有的非 uploader `commitHook` 配置。此初始化入口支持 `claude,codex,qoder,opencode`。Pi 使用 Scry 的独立集成或 host-app 宿主适配器；上传器接受 Pi 的记录和通知，不会隐式安装全局 Pi 配置。

初始化可以重复执行，保留现有 discovery cursor（发现进度，不是远端 ACK）。首次初始化使用 recorder 的 max-safe export snapshot 作为 baseline；baseline 之前的历史记录不会因为注册或初始化自动回填。之后只通过 export 发现 baseline 之后的记录。已有 custody 的待发送数据不因 discovery cursor 较大而被当作 ACK 或丢弃；禁用/启用权限使用独立状态。Recorder 提交通知通过 stdin 发送给：

```bash
scry-upload notify --workspace "$PWD" < notification.json
```

省略 `--workspace` 时，只信任 stdin 事件中的绝对 workspace；显式参数必须与事件一致。

## 日常检查

```bash
scry-upload doctor
scry-upload status
scry-upload flush
scry-upload wakeup --workspace "$PWD"
scry-upload flush --workspace "$PWD" --release-disabled <record-id>
scry-upload enable --workspace "$PWD"
scry-upload disable --workspace "$PWD"
scry-upload register --workspace "$PWD"
scry-upload scheduler-install
scry-upload scheduler-status --json
```

`wakeup` 持久化后台任务；`flush` 同步执行。两者都会消费 custody/outbox，并通过 recorder export 增量发现 canonical records，不扫描业务归档或重新采集。`status` 只读取本地状态；`doctor` 检查 Scry、transport、MCP 和 runtime。`register` 只把明确指定的 canonical workspace 加入用户级 `scry-upload` registry（独立于桌面 Scry 状态目录）；若 workspace 尚无 state，会先用 recorder max-safe snapshot 建立安全 baseline，不改变上传开关。`scheduler-install` 只写入用户级服务定义；`scheduler-status` 返回持久登记列表和安装标记，不证明目录当前可访问或系统服务正在运行。恢复逐仓重验 canonical 身份；权限等错误写入本地 `recovery-health.json`，不阻塞其他仓库。目录删除后仍可用登记的 canonical 路径执行 `unregister`。恢复只扫描 registry 中的 workspace，每轮公平处理到期任务；所有 uploader 进程共享每用户最多两个上传配额。已有任务的冷却时间不会被定时恢复覆盖，单个工作区失败不阻断其他工作区。队列只恢复会话上下文，不从历史快照恢复 CLI 路径、安装身份、状态目录或运行预算；这些配置来自当前激活环境。旧任务的关闭标记仅在尚未显式启用时生效，不能推翻之后的 enable。

安装后还需激活系统服务（仅登记自己明确允许恢复的工作区）：

```bash
# macOS
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.scry.uploader.plist"
launchctl print "gui/$(id -u)/com.scry.uploader"
# Linux
systemctl --user daemon-reload
systemctl --user enable --now scry-uploader.timer
systemctl --user status scry-uploader.timer
```

服务每 60 秒恢复一次，不依赖桌面 App 是否打开。服务保存必要的路径和非敏感运行配置，不保存环境 token；transport 必须已有可用登录。Node 或 uploader 安装位置改变后须重新安装服务定义。Linux 需要可用的用户级 systemd；不支持的环境不自动降级到其他后台方案。

工作区命令支持 `--workspace <工作区目录>`；只有 `init` 要求 Git 根目录。`init`、`doctor`、`status`、`flush`、`migrate` 支持 `--json`。

## 上传内容与可靠性

通知兼容 v1/v2，严格校验身份与字段。可选 `recordPath`、`sha256` 存在时必须与 `dataDir/records/<sequence>-<recordId>.json` 匹配。ACK 前先原子写入原始字节、SHA-256 receipt 和目录 fsync。重复通知即使源记录已归档也能重放。

export 发现同样先接管 canonical 原始字节并持久化 receipt，再推进游标；不能只把导出 JSON 放入 outbox。旧版本遗留的无 receipt outbox 在发送前接管其现有字节，保留原来的传输内容。缺少 custody 时禁止静默完成终态；legacy ACK 也保留与 canonical 不同的实际提交副本。

新记录使用 `redactionVersion=none`，保留原始内容；已有 `agent-turn-v1` 脱敏 outbox 保持可重放，不会被静默丢弃。上传成功只接受 `inserted`/`duplicated`，明确的 `conflicted`/`rejected` 先保留 payload custody，再写入仅含元数据的失败诊断；损坏的本地队列文件会原样隔离，可能包含原始内容。传输超时、deadline、429 和网络/5xx 故障保留未知远端结果，按指数冷却、jitter 和 Retry-After 重试，不消耗 job 的永久失败次数；Retry-After（秒数或 HTTP-date）也会限制同一用户其他工作区的新请求。确定性 400/413 请求错误才拆批，单条连续三次确定性失败后保留为死信。完整编码参数 JSON 在发送前限制为 512 KiB；单条超限不发送并保留正文。这是客户端限额，不代表已确认网关的实际限额。

恢复发送前还会读取 recorder 的 `record-environments/<recordId>.json`：即使原通知丢失，其中明确的 `SCRY_TURN_UPLOAD_ENABLED=0` 也会保留为 held，不由后台服务上传。读取复用 pinned recorder 的身份和 schema 校验，不把快照内的 executable/配置当作新的执行授权。

耗尽单轮预算会保留已完成的上传数和待处理任务，不把正常进度记为失败。已接管的 outbox 优先于 export 处理；对于 pinned recorder 明确拒绝、且可核对 canonical 路径和序号的记录，先保留原始字节，再推进发现游标。其他 export 错误保持 `discovery_blocked`，不盲跳记录。

关闭上传（worker 观察到 `SCRY_TURN_UPLOAD_ENABLED=0`，或执行 `scry-upload disable`）会先持久化关闭状态，继续接管新提交并标记 `skipped_disabled`。关闭不依赖 export 成功。移除环境变量或重启服务不会自动重新开启，必须显式执行 `scry-upload enable`。

重新开启先暂停旧待发送数据，再读取 canonical 高水位；只允许高水位之后的新记录，关闭期间未发出通知的历史也不补传。重复 enable 不改变已启用状态或暂停新数据。历史 held 数据只有逐条显式 `--release-disabled <record-id>` 才能释放；释放仅修改本地状态，不联网、不启动 worker，且不覆盖工作区关闭状态。

enable、首次初始化和无 state 的注册使用 recorder 的 `--after 9007199254740991 --limit 1` 查询读取 `snapshotMaxSequence`，不是 `nextCursor`；该查询不读取旧记录。baseline probe 失败时保持关闭，不猜测文件名。策略变更与上传互斥；若提示锁忙，等待当前上传结束后再执行，不能把失败的命令当作已关闭。

健康状态以 receipt 的真实状态为准，不因同一 held 记录是否另有 outbox 副本而改变。held 索引首次升级扫描一次 receipts；之后只枚举活跃索引，读到第一条 held receipt 即停止，不读取 held 正文或遍历归档 receipt。索引标记先于 receipt 持久化，过期标记清理在单记录锁内重验，避免覆盖并发 release/关闭状态。

仓库身份保留 Git host/namespace，移除 URL 用户信息、query 和 fragment；没有 remote 时使用工作区路径身份。身份超过 512 个 JavaScript 字符串单元时改用 SHA-256，避免截断碰撞。

## 本地目录

```text
<dataDir>/upload/
├── state.json
├── outbox/                 # none 信封；legacy agent-turn-v1 信封保持可重放
│   └── committed/          # ACK 前的原始字节 custody；legacy/ 保留不同的历史提交字节
├── receipts/               # sha256、provider/session 和状态
├── pending-receipts/       # 待发送 receipt 索引，避免每次通知遍历全部历史
├── held-receipts/          # held receipt 索引，供健康状态判定；不授权释放历史
├── dead-letter/            # 失败元数据；损坏文件的原样隔离副本
├── jobs/                   # 后台任务；永久失败受 6 次预算约束，传输冷却不消耗预算
└── runtime/                # init 生成的 launcher
```

worker 使用 macOS `lockf -k` 或 Linux `flock` 的内核锁，持有稳定 inode，不 unlink 锁文件。调用者退出会关闭租约管道；helper 异常退出则终止当前 uploader 进程，避免失锁后继续写入。缺少锁能力或旧 owner 身份未知时 fail closed，不盲删替换 owner。每个工作区只有一个常驻 worker，新的唤醒合并为持久任务。

远端明确 ACK 后满 30 天，后台每日维护才清理 uploader 正文副本，也可显式执行 `scry-upload prune`。先持久化清理意图，再删除正文并记录完成；崩溃后可恢复，去重 receipt 保留，重复通知仍校验 digest。canonical Scry records、disabled/held、未确认或失败正文均不自动删除。

从 host-app 升级时，先暂停旧宿主、确认旧 worker 和冻结 callback 已退出且不会再执行，再显式执行（工具没有自动停止/排空这些进程的能力）：

```bash
scry-upload migrate --workspace ROOT
```

迁移命令只准备目录并写确认标记，不创建或修改 state/cursor、不上传，不删除旧 `upload/lock` 或旧记录锁；未确认前 standalone 会 fail closed，避免新旧 flock/directory lock 并发写入。`.scry` 由 Scry 写入 `.git/info/exclude`，不会进入项目提交。
