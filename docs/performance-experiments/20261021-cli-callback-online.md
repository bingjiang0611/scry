# 独立 CLI 与 App：通知 ACK 身份互相覆盖

> 本文保留发现问题与暂停诊断 daemon 时的状态。用户随后授权继续修复，0.2.50 已仅部署独立 CLI；最新实现、验证及限制见[ACK 隔离交付记录](20261021-cli-ack-isolation.md)。

这是前一份[离线实验](20261021-cli-multirepo-concurrency.md)之后的在线调查。用户另行授权了真实回调、daemon 切换、自动补发及可能的上传。没有启动付费 Provider、推送、替换全局 CLI 或安装 App。

## 结论与处置

**已证实两个投递身份共用一个 ACK 文件，导致反复从头重放。** 项目桥接修复正确，但不足以解决 App 与独立 CLI 共存的问题。没有将不同指纹视为同一授权，没有手工推进 ACK 或删除队列。

| 时间（UTC，2026-10-21） | ACK / 身份 | 持有通知锁的进程 |
| --- | --- | --- |
| 14:41:49.215 | 2422 / CLI 配置指纹 | 此时无锁 |
| 14:42:33.490 | 1 / App 指纹 | 56135，`/Applications/Scry.app/Contents/MacOS/Scry` |
| 14:42:34.532 | 8 / App 指纹 | 56135 |
| 14:42:42.573 | 1 / CLI 配置指纹 | 87281，诊断 daemon |
| 14:43:49.136 | 468 / CLI 配置指纹 | 87281 |

- CLI 配置指纹：`05453ab89e4c0dd25a946f811a0f394894197ab20c4243418a64b9236a5651bd`。
- App 指纹：`sha256:81fb5a75c0e9583a83b0eb8fce10d6cea63b6e4c0da8c0dbfedf55066f5d7afb`。本次未证明两个指纹对应完全相同的执行 bundle；不能直接归一或复用 ACK。
- 监听使用文件事件，不触发投递。120 秒内读取 753 次状态，读取失败 0。关键写入前后的锁 token 相同，进程身份由 macOS 进程参数接口取得。
- `store.ts` 在锁内读取单个 `notifications/commit-hook-state.json`；指纹不匹配时从 0 开始，成功后用当前身份覆盖同一文件。锁串行化写入，却没有隔离不同身份的进度。
- 已排除本轮检查中 2,192 个文件的文件名序号与 JSON 序号不一致、重复 JSON 序号。检查的是这些字段，不是逐条人工阅读会话正文。
- 发现循环后，通过正常 recorder stop 停止了本次启动的诊断 daemon 87281，确认 PID 已结束、owner 文件已移除。没有停止用户 App。正常 hook 以后仍可能启动已安装 CLI，这不等于全局禁用录制或投递。

## 实际做过的变更

1. Scry 提交 `708a7d65f2199daaf0615be5983ae86a40316afb`：回调失败日志区分 spawn、非零退出、signal、stdin、timeout，并记录退出码、信号、errno 和 recorder PID。不保存原始 stderr、命令参数或错误消息；ACK、超时和 trust 行为不变。
2. `rate-native` 的三个已离线验证文件以 fast-forward 合入其现有分支，提交仍为 `106dc3f8e86b6dd1ee1404c695ca4944719b4edf`。与验证工作树逐字节一致，无关 WIP 与暂存区未混入。仅该 Git 命令禁用会执行真实 tracker 的 hook，未改持久配置。
3. 先从旧 daemon 69793 取得回调白名单环境，以相同 Node 22.23.1、相同真实通知 sequence 5 做一次真实回调。记录复制到私有临时 outbox，真实通知游标不被该 probe 写入。执行前校验七文件 bundle 指纹；回调 ACK 成功，但不等于网络上传成功。
4. 正常停止旧 daemon，启动诊断构建 87281。其环境不再包含桥接合成的 host override。全局 CLI 文件没有被替换。版本字符串仍为 0.2.49，不能用它区分诊断构建。
5. 显式 notify-drain 返回 exit 3、delivered 0、pending 1365；日志及锁 owner 表明诊断 daemon 正在持锁自动补发。没有重试该命令。随后只读观察到反复覆盖，停止了诊断 daemon。

