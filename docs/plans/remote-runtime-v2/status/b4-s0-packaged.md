# B4-S S0-5 · 打包产物的 daemon 模式 smoke

日期：2026-11-12。起点：`08d0024`（`claude/scry-performance-optimization-46ngcf`）。计划见 [P3-b4s-plan.md](../P3-b4s-plan.md) S0-5：`pack:artifact` 之后，在 daemon 模式下跑 smoke，覆盖 worker 路径（run 输出、终端录制）、私有 CLI、资源路径；验收为 `check-packaged-app` 与 daemon smoke。

## 结论

- `scripts/daemon-mode-smoke.mjs` 新增 `--app <打包可执行文件>`。复用原有 harness（`launch({ devApp: false })`）和同一套步骤，另外从**进程与磁盘证据**核对打包布局。
- **Linux 容器 + Xvfb 下，打包产物 `dist/linux-unpacked/scry` 的 daemon 模式 smoke 连续 3 次全部通过**。开发布局 smoke 加入新增步骤后也通过。打包产物用了容器绕行方式构建（见“环境”），不是 CI 的发布构建命令。
- `packaged-linux` CI job 已加入打包产物 smoke，合同测试要求它存在、无条件执行，并且在 setuid helper 和 `check:packaged-app` 之后。真实 runner 结果要等第一次 CI 运行，目前记为 **pending**。
- **macOS 没有运行**（本容器是 Linux）。命令见“macOS 验证”。macOS 上 S0-5 在验证 agent 跑完之前不算通过。

## 打包产物与 test gate

发布构建没有拒绝 test gate，所以没有改动任何 gate：

- 源码中 `SCRY_TEST_APP`、`SCRY_ELECTRON_SMOKE_PROVIDER`（还需要 `ELECTRON_ENABLE_LOGGING=1` 和 `--remote-debugging-port`）、`SCRY_DAEMON_SMOKE_PROVIDER`（只在 daemon 进程内生效）、`SCRY_DAEMON_CREDENTIAL_PLAINTEXT`（还需要 `SCRY_TEST_APP=1`）都不看 `isPackaged` 或 `SCRY_RELEASE_BUILD`。`electron-builder.yml` 没有配置 Electron fuses，所以打包二进制仍然接受 `ELECTRON_RUN_AS_NODE`，也就是 supervisor、daemon 和私有 CLI 的运行方式。
- 已有的支持方式：`electron-security-smoke.mjs` 本来就用同样的变量驱动打包 App，smoke Provider 编译在 main bundle 里（`createSmokeProviderAdapter`）。
- 实测打包 App 接受了这些变量，daemon 以 `SCRY_DAEMON_PACKAGED=1` 运行。

## 打包布局下各路径怎么解析

| 项 | 打包时的实际路径（Linux） | 依据 |
| --- | --- | --- |
| supervisor | `<exe> resources/app.asar/out/main/daemon-supervisor.js`，`ELECTRON_RUN_AS_NODE=1` | `daemon-launch.ts`：`execPath` + `app.getAppPath()/out/main` |
| daemon | `<exe> resources/app.asar/out/main/daemon.js` | `supervisor-main.ts`：supervisor 所在目录下的 `daemon.js` |
| 终端录制 worker、run 输出 worker | `new URL('./…-worker.js', import.meta.url)`，从 daemon.js 所在目录加载，也就是 asar 内 | `host-process.ts` |
| 私有 CLI | `<SCRY_DAEMON_RESOURCES_PATH>/bin/scry`；打包时 `requirePrivateCli`，缺失时 daemon 以 exit 4 拒绝启动 | `recorder-cli-runtime.ts` |
| better-sqlite3 / node-pty | `resources/app.asar.unpacked/node_modules/…` | `electron-builder.yml` 的 `asarUnpack` |

## smoke 新增的步骤

每一项都是结果 JSON 里的一个命名步骤。证据缺失时步骤记为 `ok: false` 并写明原因，任何一个不是 `true`，进程就以 exit 2 退出：

