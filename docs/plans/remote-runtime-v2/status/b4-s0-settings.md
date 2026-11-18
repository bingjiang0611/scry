# B4-S S0-1 · 设置页「后台服务」

设置里新增「后台服务」分区，范围按维护者 2026-11-12 的决定：状态、重启、退出、重新连接四项，不加日志查看（[P3-b4s-plan](../P3-b4s-plan.md)）。开关仍默认关闭；开关关闭时分区只显示「后台服务模式未启用」和数据目录，不提供任何操作。

## 用户看到什么

- **状态**：连接、版本、进程（pid）、运行时长、数据目录、已配对设备、运行中的任务。
  - 连接有四种：已连接、版本不一致（写出两边的版本）、本机连接已被撤销、不可用（写出原因代码）。
  - 已配对设备只数未撤销、未过期的设备，不含 App 自己的本机连接（与 `remote:status` 同一份过滤）；远程访问未启用时写「远程访问未启用」，不写 0 台。
  - 问不到的值显示「未知」，不显示 0。连接不是「已连接」时，App 不向 daemon 询问任何字段；进程号只取 `daemon.lock` 登记、且身份复核一致的 pid；版本只在 daemon 拒绝时自己报出过的情况下显示。
  - 打开分区时读一次，每次操作后再读一次，另有「刷新」按钮。不轮询：连接不可用时，读取会和其他调用一样尝试拉起后台服务，轮询会反复触发。
- **重启后台服务**：一直提供；版本不一致或不可用时它是主按钮，分区顶部有说明。
- **退出 Scry 与后台服务**：一直提供（开关打开时）。普通退出 Scry 仍不停止后台服务，行为没有改。
- **重新连接本机后台服务**：只在本机连接被拒（撤销，或已在另一实例入网）时出现，永远不会自动执行。

## 做法

| 文件 | 职责 |
|---|---|
| `src/main/background-service-stop.ts` | 读 `daemon.lock` → 用身份复核 → 再读一次锁和身份 → 只发一次 SIGTERM → 有界等待 → 观察监护进程退出 → 列出残留。无 Electron，无同步 I/O |
| `src/main/background-service-actions.ts` | 三个动作的顺序与二次确认规则 |
| `src/main/background-service-status.ts` | 合成状态；daemon 的回答逐字段校验 |
| `src/main/background-service-copy.ts` | 确认框与失败原因的中文文案 |
| `src/main/bootstrap/background-service.ts` | Electron 边缘：路径、确认框、`app.quit`，注册四个通道 |
| `src/daemon/local-ops/background-service.ts` | daemon 的本机 op `localBackgroundService:status` |
| `src/renderer/components/BackgroundServiceSettings.tsx`、`src/renderer/background-service-view.ts` | 分区界面与状态投影 |
| `src/preload/background-service.ts` | 四个无参数的 preload 方法 |

