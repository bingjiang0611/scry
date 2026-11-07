# Batch 4 核验（G1、G2、B4-L1、B4-L2）

核验对象：`c52133d..1bca3d4`，其中两条是我的核验 cherry-pick。提交身份全部是 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。

方法：读 diff 和 status 文件，并对照 `pairing.ts`、`inner-mtls-host.ts`、`inner-mtls-dispatch.ts`、`host-process.ts` 检查。本轮没有在本机重跑测试。

## 结论

G1、G2、L1、L2 都可以接受。只有一处授权边界要在 **L3 开工前**收紧（S1），因为 L3 的“按 scope 选策略”要建立在这一处之上。

仓库里的 `STATUS-BATCH4.md`「需要决定」写的是“无”，`status/b4-l1.md`、`b4-l2.md` 里也没有待决事项。如果执行方认为 L3 卡在某个决定上，需要把问题写进 STATUS 再推送。

## 接受

| 项 | 说明 |
|---|---|
| G1 | 5 条“不同”都写了处理方式（按 grant scope 选投影、上限或 detail）；守卫测试要求以“不同”开头的差异必须写明处理方式 |
| G2 | §13.2 已改为：secret 加 unix socket 加同一 uid 即为证明，没有额外确认；不存在有效 grant 时 secret 不按时间过期 |
| L1 grant | `scope` 与 `source` 必须一致；缺少 scope 的旧状态按 `remote` 读入，所以历史上的手机 grant 不会被当成本机。消耗 secret、签发 grant、作废旧 local grant 在同一个串行事务里完成；CSR 被拒时 secret 不会被消耗 |
| L1 传输 | `InnerMtlsHost` 每一帧在进入 controller 之前检查传输，撤销在下一帧生效；controller 无法回答传输问题时 fail closed。真实 mTLS 测试证明：local grant 走 TCP 会被拒，手机 grant 走 TCP 不受影响 |
| L1 入网 socket | 请求上限 20 KB，10 s 超时，每个连接只处理一次请求，应答里不回显 secret，版本或字段不合法时不消耗 secret；secret 文件损坏或权限过宽时 fail closed |
| L2 客户端 | 复用 lane 约定；版本不一致在写盘之前就失败；撤销后删除本地凭据，不自动重新入网；凭据损坏时 fail closed，不覆盖；`close()` 不会停掉 daemon |
| L2 supervisor | 已在运行就直接接入，不拉起第二个；必须等 `daemonInfo` 应答才算就绪；拉起失败时原因如实上报，不在背后重试 |
| 拆分 | `pairing.ts` 原来已有 20.9 KB，按职责拆出 `pairing-state.ts`，没有绕过 20 KB 门禁 |

## L3 开工前必须修

### S1 本机 socket 也接受远程 grant；策略应以 grant 的 scope 为准，而不是以传输为准

`authorizesCertificate` 的条件是 `transport !== 'network' || g.scope === 'remote'`（`pairing.ts:224`）。也就是说，在 `transport: 'local'` 上，**任何 scope 的 grant 都能通过**，手机的远程 grant 出示在 `local.sock` 上也会被接受。

现在这还没有后果，因为 local.sock 上只有 `daemonInfo` 和既有 op。但 L3 会引入“`scope: local` 沿用 App 语义”，包括 `full_access`、空 cwd、删除未归档会话。如果实现时用传输来判断调用方（“从 local.sock 进来的就是本机”），那么一个远程 grant 只要能连到 local.sock，就能拿到本机语义。

能连到 local.sock 的，确实只有同一 uid 的进程，例如经 SSH streamlocal 转发过来的连接。但 scope 的含义应当在协议层闭合，不应依赖“碰巧连不上”。

修法：

1. `transport: 'local'` 只接受 `scope: 'local'` 的 grant；`transport: 'network'` 只接受 `scope: 'remote'` 的 grant。两条规则对称。
2. 给 controller 一个窄接口，例如 `grantScope(fingerprint)`。L3 中所有“按 scope 选策略”的地方，都按**已验证 grant 的 scope** 判断，不读传输。
3. 测试：
   - 远程 grant 出示在 local.sock 上，返回 `device_not_authorized`；
   - 现有的 local-grant-transport 测试保留；
   - L3 写语义对照测试时，用同一个 controller，分别以两种 scope 调用 `submit` 和 `sessionDelete`，断言行为不同，并且远程行为与现状一致。

## L3 实现时需要注意（不阻塞，记录在案）

1. **凭据加密在 Linux 上不能落到明文后端。** `daemon-client.json` 的 `encrypt`/`decrypt` 由调用方注入。接入 App 时，必须复用 `DesktopRemoteClient` 现有的 `safeStorage` 包装：Linux 上 `safeStorage` 使用 `basic_text` 后端时，必须显示为不可用并说明原因，不能写入（CLAUDE.md 禁止 Linux 明文凭据后端）。要补一条 Linux 后端判定的测试。
2. **`launch()` 的真实实现。** 用 `daemonLaunchEnvironment` 加 `launchDaemonOnce`，传入打包后的 app/resources 路径和版本，不得从 cwd 推导。要在独立的 test userData 上实测一次“App 拉起 daemon 并完成入网”。
3. **撤销后的“重新连接本机后台服务”**（§13.2）要在 L3 实现并测试：按 `daemon.lock` 重验身份后 SIGTERM，身份不匹配时放弃并报错；运行中的 run 按 shutdown 语义处理；界面二次确认。
4. **trace 预算的 L2 计时**按已决定的条件执行，结果写入 STATUS。

## 下一步

先修 S1（先写失败测试），再开始 L3。L3 完成后按任务书停下等核验。
