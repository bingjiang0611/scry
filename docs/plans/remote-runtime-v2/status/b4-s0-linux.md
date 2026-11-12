# B4-S S0-7 · Linux daemon 模式验收记录

日期：2026-11-12。起点：`b2d8883`（`claude/scry-performance-optimization-46ngcf`）。计划见 [P3-b4s-plan.md](../P3-b4s-plan.md) S0-7 与维护者决定第 5 条。

## 结论

- **Ubuntu 容器 + Xvfb 下，daemon 模式在真实 Electron 中跑通**：开发布局完整 smoke 连续 3 次通过；打包布局（`dist/linux-unpacked`）用探针跑通 daemon 启动、终端、录制和一次 run。全程没有 `--no-sandbox`，renderer 在 Chromium sandbox 内。
- **目标桌面有阻断项（F1）**：Electron 42 在 `XDG_CURRENT_DESKTOP=Hyprland` 时把 `safeStorage` 选成 `basic_text`，**即使 gnome-keyring 已解锁也是如此**。daemon 模式会因此 fail closed（`daemon_credential_unavailable:unsafe_credential_storage`），所有 run、终端调用都失败。Omarchy 用的就是 Hyprland。在 S1 + S3 之后，daemon 是唯一路径、没有逃生开关，这一项不解决，Linux 目标机就无法运行任何 Agent。
- **建议**：按维护者决定第 5 条，**Linux 先不随 macOS 切换**，在状态里写明 F1/F2。另外需要维护者决定：S3 删除进程内管线后，"Linux 保持关闭"靠什么实现。修复方向见 F1，需要维护者先决定凭据策略，本 lane 不改产品代码。
- GitHub Actions 的 `packaged-linux` job 已加入 daemon 模式 smoke（见“CI 改动”）。真实 runner 的结果要等第一次 CI 运行，目前记为 **pending**，不当作通过。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 | Ubuntu 24.04.5 LTS，x86_64，Firecracker VM 内核 6.18.44（容器，非桌面会话） |
| Electron / Node | Electron 42.10.1（run-as-node 时 Node 24.18.1，ABI 146）；宿主 Node 22.23.4 |
| 显示 | Xvfb 2:21.1.12（`xvfb-run`），**不是** Wayland / Hyprland |
| 用户 | 容器默认 root。Chromium 拒绝以 root 运行且不带 `--no-sandbox`（`Running as root without --no-sandbox is not supported`），所以建了非特权用户 `scrysmoke` 来跑所有 GUI 步骤，没有用 `--no-sandbox` |
| sandbox | 非特权 user namespace 可用（容器内没有 AppArmor 限制）。Chromium 用 namespace sandbox；把 `chrome-sandbox` 设为 setuid root 后重跑仍通过（此时仍优先用 namespace sandbox） |
| 密钥环 | 默认没有 D-Bus 会话和密钥环。F1/F2 实验另装 `gnome-keyring 46.1`，用 `dbus-run-session` 加 `gnome-keyring-daemon --unlock --components=secrets` |

### 容器限制与绕行（只用于本容器，不进产品或 CI）

- `electron-builder install-app-deps` 和打包时的 `npmRebuild` 要从 `www.electronjs.org` / `artifacts.electronjs.org` 下载 Electron headers，本容器代理拒绝这两个主机（403）。`better-sqlite3` 的 Electron 预编译包能下载；`node-pty` 重编失败，构建目录还被清空。绕行做法：`node-pty` 是 N-API 模块，用 Node headers 执行 `npm rebuild node-pty` 得到的 `pty.node` 能在 Electron ABI 146 下加载，并且能真实 spawn（已验证）。打包用 `electron-builder --dir --config.npmRebuild=false`。CI runner 可以访问 electronjs.org，现有 `packaged-linux` 已在跑 `install-app-deps`，不需要这项绕行。
- 没有跑 `SCRY_RELEASE_BUILD=1` 的 pacman 构建（需要 fpm 下载，与 daemon 无关，CI 已覆盖）。

## 逐项结果