- **只停登记且身份一致的进程。** 进程身份在问用户之前读一次，确认之后、发信号之前再读一次（锁记录和进程身份都重读）。锁换了持有者、pid 的身份变了、身份读不出来、锁读不出来，都不发信号，并返回原因。只发一次 SIGTERM，不发第二次，不用 SIGKILL，不按进程名匹配。超时（15 秒）就停在那里，报「没有再次发送信号，也没有强制结束」。
- **身份读取不阻塞。** `process-diagnostics.ts` 新增异步的 `readProcessIdentity`，和锁模块写记录用的同步读取器读同一份数据（Linux 读 `/proc`；macOS 用同样的 `ps` 参数和 `TZ=UTC`），所以两边的身份键一致。
- **监护进程不发信号。** 它没有写身份记录。daemon 正常退出（退出码 0）时它自己结束（`supervisor.ts`）。如果 daemon 的父进程能看出是 `daemon-supervisor.js`，就记下它的身份，只观察它是否退出；5 秒内没退出，就列为残留。
- **停止期间不拉起后台服务。** 懒连接面新增 `holdLaunches()`：所有经它创建的连接模式（包括运行模式内部的重连）在持有期间拉起都返回 `daemon_stopping`。否则一次重试的读请求会在停止过程中把旧的后台服务又拉起来。退出时一直持有到 App 退出。
- **重启**：识别持有者 → daemon 报告有运行中的任务、或无法询问时（版本不一致就无法询问），二次确认，写明后果「被中断并记为 failed(host_restarted)」→ 停止 → `restart()` 丢掉本次会话记住的结果，重新探测、拉起、连接。重启后版本仍不一致（例如另一个监护进程又拉起了旧版本），如实报告。
- **退出**：同样的识别和确认规则；停止失败时 App 不退出并说明原因。停止后检查残留：`daemon.lock` 和 `scry-userdata.lock`（仍指向已停止的进程时才算）、`local.sock`、`enroll.sock`、`remote/pairing/pairing-state.lock`、`remote/ledger/session-ledger.lock`、监护进程。有残留时先弹框列出，然后退出。
- **重新连接（§13.2）**：只在连接状态为「本机连接已被撤销」时执行 → 识别持有者 → 二次确认（App 没有授权，问不到 daemon 有没有运行中的任务，所以总是确认）→ 再次核对身份并 SIGTERM → 删除 App 保存的、已被 daemon 拒绝的本机凭据（`daemon-client.json`）→ 重新拉起；daemon 启动时没有有效的本机授权，会写入新的一次性 secret，App 用它重新入网。凭据必须删：被拒时客户端只探测、不清凭据，留着它，下次连接还会拿出这份被撤销的凭据。顺序与 [P3 §13.2](../P3-batch4-design.md) 一致：先确认，再复核身份、发信号。计划表里把「二次确认」写在 SIGTERM 之后，但发信号之后再确认已经没有意义。
- **通道。** 四个通道都不接受参数，带参数一律 `invalid_request`。渲染端无法指定 pid、路径或确认结果，确认框都是 main 自己的 Electron 对话框，默认按钮是「取消」。`remote:backgroundService:{restart,quit,reconnect}` 路由为 `main`；`remote:backgroundService:status` 为 `split`：开关打开时，闸门把它交给 daemon，App 先用 guard 自己回答（连接结果、锁持有者），只在已连接时用 `callDaemonChannel` 询问 daemon。路由写在新文件 `scripts/daemon-ipc-routing-service.json`，因为 `daemon-ipc-routing.json` 已有 18.8 KB，加上这几行就超过 20 KB。矩阵脚本和闸门测试都改为合并读取它。通道放在 `remote:` 命名空间下（与 `remote:desktop:*` 同形），由性能路径 `remote` 的 `ipc.remote:` 覆盖：`scripts/performance-paths.json` 已有 19,985 字节，再加一行就超过 20 KB 的提交门禁；后台服务本身就是远程运行时的宿主，归入 `remote` 路径也说得通。
- **op 名**：`localBackgroundService`，不与设备 op 重名（已有测试检查全部本机 op 名）。

## 测试（新测试都先失败，或先跑对照实验）

- 单测：`background-service-stop.test.ts`（13）、`background-service-actions.test.ts`（16）、`background-service-status.test.ts`（8，含同步、异步身份读取器一致）、`daemon-run-lazy-restart.test.ts`（2）、`bootstrap/background-service.test.ts`（5，经生产的 `registerTrustedIpcHandler` 与闸门注册）。
- 真实进程：`background-service-stop-process.test.ts`，在临时 userData 里起一个真实子进程：身份一致时停止它；记录的身份不是它的时候不发信号，它继续运行。
- 真实 daemon：`host-process-background-service.test.ts`，用 `startTestDaemon()`。先失败，结果是 `unknown_op`。
- 渲染端：`BackgroundServiceSettings.test.tsx`（10，SSR）。设置页的标签测试先失败。
- preload：通道表加了四个方法，并新增一条测试：渲染端传入的参数不会被转发。先失败。
- 矩阵：通道数从 168 改为 172，preload 调用数从 168 改为 172。依据是新增的四个注册，不是放宽检查。
- 对照实验：逐项改坏保护，相应测试都失败，恢复后全部通过。
  - 停止：跳过发信号前的复核；超时当作已停止；身份读不出来当作已退出；顺带向监护进程发信号；准备阶段不核对身份。
  - 动作：无法询问时不确认；重新连接不确认；停止被拒仍然退出；授权有效时也重新连接。
  - 状态：未知值写成 0；daemon 的回答不校验。
  - daemon op：把 App 自己的本机授权算作设备；远程访问未启用时报 0 台。
  - 懒连接：持有不生效；`restart()` 沿用旧结果。
  - 通道：监听器接受参数；guard 接受参数；不装 guard。
  - preload：转发参数。
  - 渲染：未知显示成 0；总是提供「重新连接」。

