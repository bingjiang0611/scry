# B4-L4 · MCP（daemon 模式）

`agent:mcpSnapshot`、`agent:testMcp`、`agent:reauthenticateMcp`、`agent:mcpGuardScan` 四个通道全部由 daemon 回答（本机 op `mcp`）。

## 做法

- **一份实现。** main 的四个处理原样抽到 `mcp-channels.ts`（单独提交，进程内行为不变），daemon 跑的是同一份。实时快照、探测、重认证每次都重建并核对 MCP 执行快照与指纹，校验失败就拒绝（共用 `bootstrap/trust`）。
- **认证归 daemon。** Provider 进程和认证队列都在 daemon。main 原来的 `assertMcpAuthOwner` 保留：开关打开时，main 自己不认证；daemon 不做这个检查。
- **OAuth 页面。**
  1. daemon 不能打开浏览器。
  2. daemon 先用 `isSafeOAuthAuthorizationUrl` 校验授权地址，不安全的直接报错，不会离开 daemon；安全的作为不合并的事件 `{ kind: 'oauth', url }` 交给 App。
  3. App 只在自己发出的重认证仍在进行时打开（闸门守卫新增 `settled` 回调，成功、失败都会递减计数），并再校验一次地址。只凭事件流里的一条消息，永远不会打开浏览器。
- **单独的 `mcp` lane。** 超时 5 分钟：OAuth 回调最多等 2 分钟，测试连接时可能要先首次安装 MCP server。其余 lane 仍是 30 秒。只有 guard scan 可以重放，其余三个会启动 MCP server，不重放。
- **矩阵文档拆分。** 主矩阵超过 20 KB，`conversation:*` 拆到 `P3-ipc-matrix-conversation.md`。生成器脚本本身也超过 20 KB，渲染部分拆到 `scripts/daemon-ipc-matrix-render.mjs`。

## 测试（均先失败）

- 真实 daemon：四个 op 都由 daemon 回答；guard scan 和 snapshot 是 main 的 envelope 形状；Pi 的 guard scan 是明确的 unsupported；测试连接和重认证对不存在的目标给出 main 的回答，而不是 `unsupported_op`。
- daemon 单测：安全的 OAuth 地址进入事件流；不安全的在 daemon 内就报错，事件流里什么都没有。
- App 单测：只在本窗口的重认证进行中打开；结束后不再打开；失败结束后也不再打开；`http://` 非本机、`file:`、带凭据的地址、`javascript:` 一律拒绝。
- 对照实验：
  - 不检查是否有进行中的重认证 → 2 条失败；
  - 不校验地址 → 1 条失败；
  - 闸门不调用 `settled` → 2 条失败。
- lane：四个方法都走 `mcp`，只有 guard scan 可以重放。

## 门禁（Linux 容器，root）

- `npm run typecheck` 通过；
- 全量 vitest：5917 通过，5 失败，都是已知的环境问题；
- `performance:measure`：Ratchet 通过。

## 已知差异与未验证

- 一个连接上的 MCP 请求排队执行。一次重认证要等浏览器登录，在它结束之前，另一个 Provider 的 MCP 测试要排在它后面；进程内这两者可以并行。重认证很少用，所以接受。
- 未在 macOS 与真实 App 中验证，包括真实 MCP server、OAuth 登录（浏览器能否弹出、回调能否完成）、首次 npx 安装耗时。
