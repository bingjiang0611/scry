# B4-S S0 · macOS 第二轮验证（提交 `842ac2a`，2026-11-12）

机器 MacBookPro17,1（Apple M1，8 核），macOS 26.3.2，Node v24.18.0；新构建 build id `efd28db`，旧构建 `0bf3e97`（同为 0.2.237）。每个场景用独立临时 userData/HOME/workspace。

原生确认框无法用 UI 自动化点击（computer-use helper 协议不匹配、osascript 无辅助访问），验证方经维护者同意，在主进程注入钩子记录真实的 `dialog.showMessageBox` 参数并按脚本作答。文案、按钮和默认按钮来自真实参数；**原生对话框的实际渲染与真人点击未验证**。

## 结果

| 项 | 结果 | 要点 |
|---|---|---|
| A3 重启 | 通过 | 空闲 1.2 s 完成；有 run 时二次确认，默认按钮为「取消」，取消后 run 正常结算、pid 不变 |
| A4 退出 | 通过 | 有 run 时二次确认并可取消；空闲退出 715 ms 内进程与 lock、sock、lease 全部消失 |
| A5 同版本不同构建 | 通过 | 启动弹一次「0.2.237 (构建号未知)」对「0.2.237 (efd28db)」；「稍后」后不再弹；重启后恢复 |
| A6 丢失凭据 | 通过 | 695 ms 内显示「本机连接已被撤销」，不自动重连；确认后 865 ms 重新入网 |
| A7 版本号 | 通过 | 对话框写出 `0.0.0-b4v-old` |
| B 场景 | 8 pass / 1 fail / 2 partial | close-app、mutual-exclusion 的 partial 只因缺配对设备夹具或登录流程（not-run）；`terminal-after-quit`、`same-session-excluded`、`trust-gate` 均通过 |
| B upgrade | fail | 见下 |
| C 启动计时 | 有效 | runSurfaceReady P50：冷启动 1034.3、已运行 666.7、开关关闭 678.8 ms（负载/核 0.461） |
| E 打包 | 通过 | `pack:artifact`、打包 daemon smoke 全过；recorder smoke 见下 |
| F S1 首 token | 满足门禁 | 热启动 P50/P95：R1 125.4/145.2，R2 134.1/166.2；两轮 P95 相差 21.0 ms；负载/核 ≤ 0.38 |

## 两处失败与处理

1. **upgrade：重启后仍是 `daemon_device_not_authorized`。** 新 App 与直接启动的旧 daemon 入网时用掉一次性 secret，因版本不一致没有保存凭据；重启后新 daemon 仍有有效的本机授权，不再写 secret。这正是 `79644a2`（在本轮提交之后）修的情况：App 没有保存凭据时，「重启后台服务」在复核停止后写入一次性入网请求。待复验：`node scripts/b4v-scenarios.mjs --only upgrade`。
2. **打包 recorder smoke 在默认 TMPDIR 下失败。** 脚本用 `os.tmpdir()`（macOS 为 `/var/folders/…`），使 `enroll.sock` 路径达 101 字节，超过 daemon 的 100 字节上限（`daemon_socket_path_too_long`，exit 4）。产品行为正确（fail closed）；脚本已改为与 daemon-mode-smoke 相同的短 `/tmp` 根目录。待复验。

## 未验证

- 原生对话框的渲染与真人点击；
- `remote-device-visibility`、`auth-versus-run`、`local-plus-remote`（缺配对设备夹具 / smoke Provider 没有登录流程）；
- Linux（本轮只做 macOS）；
- 计时只有一台机器、一个会话；C 与上一轮的对比跨会话，只作方向参考。