| # | 检查 | 结果 | 证据 / 原因 |
| --- | --- | --- | --- |
| 1 | `node scripts/daemon-config-smoke.mjs`（真实 Electron 二进制，`ELECTRON_RUN_AS_NODE=1`） | **pass** | 12/12：daemon 与 supervisor 入口缺任一必需变量都以 exit 2 拒绝 |
| 2 | 原生模块在 Electron ABI 下加载 | **pass**（容器绕行见上） | run-as-node 下 `better-sqlite3` 执行 `sqlite_version()` 返回 3.53.2；`node-pty` spawn `/bin/sh`，输出 `pty-hello` 与 `/dev/pts/0`，exit 0。未经 `install-app-deps` 时 `better-sqlite3` 因 ABI 127≠146 失败，这是预期行为 |
| 3 | `xvfb-run … node scripts/daemon-mode-smoke.mjs`（开发布局，非 root） | **pass ×3** | 发送→流式→完成；流式 20 次到达，中位间隔 151 ms；两轮提问与回答；停止；SIGKILL daemon 后重新拉起，新 run 完成 |
| 4 | renderer sandbox | **pass** | renderer 进程 `Seccomp: 2`、`NoNewPrivs: 1`，有独立的 user/pid/net namespace（`NSpid` 三层）；所有 Chromium 子进程 argv 都不含 `--no-sandbox`。注意 smoke harness 自带 `--disable-gpu`（已有 fixture 配置，产品默认值没有改） |
| 5 | daemon 进程身份：真实 Electron 二进制 + `ELECTRON_RUN_AS_NODE` | **pass** | daemon 与 supervisor 的 `/proc/<pid>/exe` 都是 `node_modules/electron/dist/electron`，打包布局下是 `dist/linux-unpacked/scry`；环境里有 `ELECTRON_RUN_AS_NODE=1`；argv 分别是 `out/main/daemon.js` 和 `daemon-supervisor.js`，打包布局下是 `resources/app.asar/out/main/…` |
| 6 | `daemon.lock` 的 `/proc` 身份 | **pass** | `identityKey = <pid>:linux:<boot_id>:<starttime>`，与 `/proc/<pid>/stat` 第 22 字段、`/proc/sys/kernel/random/boot_id` 一致；SIGKILL 后新 daemon 能接管（第 3 项） |
| 7 | unix socket 路径与权限 | **pass** | `userData/daemon/` 为 0700，`local.sock`、`enroll.sock` 为 socket 0600，`daemon.lock`、`logs/daemon.log`、`daemon-client.json` 为 0600，属主都是运行用户；socket 路径 47 字节，低于 Linux 上限 108 |
| 8 | 终端经 daemon：node-pty 运行在 run-as-node 进程内 | **pass**（开发与打包布局） | `terminalStart` 返回的 shell 的父进程是 daemon pid；写入命令后实时数据里有 sentinel；按 ack 协议确认字节后收到 `terminal:exit`（code 0）。没有 ack 时 exit 会被流控挂起，与进程内实现一致，不是缺陷 |
| 9 | 录制 worker（`terminal-recording-worker.js`）与 run-output worker | **pass**（开发与打包布局；打包布局的 worker 从 asar 内加载） | `terminalRecordingRead` 返回 `state: complete`，含 sentinel 和 `/dev/pts/N`；`terminal-recordings/*.bin` 与 `*.json` 为 0600；一次 smoke provider run 完成，`error: null` |
| 10 | 凭据：smoke 专用编码（`SCRY_TEST_APP=1` + `SCRY_DAEMON_CREDENTIAL_PLAINTEXT=1`） | **pass**（仅 fixture） | `daemon-client.json` 是明文 JSON（PEM 可见），符合这个开关的定义；只用于验收 |
| 11 | 凭据：没有密钥环（容器默认） | **fail closed（符合合同）** | `safeStorage` 不可用，所有调用返回 `daemon_credential_unavailable:unsafe_credential_storage`，没有写出凭据，也没有启动 daemon。见 F2 |
| 12 | 凭据：gnome-keyring 已解锁，`XDG_CURRENT_DESKTOP=GNOME` | **pass** | 后端为 `gnome_libsecret`；`daemon-client.json` 以 `v11` 开头（密文，不是 JSON）；daemon、终端、录制、run 全部通过 |
| 13 | 凭据：gnome-keyring 已解锁，`XDG_CURRENT_DESKTOP=Hyprland` | **fail** | 后端为 `basic_text`，`isEncryptionAvailable() = false`，App 返回 `daemon_credential_unavailable`。见 F1 |
| 14 | 打包布局 `dist/linux-unpacked` + `check:packaged-app` | **pass** | `check:packaged-app` 通过（`nodePty: true`，私有 CLI 在包内）；探针以 gnome-keyring（GNOME）跑通第 5–9 项 |
| 15 | 打包布局跑完整 `daemon-mode-smoke` | **not-run** | 这个 smoke 只支持开发布局（`devApp: true`）。打包布局的完整 daemon smoke 属于 S0-5 |
| 16 | Arch/Omarchy x86_64、Hyprland/Wayland 目标机 | **not-run** | 目标机不可用。Xvfb 与 `XDG_CURRENT_DESKTOP=Hyprland` 环境变量模拟都不能代替目标机；没有验证 Omarchy 默认是否运行并解锁 gnome-keyring |
| 17 | GitHub Actions `packaged-linux`（ubuntu-latest，setuid helper 路径） | **pending** | 改动已提交，没有 push，还没有在真实 runner 上运行 |