| 步骤 | 证明什么 | 证据来源 |
| --- | --- | --- |
| `packagedArtifact`（仅 `--app`） | 目标确实是当前的打包产物 | 可执行文件存在且可执行，并且是 `packagedAppLayout` 为该目录给出的那个文件（开发版 Electron、改名或复制的二进制都会被拒绝）；`resources/app.asar` 存在，内含 `daemon.js`、`daemon-supervisor.js` 和两个 worker；产物版本等于源码版本。失败时不启动 App |
| `daemonProcesses` / `daemonProcessesAfterRestart` | daemon 与 supervisor 运行的是目标二进制和 asar 内入口；SIGKILL 后重新拉起的 daemon 也一样 | 通过 `daemon.lock` 找到 daemon，并按 `identityKey` 校验；supervisor 必须是 lock 记录的进程并且是 daemon 的父进程。Linux 读 `/proc/<pid>/exe` 和 `cmdline`，macOS 读 `ps comm=` 和 `command=`。环境变量核对 `ELECTRON_RUN_AS_NODE=1`、`SCRY_DAEMON_PACKAGED`、`SCRY_DAEMON_APP_PATH`、`SCRY_DAEMON_RESOURCES_PATH` 和本次的 `SCRY_DAEMON_STATE_DIR` |
| `runOutput` | run 输出 worker 写出了这次流式 run 的输出 | 通过 ledger 的 `bound` 事件把 App run id 对应到 ledger run id；`userData/remote/output/<sha256>.jsonl` 和 `.idx` 都非空，并且 jsonl 里有该 run 的 `output` 文本 |
| `terminalRecording` | 终端由 daemon 持有，录制 worker 在当前布局下工作 | shell 的父进程是 daemon pid；输出中有 marker（命令里是八进制编码写法，回显不会误匹配）；exit 0；`terminalRecordingRead` 返回 `complete` 且含 marker；列表项为 `complete`；`userData/terminal-recordings/<id>.json` 和数据文件都非空 |
| `privateCli`（仅 `--app`） | daemon 实际使用的私有 CLI 存在、位于打包 resources 内，并且能运行 | 路径取自 daemon 环境中的 `SCRY_DAEMON_RESOURCES_PATH`；realpath 必须在打包 resources 内（软链接指到外面会被拒绝）；必须可执行；`--version` 等于 `resources/scry-cli/package.json` |
| `daemonStopped` | 本次启动的 daemon 已经停止 | 改用 `b4v/fixture.mjs` 的 `stopFixtureDaemon`：按 lock 身份和本次 state 目录的环境变量定位进程，每次发信号前都重新校验身份。原来的清理只认得 checkout 的 `out/main`，打包时会漏掉 daemon |

另外：`--log` 可以指定失败日志的路径（打包时默认是 `daemon-mode-smoke-packaged.log`）。`packaged-artifact-guard.mjs` 的 Linux 版本读取原来指向不存在的 `resources/app/package.json`，现在改为读 `app.asar` 内的版本。`b4v/process-identity.mjs` 新增 `readLaunch`。

## 本容器内的实际结果

### 环境

| 项 | 值 |
| --- | --- |
| 系统 | Ubuntu 24.04.5 LTS，x86_64，容器（root），Node 22.23.4 |
| Electron | 42.10.1（ABI 146） |
| 显示 | `xvfb-run`（Xvfb 2:21.1.12），不是目标桌面 |
| GUI 用户 | 非特权用户 `scrysmoke`。Chromium 拒绝以 root 身份运行且不带 `--no-sandbox`，所以没有用 root；全程没有 `--no-sandbox` |

### 打包

| 命令 | 结果 |
| --- | --- |
| `npm run build && npm run build:cli` | 通过 |
| `SCRY_RELEASE_BUILD=1 node scripts/run-electron-builder.mjs`（CI 命令） | **失败**：`@electron/rebuild` 重编 `node-pty` 时，从 electronjs.org 下载 headers 被容器代理拒绝（`Proxy response (403) !== 200 when HTTP Tunneling`），随后 `electron-builder failed with exit 1`。与 S0-7 记录的限制相同；CI runner 可以访问 electronjs.org |
| 容器绕行（只用于本容器，不进 CI） | `better-sqlite3` 用 `prebuild-install --runtime electron --target 42.10.1`（本机缓存中的 v146 预编译包）；`node-pty` 用 Node headers 编译的 N-API `pty.node`，在 Electron run-as-node 下实测能 spawn。然后执行 `electron-builder --dir --config.npmRebuild=false`。没有产出 pacman 包 |
| `npm run check:packaged-app` | 通过（`nodePty: true`，`scryCliBundled: true`，`scryCliVersion: 0.2.56`，`preload: cjs`） |

### smoke

| 命令（以 `scrysmoke` 身份，`xvfb-run`） | 结果 |
| --- | --- |
| `node scripts/daemon-mode-smoke.mjs --app dist/linux-unpacked/scry` | **3/3 全部通过**，exit 0，每次约 8 s。daemon 与 supervisor 的 exe 都是 `dist/linux-unpacked/scry`，入口为 `resources/app.asar/out/main/daemon(-supervisor).js`；SIGKILL 后新 daemon 同样如此。流式 20 次到达，中位间隔 150–151 ms。run 输出 worker 文件 2462 B + 176 B，171 字符，等于界面文本。终端 shell 的父进程是 daemon，录制 `complete`，386 B，含 marker。私有 CLI 为 `resources/bin/scry`，版本 0.2.56。结束后 `remaining: []`，没有遗留进程 |
| `node scripts/daemon-mode-smoke.mjs`（开发布局，加入新增步骤） | 通过，exit 0；daemon 与 supervisor 指向 `node_modules/electron/dist/electron` 和 checkout 的 `out/main`，`SCRY_DAEMON_PACKAGED=0`；终端与 run 输出步骤通过 |

### 测试

