结论：通过（Claude 维持 not-run；附一处产品缺陷，已转给执行方 C）

# W6 核验（核验方，2026-11-20）

- 真实 codex-cli 0.170.0：86 次 `ps -axww` 零泄露；本地 HTTP 测试服务器 19/19 收到请求头密钥；stdio 服务器收到 `W6_ENV`，且没有多出 `SHLVL/PWD/OLDPWD`；临时目录 0700、文件 0600；发送、写文件工具、停止回归通过。
- 真实 qodercli：1.1.93 仍是已知的 `sdk_worker_removed`（零泄露、零残留、`tools` 例外得到实证）；SDK 内置的 1.1.11 复用真实登录态全部通过（151 次 `ps` 零泄露、31/31 收到请求头、stdio 收到 `W6_ENV`）。
- 单测 4 个文件 19/19 通过，含核验方修正后的 macOS 断言。

**执行方报告的缺陷（确认存在）**：`src/daemon/host-process.ts` 的 `dispose()` 没有调用 `providerRegistry.dispose()`（进程内路径在 `src/main/bootstrap/app-lifecycle.ts:248` 会调），后台服务优雅退出时，池化 Codex 客户端的私有 env 目录要等下次启动 5 秒后的崩溃清扫才回收。`host-process.ts` 已到 19,974 字节且执行方 C 正在改它，修复交给 C（随 W5 下一轮），需先拆分该文件并补后台服务优雅退出的清理测试。
