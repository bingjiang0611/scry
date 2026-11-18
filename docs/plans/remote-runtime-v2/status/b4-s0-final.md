# B4-S S0 · 收口（提交 `5363521`，2026-11-17）

macOS darwin arm64（M2 Pro），验证方本地 agent，维护者授权 Codex、Qoder（费用不限）与 iPhone 开发签名客户端安装。Claude 没有账号，未授权，不跑。本页汇总 S0 每一项的最终判定和证据来源，逐轮细节见同目录各文件。

## 判定

| 项 | 判定 | 依据 |
|---|---|---|
| S0-1 后台服务设置与原生对话框 | 通过 | 5363521：版本不一致「稍后」不重启；重启确认「取消」不重启、「重启」由 supervisor 接管且运行恢复；退出确认「取消」全部存活、「都退出」2 s 内退出且无 lock/socket 残留。用辅助功能（AX）按钮动作，不是物理按键；场景 upgrade、quit-all 各 7/7 |
| S0-2 真实 Provider：Codex | 通过 | 两种模式：发送、流式、工具、批准、拒绝、停止、recorder 记录与 SHA-256；恢复会话沿用同一 Provider 会话；原生分支得到新会话 |
| S0-2 真实 Provider：Qoder | 按能力降级 | CLI 1.1.89 直接运行正常；经 Scry 两种模式都失败，错误里带 CLI 自己的 stderr（`sdk_worker_removed …`，建议回退到 1.1.80）。两种模式一致，不是 daemon 问题；SDK 与新版 CLI 不兼容记为后续 |
| S0-2 真实 Provider：Claude | not-run | 本机无账号。Claude 与其他 Provider 共用 daemon 运行管线（发送、流式、审批、问题、停止、账本、recorder），由 Codex/Qoder 真实运行与 Claude 适配器的 fixture/单测覆盖；切换后第一次真实使用 Claude 时重点观察 |
| S0-2 MCP OAuth 重新认证 | not-run | 验证环境没有需要 OAuth 的 MCP 服务器 |
| S0-3 B4-V 场景表 | 通过 | sigkill 3/3（562c83f 之后）；upgrade、quit-all 用真实对话框动作通过；remote-device-visibility、auth-versus-run、local-plus-remote 用真机 iPhone 通过（local-plus-remote 在 iOS 客户端修复后通过，见下） |
| S0-4 真实数据副本 | 通过 | 先退出日常 App，`sqlite3 .backup` 加 rsync，排除 Chromium 单实例锁；daemon 模式与开关关闭逐项一致：token 949,184,432 / 111,027,346，turns 5,490，toolCalls 252,709，projects 20，用量统计与分析逐字节相同 |
| S0-5 打包产物 | 通过 | `/Applications/Scry.app`：check-packaged-app、daemon-mode-smoke、packaged recorder smoke 均通过 |
| S0-6 性能 | 通过，附说明 | L1 计数无 worse；会话打开 16/16 跑完，daemon 与进程内 P50 相差几毫秒，`loadSession` P95 尾部 daemon 更长（48–152 ms 对 12–32 ms，9/16 次高负载，不作结论）；native 对 PR base 132/132 通过。`startup.driverReady.singleMs` 是单次观测，同产物两次可差 1–2 s，不能判别 100 ms 级差异 |
| S0-7 Linux | 通过（Ubuntu runner） | packaged-linux 两个 daemon smoke 持续通过；Arch/Hyprland 目标机 not-run |

## S0 期间修复的缺陷

| 提交 | 缺陷 |
|---|---|
| `562c83f` | daemon 被强杀后，App 一直显示「运行中」（读取循环停止后没有被重新唤醒） |
| `91cac43` | 不带输出的 trace 事件不通知 App，原生轮次状态最多晚 15 s |
| `3b2bc0e`、`9a2b5b4` | 运行结束后最后几条 trace（用量、response_completed、本轮 diff）读不到；只对本机 App 开放，配对设备仍得到 `run: null` |
| `9d347b0` | 先标记结束、后送最后的文字 |
| `ef5d003` | Qoder CLI 失败没有 stderr 诊断 |
| `5363521` | trace 超过 4 MiB 时 App 读不到分段回复，窗口停止更新 |
| `7a0463b`、`564d73f`、`8dffe58` | 统一对话结束不通知窗口；滚动跟随；弹窗退出动画（后两项移植自 main） |

## 后续（不阻塞 S1+S3）

- 轮次 diff 把 `.scry/` 数据目录算作改动：App 的首次采集、兜底采集和会话基线都没有排除数据目录（`scry init` 写入 `.git/info/exclude` 的仓库不受影响）。三处需要一起改。
- Qoder SDK 与 CLI ≥ 1.1.8x 不兼容。
- daemon 模式下删除会话的确认框不显示侧聊数量；daemon 不能在睡眠唤醒后刷新中继连接（需要 App 转发电源事件）；App 仍直接读取会话存储（S3 第 10 步改为问 daemon）。
- CI 的 native 门禁在 macOS runner 上首轮常因负载失败、重跑通过；`startup.driverReady` 应改为多次采样。是否调整由维护者决定。
- iOS 客户端三处缺陷（选文件夹永远在读取、发送箭头与真实可发送状态不一致、模型列表不能滚动）已由验证方在本地分支修复并在真机上验证，尚未合入本分支。
