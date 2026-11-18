# B4-S F1/F2 · Linux 凭据后端修复的容器验证

日期：2026-11-12。决定、改动与未验证项见 [b4-s0-linux.md](b4-s0-linux.md) 的 F1、F2。本文只记录本容器里实际运行的探针与结果。提交：`65e4fd1`（F1，方案 A）、`168aa9a`（F2 文案）。

## 环境

本容器（Electron 42.10.1，Xvfb，非 root 用户 `scrysmoke`，每次临时 HOME/userData，`dbus-run-session`；"有密钥环" = `gnome-keyring-daemon --unlock --components=secrets`）。

最小探针（只加载本模块的 esbuild 产物，ready 前调用 `applyLinuxPasswordStore`，打印后端与加解密往返）：

| 条件 | 追加 | 后端 | `isEncryptionAvailable` |
| --- | --- | --- | --- |
| 有密钥环，`Hyprland`，不接线（对照） | — | `basic_text` | false |
| 有密钥环，`Hyprland`，接线 | `gnome-libsecret` | `gnome_libsecret` | true（往返成功） |
| 有密钥环，未设置，不接线（对照） | — | `basic_text` | false |
| 有密钥环，未设置，接线 | `gnome-libsecret` | `gnome_libsecret` | true（往返成功） |
| 有密钥环，`hyprland:wlroots`，接线 | `gnome-libsecret` | `gnome_libsecret` | true |
| 有密钥环，`GNOME`，接线 | 无 | `gnome_libsecret` | true |
| 有密钥环，`KDE`，接线 | 无 | `kwallet` | false（不改，仍 fail closed） |
| 有密钥环，`Hyprland`，`--password-store=basic`，接线 | 无 | `basic_text` | false（尊重显式选择） |
| 会话总线上没有任何服务（自定义 `dbus-run-session --config-file`，无 service 目录），`Hyprland` / 未设置，接线 | `gnome-libsecret` | `gnome_libsecret` | false（fail closed，立即返回） |
| 启动时不设 `DBUS_SESSION_BUS_ADDRESS`，`Hyprland`，接线 | `gnome-libsecret` | `gnome_libsecret` | false。注意：Electron 主进程里该变量最终仍有值，所以这一行**不能**证明"完全没有 D-Bus" |
| 普通会话总线、gnome-keyring 已安装但没启动、也没有已有密钥环，`Hyprland` / 未设置，接线 | `gnome-libsecret` | — | **未得出结果**：D-Bus 激活了 `gnome-keyring-daemon`，并弹出 `gcr-prompter`（要求为新密钥环设密码）；Electron 主进程一直等待（400 秒以上，SIGTERM 无效，以 SIGKILL 结束）。Xvfb 下无法回答这个对话框，取消路径没有验证 |

构建后的 App（`npm run build` 的 `out/`，开发布局；临时 app 根目录里 `better-sqlite3` 用 `prebuild-install --runtime electron --target 42.10.1` 的预编译包，其余依赖链接到仓库 `node_modules`；`SCRY_HOST_DAEMON=1`、`SCRY_TEST_APP=1`，**没有** `SCRY_DAEMON_CREDENTIAL_PLAINTEXT`；经 CDP 调用 `window.scry.activeRuns()` 与 `backgroundServiceStatus()`）：

| 条件 | 日志 | 结果 |
| --- | --- | --- |
| 有密钥环，`Hyprland` | 已追加 | `activeRuns` 成功，连接 `ready`，`daemon-client.json` 以 `v11` 开头（密文） |
| 有密钥环，未设置 | 已追加 | 同上 |
| 有密钥环，`GNOME` | 无 | 同上（行为不变） |
| 有密钥环，`KDE` | 无 | `daemon_credential_unavailable:unsafe_credential_storage`，没有写出凭据（行为不变） |
| 无任何 Secret Service，`Hyprland` | 已追加 | `daemon_credential_unavailable:unsafe_credential_storage`，没有写出凭据，没有 daemon.lock（fail closed） |

每次结束后 daemon 与 supervisor 均按 `daemon.lock` 身份核对后 SIGTERM，`remaining: []`；临时目录已删除，`scrysmoke` 名下没有遗留进程。
