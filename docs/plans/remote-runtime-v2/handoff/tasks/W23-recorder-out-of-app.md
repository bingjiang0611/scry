# W23 · 把轮次记录器移出 App

依据：[P10-recorder-out-of-app](../../P10-recorder-out-of-app.md)，以下简称「设计」。

## 开工前提

- **记录器的 Qoder Stop 归属修复（PR #205）已经合进 main。** 没合进去就不要开工，告诉维护者。
- 从 `claude/scry-performance-optimization-46ngcf` 开始，先把最新的 main 合进来，用普通 merge。

## 规则

- 照 [README](../README.md) 执行：提交身份、证据目录、报告格式、测量互斥都按它来。
- **分支**：推送到 `claude/scry-performance-optimization-46ngcf`。不开 PR，不合并 main，不 force push，不 rebase。
- **门限与测试**：
  - 不放宽任何性能门限、预算或棘轮；
  - 不跳过、不弱化测试和冒烟断言；
  - 只因为删掉托管记录器分支而失去意义的测试，可以和代码一起删除，但要在报告里逐个列出；
  - App 主进程模块数不超过 192，用 `node scripts/main-import-boundary.mjs --strict` 检查。
- **安全与环境**：
  - 测试只用临时 HOME 和 userData；
  - 不碰日常的 `com.scry.daemon` 和真实的 `~/.scry`；
  - 不用 pkill 或 killall；
  - Electron 不加 `--no-sandbox`；
  - 单文件小于 20,000 字节；
  - 不写模型名、邮箱或 ID。
- **记录器自身**（`src/cli`、`src/core/turn-recorder`）只做「为 App 搬走通用代码」所必需的改动，不改它的行为。`check:cli-runtime` 必须一直通过。
- 被权限系统拒绝的操作不要绕过，记进报告。
- iOS 不在范围内。
- **流程**：先写失败测试，再实现；小步提交，随时推送。中断后续跑时，先读 `reports/W23.md` 和 `git log`。

## 步骤

**S1 · 盘点**（只写报告，不改代码）

按设计 §5 逐项写进 `reports/W23.md`，每一项给出三样东西：
- 托管路径做了什么；
- 禁用路径做了什么；
- 结论：删除、需要补齐，或者两者等价。

如果发现某项用户在界面上能看到的数据会消失、而禁用路径没有替代，就停下来，把这一项和你的建议写进报告，问维护者。其余项继续往下做。

**S2 · 静态边界先行**

先加上设计 §3 第 7 条的导入检查，并用白名单列出现有的违规引用。之后每消掉一处就从白名单里删一行，最后白名单必须为空。

**S3 · 搬走共享代码**

- 设计 §3 第 5 条：通用代码复制进 App 自己的目录，记录器保留原文件。
- 设计 §3 第 6 条：`mcpguard-core` 搬到 `src/shared/`。
- App 改成引用新位置。这一步行为不变，全量测试通过之后再进入 S4。

**S4 · 去掉托管记录器**

按设计 §2 的表格逐行删除：
- env 注入；
- `managedRecorderIdentity`；
- `ingestionRecorder`；
- 托管归档；
- 托管恢复；
- Pi、OpenCode、Qoder 的托管分支；
- `managedRecorderMode` 和 `recorder-cli-runtime`。

所有工作区都走原来的禁用路径。S1 里判定为「需要补齐」的项，在这一步补上。

**S5 · 去掉提交关联**

按设计 §3 第 3 条删除，维护者已定。

**S6 · 去掉打包**

按设计 §3 第 4 条删除。打包冒烟要断言 `bin/scry` 和 `scry-cli/` 不存在，`bin/scry-host` 存在。

**S7 · Qoder 复用**

按设计 §3 第 8 条，撤销 `e4dfbab6` 的「一轮即关」。测试要证明三件事：
- 同一对话的第二轮复用同一个进程；
- 两个新对话互不串话；
- 第二轮的权限请求发给第二轮。

真实 Qoder 的复测：有额度就做，没有就记为未验证。

**S8 · 已 init 工作区的集成测试**

在临时 HOME 里建一个执行过 `scry init` 的工作区，按设计 §8 跑 App 启动的五家 Provider（用仓库已有的 fixture）。断言两点：
- App 的结果和在未 init 工作区里一致；
- 独立记录器把这些轮次当作普通轮次记了下来。

## 验收

- 设计 §8 的全部项。
- 全量检查：
  - `npm run typecheck`
  - `--strict` 导入检查，模块数要写出改动前和改动后的数字
  - 全量 vitest（只允许已知的环境失败）
  - `npm run check:cli-runtime`
  - 开发版和打包版冒烟
  - 原生性能门跑一轮
- 全部完成后，开一个只读子 agent 独立评审，修掉阻塞项后再复验一次。

## 报告

写在 `reports/W23.md`，第一行写状态。完成后改成 `状态：待核验`，然后告诉维护者：

- 最终 SHA
- S1 盘点的结论表
- 删除了哪些测试，以及删除的理由
- 模块数和打包体积的前后对比
- 未验证项
