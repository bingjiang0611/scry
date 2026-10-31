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

`scry-upload init` 会检查机器上是否有 `transport`。如果没有，会通过 transport 配套安装脚本自动安装最新版；如果已经安装，不会重复安装或强制升级。SSO 登录仍需用户本人完成：

```bash
transport auth login --sso
```

## 初始化项目

进入要采集数据的 Git 项目根目录执行：

```bash
scry-upload init
```

它会配置 Scry Provider Hook、创建 runtime/队列和上传状态，并保留已有的非 uploader `commitHook` 配置。此初始化入口支持 `claude,codex,qoder,opencode`。Pi 使用 Scry 的独立集成或 host-app 宿主适配器；上传器接受 Pi 的记录和通知，不会隐式安装全局 Pi 配置。

初始化可以重复执行，保留现有 discovery cursor（发现进度，不是远端 ACK）；首次从 0 开始发现已有 canonical records，并排队上传。Recorder 提交通知通过 stdin 发送给：

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
```

`wakeup` 持久化后台任务；`flush` 同步执行。两者都会消费 custody/outbox，并通过 recorder export 增量发现 canonical records，不扫描业务归档或重新采集。`status` 只读取本地状态；`doctor` 检查 Scry、transport、MCP 和 runtime。

所有命令支持 `--workspace <工作区目录>`；只有 `init` 要求 Git 根目录。`init`、`doctor`、`status`、`flush`、`migrate` 支持 `--json`。

## 上传内容与可靠性

通知兼容 v1/v2，严格校验身份与字段。可选 `recordPath`、`sha256` 存在时必须与 `dataDir/records/<sequence>-<recordId>.json` 匹配。ACK 前先原子写入原始字节、SHA-256 receipt 和目录 fsync。重复通知即使源记录已归档也能重放。

新记录使用 `redactionVersion=none`，保留原始内容；已有 `agent-turn-v1` 脱敏 outbox 保持可重放，不会被静默丢弃。上传成功只接受 `inserted`/`duplicated`，明确的 `conflicted`/`rejected` 先保留 payload custody，再写入仅含元数据的失败诊断；损坏的本地队列文件会原样隔离，可能包含原始内容。传输超时保留未知远端结果并按既有冷却策略重试。

关闭上传（`SCRY_TURN_UPLOAD_ENABLED=0`）仍接管并标记 `skipped_disabled`；重新开启不会自动发送，必须显式 `--release-disabled <record-id>`。释放只修改本地状态，不联网、不启动 worker；随后由 `flush` 或新的唤醒上传。

## 本地目录

```text
<dataDir>/upload/
├── state.json
├── outbox/                 # none 信封；legacy agent-turn-v1 信封保持可重放
│   └── committed/          # ACK 前的原始字节 custody；legacy/ 保留不同的历史提交字节
├── receipts/               # sha256、provider/session 和状态
├── dead-letter/            # 失败元数据；损坏文件的原样隔离副本
├── jobs/                   # 后台任务，每个 job 最多 6 次尝试
└── runtime/                # init 生成的 launcher
```

从 host-app 升级时，先暂停旧宿主、确认旧 worker 和冻结 callback 已退出且不会再执行，再显式执行（工具没有自动停止/排空这些进程的能力）：

```bash
scry-upload migrate --workspace ROOT
```

迁移命令只准备目录并写确认标记，不创建或修改 state/cursor、不上传，不删除旧 `upload/lock` 或旧记录锁；未确认前 standalone 会 fail closed，避免新旧 flock/directory lock 并发写入。`.scry` 由 Scry 写入 `.git/info/exclude`，不会进入项目提交。
