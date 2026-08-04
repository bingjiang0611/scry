# @ali/scry-turn-recorder

Scry 的独立本地轮次记录 CLI。它由 Provider 生命周期 hook 调用，在工作区的 `.scry/` 下写入顶层用户轮次记录；CLI 本身不上传数据，也不依赖 Electron 或原生模块。

支持 Node.js 20、22、24，运行平台为 macOS / Linux。Windows 原生当前不在支持范围。

```bash
npm install -g @ali/scry-turn-recorder@0.2.11 \
  --registry=https://registry.anpm.alibaba-inc.com
```

```bash
scry doctor --workspace "$PWD"
scry turns list --workspace "$PWD"
scry turns summary --workspace "$PWD"
scry turns summary <sessionId> --workspace "$PWD"
scry turns summary --all --workspace "$PWD"
scry turns export --workspace "$PWD" --after 0 --limit 100
```

Provider 集成优先通过 workspace 的 Unix socket 投递事件；socket 不存在时，首事件由 `scry recorder hook --start-daemon` 直接落盘并顺手拉起后台进程，不等待 daemon ready，后续事件自动切到 socket。Agent、skill 和用户提示词不应主动调用这些记录命令。

Scry 启动且启用精确记录的 Claude、Codex、Qoder 会设置 `SCRY_RECORDER_MANAGED=1`。此时 lifecycle hook 只建立轮次
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

创建 `.scry-disabled` 或设置 `SCRY_RECORDER_ENABLED=0` 可停止新增记录；`turns list/show/summary/export/verify` 仍可只读已有数据。

## 数据口径

- `turns summary` 默认汇总最新 session，与 Scry 当前会话纵览使用同一公开口径；`--all` 才汇总整个 workspace。
- `普通工具`、`MCP`、`Skill`、`子 Agent` 是四个互斥列；总调用等于四列之和，同一次 MCP 或子 Agent 不会再重复计入普通工具。
- Hook 同时报告“处理器实例”和“生命周期事件”；文件同时报告结构化文件证据与 Bash 推断读取，并保留 quality/coverage，不能拿不同分母直接比较。
- Codex 的顶层轮次会合并其子 Agent rollout，但 Token 和最终回复只取顶层权威值，避免重复累计。
- 无调用记为 `available + []`；Provider 未暴露的数据记为 `unavailable`，不会伪装成 0。Codex rollout 不包含原生 Hook 运行时事件，因此 Hook 通常为 `unavailable`。
- Codex 会从 rollout 恢复 slash prompt、Usage、文件修改及常见并行工具调用；若子 Agent rollout 缺失，相关字段降级为 `partial`。
- `turns list` 会为每轮输出紧凑的 `modelTiming`；`turns summary [sessionId]` 除纵览调用、Hook、文件、用量、错误和 diff 外，也汇总模型累计耗时、去重占用耗时、根/子 Agent 累计值和覆盖率。
- Codex 当前没有上报服务端精确 latency。新记录的 `response_intervals` 是从同一 Agent 线程的 turn start 或上一段工具/Hook 完成，到 `rawResponse/completed` 的观测区间；它适合定位流程等待，但可能包含请求构造、调度、传输和重试。
- `cumulativeMs` 会累计并行子 Agent 的模型时间；`occupiedMs` 是所有已观测模型区间的并集，用来与整轮墙钟比较。旧记录缺少 `modelTiming` 时保持 `unavailable`，不会被解释为 0。
- Recorder 只保证新生成记录使用当前口径；已经上传的旧版本记录不会被自动重写。
