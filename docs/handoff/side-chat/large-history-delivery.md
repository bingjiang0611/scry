# 侧边会话大历史 · 交付记录（App 0.2.235）

状态：当前 `/Applications/Scry.app` 是 App `0.2.235` / 私有 CLI `0.2.53` / `app.asar` `74fcedb9…`，来自本 worktree 的 `e586a165`（源码冻结 `747b5676`）。签名是 Apple Development，开发构建，未公证。日常实例需要用户自己重启才加载这一版。

这份文件回答三件事：本轮到底修了什么、当前产物范围内能证明什么、哪些限制仍然真实存在。实现细节见 [large-history-fix.md](./large-history-fix.md)，逐项验证过程见 [large-history-verification.md](./large-history-verification.md)。两者都保留当时的现场，本文件才是当前版本与证据的入口。

## 1. 修的是什么

用户报告的错误是「迁移归档超过 16 MiB 读取预算」和「没有创建侧边会话」。根因是侧聊读取链上有几层隐藏的历史/上下文上限：整份归档一次性读进内存、按字节预算拒绝、以及一次性解析全部轮次。现在侧聊读取改成流式，并且不再对这些层设人为上限。

修的是**侧聊读取链**。主会话 handoff 仍保留 16 MiB / 4 MiB / 2000 轮的限制，本轮没有放宽（见 §5）。

## 2. 版本与提交

| 项目 | 值 |
| --- | --- |
| 源码冻结 | `747b5676` |
| 版本提交 | `e586a165 chore(release): scry 0.2.235` |
| 已验证源码范围 | `e5b8ebd2..e586a165`（`main` 为 `e5b8ebd2`，未移动、未 push） |
| App 版本 | `0.2.235`（`package.json` 与 `package-lock.json` 根字段一致；没有跑 `npm version` 生命周期） |
| 私有 CLI | `0.2.53`，未变（本轮没有 CLI 合同、命令或包内容改动） |
| bundle id | `com.scry.app` |

## 3. 最终门禁（都在 `e586a165` 的树上执行）

| 命令 | 结果 | 关键数字 / 日志 |
| --- | --- | --- |
| `npm run check:cli-release` | exit 0 | 59 文件 / 807 测试；tarball smoke `{"version":"0.2.53","bin":"ok","init":"idempotent","hook":"recorded","doctor":"healthy"}`（`/tmp/t1-cli-release.log`） |
| `node scripts/cli-package-smoke.mjs`（Node 24.18.0） | exit 0 | Node 20/22/24 矩阵里的 24 分位；本机没有 Node 20，未执行（`/tmp/t1-cli-smoke-node24.log`） |
| `npm test`（`pack` 阶段内） | exit 0 | 511 文件 / 5129 通过 / 4 skip（`/tmp/t3-pack.log`） |
| `npm run test:renderer:ui` | exit 0 | Credits、conversation IPC、Pi 原生历史、side-chat 五 Provider 各两次发送、181 页大历史（`/tmp/t1-renderer-ui.log`） |
| `npm run pack`（typecheck + test + build + build:cli + electron-builder + `check:packaged-app` + `smoke:electron`） | exit 0 | 287,069,205 B，`runtimeDependencies` 311，`scryCliVersion` `0.2.53`（`/tmp/t3-pack.log`） |
| `node scripts/install-macos.mjs` | exit 0 | 备份保留 `/Applications/.Scry.app.backup`（`0.2.227`）（`/tmp/t4-install.log`） |

`pack` 第一次执行失败过一次，见 §6。同一条链第二次完整执行通过，没有通过缩短 gate 或加重试让它变绿。

## 4. 当前产物范围内的大历史证据

种子来自 `scripts/side-chat-large-history-seed.ts`，`--dev-side-chat-large-history-only` 在隔离临时 HOME/userData/工作区里跑（`/tmp/t5-lh-current.log`，退出码 0）：

- 归档 22,361,185 B；父会话 2005 轮 / 4010 条消息；单条正文 4,259,859 B。
- 快照查看器指针遍历 181 页，`lastCursor 4008:4194051`，`continuedRows 81`，`hugeMessageSeen true`，`walkedMs 20142`，`dialogReads 184`。
- 父会话删除后仍读回 4010 条（`readsAfterDelete 4010`），`readerAvailable true`，`planItems 400`，`providerReads 3`。
- 同一套断言在 `test:renderer:ui` 内再跑一次通过（`/tmp/t1-renderer-ui.log`，`dialogPages 181`）。

