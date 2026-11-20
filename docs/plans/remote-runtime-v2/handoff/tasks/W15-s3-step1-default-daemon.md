# W15 · S3 第一步：开发构建与测试实例默认走后台服务（不删代码）

执行方 B。依据：[P3-s3-plan](../../P3-s3-plan.md) §1（维护者 2026-11-20 已定）与 §5 Step 1。

维护者决定：开发构建与 `SCRY_TEST_APP=1` 测试实例改为默认走后台服务；逃生开关 `SCRY_HOST_DAEMON=0` 再保留一个发布版本。所以本任务**只切默认值、迁移夹具，不删除任何进程内代码**，`SCRY_HOST_DAEMON=0` 必须继续可用。

## 要做的

1. **默认值**：`src/main/daemon-mode-default.ts` 改为：只要没有显式设置 `SCRY_HOST_DAEMON`，打包、开发构建、`SCRY_TEST_APP=1` 三种情况都默认 `SCRY_HOST_DAEMON=1`。显式设为 `0` 时仍走进程内。同步修改注释和 `daemon-mode-default.test.ts`。
2. **测试实例隔离**：`SCRY_TEST_APP=1` 下拉起的 daemon 必须使用测试标签、测试 userData 和独立的 socket，绝不连接或拉起日常的 `com.scry.daemon`。补一个测试证明这一点（例如在临时 HOME 下，断言标签和 socket 路径都不等于日常值）。
3. **迁移 14 个 smoke 脚本**（清单见 P3-s3-plan §2.2）：
   - 逐个在默认（daemon）模式下跑通。
   - 本来就是为了测进程内或做对照的脚本，显式写 `SCRY_HOST_DAEMON=0`，并在脚本里注明原因。
   - 计时与对照类脚本（`session-open-bench`、`timing-run`、`b4v`、`concurrent-performance` 等）保持显式模式，不能因为默认值变化而改变它们测的东西。
4. **CI**：默认作业改走 daemon 后，保留一个 `SCRY_HOST_DAEMON=0` 的作业，覆盖逃生开关，直到 S3 删除代码为止。不放宽任何性能门限，也不修改棘轮文件。CI 本身只作参考，以本地验证为准。
5. **开发体验**：`npm run dev` 默认走 daemon 后，daemon 代码改动需要重启 daemon。
   - 看现有的构建标识握手（版本不一致时提示重启）在开发构建下的表现，避免每次重新构建都弹出阻塞对话框。
   - 可以只在开发构建、且没有活动 run 时自动重启；打包版的行为不变（不得静默替换）。
   - 把开发流程写进开发文档（如 README 或 `docs/` 下的开发说明）。
6. **静态检查**：`node scripts/main-import-boundary.mjs` 照常通过，基线不增长。

## 约束

- 不删除任何进程内代码，`daemonModeEnabled()` 的分支都保留。不碰 orchestration（C）、W13 的 trust 文件和 host-admin 文件。不改 scry CLI 和协议。
- 执行方 A 正在用 `/Applications` 安装包做 W14 真机验收，这个改动不影响打包版。不要动日常 App 和 `com.scry.daemon`。
- 测试只用临时 HOME、userData 和测试标签。单文件小于 20,000 字节。

## 验收

- `npm run typecheck`。
- 全量单测在默认（daemon）模式下通过；`SCRY_HOST_DAEMON=0` 时的关键子集也通过。
- 14 个 smoke 逐个列出结果（通过 / 显式改为进程内并写明原因 / 受阻并附证据）。
- `npm run check:cli-runtime`。
- 报告写 `reports/W15.md`，第一行写状态。