探针（容器内临时脚本，没有提交）：按 `daemon-mode-smoke.mjs` 的方式启动 App，读取 `/proc`、daemon 状态目录、终端与录制。`safeStorage` 探针是一个最小 Electron 主进程，打印 `getSelectedStorageBackend()` 与加解密往返结果。

## 发现

### F1 · Hyprland 下 safeStorage 默认为 basic_text，daemon 模式整体不可用（阻断 Linux 切换）

| 条件（gnome-keyring 已解锁） | 后端 | 可用 |
| --- | --- | --- |
| `XDG_CURRENT_DESKTOP` 未设置 | `basic_text` | 否 |
| `GNOME` | `gnome_libsecret` | 是 |
| `Hyprland` | `basic_text` | 否 |
| `KDE` | `kwallet`（没有 kwallet） | 否 |
| 任一值 + `--password-store=gnome-libsecret`（命令行，或在 ready 之前调用 `app.commandLine.appendSwitch`） | `gnome_libsecret` | 是 |
| 任一值 + 上述开关，但没有运行密钥环 | `gnome_libsecret` | 否 |

`unsafeCredentialStorageReason` 把 `basic_text` 和不可用的后端都判为不安全，这是正确的 fail closed。问题在于，切到 daemon 模式后，**本机 run 也要求这份凭据**：`daemon-run-mode.ts` 用 `safeStorage` 加密 App 访问本机 daemon 的 grant。而 `remote-connections.ts` 原来的注释写的是"纯本地项目不经过这条路径，密钥环不可用不应阻断它"。daemon 模式改变了这个前提。

可选方向（都需要维护者决定，本 lane 没有实现）：

1. 在 Linux 上，如果用户没有显式指定 `--password-store`，App 在 ready 之前追加 `password-store=gnome-libsecret`。探针已验证这样做后 Hyprland 下能选中 libsecret。但没有运行密钥环时仍然不可用（回到 F2），Omarchy 默认是否带 gnome-keyring 需要目标机确认。
2. 重新决定本机 daemon grant 是否需要 `safeStorage`。这份 grant 是 0700 目录内、指向 0600 socket 的客户端证书；同一用户的攻击者不在信任模型保证范围内；daemon 自己的宿主身份私钥本来就是 0600 明文文件（`userData/remote/identity/host-identity.json`，见 P3b 设计表）。但 CLAUDE.md 要求 Linux 默认不用明文凭据后端，所以改动必须由维护者明确批准。

### F2 · 没有密钥环的 Linux 会话里，daemon 模式下无法运行任何 Agent

