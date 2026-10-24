# 用户本地验证清单

用户本地可验证 OpenCode、Qoder、Codex。每个批次的报告里，执行方按下面的格式写出具体步骤；这里给出 A 批次的模板。

**所有验证都用一个临时测试仓库**，不要在日常工作仓库里做（会写进真实 `.scry/records`）：

```bash
mkdir -p /tmp/scry-verify && cd /tmp/scry-verify && git init
# 安装本分支构建的 CLI 到临时前缀，不覆盖日常安装
npm run build:cli   # 在 scry 仓库执行，产物路径见报告
node <分支 CLI>/dist/cli/scry.js init --providers codex,qoder,opencode
```

## A 批次

| # | 步骤 | 预期 |
|---|---|---|
| A-1 | 正常跑一轮（三个 Provider 各一次） | `scry turns list` 每个 Provider 各多一条记录；`hook-skip.log` 为空 |
| A-2 | 把 `.scry/cli-path` 改成不存在的路径，再跑一轮 | Provider 不报错不卡顿；`.scry/logs/hook-skip.log` 出现 `cli_path_missing`；`scry doctor` 报 error |
| A-3 | 恢复 `cli-path`。临时让 UserPromptSubmit 失效（例如在该事件触发前把 `cli-path` 改坏、Provider 回复期间改回），让 Stop 正常到达 | 旧版本：没有记录、没有计数。新版本：有降级记录（`endReason` 为新值）或 orphan 带 payload，health 计数加一 |
| A-4 | 往 `scry.config.json` 里写入非法 JSON，再跑一轮 | `scry doctor` 报 error，日志里能找到 `invalid_config`；恢复后正常 |
| A-5 | Codex：在仓库子目录启动，跑一轮（为 C3 收集信息） | 记下是否有记录；若没有，记下 hook 执行时的 `CODEX_PROJECT_DIR` 和 cwd |

回报时把每一步的结果（通过 / 不通过 / 观察到的现象）发给审查方即可。
