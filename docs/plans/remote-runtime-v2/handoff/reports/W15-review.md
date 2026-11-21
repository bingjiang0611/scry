结论：通过（第二轮，`62ae0929`）

# W15 核验（核验方，2026-11-21，提交 `ce1c2ab2`…`b03ced53`）

## 确认成立

- **默认值**：未设置时，所有构建都变为 `'1'`；显式设置的值都保留（`'0'`、`''`、`'true'` 仍走进程内，因为 `daemon-channel-gate.ts:20` 要求 `=== '1'`）。
- **单测未被翻转**：`applyDaemonModeDefault` 只在 main 入口和 `host-cli-service.ts:52`（作用于 env 的副本）调用。
- **开发构建空闲自动重启**：
  - 条件为 `autoRestartIdle && meta.activeRuns === 0`，其中 `autoRestartIdle = !isPackaged`。
  - 旧 daemon 没有 `activeRuns` 字段时仍弹对话框。
  - 协议版本仍为 2，打包版行为不变。
- **14 个 smoke**：逐个与报告一致。
  - `daemon-mode-timing` 的进程内一侧已显式设为 `'0'`（否则会变成 daemon 对 daemon）。
  - `electron-security-provider-history.mjs:86` 的改动是真正的修复：原来的 `expectedSessionId` 不是启动参数字段，这个 smoke 其实从没测到恢复会话。
- **范围**：
  - 没有删除进程内代码，没碰 orchestration、trust、host-admin、CLI 与协议。
  - 预算、棘轮、导入边界基线都没变；导入边界检查通过。
  - 所有文件小于 20,000 字节。
- **Linux 复跑**：
  - `typecheck` 通过；`test:in-process` 83/83 通过；`check:cli-runtime` 通过。
  - 全量单测失败 9 个：4 个是下面列出的既有失败；5 个是以 root 运行，或真实 Chromium 的 no-sandbox 环境造成的，与 W15 无关。

## 应修

1. **S1：空闲自动重启在发信号前不再复核。**
   - `background-service.ts:177` 用 `activeRuns: async () => 0` 跳过了重启自带的 run 检查。是否空闲，只依据连接时那一次 `daemonInfo`。
   - 在这次探测和 SIGTERM 之间，如果有已配对设备开始了一个 run，这个 run 会被中断，而且没有任何提示。
   - 修法：发信号前立即再查一次 `activeRuns`，结果不严格等于 0 就退回到确认对话框。
2. **S2：自动重启没有确认目标是不是本检出自己的 daemon（最严重）。**
   - 开发构建和打包版共用 userData（`~/Library/Application Support/scry`），所以 `npm run dev` 默认会连到用户日常的打包版 daemon。两者的构建 id 必然不同，必然判定为不一致。如果那个 daemon 正好空闲，开发构建会悄悄 SIGTERM 掉它，然后在真实台账上起一个开发版 daemon。
   - W15 之前，这需要显式设 `SCRY_HOST_DAEMON=1`，而且一定会弹框。
   - 修法：只有当锁持有者的 daemon 入口或 appPath 属于本检出，或者 daemon 报告 `isPackaged:false` 时，才自动重启；否则一律弹框。补测试。
   - 另外，在开发文档里写明：开发构建与日常 App 共用数据目录。
3. **S3：测试实例的隔离只靠约定。**
   - `SCRY_TEST_APP=1` 而没有覆盖 userData 时，会复用真实的 `daemon-client.json` 和 socket；没有 daemon 在运行时，还会直接在真实 userData 上拉起一个。
   - 新增的隔离测试是循环论证：它把自己选的路径传给 `daemonClientPaths`，证明不了 App 会选测试路径。
   - 修法：fail-closed 守卫。`SCRY_TEST_APP=1` 且 userData 等于默认的 `appData/<name>` 时，拒绝 daemon 模式或拒绝启动，并补测试。核验方检查过，14 个脚本都已经隔离了 userData。

## 小项

