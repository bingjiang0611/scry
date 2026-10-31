# Scry uploader：公开脱敏审阅快照

> **仅供代码审阅，不是可安装、可发布或可接入真实服务的发行包。** 名称与地址已替换；不要按上游安装说明连接占位服务，也不要发布此包。

此目录补充[AI Trace / Scry CLI 对比](../../ai-trace-vs-scry-cli-20261030.md)，让另一位 Agent 可以检查 uploader 的真实实现，而不接触公司名称、内部地址、身份、凭据或私人采集记录。

## 来源与覆盖

- 源包版本：`0.2.0`。源仓库 `main` revision：`8e8a9dce2a8f72c9d55432dc224807381caf24da`，2026-10-30 读取时已 fetch 并确认本地与远端相同。
- 包含该 revision 的 **27 个 Git 跟踪文件**的脱敏副本：源码、测试、fixture、包元数据、锁文件、TypeScript 配置、上游说明和许可证。
- 保留 MIT 许可证与原有公开版权署名，不转移作者身份或重新授权。
- 不包含 `.git`/历史、未跟踪文件、打包 tarball、`dist`、`node_modules`、本机配置、真实 records、凭据或采集数据库。
- `UPSTREAM-README.md` 是经过同样替换的上游说明，不是本快照的部署操作手册。
- [SNAPSHOT.json](SNAPSHOT.json) 列出公开文件及其 SHA-256，供审阅时固定版本。它不含源仓库 URL 或可逆的私有名称映射。

## 脱敏改变了什么

| 类别 | 公开形式 | 对复核的影响 |
| --- | --- | --- |
| 包命名空间 | `@review/*` | 占位名称，不代表存在对应公共 npm 包 |
| 传输 CLI、文件名、函数名、环境键 | `transport`、`TRANSPORT_*`；fixture 为 `fake-transport.mjs` | 一致替换 import、调用、测试和命令模板；真实 CLI 不能直接使用这些假名 |
| 远端服务、方法和 Skill | `agent-trace-service`、`submitTurns`、`agent-trace-skill` | 保留参数位置和处理分支，不公开实际服务标识 |
| 身份协议字段 | `userId`、`actorUserId`、`subject_id`、`--sso` | 保留身份解析和验证流程；这些是公开别名，不是原服务字段契约 |
| 宿主/上传集成标识 | `host-app`、`HOST_*`、`REMOTE_TRACE_*` | 不可直接用于配置真实宿主 |
| 安装脚本与 registry URL | `https://installer.invalid/...`、`https://registry.invalid/...` | `.invalid` 是不可用占位地址；没有保留真实域名 |
| 包发布 | `package.json` 增加 `private: true` | 防止误当发行包发布；其他构建/测试脚本保留 |

保持不变的部分包括状态转换、分支、重试/退避、上限、超时、锁、文件路径校验、hash 校验、原始字节托管、失败处理和测试断言。未为这次公开顺手修 bug 或弱化测试；审阅者看到的潜在缺陷也不会被“脱敏”掩盖。

特别区分：**本目录的公开脱敏与生产 uploader 的数据脱敏不是一回事。** `src/constants.ts` 中仍是 `REDACTION_VERSION = 'none'`。代码可能保留、托管并发送完整 record；不能因为此快照不含真实数据，就认为运行时会过滤敏感内容。

## 建议阅读顺序

| 文件 | 关注点 |
| --- | --- |
| `src/cli.ts`、`src/init.ts` | CLI 入口、workspace 初始化、已有 Hook 的处理、生成回调脚本 |
| `src/custody/index.ts` | record 接管、路径/hash 校验、持久化字节和 ACK 时机 |
| `src/uploader.ts` | 发现记录、outbox、批量发送、远端响应、cursor、失败与重试 |
| `src/queue.ts` | 唤醒合并、后台 worker、任务退避、租约及死信 |
| `src/storage.ts`、`src/util.ts` | 原子写、锁、进程退出、workspace 删除与文件系统边界 |
| `src/transport.ts` | 传输进程、安装脚本、登录身份、参数模式和远端结果解析 |
| `src/envelope.ts`、`src/wire.ts`、`src/types.ts` | 数据包装、压缩、序列化及协议类型 |
| `src/scry.ts` | recorder CLI 定位、导出和调用边界 |
| `test/` | 正常路径与故障注入；fixture 都是测试输入，不是生产采集结果 |

建议重点复核以下问题，而不是把它们当成已经确认的漏洞：

1. 本地 ACK、远端成功、cursor 推进是否可能混为一谈？崩溃或响应丢失后是否丢数据、双计或重传不同字节？
2. 原始 record、旧格式 envelope、正文引用和上传环境的生命周期是否一致？禁用上传、归档、源文件删除后会发生什么？
3. workspace/path/hash 校验是否覆盖 symlink、目录替换、重放、损坏数据和并发 worker？
4. 超时预算、拆批、退避、死信是否有确定上限？是否会饥饿、永久阻塞后续记录或越过未 ACK 数据？
5. 传输 CLI 的自动安装、进程参数、错误日志与环境传递是否泄露正文或身份？异常响应是否 fail closed？
6. uploader 是否明确保留 `exact/estimated/partial/unavailable` 等上游证据语义，而不是将缺失数据改成成功/零值？

## 验证与可运行性边界

- 环境：macOS 27.2 arm64、Node 24.18.0、npm 12.2.0、TypeScript 5.9.3。
- 原源码的隔离副本执行 `npm test`：**44/44 通过，0 skipped**。该命令先执行 TypeScript 构建，再运行 `node --test`。
- 脱敏副本使用一致的本地依赖执行同一命令：**44/44 通过，0 skipped**。没有删除断言、修改预期、加重试或扩大超时来通过。
- 测试使用临时 workspace/HOME、fake transport，以及注入的安装脚本响应；未对真实上报服务做端到端验证，也没有主动提交真实采集记录。
- 测试时复用了本机已有的 recorder `0.2.53`，仅在不提交的 `node_modules` 中把它映射到公开别名；没有上传该依赖的代码、元数据或符号链接。
- **公共读者不能直接 `npm ci` 复现**：私有依赖名称和所有 registry 地址已经隐藏。`@review/scry-turn-recorder@0.2.53` 不是可下载承诺。要运行测试，需要另行取得兼容且获授权的 recorder 依赖与工具链；不要静默换成其他版本后宣称结果等价。
- 上文对比文章固定的是 Scry CLI `0.2.52` 源码，而本 uploader 锁定 recorder `0.2.53`。这是不同版本，不能直接把测试结果等同于文章版本的端到端验证。
- 本目录位于已有 `experiments` 测试排除范围，不进入 Scry App 的 Vitest 自动发现，也不是 App/CLI 发布依赖。未构建或安装桌面 App。
- 原单体 `src/uploader.ts` 脱敏后仍超过仓库本地 20 KB 文件上限。为保留真实审阅结构，维护者明确批准本次提交的一次性大小检查豁免；未拆改原逻辑、未修改仓库规则，也不豁免 CI 或 main 保护。

下一位 Agent 请返回：问题严重度、文件/行号、实际失败链路、已有测试是否覆盖、最小复现/修复建议，以及因脱敏别名或缺少依赖无法验证的部分。不要把假名当真实端点，也不要为复核打开生产上传或恢复私人正文。
