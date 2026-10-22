# A+B 合入 main 与开发版安装（2026-10-22）

## 交付身份

- A+B 完整历史：`d855aa33bd676eae2073516c204e14922ab300c9`；原受检代码 `4d561dd`。
- 初次组合合并：`821957a`，保留 main `9aac41d` 与 A+B 两个 parent。
- 期间 main 的并行 Pi 修复 `a8de51b`、`5afd15d` 均保留；最终受检、已合入 main 的代码：`b155baadd8dad3a5c7528e3dbe1e2e6c1d34f138`。
- 已安装 `/Applications/Scry.app`：**0.2.219**。内置 CLI **0.2.51**；未升级/发布全局 npm CLI，未 push。
- 最终为本机开发证书签名产物，**不是公证发布版**。未停止或重启日常实例；用户需自行重启加载新版本。
- installed build ID：`3bc8f2030416ff0e682e50d250770a6bb0e75ccec08dc3ec8e7095d2c8842921`。
- installed `app.asar` SHA-256：`8a4e46dcb36926c01935d62fd672c7fafc500cbc90e16244448d2610e4f69008`。
- 从安装后 asar 提取 main bundle，确认包含当前源码/依赖锁计算的 build ID；安装器验证版本与内置 CLI，安装后重新核对 asar 和深度签名。

## 集成处理

18 个冲突按合同组合，未整文件取 ours/theirs。保留 main 的远程队列、会话 fork/delete、来源 profile 校验、附件读取边界、统一对话写入栅栏和 CLI 多仓库/零候选优化。

额外补齐三个交界问题：

1. 原生 fork 支持由静态 adapter 能力传入 metadata/selected/legacy，再由 gateway 保留；metadata 仍不启动 SDK controls。
2. 严格归档读取在索引证据不完整时拒绝，不因坏的页外 canonical 文件返回缩小后的成功结果。
3. 归档 metadata 增加 profile-aware 格式标记。旧 v2 从 canonical 恢复真实 profile/null/unknown，不把请求 profile 赋给旧数据。

新增标记校验同时覆盖基表和 delta。严格分页仍只读取所选正文，先核对 canonical 成员和文件指纹；没有为安全校验重新加入每页全量正文扫描。负对照先出现冷读 80 而非 40 个正文，再出现 121 次 parse 超过 41 上限；修复后该检查和严格损坏/profile 回归均通过。

## 当前版本验证

主验证在隔离 mac2 worktree，Node 24.18.0 / Electron 42.10.1 / macOS 26.3.2。打包及 App 行为使用临时 workspace/userData、合成 Provider，不执行真实账号或付费调用。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 类型、完整 unit、shell | **3699 pass / 4 既有 opt-in skipped**，类型和 shell 通过 | `npm run pack`；`ab-main-pack-pinned.log` |
| App/CLI build、目录包、资源 allowlist、打包安全冒烟 | 通过 | 同上，含 navigation/subframe、终端崩溃恢复、归档权限、目录选择、workbench |
| 完整 renderer UI | 通过 | `npm run test:renderer:ui`；`ab-main-renderer-pinned.log` |
| CLI release 检查与临时 tarball 安装冒烟 | 通过，CLI 0.2.51 | `npm run check:cli-release`；`ab-main-cli-release-pinned-confirmed.log` |
| 固定性能门禁 | 43 个 measured observations，各 5 次；ratchet 通过 | `npm run performance:measure -- --out ../ab-main-performance-pinned` |
| iOS 源码编译 | Xcode 26.6、generic iphoneos、禁用签名，BUILD SUCCEEDED | `ios-compile.log`；未安装或操作手机 |
| 本机最终可安装产物 | build、CLI build、打包检查及完整 packaged smoke 通过 | `npm run pack:artifact`；`local-signed-pack.log` |
| 原子安装与最终签名 | App 0.2.219 / CLI 0.2.51；深度签名通过 | `node scripts/install-macos.mjs`；`codesign --verify --deep --strict /Applications/Scry.app` |

原有设计 WIP 的三个文件字节未变，暂存区保持原来的空状态。五个 Pi WIP 文件在任务期间由并行 main 提交收口，完整纳入上述两个 Pi 提交，没有用旧快照覆盖。

## 首次失败与修复记录

