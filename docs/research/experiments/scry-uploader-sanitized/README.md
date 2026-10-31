# Scry uploader：公开脱敏审阅快照

> **仅供代码审阅，不是可安装、可发布或可接入真实服务的发行包。** 名称与地址已替换；不要连接占位服务，也不要发布此包。

本目录补充 [AI Trace / Scry CLI 对比](../../ai-trace-vs-scry-cli-20261030.md)。维护者授权修复 uploader 后，先修改并验证源任务分支，再同步生成此脱敏副本。

## 来源与覆盖

- 源版本：`0.2.2`；源任务分支 revision：`afe8b545356115f89a42204d9ba97fe3836e83eb`。
- 包含该 revision 的 **47 个 Git 跟踪文件**：源码、测试、合成 fixture、包元数据、锁文件、TypeScript 配置、上游说明及许可证。
- 源仓库只做本地提交，未推送其远端。公开仓库不包含源 Git 历史或私有名称映射。
- 保留 MIT 许可证及原有公开版权署名。
- 不包含 `node_modules`、`dist`、tarball、本机配置、真实 records、身份、凭据或数据库。
- `UPSTREAM-README.md` 是同步替换后的上游说明，不是本快照的部署手册。
- [SNAPSHOT.json](SNAPSHOT.json) 固定版本、验证范围及公开文件 SHA-256；清单不计算自身 hash。
- 先前 `0.2.0` / 27 文件 / 44 测试的审阅基线保留在 PR 历史中。本次不沿用旧单体文件的大小检查豁免。

## 本次修复

| 领域 | 行为与边界 | 阅读入口 |
| --- | --- | --- |
| 批次与坏记录 | 按最终参数 JSON 的 UTF-8 字节数限制 512 KiB；单条超限保留死信；确定性 400/413 拆批隔离 | `src/uploader-worker.ts`、`src/uploader-batch.ts` |
| 传输与预算 | timeout、429、网络/5xx 冷却并保留未知远端结果；共享 Retry-After；正常进度不消耗永久失败次数 | `src/retry.ts`、`src/admission.ts` |
| worker 与锁 | 唤醒合并、lost-wakeup 握手、竞争失败退出；每仓一个 worker、每用户最多两个上传配额；稳定 inode 内核租约 | `src/queue.ts`、`src/locks.ts` |
| 发现与游标 | 先发已托管数据，再做 export；仅隔离 pinned recorder 明确拒绝且身份可核对的记录；未知错误不盲跳 | `src/uploader-custody.ts`、`src/scry.ts` |
| 关闭与重新开启 | 持久关闭；重新开启以安全高水位为界，只允许新记录；历史逐条显式 release；丢失通知时仍尊重 recorder 的 opt-out | `src/uploader.ts`、`src/uploader-state.ts` |
| 多仓恢复 | 仅恢复显式登记路径；逐仓校验和错误隔离；保留退避与会话上下文，但不从旧队列恢复 executable、安装身份或状态目录 authority | `src/scheduler.ts`、`src/queue.ts` |
| 数据保留 | export 先接管 canonical 字节再推进游标；旧无 receipt outbox 先托管再发送；缺少 custody 禁止完成终态；legacy ACK 保留实际提交副本。只有 ACK 满 30 天的副本可清理，保留去重 receipt，不删除 canonical、held、未确认或死信正文 | `src/custody/receipts.ts`、`src/custody/index.ts` |
| 协议与身份 | 等待进程 close 并读取完整协议 stdout；认证文件原子替换使缓存失效；仓库身份保留 host/namespace，不带 URL 凭据、query 或 fragment | `src/util.ts`、`src/transport.ts` |

发现游标不是远端 ACK，也不是关闭权限边界。旧 `enqueuedThrough` 较大不能使未确认的 custody 消失。内核锁、持久状态和指纹检查也不构成安全沙箱。

## 脱敏改变了什么

