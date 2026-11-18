# recorder 0.2.78：采集初始化证据

## 改动与审查范围

维护者已审查原修法，并授权补齐以下行为后合并发布。已变基到包含 daemon 空闲 CPU 修复的 `062a008d`；该修复发布了 0.2.77，因此本次候选取下一个版本 0.2.78。

- 新 claim 等完整基线与控制状态持久化后再 ACK。初始化中断不能重新制作历史基线；publication 重试复用原 generation、turn 与 snapshot，排除路径按并集合并。
- 已开启的同一 capture 重复 start 返回 `already_started`。当前轮次初始化未完成时附带 warning，不把幂等 ACK 当作基线完整证明；不同 capture 的 claim 仍拒绝。
- Stop、正常恢复、过期恢复都将初始化中断轮次的 diff 标为 `unavailable`，并写明 `baseline initialization was interrupted`。迟到的工具基线不能补齐缺口；显式 disabled 保持 disabled。下一轮可正常初始化与采集。
- 宿主启动时间使用固定 C 日期格式；历史不可信身份保持 unknown。普通 Hook 的 durable inbox / fsync / ACK 合同不变。
- 快速迭代 L3 规则增加真实中文系统语言环境与中文工作区/脚本路径，必须记录平台、locale、宿主版本与正式包身份。

本次不修 PostToolUse/Stop 的 `forward_deadline`，不改变转发预算或协议。

## 当前验证

- macOS 27.3（26C5047e）、arm64、Node 24.18.0。
- 新增测试先失败：同 capture pending 被拒绝；封箱缺中断原因，晚基线甚至被标为 available。修复后通过。
- 变基后串行 focused 检查：5 文件 / 32 项通过，覆盖初始化、同 capture 幂等、不同 capture 拒绝、排除集合、工作树与宿主 locale。
- Stop / recover / expire 三个封箱场景均验证下一轮真实 Git patch 恢复。expire 场景使用受控 gone-host 证据与时钟，不是真实宿主过期验收。
- `npm run typecheck`（node + web）和 `git diff --check` 通过。未放宽测试超时。
- 先前并行 focused 检查的超时与缺 diff 失败日志保留；串行重跑通过，不将首次失败改写为通过。

原未发布组合的真实 Qoder 证据见 [采集 ACK 预算](20261117-capture-ack-budget.md)。它不能证明 0.2.78 正式包。本候选的 CI、发布校验值及正式包真实 Qoder 验收尚待完成，将另行追加证据。
