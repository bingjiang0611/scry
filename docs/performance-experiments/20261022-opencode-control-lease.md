# 2026-10-22 OpenCode：跨能力刷新周期保留有界原生实例

## 范围与假设

用户继续方案 A，但明确只允许修改 Scry，不允许修改 Pi/Rotom 原生源码。本轮只推进已有可验证运行时管理器的 OpenCode，不把它当作完整 A 或全部 Provider 常驻完成。

现有 OpenCode 实例在 60 秒空闲后回收；桌面可见上下文的能力读取由约 60 秒元数据周期触发，实例容易在下一次读取前关闭。将空闲租期改为 90 秒，后续实际请求续租；停止查询后仍有明确回收。没有改变请求/启动/测试期限、30 秒模型目录缓存、原有至多保留 3 个空闲实例的淘汰策略（不强制淘汰活跃操作）、配置内容/plugin/MCP 指纹重验、active writer 保护或 owned-process 退出确认。

- 基线代码：`54e9dd1`，其 OpenCode 实现与实验前 `98568ce` 相同。
- 冻结测试提交：`b3b28f1`。初版通过 Skill 读取观察相同管理器生命周期；父任务改为实际 `runControls.read` 并补 89,999/90,000ms 边界，提交 `74520c8`。未改变三次读取和每次间隔 60 秒的负载。
- 唯一生产修改：`06591d9`，`SERVER_IDLE_MS` 从 60,000 改为 90,000。这是有界空闲保留策略，不是放宽失败期限。
- 仅本地提交；未合入 main、push、安装或改动其他仓库。原 main 的 WIP 保留。

## L1 与独立受控原生检查

单元回归运行实际 adapter/manager 管理逻辑，mock 原生 ready/client 边界：旧代码三次 manager start，两次查询之间均回收；新代码一次 start，最后一次查询后 89,999ms 未回收，90,000ms 回收。另一个负对照证明模型目录仍在 30 秒过期，而不是用陈旧目录减少请求。

另外使用真正的受控 Node HTTP 子进程替代 OpenCode CLI，运行生产 manager 启动、健康检查、SDK HTTP 模型读取、指纹及退出路径。没有模型任务、账号或网络 Provider。相同三个读取、60 秒虚拟需求间隔；只虚拟 Date/调度器，原生子进程、网络 I/O 和 hrtime 计时不虚拟。用户空闲时间不是主动读取耗时，未将生产工作挪出窗口。

mac2 `54e9dd1` 对 `74520c8` 交替顺序五对：每个基线实际启动 **3 个**子进程，每个候选启动 **1 个**。减少的工作是真正不再重复启动两个服务；必要的 SDK 查询与指纹重验继续执行。测试并不代表真实 OpenCode 服务或用户屏幕绘制。

临时可运行 harness 保存在本机 `/tmp/scry-provider-control.UGpNzU/lease-lab/`，mac2 `/Users/test/scry-provider-control-mac2.IEatqT/lease-lab/`。可分别设置 `LEASE_SOURCE` 后用所选源码的 Vitest 执行该目录 `vitest.config.mjs`；`pair.mjs` 使用 `LEASE_BASELINE` / `LEASE_CANDIDATE` 执行交替五对。harness SHA-256：

- `lease.test.ts`: `63841251dc24ea1dabe5bab202745d222d7d6b160d647b924eea639675719eca`
- `pair.mjs`: `81aba0a03d6a16ecf8fca6a9a721265499fdde2592ced1e34b24a43601757315`
- `vitest.config.mjs`: `b9bfa303abb177f8a5666286d898a1caa307bdfc03f32b696198ce393bcc6989`

## 验证与限制

| 项 | 结果 |
| --- | --- |
| OpenCode focused | 本机 60 项通过；已有配置/内容/plugin 指纹变化重建用例保留 |
| mac2 完整 unit | `74520c8`：**3493 pass / 4 既有 opt-in skipped**，290 文件；`lease-unit-full.log` |
| mac2 类型 / build | 均通过；`lease-typecheck.log`、`lease-build.log` |
| mac2 完整性能计数 | 原固定负载、43 observations、ratchet 通过；`lease-performance.log`；未改台账或升门禁 |
| L2 | 未验证可信收益：锁内真实受控子进程五对虽执行完，但 8 核 load17.99→22.55、`highLoad=true`。原始 `lease-pair.log` 和 `samples.json` 保留，不因耗时下降宣称提速，也不重复找绿 |
| 生效 / 设备 | 未安装或打包部署；不影响现有 App。无真实/付费 Provider、手机、L3 或 Swift 新验证；本次未改 Swift/UI |

原始本机归档 `/tmp/scry-provider-control.UGpNzU/lease-lab-mac2/` 包含对子结果及日志。mac2 独立源码根保留，测试后工作区干净。

## 未完成部分与下一步

Pi 仍使用新的 offline/no-session 探测。已检查的 Pi SDK `1.3.0-rotom.2` 虽能通过 `new_session` 重建模型/auth 服务，但还保留进程级扩展模块和项目 trust 决策缓存；不能把新 session ID 当作完整冷启动等价，也不通过 `prompt` 冒充重载控制。用户拒绝跨仓库修改后，本轮不新增无权威刷新合同的 Pi 常驻复用。Qoder 原有生命周期也未扩大；不能从本轮 OpenCode 结果推断其可安全长留。

性能 owner 下一步在空闲机器对同一 harness 补可信 L2；后续 Qoder 必须先证明 live catalog、初始化证据和认证/配置失效合同，才扩大其实例寿命。Pi 完整常驻仍需原生刷新合同或其他已证明等价的方案；当前限制下不宣称完整 A 完成。
