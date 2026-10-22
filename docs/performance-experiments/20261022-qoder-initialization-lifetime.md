# 2026-10-22 Qoder：初始化证据寿命与控制实例所有权

## 合同

用户继续 Scry-only 方案 A。SDK 的初始化命令及部分 Skill 元数据不是 live 查询；不能通过重复调用重新盖“当前”时间。本轮约束的是初始化证据，不延长原生实例寿命，也不假定 Qoder 提供统一重载。

- Skill/命令观察时间取初始化完成时刻，30 秒有效期不因后续读取而续期。已开始的读取可以正常完成并保留原来源时间；过期后的新初始化依赖读取先等待旧实例活跃读取结束、确认 SDK 关闭，再建立新实例。
- 相同上下文刷新合并；最终租约预留与当前/退休状态检查同步完成。await 期间建立的刷新/关闭屏障必须重新检查。
- 旧实例及已失效上下文的结果不得回填新缓存。模型仍使用原生 live 查询，绕过的仅是初始化年龄检查，不绕过退休/所有权屏障。
- TTL 轮换正常排空；显式失效及 dispose 直接调用 SDK 关闭以取消请求。关闭失败保留 owned session 与 rejected promise，阻止替换，dispose 报告失败；不把未知关闭当作成功或自动重试。
- 5 秒空闲回收、30 秒目录 TTL、20 秒初始化期限和 30 秒 SDK control 请求期限不变。无 prompt 输入、发现 persistSession:false 保持，正式用户运行路径不变。

## 代码与自审

源码 `84e6a25`，初始回归 `cc1c73b`；独立只读审查发现并修正关闭失败所有权丢失、租约获取竞态、主动释放等待应取消请求、刷新期间失效漏关替换实例，源码 `80e12b5` / 回归 `b220a46`。再次审查发现 await 期间可新建屏障，父任务修正 `cbeb568`，增加七个微任务顺序回归 `2c9e602`。不要单独使用早期提交作为已验收实现，受检树为 `2c9e6026a287b24ccf74aedb2d18072a295eb7f2`。

仅修改 qoder.ts / qoder.test.ts；未更改 CLI、其他 Provider、renderer、Swift、仓库 trust/fingerprint 或 journal 格式。代码局部状态增加是为了明确当前、排空、关闭中和未知关闭的所有权，不新增通用注册表或配置。

## 证据

| 检查 | 实际结果 |
| --- | --- |
| 父任务 Qoder focused | **101 项通过**；`qoder-init-final-focused.log`。旧 worker 的 148/152 是多文件合计，不是 Qoder 单文件项数 |
| 初始化寿命负对照 | 新回归放回旧生产代码时有 3 项失败；初稿第一次通过不能替代后续竞态复核 |
| 屏障负对照 | 临时仅移除最终屏障检查，七个顺序中 offset4 确定性失败：SDK query 提前启动第2次。`qoder-barrier-negative.log`；恢复后101项通过，不扩大期限/删除断言 |
| 本机完整类型 | 通过，`qoder-init-final-typecheck.log` |
| mac2 完整 unit | **3510 pass / 4 既有 opt-in skipped**，290 文件；`qoder-init-unit.log` |
| mac2 类型 / build | 均通过；`qoder-init-typecheck.log`、`qoder-init-build.log` |
| mac2 完整性能计数 | 43 observations、ratchet 通过；`qoder-init-performance.log`。计数未覆盖新增初始化轮换，不把原指标通过当成本项零成本或提速证明 |
| mac2 完整 renderer UI | 首次在未改动的 Markdown workspace 夹具失败：文本与预览更新，但dirty=false，见 `qoder-init-renderer-ui.log`。冻结基线同夹具单跑通过，见 `qoder-init-ui-baseline-control.log`；同一候选完整复核通过，见 `qoder-init-renderer-ui-review.log`。未改该夹具、断言、期限或负载；首次失败原因未确认，后续通过不抹掉它 |

日志本机归档 `/tmp/scry-provider-control.UGpNzU/`，原始 mac2 日志 `/Users/test/scry-provider-control-mac2.IEatqT/logs/`。mac2 为原8核/Node24.18.0独立目录，源码冻结如上，测试后工作区干净。普通 Node SQLite ABI137 与现有 Electron ABI146 的已知区分不变；真实 Electron SQLite collector 单独验证。无真实/付费 Provider、实际用户 transcript/DB 写入、模拟器或手机操作。

## 成本、限制与下一步

过期后创建新控制实例是保证初始化证据有效的必要成本，不是常驻优化收益。没有 L2/L3 提速结论；必要校验和关闭确认未移出计算。没有永久扩大 Qoder 保留时间。

Skill 的“已加载上下文”仍不等于全部已安装 catalog；native scene/config/auth 的完整动态刷新也未获证明。Pi 保留新进程探测，完整 A 仍受这些原生合同限制。UI 首轮 dirty 状态失败若再出现，由 UI 测试 owner 采集输入、saved baseline 与dirty状态时序，不先加等待/重试。

后续性能 owner 以此寿命边界为前提评估有界的 Qoder 控制复用；若仍只允许 Scry，则不使用未经证明的原生重载或私有缓存操作。当前只保留本地提交，不合入、push、安装或发布。
