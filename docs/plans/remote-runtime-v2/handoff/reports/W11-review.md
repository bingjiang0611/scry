结论：通过（无阻塞；7 项应修须在 P5-8 前完成）

# W11 核验（核验方，2026-11-21，提交 `2da09eb3`…`b52a7ebc`）

## 确认成立

- **发布门控**：实验开关不设时，行为与之前一致：
  - 不开 admin socket，不写 `approvedVia`。
  - daemon 状态里没有 `cliApproval`，本地操作和 main 都拒绝。
  - 设置页看不到入口，不宣告能力。
  - `REMOTE_PROTOCOL_VERSION` 仍为 2；旧桌面端不检查未知键，不受影响。
- **挑战认证**：
  - 每条连接一个 128 位文件名、256 位 token，文件用 `O_CREAT|O_EXCL|O_NOFOLLOW` 以 0600 创建在 0700 目录里。
  - 先删挑战文件、再比对 token；比对是时间恒定的，并且先校验构建。
  - 客户端校验文件名格式，用 `O_NOFOLLOW` 打开，再 `fstat` 核对类型、uid、权限和大小。
  - scry CLI 不使用这个 socket；经 SSH 转发来的调用方读不到挑战文件。
- **批准流程**：
  - 开关关闭时拒绝批准，并给出明确提示。
  - 没有任何 admin 方法能打开开关；打开开关需要 App 原生确认，而且只能在本机范围操作。
  - 速率限制持久化，daemon 重启后仍然有效。
  - 命令行显示完整的 64 位指纹，输入至少 16 位，前缀有歧义时拒绝，还要输入 `yes` 确认，再由配对权威复核指纹和 2 分钟有效期。
  - `approvedVia` 由代码路径决定，在 `confirmLocal` 时写入。
  - App 和已配对的桌面端都能收到通知；检查过的日志里没有秘密。
- **wrapper**：
  - 与 `scry-cli` 一致：固定路径，`$@` 加引号；清掉 `NODE_OPTIONS`、`NODE_PATH`、`DYLD_*`、`LD_*`。
  - invite 秘密只在通过 TTY 检查后打印，`--json` 不输出它。
  - `SCRY_HOST_CHILD` 只会导致拒绝，伪造它得不到任何权限。
- **`restart`、`login-start`**：按身份停止进程，不用 pkill；使用 W2 的共享模块。
- **范围**：
  - 没碰 `src/cli`、orchestration、W10 的文件和性能门限。
  - `host-process.ts` 改了约 25 行。
  - 所有文件都小于 20,000 字节。
- **Linux 复跑**：
  - `typecheck` 通过。
  - W11 的 15 个测试文件 90/90 通过，包括真实 node-pty 测试。
  - daemon 与 remote 共 893 个用例通过，唯一失败的是以 root 运行导致的已知用例。
  - `check:cli-runtime` 通过。
- **变异测试**：6 处开关门控、挑战校验、客户端权限与 uid 检查、`O_NOFOLLOW`、umask、批准限速、限速持久化、经 admin 打开开关、无视开关批准、跳过原生确认，这些被改坏后都会让测试失败。

## 应修（P5-8 前完成）

1. **`hostAdminNotices` 的门控没有测试**（变异存活）：要补测开关关闭时，`desktop info` 和 `catalogSnapshot` 都不带这两个字段。
2. **一条不合法的通知会让整个目录读取失败**（`desktop-client-catalog.ts:65-70`）：以后新增通知类型时，旧客户端会看不到那台主机的所有项目。改成丢弃不合法的项、截断到上限，不让整体失败。iOS 后续接入时照此处理。
3. **umask 跨 `await` 修改整个进程**（`host-admin-socket.ts:220-228`）：调用 `server.listen()` 之后立即恢复。
4. **开关打开时，admin socket 出错会阻止 daemon 启动**：路径超过 100 字节，或权限不符时抛错（`:107-108`、`:232-235`），而 `attachDaemonHostAdmin` 没有捕获。要捕获并记日志，然后在没有 admin socket 的情况下继续运行。
5. **invite 的限速没有在 socket 层测试**（变异存活）：补一个 socket 层的用例。
6. **报告与 P5-8 步骤写错了**：
   - 管道运行和 `SCRY_HOST_CHILD` 下的退出码实际是 1，不是 4。
   - 错误名是 `host_cli_approval_disabled`。
   - 由登录启动服务拉起的 daemon 拿不到 `SCRY_EXPERIMENTAL_HOST_CLI`。

   核验方决定：实验期间，如果开启「登录时启动」时 App 的环境里有这个开关，就把它写进服务的策略变量；在 P5-8 步骤里写明 App 要怎样带着开关启动。
7. **`scry-host status` 在 daemon 运行、开关关闭时，会误报「daemon 没有运行」**：要按 `daemon.lock` 的持有者判断，并提示功能未开启。

小项（可以一起改）：
- 日志里的 `method` 未转义（可伪造日志行）。
- 挑战文件改用 `fchmod`。
- 启动时清理遗留的 `challenge-*`。
- 打印 `deviceLabel` 时过滤 C1 控制字符。
- `SCRY_HOST_CHILD` 只在开关打开时设置，或者在报告里写明。
- CLI 的 `login-start` 不要写死 `daemonMode: true`。

## 维护者决定（§5.2）

核验方同意三项推荐（默认开启的时机、iOS 同步显示通知、只提供复制路径），等维护者确认。
