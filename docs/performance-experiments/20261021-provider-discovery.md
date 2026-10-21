# 2026-10-21 方案 A：按选中上下文发现 Provider 能力

## 范围与交付状态

- 基线：`4b624c8a6cac6296c4430bfe72afd27b8468e55c`；隔离分支 `perf/provider-control-20261021T115356Z`。原 main 的并行 WIP 未迁入、未改动。
- 初稿提交：`ce51eb0`、`d664f35`。父任务复核发现初稿的测量只是通用去重 helper，并不足以证明真实发现调用链；已替换为 main 实际使用的领域实现及其计数，不沿用初稿的完整验收结论。
- 修正源码提交 `7d46bc6`；回归/collector/candidate 台账独立提交 `39739f2`，需连同初稿提交一起查看最终树。合入 main、安装、push、发布均未执行。不是可直接发布的完整 gate 通过状态。
- 首轮隔离桌面构建：生产源码已提交于 `39739f2`，App 版本沿用基线 **0.2.216**，build ID `c8749c955d123b2ed99253c9e10136a4e0c7bb3301dc0cf70992a8437f8c987a`。此前全量 renderer UI 检查使用 build `d4d001dd31dd1f21a2f4647db2bd762874ecf9dab61082e085316856d81c729b`；其后仅复用 gateway 的纯选项映射，当前 gateway 36 项通过，并对最终构建重放 A 专项。二者都是测试构建，不是安装身份。
- 日常 baseline 是已运行的 0.2.215/build `6eaf858de913113b87db8ed41811ab57cdf50e2e1c86f874a6cf7480a316d9b4`；candidate 未部署，没有日常前后对照或 L3 结论。

## 假设与实现

原远程 picker 快照在一分钟 TTL/十五秒 tick 的链路中，对全部可用 Provider/Pi Profile 调用 runControls，并等待全部结果。改为：

1. 定时刷新只读取 descriptor/Profile 元数据，不初始化 Provider runtime。
2. 支持新协议的客户端先通过已有 desktop/info 协商 `providerDiscovery: 2`，再发送 metadata/selected 请求。旧主机只收到原有无 detail 请求，不靠错误重试或假定旧主机会理解新字段。
3. selected 绑定 Provider、Profile 和 canonical cwd；每次先重验工作区授权，进入原 ProviderOperationGate。相同上下文只合并在途请求，完成/失败后不留能力结果缓存；不同上下文互不等待。
4. 新旧查询路径显式区分。旧客户端仍可主动获取全量快照，保留原有 60 秒复用；新客户端连接旧主机使用明确标注的 legacy snapshot，执行仍由宿主重验。
5. 桌面与 iOS 在切换/加载时撤销旧就绪状态。返回值 unavailable、旧回复、失效模型/effort/权限不能启用发送，也不静默退回默认值。失败有显式重读入口。iOS 恢复先恢复身份，收到对应 cwd 的能力后才验证保存的控制项。

**实例复用边界**：复用 Qoder/OpenCode 已有实例与 Pi 已有重叠请求机制；不延长其 TTL，不把 discovery 与会话 writer 混用。Pi 公开 RPC 无可证明完整刷新的 reload 合同，因此没有新增跨请求常驻 Pi 能力实例或 settled cache，后续显式刷新仍启动真实探测。该项仍是后续平台协议工作的限制，不宣称已消除真实 Pi 冷启动等待。

**首轮时尚未完成整个方案 A**：当时完成按需查询和在途复用。选中能力还未贯穿来源读取时间与配置变化的版本化失效；尤其桌面 selected effect 不订阅元数据刷新代次，成功后的目录变化不能只依靠当前固定依赖自动重验。需要补充可见选中上下文的有界重读/失效信号、来源时间和显式成功重读，并保持隐藏/卸载暂停及旧回复栅栏。未补齐前不能把此分支当作完整 A 合入。常驻 Pi 能力实例也仍受上述原生 reload 合同限制。

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

