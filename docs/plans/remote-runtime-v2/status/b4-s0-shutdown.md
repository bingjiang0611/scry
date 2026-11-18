# B4-S S0 · App 连着时后台服务无法正常停止（已修复）

## 现象（2026-11-12 macOS 验证，提交 `0bf3e97`）

- 「重启后台服务」「退出 Scry 与后台服务」在 App 与 daemon 连接正常时，每次都在 15 s 后报停止超时；直接对 daemon 发 SIGTERM 也一样，观察 150 s 不退出。
- 对照：结束掉连着的 App 后，同一个 daemon 约 120 ms 退出。打包产物同样复现。
- b4v 的 `upgrade`、`quit-all` 两个场景失败，以及 A3、A4 的失败，都是它的下游。

## 原因

daemon 退出前的 `dispose()` 依次关闭入网 socket 和本机 socket，用的是 `server.close(callback)`。Node 的这个回调要等**所有已打开的连接**结束才触发。App 的连接（各条 lane、挂在事件流上的长轮询）在 daemon 运行期间一直保持；而重启或退出时，App 恰恰在等 daemon 退出。两边互等，直到 App 一侧 15 s 超时。

## 修复

`src/daemon/socket-server-close.ts`：从 server 创建起记录每个连接。关闭时先停止接受新连接、删除 socket 文件，给进行中的请求 500 ms 宽限，然后断开所有仍打开的连接。本机 socket（`local-channel.ts`）和入网 socket（`local-enrollment.ts`）都改用它。

App 看到连接断开，按已有规则处理：结果未知，只重放声明为可重放的调用（`retryAfterReconnect`）。远程设备的监听器原本就是先断连接再关 server，不受影响。

## 测试

- `src/daemon/host-process-shutdown.test.ts`（真实 daemon）：App 的 lazy run surface 已连接、另有一个不说话的裸连接，`dispose()` 必须在 5 s 内完成、裸连接被关闭、`local.sock` 被删除。修复前失败（5 s 超时），修复后约 0.7 s。
- `npx vitest run src/daemon src/main/background-service-stop*.test.ts src/main/bootstrap/background-service.test.ts`：31 个文件、128 项通过；`npm run typecheck` 通过。

## 未验证

- 真实 App + 真实信号的重启与退出（Linux 容器只跑了进程内的 `dispose()`）。macOS 复验：验证提示词 A3、A4，以及 `node scripts/b4v-scenarios.mjs --only upgrade,quit-all --out /tmp/b4v-stop.json`。