## 门禁（Linux 容器，root）

- `npm run typecheck` 通过。
- `npx vitest run src/daemon src/main src/renderer src/preload scripts/daemon-ipc-matrix.test.ts scripts/performance-feedback.test.ts`：4646 通过、3 跳过、4 失败。失败的 4 项都是本容器已知的环境问题：`desktop-directory-picker`、`db-outbox`（root 下 chmod 不生效），`MarkdownLayout`、`SessionRename`（无头 Chromium）。
- `npm run performance:measure`：Ratchet 通过，没有 `worse`。这次改了 `index.ts`，它在 `sources` 里，所以跑了这一项。`analytics.sqlite` 在本容器记为 unavailable（better-sqlite3 的 ABI 不匹配），与本次改动无关。
- `node scripts/daemon-ipc-matrix.mjs`：172 个通道，生成文档已是最新。

## 维护者决定（2026-11-12）

- **启动时版本不一致：弹一次系统对话框**（批准）。做法见下一节。之前只在分区里说明并把重启设为主按钮，分区的行为不变。
- **「退出 Scry 与后台服务」不加菜单项**（决定不加）。它只在设置页里：App 没有自定义应用菜单，加一项就要替换整个默认菜单。
- **通道名 `remote:backgroundService:{status,restart,quit,reconnect}` 接受**，不改名。

## 启动时版本不一致提示

App 进程里第一次得知后台服务是另一个版本时，弹一次原生对话框（有主窗口时挂在主窗口上）。

- **触发**：沿用已有的检测，不加探测。懒连接面（`daemon-run-lazy.ts`）新增 `onOutcome(listener)`：它自己连接得到的每个结果（首次使用、`unavailable` 后再问、daemon 消失后的重连）都告诉观察者；`restart()` 的结果不告诉，那是用户发起的动作，由动作自己报告。观察者抛错不影响运行调用。渲染端启动时 `useBackgroundWork` 会调 `activeRuns()`，所以实际上窗口加载后就会弹；不阻塞窗口创建，主进程不等用户回答，没有同步 I/O。开关关闭时没有懒连接面，也就不订阅。
- **对话框**：标题「后台服务版本不一致」，写出两边的版本；没有已保存凭据、在入网时被拒的情况，用入网回复里 daemon 自报的版本（2026-11-12 补上）；daemon 没有报出、或报的不像版本号（`DaemonClientError` 只接受 ≤ 64 字符的版本形字符串）时写「版本未知」，不猜。说明运行任务和终端需要版本一致的后台服务。按钮「重启后台服务」（默认）和「稍后」（取消）。文案在 `background-service-copy.ts`（`versionMismatchPrompt`、`restartFailedNotice`）。
- **「重启后台服务」**：调用设置页的同一个重启动作（同一个 `exclusive` 包装，`busy` 共用），身份复核、二次确认、停止期间不拉起、失败原因都是同一份代码。版本不一致时问不到 daemon 有没有运行中的任务，所以一定还会出现第二个确认框「重启后台服务会中断正在运行的任务」。用户在第二个框里取消，就什么也不做。
- **失败**：用已有的失败原因文案（`reasonMessage`）再弹一个说明框，不自动重试。重启动作抛错时记为 `background_service_restart_error`，同样弹说明框。
- **「稍后」**：什么也不做；设置页仍提供重启。
- **只弹一次**：守卫在第一次 `await` 之前就置位，所以对话框开着时再来的检测、任何回答之后，都不会再弹。检测到时如果设置页的某个动作正在进行，不弹，也算用掉了这一次（用户正在处理后台服务）。新的 App 进程会重新判断。
- **判断逻辑**在纯模块 `src/main/background-service-mismatch-prompt.ts`（对话框、重启、失败说明都由外部注入）；`bootstrap/background-service.ts` 只接线。`src/main/index.ts` 没有改。没有新增通道。

