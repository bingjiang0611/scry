# @scry/turn-recorder

Scry 的独立本地轮次记录 CLI。它由 Provider 生命周期 hook 调用，在工作区的 `.scry/` 下写入顶层用户轮次记录；CLI 本身不上传数据，也不依赖 Electron 或原生模块。

```bash
scry doctor --workspace "$PWD"
scry turns list --workspace "$PWD"
scry turns export --workspace "$PWD" --after 0 --limit 100
```

Provider 集成优先通过 workspace 的 Unix socket 投递事件；socket 不存在时，首事件由 `scry recorder hook --start-daemon` 直接落盘并顺手拉起后台进程，不等待 daemon ready，后续事件自动切到 socket。Agent、skill 和用户提示词不应主动调用这些记录命令。

后台 recorder 不依赖 Scry App 常开，每个 workspace 独立运行，空闲 30 分钟自动退出：

```bash
scry recorder status --workspace "$PWD"
scry recorder start --workspace "$PWD"
scry recorder stop --workspace "$PWD"
scry recorder restart --workspace "$PWD"
```

正常使用无需手动启动。若 daemon transport 出现兼容问题，可设置 `SCRY_RECORDER_TRANSPORT=direct` 临时切回逐 Hook 同步 CLI；`.scry-disabled` 和 `SCRY_RECORDER_ENABLED=0` 仍用于完全停止记录。

工作区根目录需要显式配置，缺少配置时 fail closed，不创建数据目录：

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "workspaceId": "my-workspace",
  "dataDir": ".scry",
  "repositories": { "mode": "discover-nested-git", "maxDepth": 2 },
  "capture": {
    "prompt": true,
    "assistant": true,
    "toolOutput": "summary",
    "diff": true,
    "hooks": true
  }
}
```

创建 `.scry-disabled` 或设置 `SCRY_RECORDER_ENABLED=0` 可停止新增记录；`turns list/show/export/verify` 仍可只读已有数据。
