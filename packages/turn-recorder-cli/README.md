# @ali/scry-turn-recorder

Scry 的独立本地轮次记录 CLI。Provider 的生命周期 hook 调用它,把每个顶层用户轮次写成 `.scry/` 下的一个 JSON 文件。

- **不上传任何数据**,不依赖 Electron 或原生模块。
- **不是沙箱**:它记录发生了什么,不限制 Agent 能做什么。
- 支持 Node 20 / 22 / 24,macOS 与 Linux。Windows 不在支持范围。

## 安装与接入

```bash
npm install -g @ali/scry-turn-recorder@0.2.52 \
  --registry=https://registry.anpm.alibaba-inc.com

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
| `scry records archive --before 30d` | 归档旧记录(见「容量与归档」) |
| `scry records maintain [--apply]` | 检查 quota/retention，安全回收孤立正文与压缩轮转日志 |
| `scry support-bundle create` | 脱敏排障包 |
| `scry recorder status\|stop\|restart\|recover\|notify-drain` | daemon 与恢复 |
| `scry integrations diff\|repair\|uninstall` | 托管 hook 的漂移检查与修复 |
| `scry upgrade [--check]` | 升级 CLI |

所有命令都接受 `--workspace <root>` 或 `--workspace=<root>`,输出为 JSON。未知参数直接报错。

`status` 的三个阶段不可互相代替:`configured` 只证明配置写入,`hookSeen` 证明 hook 真的到达 recorder,`recordSeen` 才证明轮次已提交。`trusted` 永远是 `unknown` —— Codex 需要交互式确认,其余 Provider 不向 CLI 暴露信任状态;写 `n/a` 等于声称"不需要信任"。

`openTurnsPending`(未收敛的 open turn)与 `notifyBacklog`(commit hook 未 ACK 数)是两个不同指标,不要混用。

Agent、skill 与提示词不应主动调用这些命令。

## 文档导航

- [采集与运行语义](./docs/usage.md)
- [命令与配置参考](./docs/reference.md)
- [版本历史](./docs/history.md)