测试（都先失败，再做对照实验）：

- `background-service-mismatch-prompt.test.ts`（10）：重启、稍后、并发两次检测只弹一次、失败只报一次不重试、抛错也报、第二个确认框取消时不弹失败、其他连接状态和开关关闭不弹、动作进行中不弹、文案（两个版本、版本未知、默认按钮与取消按钮）。
- `daemon-run-lazy-restart.test.ts`（+1）：自己连接的结果告诉观察者，`restart()` 的结果不告诉，观察者抛错不影响。
- `bootstrap/background-service.test.ts`（+2）：经生产注册，检测到不一致时在主窗口上弹一次，点「重启后台服务」走重启动作；「稍后」不调用重启、不持有拉起；相同版本不弹。
- 真实 daemon：`src/daemon/host-process-version-mismatch.test.ts`，用 `startTestDaemon()`（版本 `test`）。先用同版本客户端入网并保存凭据（模拟升级前的 App），再用版本 `2.0.0` 的懒连接面、同一 userData 调两次 `activeRuns()`：两次都是 `daemon_version_mismatch`，观察者只收到一次结果（`running: 'test'`），只弹一次，「稍后」之后旧凭据仍能连上同一个 daemon。真实的重启（SIGTERM 与重新拉起）这里没有覆盖：harness 的 daemon 在测试进程内，没有 `daemon.lock` 持有者可停，这部分由 S0-1 的真实子进程测试和 macOS 重放覆盖。
- 对照实验：去掉一次性守卫（4 项失败）；「稍后」也重启（2 项失败）；守卫在 `await` 之后置位（2 项失败）；`restart()` 也通知观察者（1 项失败）；懒连接面不通知（真实 daemon 测试失败）。

门禁（Linux 容器，root）：

- `npm run typecheck` 通过。
- 受影响的 13 个测试文件（`background-service-*`、`bootstrap/background-service`、`daemon-run-lazy*`、`daemon-run-mode`、`daemon-run-surface`、`host-process-background-service`、`host-process-version-mismatch`、`daemon-ipc-matrix`）：102 通过。
- `npx vitest run src/daemon src/main src/renderer src/preload scripts/daemon-ipc-matrix.test.ts scripts/performance-feedback.test.ts`：4662 通过、3 跳过、4 失败，失败的就是上面「门禁」一节里同样的 4 项本容器环境问题（`desktop-directory-picker`、`db-outbox`、`MarkdownLayout`、`SessionRename`）。
- `node scripts/daemon-ipc-matrix.mjs`：172 个通道，已是最新（没有新增通道）。
- 没有跑 `npm run performance:measure`：改动的文件都不在 `scripts/performance-paths.json` 的 `sources` 里（`index.ts` 没改）。

对 B4-V 场景脚本的影响：`upgrade` 场景现在会在新 App 上看到这个对话框（macOS 上是挂在窗口上的 sheet）。脚本经 `window.scry` 调用重启时，它的二次确认框会排在这个对话框后面；原来这一步就要等人点确认（脚本有 30 秒超时，写着「a native confirmation may be waiting」），无人值守时结果不变。有人值守时，先在提示框点「稍后」，再处理确认框。

### macOS 重放步骤（验证人执行）

准备两个 worktree：`OLD` 检出本提交之前的 `0bf3e97`，`NEW` 检出本分支。两边都 `npm ci && npm run build && npx @electron/rebuild -f -w better-sqlite3`。两边的 `package.json` 版本相同，所以在 `OLD` 里把 `version` 临时改成 `0.2.236` 再 `npm run build`（不提交）。

