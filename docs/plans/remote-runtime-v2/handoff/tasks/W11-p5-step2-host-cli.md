# W11 · P5 第 2 步：用命令行批准新设备（P5-5b、P5-5、P5-6、P5-7）

执行方 B。前置条件：W1 已通过（附条件 W10），W2、W3 的代码已通过，W8 已通过。

依据（按设计实现，不重新设计）：
- [P5-host-cli](../../P5-host-cli.md)：命令行与协议，§3.7 两次发布。
- [P5-host-security](../../P5-host-security.md)：§4 安全分析与缓解，§6 测试，§7 拆分与顺序。
- [P5-headless-host](../../P5-headless-host.md)。

维护者 2026-11-18 选定方案 a：在执行端用命令行批准新设备；「允许命令行批准」开关默认关闭。

## 范围

| 项 | 内容 |
|---|---|
| P5-5b | 「允许命令行批准」开关：由 daemon 持久化到 `<userData>/remote/host-admin.json`（0600）；在 App 里打开时弹原生确认；加运行标记 |
| P5-5 | admin socket、挑战认证（挑战文件）、白名单、速率限制、通知、机器码 |
| P5-6 | `scry-host` 入口、`restart`、`login-start`、wrapper、打包 allowlist；`status` 显示配对记录条数（见 security §4.5 末条） |
| P5-7 | 确认时写入 `approvedVia`；设备列表显示批准方式；App 与设备上展示通知 |

P5-8（第 2 步实机验收，手机和桌面各一次）由执行方 A 另做，不在本任务内。

## 发布顺序约束（必须遵守）

P5-5a（W3 的读取端）至少要比 P5-7 早一个发布，保证回退一个版本后仍能读取配对状态。W3 目前还没进入任何发布，而本分支是整体合入 `main` 的，所以：

- **用实验开关隔离**：`scry-host` 的批准命令、App 里的开关入口、`approvedVia` 的写入，都放在实验开关 `SCRY_EXPERIMENTAL_HOST_CLI=1` 后面（参照 `src/shared/experimental-providers.ts` 的做法）。默认关闭时，行为与现在完全一致，也不写 `approvedVia`。
- 含 W3 的版本发布之后，再由维护者决定在哪个版本打开它。
- 用测试证明：开关关闭时，不会写出新字段，admin socket 不监听（或只返回不可用），App 里看不到入口。

## 约束

- **安全**：
  - 认证必须是挑战式的，不接受只靠文件存在、或只靠进程身份的认证。
  - 白名单与速率限制要有测试。
  - 开关关闭时，命令行批准一律拒绝，并给出明确提示。
  - 不在日志、argv 和通知里泄露机器码之外的秘密。
- **改动边界**：
  - 不改 scry CLI（`npm run check:cli-runtime` 证明），不改协议版本，不放宽性能门限。
  - 不碰 orchestration 文件（C 在返修 W9），也不碰 W10 的执行目标路由文件（A 在返修）。
  - `host-process.ts` 只做尽量小的改动，放进独立函数，推送前先合并他人提交。
- **工程**：
  - 单文件小于 20,000 字节，接近上限的文件先拆分。
  - 测试只用临时 HOME、userData 和测试标签，不碰日常的 `com.scry.daemon` 与真实 userData。
- **真机**：B 可以在本机用测试实例和临时目录做命令行自测；涉及 iPhone 和 `/Applications` 的验收留给 A，并在报告里写明。

## 验收

- 按 security §6 的测试清单，先写失败测试再实现。
- 每个单元提交后推送到 `claude/scry-performance-optimization-46ngcf`。
- 报告写 `reports/W11.md`，第一行写状态，列出已定事项、仍需维护者决定的事项（附推荐），以及交给 A 做 P5-8 的验收步骤。全部能做的都做完再停。