诊断构建 `store.js` SHA-256：`df908971ce18bdc984d7b41cf69154f71806f9496aafdf262ffaf0d27f1a073e`；CLI entry SHA-256：`1457bd9e30b87e8617571019ea59112182a77fae0f45255ec587bdcbaab6c274`。

## 通知积压不是上传积压

- 干预前的 12:02 UTC 快照：上传 `enqueuedThrough=2411`，上传 outbox 待发 0，上传 dead-letter 3。不能声称两千余条通知代表两千余条数据尚未上传。
- 在线检查曾达到上传 `enqueuedThrough=2419`、outbox 0、health healthy。期间用户仍在产生新记录，不能把全部进展归因于本次操作。
- 三条上传死信是 sequence 97、98、297，原因为本地 `oversize_after_redaction`，日期为 2026-08-10。文件与干预前快照逐字节一致，未重投或删除。它们并不证明当前服务端拒绝，也不能因当前上限不同就直接改写终态。
- 反复投递增加了 async callback job。停止诊断 daemon 后一次快照有 5,106 个排队文件；这不是 5,106 条未上传记录。原有 worker 继续处理它们，没有清队列或停止用户 worker。
- async queue 另有 1,678 个历史 dead-letter 文件，最新 mtime 为 2026-10-14；本次诊断启动之后新增为 0。它们与上述三个上传死信是不同层，不混计。

## 验证

| 检查 | 结果 |
| --- | --- |
| 新回调诊断 focused | 4 通过；非零退出、signal、spawn error、真实 10 秒截止；失败不推进 ACK，日志不含 stderr secret |
| 旧实现负对照 | 三个新诊断用例均因缺少诊断字段失败 |
| `npm run check:cli-release` | 类型检查、593 项测试、CLI build、临时安装后的 package smoke 通过 |
| `npm run test:unit` | 完整运行：3469 通过、4 个既有 opt-in 跳过、1 项 5 秒超时 |
| 失败基线对照 | 干净 `c229f79` 上相同 `runtime-evidence.counters.test.ts` 用例同样超时；未改断言或测试时限 |
| 性能计数 | `performance:measure --scenario source-control.diff`，5 次均 Git / total 子进程 8，ratchet 通过；没有提速结论 |
| 实际停止 | stop 返回 true，诊断 PID 不存在，owner 文件移除 |

第一次 full unit 被工具的 300 秒执行期限中断，当时没有断言失败汇总。确认该工作树已无 Vitest 进程后，以足够的工具等待期限完整运行，得到上表结果；没有修改测试自身 timeout，也不把后续结果称为全量全绿。

## 尚未解决及下一步

- 历史 `callback did not ACK` 的具体原因仍未知。同环境真实单条回调成功，诊断 daemon 运行期间未捕获新的 callback 失败；身份覆盖解释了重复投递，不足以解释所有历史退出失败。
- 下一项实现应隔离不同指纹的持久 ACK，不能强制两个指纹相等或给新身份复用旧 ACK。需要先明确旧单游标的迁移、旧 App 与新 CLI 并存、bundle 更新和 archive 的合同，再补真实临时目录与并发回归。
- 不应再用当前单游标实现做全量补发，也不应为了队列变空删除任务。是否扩大到上述持久化修复及后续部署，由用户确认。
- 三个历史超限上传死信另行处理；本次未改 payload、上限或终态。

本机只读证据与脚本保留在 `/tmp/scry-cli-multirepo.AVEdj0/`：`notification-identity-watch.json`、`online-status.json`、`diagnostic-daemon-restart.json`、`diagnostic-daemon-stop.json`、`live-notification-drain.json`、`live-delivery-state-q5i7yzqr/`。其中快照包含私有记录，不能上传；文档只保留字段、计数和构建身份。