- 最初冲突解析时，本机归档用例触发 5 秒期限；子任务曾用 15 秒做诊断。该结果不算交付 gate；最终低负载完整检查使用原期限通过。
- 首轮 packaged smoke 在 shell 退出时看到 `(zsh)`，拒绝信号而失败。清理器现在对变化身份不发信号，只在原有有界等待内确认退出；仍存活则失败。两个确定性负对照和真实 TERM-resistant 子进程回归通过；未增加等待期限。
- host capability 精确断言补入新增 `providerDiscovery: 2`；UI fixture metadata 补回真实原生 fork flag。保留原功能和断言。
- 统一对话的 accepted delivery 早于 runtime settlement。通过只读 adoption 观察等待原生来源所有权，再做一次应拒绝的写入；未重试未知写入或放宽所有权错误断言。
- workspace fixture 的保存 Promise 太快结束，漏掉应检查的 dirty 状态。只在 fixture 控制 write completion，保留原生输入、dirty、实际保存和清除按钮断言；无生产改动、sleep、重试或期限放宽。
- 一次组合命令达到外层 600 秒边界；检查日志和进程确认无在途任务后，单独获得 CLI 检查退出码 0，再运行性能门禁。
- mac2 无本机开发证书，转移产物的追加深度签名检查失败。最终改为本机现有证书通过原 `pack:artifact` 流程重新打包、全部冒烟、深度验证、原子安装。中间未签名产物不是最终交付。
- 安装备份现为同一个已签名 0.2.219 恢复副本，不是 0.2.218 回滚包；目标与备份均通过深度签名，asar SHA 相同。

原始日志保留，不把后续通过写成首次成功。未修改门限、tolerance、测试期限或 workload。

## 性能爬坡整体结果与边界

下表是**原 A+B 冻结代码 `4d561dd` 的低负载受控 L2**，不是安装后日常 App 的重测。完整方法见[证据引擎](20261022-evidence-engine.md)和[OpenCode 租期](20261022-opencode-control-lease.md)。

| 用户路径/工作量 | 对照 → A+B | 含义 |
| --- | --- | --- |
| OpenCode 三次能力读取启动次数 | 3 → 1 | 后续复用，不省略指纹校验 |
| OpenCode 三读合计中位数 | 1939.06 → 931.91 ms | 约减少 52%；首冷读没有改善证明 |
| 4000 轮历史，首次最新+旧页 | 1708.1 → 1002.7 ms | 同正文 SHA；生产 Electron IPC |
| 同场景暖两页合计中位数 | 958.1 → 154.6 ms | 约减少 84%，非屏幕绘制耗时 |
| 单独旧页 | 0.8 → 39.0 ms | 按页 hydration 与来源重验的明确成本 |
| 1000 文件 Git 完整 patch | 中位 53/1000 → 1000/1000 | 8 批，原 patch 总预算不变 |
| Pi 4000 轮暖读 API 字节 | 21,517,508 → 215,440 | 不是物理磁盘吞吐 |
| 大 journal 完整 intent 写入 | 3 → 1 | 另有两个小 phase；收敛顺序不变 |
| 归档插入+相同重试写入字节 | 981,132 → 796 | 包含后续读取，不隐藏延后工作 |

A 不等于统一常驻：OpenCode 有界复用，Qoder 保留 5 秒 idle 并修正刷新/关闭所有权，Pi 继续 fresh。B 仍有 O(history metadata) 成员/指纹核对，冷源和损坏恢复可全扫。必要的 I/O/旧页成本没有通过抬基线掩盖。

本轮没有真实 Provider、真机操作、完整 Swift XCTest、CPU instruction 或日常 L3 结论。若要评价日常提升，用户重启后按相同场景收集每侧至少 30 样本、至少 2 会话；不能拿旧 build 日志评价新代码。

## 可读证据位置

- 本机：`/private/tmp/scry-ab-main-integration.QY7ic6/`。
- mac2：`/Users/test/scry-provider-control-mac2.IEatqT/ab-main-*-pinned.log`、`ab-main-cli-release-pinned-confirmed.log`、`ab-main-performance-pinned/measure.json`。
- 原 A/B 全部实验与失败记录继续保留在原实验文档和隔离树；本次没有删除或覆盖旧证据。
