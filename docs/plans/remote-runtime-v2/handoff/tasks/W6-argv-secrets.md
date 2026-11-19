# W6 · MCP 密钥不进 Provider 命令行：macOS 真机核对

执行方 A。可与 W1 穿插进行（W1 安装的正式包已包含本修复时，可直接用它）。

## 背景

维护者 2026-11-19 决定优先修复：经授权的 MCP 配置（远程的请求头、stdio 的 `env`）与 Claude 的历史检索 token 曾整段进入 Provider 的命令行参数，本机其他用户可用 `ps` 看到。核验方已在本分支修复（提交 `d29a6cf3`…`0bda19ec`），只在 Linux 上做过单元验证。记录见 [STATUS-BATCH4](../../STATUS-BATCH4.md) 的两行「已知问题」。

| Provider | 修复 | 仍暴露 |
|---|---|---|
| Claude | 配置写进 0600 私有文件（0700 临时目录），`--mcp-config <路径>`；运行结束删除，启动 5 秒后清扫崩溃遗留 | 无 |
| Qoder | 同上 | 配置里带 `tools` 键的服务器仍走 SDK 内联参数（测试已钉住） |
| Codex | 远程静态请求头改为从 app-server 的环境变量读取（`env_http_headers`） | stdio 服务器的 `env` 仍在参数里，等维护者决定方案 |
| OpenCode、Pi | 原本就不进参数，未改 | — |

## 项目与验收

用测试实例（临时 HOME 与 userData、临时 Git 工作区）。在工作区放一份测试用 MCP 配置：一个远程服务器带请求头 `X-Test-Secret: W6-HEADER-<随机>`，一个本地 stdio 服务器（可用任意回显参数与环境变量的小脚本）带 `env` 里的 `W6_ENV=<随机>`。

| # | 项目 | 验收 |
|---|---|---|
| 1 | Claude（不可用则标 not-run） | 运行期间 `ps -axww -o pid,command` 中，任何进程的参数里都不出现两个随机值和历史检索 token；stdio 服务器实际收到 `W6_ENV`；运行结束后 `$TMPDIR/scry-mcp-config-*` 目录被删除 |
| 2 | Qoder（真实运行，已授权） | 同 #1；另放一个带 `tools` 键的服务器，确认它按预期仍出现在参数里（已知例外） |
| 3 | Codex（真实运行，已授权） | 请求头随机值不出现在任何进程参数里，远程服务器收到该请求头（服务器端记录）；stdio `env` 随机值**仍会**出现在参数里（已知，未修） |
| 4 | 崩溃清扫 | 运行中对测试实例的 App 进程 `kill -KILL`（只对自己启动、核实过 PID 的进程），重启测试实例后 5 秒内遗留目录被清扫；不删除其他用户或存活进程的目录 |
| 5 | macOS 的 `$TMPDIR` | 记录实际路径（macOS 为每个用户独立），确认目录权限 0700、文件 0600 |
| 6 | 回归 | 两个 Provider 的普通发送、工具调用、停止照常；历史检索在 Claude 上仍可用（若 Claude 不可用标 not-run） |

## 报告

`reports/W6.md`，第一行写状态。Codex stdio `env` 的方案不在本任务内（等维护者决定）。
