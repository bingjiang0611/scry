# W21 · 机器管理第一版（与 W20 并行）

执行方：维护者本机上一个独立的执行方，与 W20 并行。依据：[P8-machine-management](../../P8-machine-management.md)，以下简称「设计」，维护者 2026-11-23 已定。界面以 UI 设计稿为准：源文件在 [designs/machines/](../../designs/machines/README.md)。

## 范围

只做设计 §2–§7 和 §9 的第一版，§8 的第二版不做。

- **后台服务**：在 `src/daemon/` 新增 `HostMetricsSampler`，按需采样，缓存 5 秒，两次采样至少相隔 2 秒，macOS 和 Linux 的指标口径见设计 §3。挂到 `host-process.ts` 上，只加一行。
- **协议**：
  - 本机走本地接口 `hostMetrics:read`，注册在 `src/main/daemon-local-ops/`；
  - 远程走只读接口 `hostMetrics`，带能力位 `hostMetrics: 1`；
  - 转发白名单加入 `desktopRemote:hostMetrics`。
  - remote scope 要脱敏，按设计 §5 执行。
- **界面**：
  - 侧栏加顶层入口「机器」；
  - 新页面分三块：本机、执行目标、已配对的设备；
  - 把 `RemotePairing.tsx` 和 `HostsView.tsx` 的功能整体搬过来，逻辑和文案都不变；
  - 删除设置里的「远程」标签页，只留一行跳转提示。

## 规则

- 照 [README](../README.md) 执行：分支、提交身份、证据目录、报告格式、测量互斥都按它来。
- **分支**：远程分支 `feat/machines-v1` 已经建好，基于 main，含设计文档、设计稿和本任务单。在它上面开发，只推送到这个分支。不开 PR，不合并 main，不 force push。
- **不碰 W20 正在改的文件**：设计 §7 列出的订阅引擎、表结构、Provider 适配器、派发器、`run-*.ts`。如果确实必须动，停下来写进报告，不要动手。
- **门限与测试**：
  - 不放宽任何性能门限、预算或棘轮；
  - App 主进程模块数不超过 192，用 `node scripts/main-import-boundary.mjs --strict` 检查；
  - 不跳过、不弱化测试和冒烟断言。
- **安全与环境**：
  - 测试只用临时 HOME 和 userData；
  - 不碰日常的 `com.scry.daemon` 和真实的 `~/.scry`；
  - 不用 pkill 或 killall；
  - Electron 不加 `--no-sandbox`；
  - 单文件小于 20,000 字节；
  - 不写模型名、邮箱或 ID。
- **流程**：先写失败测试，再实现；小步提交，随时推送。中断后续跑时，先读 `reports/W21.md` 和 `git log`。
- 被权限系统拒绝的操作不要绕过，记进报告。

## 验收

- 设计 §9 的全部项。
- 全量检查：
  - `npm run typecheck`
  - `--strict` 导入检查
  - 全量 vitest（只允许已知的环境失败）
  - `npm run check:cli-runtime`
  - `npm run design:audit`
  - 开发和打包两种布局的冒烟，包括原有的远程配对和连接流程
  - 原生性能门跑一轮
- 明暗主题下的截图放进证据目录。
- 真机：mac1、mac2、mac3 各打开一次「机器」页，和「活动监视器」对照。需要在 mac2、mac3 上操作的步骤，由维护者来做。
- 全部完成后，开一个只读子 agent 独立评审，修掉阻塞项后再复验一次。

## 报告

写在 `reports/W21.md`，第一行写状态。完成后改成 `状态：待核验`，然后告诉维护者：

- 最终 SHA
- 截图位置
- 真机对照结果
- 未验证项
