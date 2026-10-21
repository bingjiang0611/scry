# 2026-10-21 方案 A：按选中上下文发现 Provider 能力

## 范围与交付状态

- 基线：`4b624c8a6cac6296c4430bfe72afd27b8468e55c`；隔离分支 `perf/provider-control-20261021T115356Z`。原 main 的并行 WIP 未迁入、未改动。
- 初稿提交：`ce51eb0`、`d664f35`。父任务复核发现初稿的测量只是通用去重 helper，并不足以证明真实发现调用链；已替换为 main 实际使用的领域实现及其计数，不沿用初稿的完整验收结论。
- 修正源码提交 `7d46bc6`；回归/collector/candidate 台账独立提交 `39739f2`，需连同初稿提交一起查看最终树。合入 main、安装、push、发布均未执行。不是可直接发布的完整 gate 通过状态。
- 最终隔离桌面构建：生产源码已提交于 `39739f2`，App 版本沿用基线 **0.2.216**，build ID `c8749c955d123b2ed99253c9e10136a4e0c7bb3301dc0cf70992a8437f8c987a`。此前全量 renderer UI 检查使用 build `d4d001dd31dd1f21a2f4647db2bd762874ecf9dab61082e085316856d81c729b`；其后仅复用 gateway 的纯选项映射，当前 gateway 36 项通过，并对最终构建重放 A 专项。二者都是测试构建，不是安装身份。
- 日常 baseline 是已运行的 0.2.215/build `6eaf858de913113b87db8ed41811ab57cdf50e2e1c86f874a6cf7480a316d9b4`；candidate 未部署，没有日常前后对照或 L3 结论。

## 假设与实现

原远程 picker 快照在一分钟 TTL/十五秒 tick 的链路中，对全部可用 Provider/Pi Profile 调用 runControls，并等待全部结果。改为：

1. 定时刷新只读取 descriptor/Profile 元数据，不初始化 Provider runtime。
2. 支持新协议的客户端先通过已有 desktop/info 协商 `providerDiscovery: 2`，再发送 metadata/selected 请求。旧主机只收到原有无 detail 请求，不靠错误重试或假定旧主机会理解新字段。
3. selected 绑定 Provider、Profile 和 canonical cwd；每次先重验工作区授权，进入原 ProviderOperationGate。相同上下文只合并在途请求，完成/失败后不留能力结果缓存；不同上下文互不等待。
4. 新旧查询路径显式区分。旧客户端仍可主动获取全量快照，保留原有 60 秒复用；新客户端连接旧主机使用明确标注的 legacy snapshot，执行仍由宿主重验。
5. 桌面与 iOS 在切换/加载时撤销旧就绪状态。返回值 unavailable、旧回复、失效模型/effort/权限不能启用发送，也不静默退回默认值。失败有显式重读入口。iOS 恢复先恢复身份，收到对应 cwd 的能力后才验证保存的控制项。

**实例复用边界**：复用 Qoder/OpenCode 已有实例与 Pi 已有重叠请求机制；不延长其 TTL，不把 discovery 与会话 writer 混用。Pi 公开 RPC 无可证明完整刷新的 reload 合同，因此没有新增跨请求常驻 Pi 能力实例或 settled cache，后续显式刷新仍启动真实探测。该项仍是后续平台协议工作的限制，不宣称已消除真实 Pi 冷启动等待。

**尚未完成整个方案 A**：当前完成按需查询和在途复用。选中能力还未贯穿来源读取时间与配置变化的版本化失效；尤其桌面 selected effect 不订阅元数据刷新代次，成功后的目录变化不能只依靠当前固定依赖自动重验。需要补充可见选中上下文的有界重读/失效信号、来源时间和显式成功重读，并保持隐藏/卸载暂停及旧回复栅栏。未补齐前不能把此分支当作完整 A 合入。常驻 Pi 能力实例也仍受上述原生 reload 合同限制。

**减少的工作去了哪里**：没有消费者的能力探测不再执行；并发相同查询合并；未选中的 Provider 不初始化。必要的当前上下文读取、授权与 trust 校验仍执行。

## L1：固定负载与负对照

`providers.discovery` 固定三个可用上下文，刷新 picker 后并发两次读取选中的 Pi，并另测一次显式 legacy 全量快照。collector 调用 main 实际使用的 `createProviderDiscovery`，记录进入 adapter callback 的次数，不把它冒充真实 CLI 启动数、模型耗时或网络时延。

| 指标 | 五轮结果 | 含义 |
| --- | --- | --- |
| metadata.controlReads | 0,0,0,0,0 | 打开元数据列表不做能力探测 |
| selected.controlReads | 1,1,1,1,1 | 两个重叠请求只读选中上下文一次 |
| legacy.controlReads | 3,3,3,3,3 | 保留显式旧协议全量行为 |

