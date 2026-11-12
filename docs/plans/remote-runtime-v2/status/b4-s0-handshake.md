# B4-S S0 · App 与后台服务的握手（A5 构建号、A6 凭据丢失）

macOS 验证里发现的两个问题（A5、A6）的原因、修复、测试与复验步骤。设置页「后台服务」本身见 [b4-s0-settings.md](b4-s0-settings.md)。

## A5：同一版本号、不同构建没有被识别

**现象。** `npm run install:mac:dev` 重新构建并安装，但不改版本号。安装后旧 daemon 继续跑旧代码，新 App 直接连上（「已连接」），旧 daemon 答不上的字段显示「未知」。实测 3b04ee8 与 0bf3e97 两个构建都是 0.2.237，新 App 接管了旧 daemon。

**原因。** 握手只比较 `package.json` 的版本号：`daemon-client.ts` 的 `#requireVersion`、`daemon-supervisor.ts` 的 `adopt` 都是 `version !== appVersion`。daemon 的版本来自启动它的 App 传入的 `SCRY_DAEMON_APP_VERSION`，同一版本号的两个构建在这里没有区别。

**修复。**

- 构建号用已有的 `__SCRY_BUILD_ID__`：`electron.vite.config.ts` 在构建时用 `performanceBuildId()` 对 `src/`、`package.json`、`package-lock.json`、构建配置做 SHA-256，通过 `define` 写进 main 构建。daemon、监护进程和 App 主进程是同一次 main 构建的不同入口，所以同一次构建（开发布局 `out/` 或打包后的 asar）两边的值一定相同；daemon 代码有任何变化，值就不同。运行时只读一个常量：App 启动路径上没有哈希，handler 里没有同步 I/O。
- 新模块 `src/shared/build-identity.ts`：`scryBuildId()`（读常量，只接受 7–64 位十六进制）、`sameBuild()`（版本和构建号都要相同）、`mismatchLabels()`（显示用）。
- daemon 在 `daemonInfo` 回复里加 `build`，在入网回复里加 `daemonBuild`（`host-process.ts` 用 `buildIdentity(appVersion)`，值取自 daemon 自己的 bundle，不取自环境变量：常驻的旧 daemon 报的是它内存里那份代码的构建号）。
- App 侧 `DaemonClient`（选项 `appBuild`）、`ensureDaemon`（选项 `appBuild`）、`createDaemonRunMode`（`appDaemonModeDeps` 传入 `scryBuildId()`）都用 `sameBuild` 判断。**没有构建号的 daemon（修复前的构建）与有构建号的 App 视为不一致**（fail closed）；两边都没有构建号（单元测试，未打包代码）时只比较版本。
- 不一致沿用现有的 `version-mismatch` 状态、启动提示和重启动作，没有新状态。`DaemonRunModeResult` 增加 `runningBuild` / `expectedBuild`。
- 显示：版本号不同时照旧只写版本；版本号相同、构建不同时两边都写成 `0.2.237 (3b04ee8)`，daemon 没报构建号时写 `0.2.237 (构建号未知)`。设置页版本行、分区说明、启动提示都用这个标签（`connectionFromMode` 里组合，`BackgroundServiceConnection` 的字段类型不变）。用户可见的版本仍是包版本号。
- `scripts/b4v/scenarios/upgrade.mjs` 不用改：它的假旧 daemon 用同一份 `out/main/daemon.js` 报 `0.0.0-b4v-old`，版本号本来就不同，断言不变。

**取舍（请维护者知悉）。** 构建号覆盖整个 `src/`，只改了渲染端或测试文件的重装也会被判为不一致，需要重启一次后台服务。这是偏保守的方向；要缩小到只看 daemon 相关源码，需要另一份哈希范围，本次没有做。

## A6：丢了本机凭据的 App 面对仍在运行的 daemon，报超时而不是提供重新连接

**现象。** App 已连接 → 退出 App（daemon 继续）→ 删除 `<userData>/daemon-client.json` → 启动 App。约 10 秒后显示 `unavailable (daemon_ready_timeout)`，主按钮是「重启后台服务」。

**原因（三处）。**

1. daemon 只在没有有效本机授权时写一次性 secret（设计如此：另一个实例不能重新入网）。App 没有凭据，走入网；`DaemonClient.#enroll` 先读 secret，读不到就报 `daemon_enrollment_unavailable`，在连 `enroll.sock` 之前。于是「daemon 在运行但没有给我的 secret」和「daemon 根本不在」是同一个错误。
2. `createDaemonRunMode` 的探测把 `daemon_enrollment_unavailable` 当作「还没起来」，交给 `ensureDaemon` 拉起；新 daemon 发现 `daemon.lock` 被占用，以退出码 3 退出（`already-running`，不写 `supervisor-failure.json`）；App 一直轮询到 `daemon_ready_timeout`。
3. 即使分区显示「重新连接」，原有 §13.2 流程也会失败：重启后的 daemon 仍持有那份凭据对应的有效本机授权，照规则不写 secret，App 仍然无法入网。

**修复。**

