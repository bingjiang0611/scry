# 2026-10-26：历史页 Stage 1 安装与独立验收

## 结果

用户在 main-only 交付后明确要求安装并验收。当前 main `9cbd73ff` 已重新构建，并安装到 `/Applications/Scry.app`：

- App：0.2.226
- 内置 CLI：0.2.51
- source tree：`531e9dd56088391976c5ba1602b95364f296f521`
- build ID：`b251f32389930f388231f010006166c4d64d2ec623c8ae20bf6bb813e03d9cf6`
- 安装清单 SHA256：`758a7caa711a93f1bb3080acf94b9a79053dcb00c00d73898ddc6c4ff1807c10`

版本号和安装前已有 App 相同并不足以证明更新。安装前磁盘 App 实际为 0.2.221 / build `c20f8ef4…`；候选源码、传输产物和安装后 asar 均核对为 build `b251f323…`。

这是 development-only 构建。mac2 没有 Developer ID Application 身份，因此没有签名或公证发布声明。

## 构建和产物身份

在授权的 mac2 Apple Silicon 主机上，从精确 commit `9cbd73ff` 建立独立 worktree。依赖来自同一 package-lock 的物理 APFS clone，不使用 `node_modules` 符号链接；lock SHA256 为 `10edc3c42bad6edd0b0295824381ed2b0dbdfd05e0902c0b2a2d71a091ce69d0`。

`npm run pack:artifact` 依次产生了以下完整输出：

1. production Electron build；
2. 独立 recorder CLI build；
3. Electron 42.10.1 arm64 打包及 native dependency rebuild；
4. packaged dependency/allowlist 检查；
5. external-links、renderer crash recovery、默认 packaged security、files-only 和 desktop remote host smoke。

外层 zsh 在 npm 返回后，因为脚本试图写只读变量 `status` 而退出 1，所以**原命令退出码未知**，不能伪造为 0。该错误发生在全部 smoke 输出之后，没有重跑整个打包链来挑绿。随后独立执行原 `check-packaged-app.mjs`，并对产物建立完整文件清单。

产物检查结果：

- 478 个文件、目录或符号链接，其中 369 个普通文件；287,354,997 字节。
- 311 条运行时传递依赖完整。
- preload 为 CJS；node-pty、Qoder SDK 和私有 CLI 齐全。
- zip SHA256：`7cc8d9ec902cfa26c221586c58b74e31cdee24bed8085daee3bf85b7d4468246`。
- 传回本机后，内容、权限位及符号链接目标与 mac2 清单全部一致。

## 安装

使用仓库原 `scripts/install-macos.mjs` 的原子安装流程。安装器验证 bundle ID、App 版本、可执行文件和内置 CLI，并保留回滚副本：

- 目标：`/Applications/Scry.app`
- 备份：`/Applications/.Scry.app.backup`
- 备份身份：0.2.221 / build `c20f8ef4…`
- 安装后身份：0.2.226 / build `b251f323…`

安装后再次对 `/Applications/Scry.app` 运行完整清单比较，478 项全部匹配。没有更新全局 npm CLI。

## 已安装产物验收

直接针对 `/Applications/Scry.app` 启动独立测试实例。测试使用临时 `userData`、临时 workspace 和 fixture Codex adapter；禁用真实 Claude、Qoder、OpenCode、Pi 和远程 host，因此没有真实 Provider、账号或费用操作。

已通过：

- production renderer、本地 file URL、sandbox/preload IPC 边界；
- history reload：同 session、两轮内容、重开后最新轮次；
- owned-app crash 后 history restart：只读恢复、旧 writer 拒绝、foreign session 隔离；
- renderer reload 后 terminal replay、ownership epoch 前进和 stale owner fencing；
- recorder 捕获、重放、只读及删除；
- workspace Git evidence、surface/modal、popup/navigation denial。

该 installed smoke 直接读取 `/Applications/Scry.app/Contents/Resources/app.asar`。历史页 40 轮大 diff、Pi native 55 轮分页和完整 unit 仍引用前一份精确源码验收；本轮没有为安装重复构造真实 Provider 或日常数据。

## 当前运行实例

安装前用户实例 PID 59065 正在运行旧磁盘版本。安装后同一 PID 和启动时间仍存在，证明本任务没有退出或重启用户实例。磁盘 App 已更新，但该进程仍需用户自行重启，才会加载 build `b251f323…`。

## 限制与状态

- 已安装并完成独立 packaged smoke。
- 未 push，未重启用户实例。
- 没有真实 Provider 验收，也没有 L3 日常样本。
- 打包与验收日志保存在 `/Users/baobingjiang/.local/state/scry-history-install-20261026.IubVGb`。
- 结构化证据：[20261026-history-open-install-evidence.json](20261026-history-open-install-evidence.json)。
