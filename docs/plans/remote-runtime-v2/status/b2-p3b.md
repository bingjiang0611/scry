# B2-P3b daemon 与本机通道

返回[批量状态](../STATUS-BATCH2.md)。P3 设计 §9 第 2 步。

## 结论先写：本批只交付了本机通道，daemon 进程与影子模式未完成

任务书要求交付 daemon 可执行入口、supervisor、台账锁单写者与 `SCRY_HOST_DAEMON=1` 影子模式。本批实现并验证了其中**不依赖运行管线**的一层：本机通道（unix socket 上的同一套 inner-mTLS）。daemon 进程本身没有交付，原因写在下面「阻塞」，需要维护者决定后由 Batch 3 的迁移承接。

## 已实现并验证：本机通道 `src/daemon/local-channel.ts`

- `openLocalChannel({ directory, serve })`：`mkdir 0700` → 绑定 `local.sock` → `chmod 0600` 并读回校验；路径超 `100` 字节直接 `daemon_socket_path_too_long`（macOS unix socket 上限 104）；崩溃残留的 socket 先删除。
- 复用 `InnerMtlsHost.serve(stream)`：连接进入同一个 TLS 1.3 服务器（`requestCert`、`rejectUnauthorized`、禁 session 复用、禁 ticket），因此继承与远程完全相同的证书校验和每请求授权，没有第二套协议。
- 只绑 unix socket，返回对象只有 `socketPath` 与 `close()`：不存在 TCP 端口，也没有可监听的地址。
- 本机设备走与手机相同的 enrollment：`authority.begin` → `prove`（CSR 公钥指纹）→ `confirmLocal`，是真实 grant，不是绕过。

测试 `src/daemon/local-channel.test.ts`（真实 `RemoteHostService` + 真实 `InnerMtlsHost`，不 mock TLS）：

| 场景 | 结果 |
|---|---|
| 目录 `0700`、socket `0600`，返回对象只有 socket 路径 | 通过 |
| 本机设备经 socket 读到 `desktop info`（`protocol: 2`） | 通过 |
| 同一 socket 上 `protocol: 1` 被硬拒（`protocol_mismatch` 且报两端版本） | 通过 |
| 撤销本机 grant 后 `device_not_authorized` | 通过 |
| 非本机签发的证书被拒（grant 决定，不是 socket 决定） | 通过 |

## 未完成：daemon 进程、supervisor、影子模式、打包

阻塞证据（不是估计）：`createHostRuntime` 需要的输入全部来自 Electron main 的进程内运行时，而不是可以跨进程传的东西：

- `startAppRun` / `remoteStartReceipts`：远程提交的 run 必须在本进程真正跑 Provider（`src/main/bootstrap/run-execution.ts`、`run-provider.ts`）。
- `providerRegistry`、`providerOperationGate`、`sourceControl`、`appSessionStore`：分别住在 `src/main/providers`、`provider-operation-gate.ts`、`source-control`、`app-store.ts`，后者依赖 `db.ts`，而 `db.ts` 顶层 `import { app } from 'electron'`。
- `toolPanels`（analytics / llmPerformance / mcpTrust）与 history readers 同理：`src/main/bootstrap/remote-history.ts`、`db.ts`、`mcp-execution-trust.ts` 直接 import `electron`。

也就是说，任务书假设「远程宿主可以单独进 daemon，本机运行管线留到 Batch 3」，但远程宿主本身就依赖运行管线与 App 存储。要真的把宿主搬进 daemon，必须先做 B2-D 设计的那件事（把 `db.ts` 的 userData 注入化、把 bootstrap 运行管线与 renderer 解耦），否则 daemon 只能启动一个空壳，无法回答任何真实请求——那会是「看起来完成了、实际服务不了」的假实现，因此没有提交。

同样未做：`scope: local` grant 字段。现有 `DeviceGrant` 只有 `authority: 'owner-device'` / `source: 'local_confirmation'`，没有 scope 概念（`src/main/remote/pairing.ts:30`）；新增 scope 属于授权语义变更，必须显式征得同意。

## 因此本批对默认路径的影响

`SCRY_HOST_DAEMON` 未实现，默认路径与 Batch 1 完全一致（任务书完成定义的最后一条按字面成立，但它是「没有影子模式」的结果，不是「影子模式默认关闭」的结果）。

## 需要维护者决定

1. 是否接受把 daemon 的目标顺序调整为「先做 B2-D 的 bootstrap 去 Electron 化，再做 daemon 进程」？若坚持先出 daemon 可执行文件，需要先同意一个只服务本机通道、不承载 run 的中间态，并明确它不满足「关闭 App 后 run 继续」的验收。
2. `scope: local` grant 是否要新增到配对模型（涉及授权语义）。
3. Node 没有 unix socket peer credential API（`SO_PEERCRED` / `LOCAL_PEERCRED` 都要原生扩展）。当前用「`0700` 目录 + `0600` socket + 文件属主」作为本机 uid 校验，mTLS 证书作为身份认证。是否接受这一替代，还是要求原生模块实现真正的 peer uid 读取？