## 首轮 L2/L3 与交接

本机持续高负载：初始 10 核 load 约 41，后续完整检查期间仍明显超过核数。初稿锁内的 focused-test 计时 `highLoad: true`（28.43→28，10 核），而且它不是 Provider 冷/热用户路径基准，不能据此宣称 L2 提速。L2 **未验证**，没有百分比收益或 L3 宣称。

首轮超过技能约两小时预算后暂停，随后用户明确选择继续收口按需层，不做 Pi 跨请求缓存、不合入或安装。原交接要求由性能 owner 先补上述能力来源时间/失效链路，再在低负载环境定位/复核默认全量 unit、runtime-evidence collector，以及默认桌面回放的结果输出→app.exit→child close 时序（保留 55 秒期限）；再完成全量 propose 和相同负载的锁内冷/热 L2。未解决前不合入或安装。通过后再请求用户确认合入/安装，真机/iOS 新版本验收另行执行；L3 仍需安装后同场景每侧至少 30 样本、至少两个 App session。

## 第二轮：按需层收口（2026-10-21）

源码提交 `a742d62`，测试与 fixture 诊断独立提交 `1588832`。最终受检源码补丁（相对 `202460b`）SHA-256 为 `5e404400388f053e90b871cd2b1bf660024a9b43289e574a1ac8464994c11a6d`，保存在本机 `phase2-final-source.patch`。这是按需层的实现收口，不是整个常驻方案 A 完成，也不是可合入/发布的全门禁通过。

- 增加主机观察时间 `observedAt`，缺失显示未知，不填当前时间或 0。它表示 Scry 收到 adapter 结果的时间，不是底层 Provider catalog 的更新时间。
- 元数据发布使用独立 `metadataRevision`，不拿可回拨/同毫秒的时钟当版本。已知 Profile 增删、显式 Provider context 失效触发重新观测；其中显式 context 失效经过已有 ProviderOperationGate，与认证互斥。
- 失效前的在途能力结果不再发布为可用；新读取等待旧 adapter 请求结束，再重验工作区/Profile 并读取。Profile 展示名称不参与 runtime 去重键。元数据在途旧读取也不能覆盖已知失效后的快照。
- 修复共享 CachedAsyncLoader 的失效竞态：旧在途读取不回填新代次缓存；显式要求新代次的调用等待旧读取收敛后重读。这也防止 legacy 快照将失效结果再缓存 60 秒。普通 TTL、错误不缓存和并发合并合同保留。
- 桌面订阅元数据版本，隐藏时不新查能力；可见性恢复、可见窗口 focus、手动刷新会重读。相同上下文重读期间保留选择并显示“重新读取中”及旧来源时间；失败丢弃旧成功值，不冒充当前。运行中不显示可操作的来源提示。
- iOS 保留可验证的来源时间与成功重读入口，只在相关页面可见且恢复前台时重读；不新增永久轮询。Session 重读显式使用该 session 的 cwd。
- 不增加 Pi settled cache，不延长 Qoder/OpenCode 原生缓存/实例 TTL，不新增全配置文件 watcher，不承诺所有外部配置写入立即生效。实际 SDK 缓存/重载能力仍逐 Provider 决定；执行前原有授权、trust/fingerprint 重验不变。

### 第二轮验证与失败记录

日志均在 `/tmp/scry-provider-control.UGpNzU/`。新实现没有真实/付费 Provider 探针、安装、模拟器或日常记录格式变更。

