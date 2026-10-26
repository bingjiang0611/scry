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

## 合入前的汇总验收（A–E 全部核验后，2026-10-26）

自动化部分已由执行方与审查方完成。以下是只能在真机上做的部分，**用分支最终构建跑一遍即可**，不必逐批重做。每个 Provider 用独立的临时 workspace、HOME 和 XDG，不在日常仓库操作。详细步骤见各批报告对应小节。

| # | 场景 | 来源 | 通过标准 |
|---|---|---|---|
| F-1 | 三个 Provider 各正常跑一轮 | A-1 | 每轮一条 record；OpenCode/Qoder 的短轮次可能在 180 秒后才落盘，以 recover 读回为准 |
| F-2 | Codex 在子目录启动；在多仓库工作区的**子仓库**里启动 | C-U2 | 子目录有 record；子仓库的情况如实记下（有 record、`bridge_not_found`，或者完全没有加载 hook） |
| F-3 | 长路径 workspace（socket 路径超过 100 字节） | C-U3 | `.scry/recorder-socket-path` 指向真实 socket，并且有 record |
| F-4 | 多仓库覆盖：根目录、`one/`、`a/b/c`（第 3 层） | D-U1～U3 | record 的 `diff.discovery` 列出请求目录；doctor 列出 `a/b/c` 并 warn；普通深目录不 warn |
| F-5 | 每轮 env：daemon 以 `SCRY_TURN_UPLOAD_ENABLED=0` 启动，会话 B 不设置该变量 | E-U1 | commit hook 收到的是 B 的「未设置」 |
| F-6 | 通知 v2 与新 uploader 接管 | E-U2 + U1 | uploader 按 `recordPath` 读取，`sha256` 一致，接管后才返回 0 |
| F-7 | uploader 短暂故障后恢复 | VE2 | 恢复后在退避时间到期时自动补投，不进死信；doctor 显示下次重试时间 |
| F-8 | 机器重启或 kill daemon 之后继续使用 | VC1 | 下一轮正常落盘，daemon 自动拉起，inbox 不积压 |

执行记录见 [F 报告](reports/F.md)：F-3～F-8 通过；F-1 只有 OpenCode 与 Pi 通过，Claude/Codex/Qoder 未通过或阻塞；F-2 的 Codex 场景未通过。

部署提醒：hook 脚本在 C、D、E 都有改动，存量 workspace 需要 `scry integrations repair --yes`，然后 `scry recorder restart`，再重启 Provider；Codex 要在 `/hooks` 重新确认 trust。