- **打包版门控的装配层没有测试**：把 `background-service.ts:257` 改成 `true`，测试照样通过。要补一个装配层的测试。
- **新增的 `unit-in-process` 作业作用有限**：vitest 里本来就未设置 `SCRY_HOST_DAEMON`，未设置就等于进程内。报告里「全量单测在 daemon 模式下通过」的说法不准确，要改正。真正覆盖进程内的，是显式设为 0 的那几个 smoke。保留这个作业可以，但要如实写明它覆盖了什么。
- `external-links-smoke` 的钥匙串守卫现在靠测试用的明文凭据才能通过，已经反映不了真实启动会不会碰钥匙串。在报告里写明。
- 几个计时脚本有的写死 `'0'`、有的用 `env ?? '0'`，写法要统一。

## 分支上两个长期红着的测试（交给 B 修）

- **`scripts/daemon-ipc-matrix.test.ts:11,57,64`**：期望 180 个通道，实际 181 个。多出的是 W11 的 `2da09eb3` 新增的 `remote:hostAdmin:setCliApproval`，路由本身是正确的。把这三处 180 改成 181 即可。
- **`scripts/performance-native.test.ts:187`**：报告缺少 `smoke-scenarios.ts`。这是 A0.5 拆分文件（`477fb398`）时漏了更新：在 `scripts/performance-native.mjs:14` 的 `nativeHarnessFiles` 里，`smoke-paced-stream.ts` 之后加上 `'src/main/providers/smoke-scenarios.ts'`。harness 的指纹会因此改变，这是预期的。

## 另立任务：远程桌面连到 daemon 主机时缺少会话操作（已确认，属于线上回归）

- **原因**：
  - daemon 的 `createHostRuntime`（`host-process.ts:270-297`）没有传 `openPath`、`trashItem`，所以 workbench 报告这两项都是 `false`。
  - daemon 的 runtime 没有 `sessionRefFromRequest`、`changeLegacySessionMetadata`、`deleteOneSession`，所以 info 里不宣告 `sessionAction`、`sessionFork`、`sessionDelete`。
- **远程桌面上看到的现象**：
  - 会话菜单里的重命名、置顶、归档都是灰的，横幅还提示「请更新并重启 Scry」（误导，更新也没用）。
  - 归档面板不能恢复、不能删除。
  - 远程对话里没有分叉。
  - 工作区里没有「在系统应用中打开」和「移入废纸篓」。
- **不受影响**：主机自己的 App 本地侧栏。
- **影响范围**：打包版从默认走 daemon 起就是这样了；W15 只是把它扩大到了开发构建和测试实例。修复任务见 W17。

## 复核（第二轮，2026-11-21，提交 `62ae0929`）

结论：**通过**。

**S2 已修**：
- daemon 报告 `isPackaged: true` 时拒绝自动重启；这个值来自必填的 `SCRY_DAEMON_PACKAGED`。
- 旧 daemon 不带这个字段时，退回检查锁持有者的命令行：必须包含 `<appPath>/out/main/daemon.js`，并且两侧在分隔符边界上。
- 边界情况：
  - 路径含空格、`appPath` 是符号链接：能匹配。
  - 命令行里用的是符号链接：不匹配，退回弹框。
  - 同级目录、路径里的 `x/..`、`dist/mac-arm64/Scry.app` 里的 asar：都不匹配。
- 出错或结果未知时一律弹框。
- 说明：`isPackaged: false` 单独成立时也会自动重启，所以另一个检出的空闲开发版 daemon 可能被重启。这只影响开发环境，而且重启前会先查是否有 run，可以接受。

**S1 已修**：跳过弹框前和发 SIGTERM 前各实时查询一次。剩下的竞态窗口只有几十毫秒，和手动重启一样。

**S3 已修**：
- 入口和 `createDaemonRunMode` 两处都有守卫，测试不是循环论证。
- 用真实 Electron 验证过：`SCRY_TEST_APP=1` 且不带 `--user-data-dir` 时立即以 1 退出，不生成 `daemon/` 下的任何文件；带上之后正常运行。

**小项**：均已完成。两个长期红着的测试（daemon-ipc-matrix、performance-native）现在都通过了。

**剩余小缺口**：入口 `daemon-mode-default-entry.ts` 传入 `userDataDir` 这一步没有自动化测试，只有手动 Electron 验证覆盖。