没有缩小或替换已有 workload。三个新指标只登记 candidate，未升门禁、未放宽任何上限。`performance:measure -- --scenario providers.discovery` 和旧→新台账 guard 通过。

负对照：临时在 metadata 路径注入原全量行为 `await legacy.load()`，同一生产路径回归确定性失败（预期 0 次，实际三个上下文都被读取）。已撤销注入，随后定向检查通过。它证明检查能抓到重复探测，不是旧安装包毫秒收益证明。

## 已执行验证与首轮失败

证据仅保留本机目录 `/tmp/scry-provider-control.UGpNzU/`；不上传用户日常记录。

| 检查 | 结果 / 日志 |
| --- | --- |
| 类型检查、桌面 build | 最终通过；`typecheck-final.log`、`build-final.log`。首轮新增 fixture 漏传权限 description 已按原合同补齐，未改类型，保留 `parent-typecheck-1.log` |
| 最终定向 TS/合同/计数检查 | 11 文件、132 项通过；`focused-final.log`。包括真实 inner-mTLS 选中查询、Swift 消费的回复标记、协议协商顺序、IPC sender/frame/origin 拒绝、未授权 cwd/Profile 拒绝、并发合并、失败不复用旧成功值 |
| renderer UI / 当前 A 专项 | 先前完整 `test:renderer:ui` 通过，见 `renderer-ui-1.log`。最终构建的 A 专项 `--session-opening-only` 通过，见 `discovery-ui-final.log`，覆盖延迟回复/切换、unavailable→重试、legacy-host 不发 selected 且原发送保留。最终默认桌面回放在输出全部业务断言结果后仍触发 55 秒退出期限，exit 1，见 `desktop-ui-final.log`；PID34641 已收敛，失败现场保留。不能把业务结果当作该轮完整 gate 通过；没有扩大期限或改关闭检查 |
| Swift package 全量 | 当前 53 项通过；`swift-full-final.log`。新增协议协商请求/回复、缺失 selected 标记拒绝、授权错误不降级检查 |
| iOS App 目标 | iPhoneOS SDK、generic physical-device target、unsigned Debug build 通过；`ios-build-final.log`。没有模拟器，也未安装或真机重放 |
| 初稿 Swift 首次失败 | TLSLayer 的 Lane.swift:240 leaked promise；未改动基线同一用例也失败，见 `baseline-swift-control.log`。后续全量通过不等于根因已修复 |
| 父任务首轮全量 unit | 3480 pass / 3 fail / 4 既有 opt-in skipped；两个新增 fixture 的 sessionsPage envelope 错误已修正；另一项 Pi lifecycle 超时。见 `unit-full-1.log` |
| 修正 fixture 后全量 | 3478 pass / 5 fail / 4 skipped；Pi 相关超时/menu-only 断言，见 `unit-full-2.log`。未扩大超时、skip 或改 Pi 生产/测试代码 |
| 基线诊断 | 五项 Pi 定向用例通过；基线全量 3465 pass / 4 skipped，见 `baseline-pi-control.log`、`baseline-unit-full.log`。不能因此把当前版本的首次失败追认为无关 |
| 紧接基线后的当前全量 | 3482 pass / 1 fail / 4 skipped；未修改的 performance-baseline resources-shell 子进程超时，输出为空、SIGKILL，见 `unit-paired-after-baseline.log`。全量门禁仍未通过，原因尚未确认；不再循环重跑找绿 |
| 全量计数 | 未生成完整报告：既有 runtime-evidence collector 5 秒超时，见 `full-counts.log`。其他已完成 collector 不替代完整结论 |
| propose | 部分场景报告不足以通过全台账的 propose 前置条件；拒绝已保留在 `ratchet-proposal.log`。未强写或弱化 guard |
| inventory / diff check | 通过；`inventory.log`。新入口来源登记到 providers 路径，既有缺口保留 |

本轮始终使用 Node 24.18.0、临时 fixture/workspace/userData。没有真实/付费 Provider、真实 `.scry` 或用户 DB 写入。iCTRL 只确认真机可用，未操作或替换手机 App。

## L2/L3 与下一步

本机持续高负载：初始 10 核 load 约 41，后续完整检查期间仍明显超过核数。初稿锁内的 focused-test 计时 `highLoad: true`（28.43→28，10 核），而且它不是 Provider 冷/热用户路径基准，不能据此宣称 L2 提速。L2 **未验证**，没有百分比收益或 L3 宣称。

本轮已超过技能约两小时预算，到此停止。下一轮由性能 owner 先补上述能力来源时间/失效链路，再在低负载环境定位/复核默认全量 unit、runtime-evidence collector，以及默认桌面回放的结果输出→app.exit→child close 时序（保留 55 秒期限）；再完成全量 propose 和相同负载的锁内冷/热 L2。未解决前不合入或安装。通过后再请求用户确认合入/安装，真机/iOS 新版本验收另行执行；L3 仍需安装后同场景每侧至少 30 样本、至少两个 App session。