**证明范围要说清**：现有的打包 security fixture（`scripts/electron-security-smoke.mjs` 不带 `--dev-*`）没有大历史模式，所以大历史是在开发 out/ 产物上验证的，不是在 `/Applications` 二进制的 UI 上重放。打包侧的证明是字节同一性：`dist/mac-arm64/Scry.app` 内 `app.asar` 的 `out/main/index.js` = `7c23d19d…`、`out/preload/index.cjs` = `21c2e11b…`、`out/renderer/index.html` = `18bd34cd…`，与本机 `out/` 文件逐字节相同；安装后 `/Applications/Scry.app/Contents/Resources/app.asar` 也是 `74fcedb9…`，等于构建产物。打包 security fixture 在该 bundle 上跑通（`preloadKeys 123`、`subframeIpc not_exposed`、`popupDenied`、`navigationDenied`）。

如果之后需要在打包 App 的 UI 上重放 181 页，需要先给打包 fixture 增加对应模式，那是一次单独的授权。

## 5. 仍然存在的真实限制

- **没有承诺无限历史**：读取是流式、按需分页，不再有 16 MiB 整份读取预算，但界面侧仍有页大小上限（快照查看器每页 40 条 / 256 KiB）、页签上限 8、列表上限 100。轮数越多，走完越多页。
- **不承诺更快**：本轮没有做性能优化承诺，也没有 L2 毫秒级前后对比。性能闭环里 135 行 `0 worse` 只覆盖被计数的路径；原生会话正文捕获（Claude 前缀复读 + 两侧 SHA-256）不在计数器里，属于未测量的证据成本。
- **Provider 能力差异照旧**：有原生会话文件可读的 Provider（Claude、Pi、Codex 等）才走原生读取；没有 reader 时明确返回能力不可用，不回退成空数组，也不假造内容。
- **非侧聊 handoff 未放宽**：主会话 handoff 仍是 16 MiB / 4 MiB / 2000 轮。那条链路是另一份合同，本轮没有动它。
- **前缀一致性有边界**：读取期间文件被改写会被拒绝（`Pi 原生会话文件在读取期间被改写…`、`原生会话 transcript 在读取期间被改写…`），但「改写后写回完全相同的字节」在内容哈希下不可区分，这是设计取舍。Pi 的身份检查只覆盖文件头（`type`/`version`/`id`/`cwd`），Claude 逐条记录 `sessionId`。
- **不是完整审计**：文件足迹与快照证据可检查，但不是完整审计日志；被拒绝时已经流出的 sealed partial 会被丢弃，不会被当作可用快照。
- **开发签名**：`codesign -dv` 显示 `Apple Development: …`，没有公证，不满足正式发布路径。

## 6. 首次失败记录（保留现场，不掩盖）

| 首次失败 | 现象 | 处置与状态 |
| --- | --- | --- |
| `npm run pack` 第一次 | `smoke:electron` → `external-links-smoke.mjs` 断言全部打印通过后，清理临时 HOME 时报 `ENOTEMPTY: rmdir …/home/.qoder` | 根因 **UNKNOWN**（fixture 清理与 App 关闭写入竞争）；没有改代码，同一条 `npm run pack` 第二次完整通过。日志 `/tmp/t1-pack.log` |
| renderer-UI `Side-chat drafts restart state: .pending-submission-modal` | 早前一次运行该步失败 | 根因 **UNKNOWN**；之后未改相关断言，`747b5676` 与 `e586a165` 两轮 `test:side-chat:ui` 都通过（`/tmp/t1-renderer-ui.log` 的 `side-chat step: drafts restored`）。详见 [large-history-verification.md](./large-history-verification.md) §5 |
| `conversation-side-chat.test.ts > refuses corrupt archives and over-budget bodies` | 5 s 默认超时 | 该用例现在真的冻结 >16 MiB 归档；显式设为 30 s 并在代码里写明原因，不是靠重跑变绿 |

没有把任何失败标成 flake、环境抖动或 fixture 时序。

## 7. 安装与日常重启

安装走既有 `install:macos.mjs`（`install:mac:dev` 的后半段），安装器自己校验 bundle id、版本与签名后原子替换，并保留上一份为 `/Applications/.Scry.app.backup`。没有手工替换 bundle，没有绕过安装器。

装好不等于用户正在用的那个进程换了代码：日常实例还是旧进程，重启后才加载 `0.2.235`。本轮没有关掉或干扰用户正在使用的实例，所有验证都跑在隔离临时 HOME/userData/工作区的隐藏实例里。

`main` 仍是 `e5b8ebd2`，本分支没有 push。集成分支与推送由父级在复核安装结果后执行。

## 8. 文档地图

- [large-history-fix.md](./large-history-fix.md)：实现与边界（源码层）。
- [large-history-verification.md](./large-history-verification.md)：逐项验证、失败现场、性能分类。
- [final-delivery.md](./final-delivery.md)：更早一轮的侧聊交付（App `0.2.231`），历史记录，不是当前证明。
- [release-verification.md](./release-verification.md)：安装前门禁轮记录（`0.2.231`），同上。