- `DaemonClient.#enroll` 先连 `enroll.sock`，再读 secret。daemon 在打开 `enroll.sock` 之前已经决定是否写 secret（`host-process.ts`：`enrollment.ensure()` 在 `openLocalEnrollSocket()` 之前），所以：连不上 → `daemon_not_running`（缺席，可以拉起）；连上了但没有 secret → `daemon_enrollment_unavailable`（daemon 在运行，有效本机授权属于别的凭据）。
- `createDaemonRunMode` 把 `daemon_enrollment_unavailable` 归入拒绝（与 `daemon_device_not_authorized` 同列），映射为已有的 `device-not-authorized` 状态（`reason: 'daemon_enrollment_unavailable'`），**不拉起、不等待**。拉起之后等待期间出现同样的拒绝，也立即结束等待（通过 `launchFailure` 轮询），不再跑满超时。复用已有状态与文案：分区显示「本机连接已被撤销」并提供「重新连接本机后台服务」，永远不自动执行。分区说明和失败原因文案补了一句「或本 App 保存的连接凭据已丢失」。没有改为依赖 `daemon.lock` 校验来分类：`enroll.sock` 的应答已经证明 daemon 在运行；重新连接动作本身在确认前、发信号前两次核对 `daemon.lock` 身份，核对失败就不发信号（fail closed）。
- 让重新连接真正可用：新增 `src/daemon/local-enrollment-request.ts`。用户确认「重新连接」并且已核对身份、停止 daemon 之后（`background-service-actions.ts`，在 `holdLaunches` 期间），App 在状态目录写一个 0600 的 `local-enrollment-request.json`（异步写，temp + rename）。下一个启动的 daemon 在 `ensure()` 里读取并删除它，此时即使有有效本机授权也写 secret；App 用它入网，`enrollLocal` 按既有规则撤销上一份本机授权（确认框里已写明「如果连接是被另一个 Scry 实例接管的，那个实例会断开」）。请求超过 10 分钟、时间在未来超过 1 分钟、格式不对、不是 0600、不是普通文件（如符号链接）时忽略，并且同样删除，避免半途失败的重连在以后某次启动时拿走授权。

**信任边界说明（请维护者确认）。** 原规则是「secret 只在没有有效本机授权时存在」。现在多了一个例外：用户在 main 自己的确认框里确认重新连接之后。请求文件本身不含 secret、不授予任何东西；能在 0700 的状态目录里写它的进程，本来就能在那里读 secret，也能向 daemon 发信号。这属于 CLAUDE.md 所说「同一用户下的并发攻击者」，不在保证范围内。如果不接受这个例外，A6 只能分类正确、但「重新连接」会失败（重启后仍无 secret），需要另定方案。

## 测试

先写失败的测试，再改代码；修复后再逐项改坏保护做对照。

- A5（修复前均失败）：
  - `daemon-client.test.ts`：同版本不同构建在入网回复和 `daemonInfo` 两条路径都被拒，失败时不保存凭据，拒绝后同一构建仍能用原凭据连接（对照）；daemon 不报构建号而 App 有构建号时被拒。
  - `daemon-supervisor.test.ts`：同版本不同构建 → `version-mismatch` 且带两边构建号；daemon 不报构建号也不一致；同版本同构建仍 `adopted`（对照）。
  - `background-service-status.test.ts`：同版本时标签带构建号，版本不同时只写版本（对照）。
  - `shared/build-identity.test.ts`：读取 define、拒绝非构建号、`sameBuild` 各组合。
  - 真实 daemon（`host-process-version-mismatch.test.ts`，`startTestDaemon()`）：daemon 以旧构建号运行，旧构建入网并正常调用（对照）；同版本新构建的 App 用已保存凭据连接 → `version-mismatch`，标签 `test (3b04ee8)` / `test (0bf3e97)`。修复前该 App 直接拿到 `[]`（接管了旧 daemon），与 macOS 现象一致。
- A6（修复前均失败）：
  - `daemon-client.test.ts`：凭据丢失后连接 → `daemon_enrollment_unavailable`；`enroll.sock` 不在 → `daemon_not_running`（对照）。原有测试「reports a daemon that is not running」的期望由 `daemon_enrollment_unavailable` 改为 `daemon_not_running`：状态目录不存在就是 daemon 不在，旧名字正是本问题的混淆来源。
  - `daemon-run-mode.test.ts`：首个探测即拒绝 → `device-not-authorized`，不拉起；拉起后等待中出现 → 立即同样结果（修复前跑满超时）；完全无应答仍会拉起（对照）。
  - `local-enrollment-request.test.ts`：有效授权且无请求时不写 secret（对照）；请求让下一次 `ensure` 写 secret 且只生效一次；过期、未来、格式错、非 0600、符号链接都被忽略并删除。
  - `background-service-actions.test.ts`：请求在停止之后、释放 hold 之前写；daemon 不在时也写；取消或停止被拒时不写。
  - 真实 daemon（`host-process-lost-credential.test.ts`）：保留凭据时正常（对照）；删除凭据后 `ready()` 在 5 秒内返回 `device-not-authorized`，`launch` 未被调用（修复前约 10.3 秒后超时且调用了 launch）；完整重连链路（确认 → 停止 → 删凭据 → 请求 → 新 daemon 启动 → 入网）后运行调用成功，只剩一份有效本机授权；不写请求就重启时仍拿不到 secret（对照）。