```sh
T=$(mktemp -d /tmp/scry-mismatch-XXXX); mkdir -p "$T/home" "$T/userData"
export HOME="$T/home" SCRY_TEST_APP=1 SCRY_HOST_DAEMON=1 SCRY_DAEMON_CREDENTIAL_PLAINTEXT=1 SCRY_REMOTE_HOST=0
"$OLD/node_modules/.bin/electron" "$OLD" --user-data-dir="$T/userData"   # 旧 App 拉起 0.2.236 的后台服务并入网
# 窗口出来后正常退出旧 App（Cmd+Q）；后台服务继续运行
cat "$T/userData/daemon/daemon.lock"; ps -o pid,lstart,command -p <锁里的 pid>
"$NEW/node_modules/.bin/electron" "$NEW" --user-data-dir="$T/userData"
```

1. 新 App 窗口加载后，主窗口上出现一个对话框：标题「后台服务版本不一致」，写「正在运行的后台服务版本是 0.2.236，本 App 的版本是 0.2.237」，按钮「重启后台服务」（默认，回车）和「稍后」（Esc）。记录截图。
2. 点「稍后」：没有别的框；`daemon.lock` 的 pid 与 `ps` 的身份不变；设置 →「后台服务」显示版本不一致、重启是主按钮；新建会话发一条消息、切换会话、打开设置几次，都不再弹。
3. 退出新 App 再启动（新进程）：对话框再出现一次。点「重启后台服务」→ 出现第二个确认框「重启后台服务会中断正在运行的任务」（写「无法确认后台服务里是否有正在运行的任务」）。先点「取消」：什么也不发生，`daemon.lock` 不变，也不再弹。
4. 再退出、启动一次，点「重启后台服务」→ 确认：旧 pid 消失，`daemon.lock` 换成新的 pid，`ps` 里没有 0.2.236 的 daemon 和监护进程残留；设置页显示已连接、版本 0.2.237；发一条消息能跑完。
5. 版本未知：换一个新的 `$T`，不经旧 App，直接按 `scripts/b4v/scenarios/upgrade.mjs` 的 `oldDaemonEnv` 启动旧 daemon（`ELECTRON_RUN_AS_NODE=1 SCRY_DAEMON_APP_VERSION=0.0.0-b4v-old … electron $OLD/out/main/daemon.js`），再启动新 App：对话框写出旧 daemon 自报的版本 `0.0.0-b4v-old`（取自入网回复），不是「版本未知」。
6. 开关关闭对照：旧后台服务仍在运行时，不设 `SCRY_HOST_DAEMON` 启动新 App：不弹任何框。
7. 失败说明框（例如重启后 15 秒内旧进程没退出）在 macOS 上不容易人为制造，可以不做；单测已覆盖。

结束后按 `daemon.lock` 的 pid 核对身份后停止残留进程，再删除 `$T`。

## 未验证与待定

- **未在 macOS 上验证（必须做）**：
  - 三个原生确认框的文案与默认按钮；
  - 版本不一致时的真实重启（旧版 daemon → 新版）；
  - 撤销本机授权后的重新连接（用另一个配对设备或命令撤销）；
  - 退出后 `ps` 中没有 daemon 和监护进程，`daemon.lock`、`scry-userdata.lock`、socket 和 lease 文件都不在；
  - `ps -o lstart` 的身份与 `daemon.lock` 记录一致，不会因为身份不一致而误拒。
  - 本容器是 Linux（root），只跑了单测、真实子进程和真实 daemon 测试。
  - 启动时版本不一致提示：对话框的样子、挂在主窗口上、默认按钮与 Esc、「稍后」后不再弹、「重启后台服务」接第二个确认框后真实重启，都没有在真实 App 里看过（按上面的 macOS 重放步骤做）。Linux 真实 App 也没有跑；入网被拒时显示 daemon 自报版本：真实 daemon 测试 `host-process-version-mismatch.test.ts` 第二项覆盖（改动前得到 `unknown`，先失败），真实 App 里按步骤 5 看。
- 运行中的任务数来自 daemon 的未结算 run（`unsettledStates`）。真实 daemon 测试只覆盖了 0 的情况，有运行中 run 时的计数没有用真实 run 验证。
