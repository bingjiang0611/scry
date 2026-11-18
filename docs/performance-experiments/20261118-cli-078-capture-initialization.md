# recorder 0.2.78：采集初始化证据

## 改动与审查范围

维护者已审查原修法，并授权补齐以下行为后合并发布。已变基到包含 daemon 空闲 CPU 修复的 `062a008d`；该修复发布了 0.2.77，因此本次顺延发布 0.2.78。

- 新 claim 等完整基线与控制状态持久化后再 ACK。初始化中断不能重新制作历史基线；publication 重试复用原 generation、turn 与 snapshot，排除路径按并集合并。
- 已开启的同一 capture 重复 start 返回 `already_started`。当前轮次初始化未完成时附带 warning，不把幂等 ACK 当作基线完整证明；不同 capture 的 claim 仍拒绝。
- Stop、正常恢复、过期恢复都将初始化中断轮次的 diff 标为 `unavailable`，并写明 `baseline initialization was interrupted`。迟到的工具基线不能补齐缺口；显式 disabled 保持 disabled。下一轮可正常初始化与采集。
- 宿主启动时间使用固定 C 日期格式；历史不可信身份保持 unknown。普通 Hook 的 durable inbox / fsync / ACK 合同不变。
- 快速迭代 L3 默认要求真实中文系统语言环境与中文工作区/脚本路径，必须记录平台、locale、宿主版本与正式包身份。本次维护者明确接受中文进程 locale；系统界面仍为英文，不能据此宣称中文系统界面已验证。

本次不修 PostToolUse/Stop 的 `forward_deadline`，不改变转发预算或协议。

## 当前验证

- macOS 27.3（26C5047e）、arm64、Node 24.18.0。
- 新增测试先失败：同 capture pending 被拒绝；封箱缺中断原因，晚基线甚至被标为 available。修复后通过。
- 变基后串行 focused 检查：5 文件 / 32 项通过，覆盖初始化、同 capture 幂等、不同 capture 拒绝、排除集合、工作树与宿主 locale。
- Stop / recover / expire 三个封箱场景均验证下一轮真实 Git patch 恢复。expire 场景使用受控 gone-host 证据与时钟，不是真实宿主过期验收。
- `npm run typecheck`（node + web）和 `git diff --check` 通过。未放宽测试超时。
- 先前并行 focused 检查的超时与缺 diff 失败日志保留；串行重跑通过，不将首次失败改写为通过。

## 正式发布