| 项 | 实际结果与范围 |
| --- | --- |
| 最终类型检查 | `phase2-review-fixes-typecheck.log` 通过 |
| 桌面 build / 完整 renderer UI | `phase2-renderer-ui-final.log` 通过，包括 Credits、生产 conversation IPC；此前完整 UI 亦通过，见 `phase2-renderer-ui-full.log` |
| 最终全量 unit | `phase2-unit-final.log`：290 文件，3490 pass / 1 fail / 4 既有 opt-in skipped；SessionRename 原生 Electron fixture 30 秒超时。未修改其源码、断言或期限，完整 unit **仍不通过** |
| Rename 隔离诊断 | 同一候选与干净基线各单跑 1 项均通过，见 `phase2-rename-isolated.log`、`phase2-rename-baseline.log`。不抹掉完整运行的首次失败，也不能据此证明其因果与本次改动无关 |
| 缓存/失效与计数 focused | `phase2-review-fixes-focused.log`：3 文件 25 项通过；覆盖旧成功/旧失败均不能回填新缓存、失效期间 legacy 重读、旧元数据不发布、在途结果失效、时钟不变仍更新版本 |
| 新行为的 Chromium 回归 | `phase2-review-fixes-ui.log`：原生指针/键盘回放通过，覆盖相同上下文版本变化、成功手动刷新、重读失败丢弃旧值、隐藏不新查、恢复可见及 focus 事件重读。visibility/focus 策略用受控浏览器事件验证，不冒充真实 OS 切 App 验收 |
| 负对照 | `phase2-negative-revision.log`：仅在 fixture bundle 移除版本依赖，确定性失败于“same-context metadata invalidates selected controls”；生产文件未改写 |
| L1 | `phase2-counts.log` / `phase2-counts/measure.json`：原固定负载各 5 轮，metadata=0、selected=1、legacy=3；这三个 candidate 的 scoped ratchet 通过，不是全台账 propose 或 CLI 启动数/毫秒收益 |
| Swift package | `phase2-swift-full.log`：新增协议组 5 项通过，完整运行随后再次命中基线已证明存在的 Lane.swift:240 leaked promise；未改 TLS 实现，不能记完整 Swift 通过 |
| iOS App 编译 | `phase2-ios-build.log`：unsigned Debug、generic iPhoneOS SDK 编译通过；产物在 `phase2-ios-build/`，未安装、未真机重放 |

第二轮首次默认 UI 出现新增来源栏的指针命中移动，见 `phase2-ui-default.log`；以同步初始化已缓存的 Provider 选择、稳定来源栏高度修正，未加等待/重试。另一次默认回放将运行中仍显示的信息栏视作旧“等待”状态，见 `phase2-ui-default-layout-fix.log`；运行中隐藏该信息栏，历史重连断言只允许非阻塞 info 留存，离线断言加强为非 info 按钮。随后默认回放与最终完整 renderer UI 通过。旧 55 秒退出问题未再次复现，保留原期限，并在失败日志记录 result、exit 请求、进程 exit/close 阶段；不声称已证明原根因。

完整运行的历史失败也保留：`phase2-unit-full-serial.log` 在工具 600 秒截止时中断，已完成 6 文件有 8 项失败；`phase2-unit-full-default.log` 被中断，末尾 ERR_IPC_CHANNEL_CLOSED；按完全执行文件续跑 `phase2-unit-remaining.log` 后覆盖 290 文件的同一源码范围时有 3 项失败（runtime-evidence、MarkdownLayout、Pi lifecycle），不冒充单次完整运行。其源码补丁为较早的 `ba310591...`，不替代上述最终 `5e404400...` 全量。基线对照 `phase2-baseline-timeout-control.log` 的两个对应文件单跑 4 项通过；尚不能把全部超时简单归因于资源或本次代码。

**交付边界**：按需层专项、完整 renderer UI、类型、桌面/iPhoneOS 编译和 scoped L1 已验证；完整 unit/Swift 未全部通过，原生/付费 Provider、真实手机、安装构建和 L2/L3 未验证。本轮机器负载从约 142 降至约 13（10 核），不报告毫秒提升。性能 owner 下一步先在可控空闲环境复核 Rename 完整运行及独立 TLS 失败，保留现有期限；再补独立的冷/热 L2。当前仅保留本地提交，不合入、push 或安装。
