# B3-D 设计稿更正

返回[批量状态](../STATUS-BATCH3.md)。对象：[P3b-local-runtime-design.md](../P3b-local-runtime-design.md)。纯文档，无代码改动。

## 按 REVIEW-BATCH2 的三处更正

### 1. §7 凭据（原文与代码不符）

原文写「auth 的凭据文件仍由 App 加密存储（`safeStorage`），daemon 通过本机通道拿到短时凭据」，这是错的：`safeStorage` 只用于桌面端连**别的**宿主时的本地配对凭据（`src/main/bootstrap/remote-connections.ts` 的 `DesktopRemoteClient`），Provider 认证由各 Provider CLI/SDK 自己管理，不经 Scry。

改成一张表，如实分开三件事：

| 凭据 | 现在在哪 | 迁移后 |
|---|---|---|
| 宿主身份私钥与证书 | `host-identity.ts` 的 `0600` 文件（目录 `0700`） | 随 daemon 走，daemon 直接读 |
| 桌面端连别的宿主的配对凭据 | `remote-connections.ts`，`safeStorage` | 留在 App |
| Provider 认证 | 各 Provider CLI 自己管理 | 不经 Scry 存储 |

结论：daemon 不需要「凭据通道」，因为宿主身份是它自己 userData 里的文件，Provider 认证它根本不碰。

### 2. 新增 §8.1 daemon 运行时

原文完全没写 daemon 用什么跑。补上取舍表并说明为什么选 RunAsNode：

- 系统 Node + 第二份原生构建 → 否（两套 ABI 的 `better-sqlite3`）。
- `utilityProcess.fork` → 否（随 App 退出，不满足「关闭 App 后 run 继续」）。
- **App 自带 Electron 可执行文件 + `ELECTRON_RUN_AS_NODE=1`** → 采用（同一已签名二进制、同一 ABI、同一 Node 版本；进程独立于 App 主进程）。

并写明两个直接后果：daemon 代码路径**不得**依赖任何 Electron API（B3-M1/M2 的目标 + 导入图测试守住）；启动环境清洗与私有 CLI 绝对路径对 daemon 同样适用。

### 3. §11 删掉「共存一个版本」

原文第 4 条问「迁移期是否允许两条路径共存一段时间」，REVIEW-BATCH2 已决定不保留兼容版本。从「需要决定」里删除，改为在 §8 明确写出「Batch 4 合入前删除进程内宿主与 App 直连 SQLite，不保留兼容版本」，并把另外两条已定事项（`scope: local` 留到 Batch 4、unix socket 用文件权限 + mTLS 不引原生模块）移到「已决定、不再列为待定」。

## §8 加进度

原来的编号步骤改成带状态的表，标明本批（Batch 3）做到第 3 步、Batch 4 做第 4–5 步，并说明 Batch 3 的 `SCRY_HOST_DAEMON` 只是开发期开关、默认关闭、两条路径不共用同一 userData。