- 新增 `scripts/daemon-mode-smoke/{packaged,processes,cli}.test.mjs`。包括 `--app` 指向不存在的文件、指向开发版 Electron、缺少值时都会 fail closed（exit 2，不启动 App，清理完成）；非打包目录、asar 缺入口、产物过期、不可执行、私有 CLI 缺失/越界/版本不符、开发进程冒充打包进程、pid 复用、supervisor 不是父进程，都会失败。
- 负对照：用旧版 `daemon-mode-smoke.mjs` 跑 CLI 对照测试，3 条全部失败（旧版忽略 `--app`，静默改为驱动源码构建）；去掉布局校验后，开发版 Electron 的两条对照失败；去掉 `executable_mismatch` 后，两条进程对照失败。恢复后全部通过。
- `ci-linux-daemon-smoke.test.ts` 先加断言，确认失败（`Missing workflow step: Daemon mode smoke against the packaged app`），再改 `ci.yml`，然后通过。`pr-workflow.test.ts` 通过，`npm run typecheck:node` 通过。

## CI 改动

在 `packaged-linux` 中（没有新增 job、secret 或 runner）：

1. `Enable the Chromium setuid sandbox helper` 也处理 `dist/linux-unpacked/chrome-sandbox`。打包可执行文件使用它旁边的 helper，不使用 node_modules 里的。
2. 开发布局 smoke 之后新增 `Daemon mode smoke against the packaged app`：`xvfb-run … node scripts/daemon-mode-smoke.mjs --app dist/linux-unpacked/scry`。
3. 失败时上传 `daemon-mode-smoke-packaged.log`（保留 3 天）。

`docs/agent/pr-workflow.md` 的接线表和 `docs/agent/verification.md` 的 Linux 小节已同步。

## macOS 验证（交给维护者的验证 agent）

```sh
npm run pack:artifact
node scripts/daemon-mode-smoke.mjs --app dist/mac-arm64/Scry.app/Contents/MacOS/Scry
```

`pack:artifact` 包含 build、build:cli、electron-builder、`check:packaged-app` 和 `smoke:electron`。Intel Mac 的路径是 `dist/mac/Scry.app/…`。产物版本与源码不一致时，smoke 以 `app_artifact_stale` 拒绝运行。

macOS 上有以下几点没有验证。如果某项拿不到证据，对应步骤会失败并写明原因，不会算作通过：

- 进程环境通过 `ps -wwE` 读取，可执行文件路径通过 `ps -o comm=` 读取。打包 App 启用了 hardened runtime，`ps -E` 能否读到它的 run-as-node 子进程的环境没有验证。读不到时会报 `environment_unavailable`。
- `ps` 输出的 command 以空格拼接，所以 Scry.app 的路径里不能有空格。
- 本地签名身份、首次启动时的 Gatekeeper 校验，以及 smoke 专用凭据编码绕开 Keychain 的行为，都在 macOS 上没有实际运行过。

## 仍未验证 / pending

- macOS 打包产物 smoke（见上节）。
- 真实 runner 上的 `packaged-linux`，包括发布构建产出的 `dist/linux-unpacked`（本容器用的是绕行构建）和 AppArmor 限制下的 setuid helper 路径。
- pacman 包安装后的 smoke，以及 Arch/Omarchy、Hyprland/Wayland 目标机。S0-7 的 F1/F2（密钥环）对打包产物同样适用；本 smoke 用的是 smoke 专用凭据编码，不是密钥环验收。
- 真实 Provider（S0-2，另有授权项）。

## 附带发现

- `scripts/daemon-packaged-recorder-smoke.mjs` 原来写死了 `dist/mac-arm64`，用打包二进制运行的是 **checkout 的** `out/main/daemon.js`，版本号也写死。维护者 2026-11-12 同意改为 asar 内的入口，已改：
  - 用法 `node scripts/daemon-packaged-recorder-smoke.mjs [--app <打包可执行文件>]`，不带参数时按平台取默认产物（macOS `dist/mac-arm64/Scry.app/Contents/MacOS/Scry`，Linux `dist/linux-unpacked/scry`）；
  - 目标经同一个 `resolvePackagedApp` 校验（布局、asar 内入口、产物版本与源码一致），入口为 `resources/app.asar/out/main/daemon.js`，`SCRY_DAEMON_APP_VERSION` 取产物版本；
  - 新增进程证据：daemon 起来后读它的 argv（Linux `/proc`，macOS `ps -ww -o command=`），必须与「打包可执行文件 + asar 入口」完全一致；
  - 启动参数由 `scripts/daemon-mode-smoke/recorder.mjs` 生成，单测 `recorder.test.mjs`；把入口换回 checkout 的 `out/main/daemon.js` 时单测失败（对照）。
  - 本容器实测（产物用 `electron-builder --linux dir --config.npmRebuild=false` 构建，原生模块未按 Electron ABI 重编，daemon 以 `ELECTRON_RUN_AS_NODE` 运行）：`--app dist/linux-unpacked/scry` 与不带参数各一次，`ranPackagedEntry: true`、`liveCode: 0`、`missingCode: 4`；`--app node_modules/electron/dist/electron` 在启动前被拒（`app_executable_not_packaged_layout`）；结束后没有残留进程。macOS 未运行。