PR [#117](https://github.com/bingjiang0611/scry/pull/117) 已合入 `92b9ada41dd76941d3c6473c2b6ef8b2ddde3b4b`。首次分支 CI 暴露遗漏的 `RECORDER_VERSION`，修正提交为 `c1351d738b1157e68d0cc90124393340489331aa`；不以首次失败作为通过证据。main CI [44236164052](https://github.com/bingjiang0611/scry/actions/runs/44236164052) 最终全部成功，包括类型检查、单测、coverage、Node 20/22/24 CLI、Linux 与 packaged-electron。

- recorder 0.2.78 已正式发布。构件来自上述确切 main 提交，未用本地构建替代。
- 原始 CI tarball SHA256：`4d4fabba671119a2fc03d1b10891a2aaf6f676c3bf905ce9509222cf47b7e9d1`。
- 正式分发 tarball SHA256：`616c0da52fb9f37fc07e229ae4d136ec3a93c10ad4517df30e1d89ef4835256f`；SHA1：`c120e4130c6dfc96567e3bd7c61c9d254262f72f`。
- 分发时仅改 npm 命名空间。registry 下载件的 150 个文件与改名后的 CI 构件逐字节一致；SHA512 integrity 校验通过。隔离 init / doctor / 空 recovery 通过。
- CodeLens 0.2.31 与 uploader 0.2.31 已正式内置 0.2.78；保留 0.2.77 的空闲 CPU 修复及状态查询不续命语义，默认 30 分钟阈值不变。

## 正式包真实宿主：尚未通过

环境为 macOS 27.3（26C5047e）arm64、Node 24.18.0、Python 3.14.6、Qoder 1.1.91、Friday 0.7.62。使用中文工作区与脚本路径，`LC_ALL=zh_CN.UTF-8` / `LC_TIME=C`；AppleLanguages 首选 en-US、AppleLocale 为 en_US。维护者明确接受该进程 locale 口径，不更改系统设置。未使用 recorder override。

两个独立新会话 `2cdda130-05dc-4907-9623-7ed62e1f39dd`、`dac53e82-6739-4270-a418-e4276da4a9e9` 均在身份匹配后的 recorder start 超时，PostToolUse / Stop 留下 `pending_unconfirmed` 与 `gate_deadline_reached`。没有 capture ACK 或自动 uploaded / inserted 回执；也没有可用于单 daemon 和默认空闲退出验收的进程。这不是 forward_deadline，不通过重放旧事件或提高预算掩盖。

带启动追踪的第三个会话仅用于诊断，仍失败，不算默认配置验收。首个 start 进入 JS 后仅约 0.38 秒即被剩余预算终止；另一个 start 没有留下 JS 入口记录。后续机器观测为 10 核、load 101、交换空间约 15.1 GiB。独立诊断中 exec Node 到入口日志出现的间隔曾达 6.30 秒；它包含启动与调度，不能解释为 recorder 初始化本身耗时，不能据此宣称基线同样失败或性能已改善。

第四次独立会话 `7bda9064-ad36-43a8-8dbb-1842ff34065c` 在预检 load 10.0869（10 核、门槛 15）后仍于 PostToolUse start 超时；Stop 重试 exit 4。请求 `75cc912d-2d7a-4f67-a6e6-e8d02227a46a` 的 open turn 为 `initialization=pending`、`captures=[]`，不能把 `baselineAt` 当成初始化完成证明。不能继续只归因于高负载，未重放旧事件或补建基线。

本地原始证据：`/tmp/codelens-formal-0.2.31-20261118{,-recheck,-diagnostic,-idle}/`、`/tmp/codelens-capture-release-20261118/`。维护者随后授权“现在继续修 start”；当前修复在 CodeLens 的 Qoder SessionStart 身份交接层，让脚本使用已有命令预算，尚未完成正式包真实宿主验收。recorder 保持 0.2.78 的完整初始化 ACK 合同，两处 forward_deadline 仍不在本次范围。自动 inserted、单 daemon 与默认 30 分钟空闲退出尚未通过。原未发布组合的成功见 [采集 ACK 预算](20261117-capture-ack-budget.md)，不能替代正式包证据。

## CodeLens 0.2.32 候选与隔离补丁宿主诊断

CodeLens MR !35 合入 `d3b9c2985652c88f96b5972f819abb386552409c`，验证 CI `91178349` SUCCESS，`npm_publish=false`；仍内置未修改的正式 recorder 0.2.78。384 个 runtime 文件内容与权限和 CI 的 npm 构件一致。它通过 Qoder SessionStart 的 ENV_FILE 交接真实身份，让脚本复用命令预算，而不是提前 ACK 或调整 forward_deadline。

官方 Qoder 1.1.91 会话 `ec7bc56a-b3e3-46c7-a097-e138ecc02995` 在 load 6.497 / 10 核下失败：SDK 把带尾部换行的环境脚本与用户命令用 ` && ` 拼接，产生 `zsh:2: parse error near &&`。Friday 未执行，没有 capture、record 或自动上传。SDK 对文件 trim 后仍强制追加换行，删除生产者的末尾换行无效；最小 zsh 控制复现同错，宿主侧将脚本包为复合命令后才通过。原替身用 source 装载环境，漏掉了 SDK 拼接行为。npm latest 查询仍为 1.1.91，因此不能升级到一个已经验证修复的官方版本。

维护者明确选择仅在隔离副本修补 Qoder、继续诊断，不据此发布 CodeLens 0.2.32。副本 351 个文件中只有 `bundle/qodercli.js` 改变；原 SHA-256 `1289a4d8c36e0299dbcca66c25c23dd9ef0951697f5c3a76ee774b01feb3fa26`，补丁 SHA-256 `01ba13d284eb3d0dc8146aa705b1922161e9122aea8333b0b0e7cc4f47d1f319`。未改全局 Qoder、CodeLens runtime、recorder、Friday、Hook 预算或两处 forward。

新的隔离工作区与会话 `39b97b85-6c1a-4f68-8bbe-caef0f7f31eb` 实际只执行一条 Friday collect。环境仍为中文路径和中文进程 locale，load 10.107 / 10 核。脚本返回 `phase=query`、`scry.status=started`、`confirmed=true`、`queued=false`；captureId `9060e5e5-9f60-433f-88ce-2c17cc018ae6` 与真实会话一致。自动 record `7a17c837a03a301025fafac95a0b12bf` 的回执为 `uploaded / inserted`。没有手工补 start、Stop、flush、wakeup 或 upload。

该 record 的 diff 是 `partial`，不是整轮完整快照：显式 claim 在轮次中途，baseline 晚于 prompt 12904 ms，另有集成方排除目录的 5 个文件。日志有一条通知锁超时，后续自动送达、pending=0、deadLetterCount=0、quarantine index=[]；源码显示通知 drain 锁超时会保留待通知记录。没有留下当时的锁 owner 证据，不能断言持锁方或声称修复了超时。

默认 1800 秒单 daemon / 空闲退出观察已完成：PID `25043` 的 157 次进程快照中最多 1 个，终点进程列表为空、原 PID 和 socket 均消失。最后存活 / 首次发现退出分别在启动后 1799.513 / 1809.562 秒；约 10 秒采样，后者不是精确退出时间。28 次只读 GET status 不续命，没有缩短阈值或手工 wake / flush / upload / stop。计时从 daemon 活动算起，不从宿主进程退出重新计时；观察开始于 daemon 启动后 236.068 秒，不证明此前每一瞬间的进程数量。窗口内该 PID 累计 CPU 增量 0.08 秒，不是整个采集子树或启动阶段的 CPU。结果只属于隔离补丁宿主诊断，不能替代正式 CodeLens 包和官方 Qoder 验收。`verification-native.json` 已核对原始 record / 回执 SHA、正确会话、队列收敛、零丢弃 / 孤立事件，以及运行后未修改的 384 个 runtime 文件和全局 Qoder 351 个文件。原始失败根目录 `/private/tmp/codelens-context-candidate-91178349/`；诊断根目录 `/private/tmp/codelens-context-diagnostic-qoder-91178349/`；最小解析控制在 `/tmp/codelens-start-context-20261118/`，SDK 补丁校验和最终诊断 JSON 在诊断根目录。