- 改坏对照（修复后）：`sameBuild` 只比版本 → 5 个 A5 测试失败；请求不检查 0600 → 1 个失败；运行模式不把 `daemon_enrollment_unavailable` 当拒绝 → 4 个失败。恢复后全部通过。

## 实际执行（Linux 容器 x86_64，4 核，root；GUI 步骤用非 root 用户 `scrysmoke`）

- `npm run typecheck`：通过。
- 受影响测试：`npx vitest run src/daemon src/main/daemon-*.test.ts src/main/background-service-*.test.ts src/main/bootstrap src/main/remote/inner-mtls-host*.test.ts src/shared src/renderer/background-service-view.test.ts src/renderer/components/BackgroundServiceSettings*.test.tsx scripts/b4v`：136 个文件、759 项全部通过。
- `npm run build`：通过。`out/main/chunks/build-identity-*.js` 里 `scryBuildId()` 返回 64 位构建号常量，`out/main/index.js` 与 `out/main/daemon.js` 都引用这同一个 chunk。
- 构建产物检查（临时脚本，不提交）：用 Electron（`ELECTRON_RUN_AS_NODE=1`）运行 `out/main/daemon.js`，临时 userData：`daemonInfo` 返回的 `build` 与 bundle 常量相同；入网后普通重启不写 secret（对照）；放入请求后重启写出 secret、请求被删除、重新入网成功、旧证书被拒（`device_not_authorized`）。本容器 `better-sqlite3` 是 Node ABI，daemon 打印 sqlite 降级警告，与本改动无关。
- `node scripts/daemon-config-smoke.mjs`：12 项通过。
- `xvfb-run -a node scripts/daemon-mode-smoke.mjs`（`scrysmoke`，开发布局）：通过（握手、发送、流式、提问、停止、终端录制、SIGKILL 后重拉起、按身份停止，`remaining: []`）。
- `npm run performance:measure`（因为改了 `sources` 里的 `src/main/remote/inner-mtls-host.ts`、`remote-host-service.ts`）：Ratchet 通过，没有 `worse`。`analytics.sqlite`、`analytics.data-updated` 在本容器记为 unavailable（better-sqlite3 的 ABI 不匹配），与本次改动无关。只有计数（L1），没有毫秒结论。

## 未执行

- macOS：构建、安装、真实 App 复验都没有在本次执行（本容器是 Linux）。
- `node scripts/b4v-scenarios.mjs --only upgrade`：预检 `sqlite-electron-abi` 失败（共享 `node_modules` 的 `better-sqlite3` 是 Node ABI），记为 not-run。没有重编译：那份 `node_modules` 是主检出与其他并行任务共用的。
- 两个真实构建、同一版本号的 App 级复验（A5）与删除凭据的 App 级复验（A6）：只在单元、进程内真实 daemon 和构建产物 daemon 上验证，没有用两次安装的真实 App 复验。
- Arch/Omarchy 目标机：未验证。

## macOS 复验步骤

**A5（同版本两个构建）**

1. 在当前分支之前的提交（例如 3b04ee8）上 `npm run install:mac:dev`，开关 `SCRY_HOST_DAEMON=1` 打开，启动 App，确认设置「后台服务」为「已连接」。退出 App（daemon 继续）。
2. 切到包含本修复的提交，不改版本号，再 `npm run install:mac:dev`。启动 App。
3. 预期：弹出「后台服务版本不一致」，写「正在运行的后台服务版本是 0.2.237 (构建号未知)，本 App 的版本是 0.2.237 (xxxxxxx)」（旧构建不报构建号）。设置页连接为「版本不一致」，版本行同上，主按钮「重启后台服务」。
4. 点「重启后台服务」并确认 → 连接变为「已连接」。
5. 再改任意源码、不改版本号重装一次 → 这次两边都有构建号，提示写两个不同的 7 位构建号。
6. 对照：不改源码重装同一提交 → 构建号相同，不提示，直接「已连接」。

**A6（删除凭据）**

1. App 已连接；退出 App（daemon 继续，`daemon.lock` 仍被持有）。
2. 删除 `~/Library/Application Support/Scry/daemon-client.json`（以实际 userData 为准）。
3. 启动 App，打开设置「后台服务」。预期：几秒内显示「本机连接已被撤销」，说明里有「或本 App 保存的连接凭据已丢失」，出现「重新连接本机后台服务」；不出现 `daemon_ready_timeout`，没有自动重启或重新入网，后台服务 pid 不变。
4. 点「重新连接本机后台服务」→ 确认框 → 确认。预期：后台服务换了 pid，连接「已连接」，`daemon-client.json` 重新生成；`<userData>/daemon/local-enrollment-request.json` 不存在。
5. 对照：在第 4 步的确认框选「取消」→ 什么都不变，pid 不变。