| 类别 | 公开形式 |
| --- | --- |
| 包命名空间 | `@review/*` |
| 传输 CLI、文件、函数和环境键 | `transport`、`TRANSPORT_*`、`fake-transport.mjs` |
| 服务、方法和 Skill | `agent-trace-service`、`submitTurns`、`agent-trace-skill` |
| 身份协议 | `userId`、`actorUserId`、`subject_id`、`--sso` |
| 宿主集成 | `host-app`、`HOST_*`、`REMOTE_TRACE_*` |
| 安装脚本和 registry | `https://installer.invalid/...`、`https://registry.invalid/...` |
| 发布保护 | `package.json` 增加 `private: true` |

替换一致应用于 import、调用、测试、命令模板及包元数据；锁文件 integrity 保持不变。脱敏步骤不另改分支、限额、断言或失败语义。修复发生在源任务分支，而不是只修公开副本。

**源码公开脱敏不等于运行时数据脱敏。** `REDACTION_VERSION` 仍为 `none`。私有安装版可能托管并发送完整 record；本快照没有真实正文，不代表运行时会过滤敏感内容。

## 验证

- 环境：macOS arm64、Node `24.18.0`、recorder `0.2.53`。
- 原版与脱敏副本各自运行 `npm run check`：构建、**84/84 测试，0 skipped**、`npm pack --dry-run` 均通过。原版额外的 TypeScript unused 检查通过。
- 同步后逐文件核对冻结源 revision 的确定性替换结果；源码/测试不使用旧单体文件大小豁免。
- 关键回归：60 条记录首轮完成 35 条后保留进度；追加通知与 10 个并发唤醒；三个独立 CLI 的全局并发限制；坏 exporter/不可访问仓库隔离；完整 wire 大小；跨进程关闭与重复 enable；清理中断及重放；队列环境权限隔离。
- 四个独立破坏对照按预期失败：并发槽改为 3、恢复旧环境覆盖、移除旧关闭标记的 enable 保护、用 exit 代替 close。最后一个对照只取得 6 字节，而不是预期的 70,006 字节。
- 真实恢复发现 `0.2.1` 的 export 路径没有持久化 custody/ACK receipt。远端查询确认该记录已保存，未重发。`0.2.2` 修复此路径及旧无 receipt outbox、legacy 提交副本；原先静默完成终态改为明确拒绝。对应旧实现失败对照已复现，原文件保留断言未删除。
- 首轮失败保留记录：曾修正 cutoff、baseline、service 转义与 fixture 假设；升级后还有旧版本字符串/静默终态预期未同步、2 秒子进程 fixture 失败及外层命令超时。最终将独立测试文件串行化，未扩大单项超时，完整检查重新通过。验收脚本也修正了 commitHook 配置和持久锁文件的判断，不把这些脚本错误当产品成功。
- 私有安装版 `0.2.2` 已部署：72 个包文件与 tarball 一致，99 个 recorder 运行文件与测试依赖一致。真实 launchd 在无通知、无队列任务时恢复 **1 条新记录**，获得 `inserted` ACK；远端查询确认完整结构化内容一致。**2 条关闭期间的记录均未在远端找到**，4 条 canonical 原始字节未变，新记录 custody 字节一致。随后按安全高水位启用获授权主工作区，定时恢复正常。
- 上述真实验收使用合成 hook 记录、真实 recorder 与真实传输，不是实际 Provider 会话验收。公开占位版未连接真实服务；不附部署路径、正文、身份、凭据或原始响应。

## 可运行性与未验证边界

- 测试使用临时 workspace/HOME、fake transport 和本地进程；不能证明所有真实网关错误、服务端大小限制或并发凭据刷新行为。
- macOS 内核锁和真实子进程已覆盖；Linux `flock`、systemd 实际运行尚未验收。服务定义的字符串检查不等于 Linux 部署成功。
- **公共读者不能直接 `npm ci` 复现。** `@review/scry-turn-recorder@0.2.53` 是占位名称。测试复用本机已获授权的同版本依赖，只在不提交的 `node_modules` 中建立别名；未发布该依赖或符号链接。
- 对比文章固定的 Scry CLI 为 `0.2.52`，此 uploader 使用 `0.2.53`；两者验证范围不同。
- 本目录仍在 `experiments` 排除范围，不进入 Scry App 的测试发现或发布依赖；本任务不构建、安装桌面 App。

审阅时请给出文件/行号、失败链路、测试覆盖及最小修复建议。不要把公开别名当真实端点，也不要为复核恢复私人正文或开启生产上传。