这一项符合 fail closed 合同，但对用户的影响和 F1 相同：每次调用都报 `daemon_credential_unavailable`，界面上只能看到失败。与 F1 一起决定；最少也要在 S0-1 设置页把这个原因说清楚。

### F3 · `daemon-mode-smoke.mjs` 结束后遗留 daemon 与 supervisor（已修复，fixture 问题）

daemon 按设计比 App 活得久，smoke 只停止 App，然后删除临时目录。修复前，第一次运行后 supervisor（pid 2859）与 daemon（pid 2867）在临时 userData 已删除的情况下继续运行（运行时间 1:41 时仍在，手动 SIGTERM supervisor 后两者都退出）。macOS 上每运行一次本地 smoke 也会留下一对。修复：smoke 结束时读取 `daemon.lock`，只对命令行仍是本 checkout 的 `out/main/daemon(-supervisor).js` 的进程发 SIGTERM（Linux 上另外核对 `/proc` 的 starttime 与 boot_id），给 supervisor 发 SIGTERM 会一并停止 daemon；10 秒内没退出就 SIGKILL，并记为失败步骤 `daemonStopped`。修复后连续两次运行都是 `daemonStopped.ok = true`，`ps` 里没有遗留进程。macOS 上的这段清理没有验证（`ps -o command=` 格式相同，但没有实际运行）。

### F4 · daemon 在 userData 被删除后仍继续运行（观察，非 Linux 专有）

见 F3 修复前的现象：状态目录与 socket 已删除后，daemon 和 supervisor 不会自己退出。正常使用中很少遇到；是否需要监视状态目录由维护者判断，本 lane 不处理。

## CI 改动（已在本 worktree 提交，未 push）

`packaged-linux`（ubuntu-latest，已由 `Check` 汇总）在 pacman 检查之后追加：

1. `Enable the Chromium setuid sandbox helper`：`sudo chown root:root` + `sudo chmod 4755 chrome-sandbox`，与 `node`、`unit` job 现有做法相同。Ubuntu 24.04 runner 用 AppArmor 限制非特权 user namespace，Electron 需要 setuid helper；不用 `--no-sandbox`，不改 sysctl。
2. `Daemon entry configuration smoke`：`node scripts/daemon-config-smoke.mjs`。
3. `Daemon mode smoke in the real Electron`：`xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24' node scripts/daemon-mode-smoke.mjs`。
4. 失败时上传 `daemon-mode-smoke.log`（只包含临时 fixture 的 App 输出，保留 3 天）。

没有新增 job、secret 或 runner 类型；没有放宽任何现有检查。新合同测试 `scripts/ci-linux-daemon-smoke.test.ts`：三个步骤都必须存在且无条件执行，helper 必须在 smoke 之前，job 内任何命令都不允许出现 `--no-sandbox`、`--disable-gpu`、`ELECTRON_DISABLE_SANDBOX` 或改 AppArmor userns 的写法。`pr-workflow.test.ts` 已超过提交大小上限，所以新测试单独成文件；该文件原有的 job 列表与 `Check` 汇总合同仍然通过。负对照：给 smoke 加上 `--no-sandbox`、删掉 smoke 步骤、加入 `sysctl … apparmor_restrict_unprivileged_userns=0`，测试都会失败。`docs/agent/pr-workflow.md` 的接线表和 `docs/agent/verification.md` 的 Linux 小节已同步。

本容器内逐条验证过的命令：第 1 步（容器内以 root 直接执行 chown/chmod）、第 2 步、第 3 步（以非 root 用户执行）。runner 上的 setuid helper 路径（userns 受 AppArmor 限制）本地无法复现，记为 pending。这一项依据是 `unit` job 已经用同样配置在 runner 上运行 Electron fixture。CI 预计增加约 1–2 分钟。

## 仍未验证

- 真实 runner 上的 `packaged-linux` 结果（第 17 项）。
- Arch/Omarchy、Hyprland/Wayland、真实密钥环的默认状态（第 16 项，F1/F2）。
- 打包布局的完整 daemon smoke（S0-5）；pacman 安装、升级、卸载。
- daemon 模式下的真实 Provider（另有授权项，不在本 lane）。
