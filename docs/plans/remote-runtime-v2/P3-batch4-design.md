# P3 §13 · Batch 4 设计补全

返回 [P3 daemon 设计](P3-daemon-design.md)。本节保留原 §13 的编号与顺序，正文从 P3 移出以便单独维护。

四部分回答「开关打开后，App 与 daemon 之间到底怎么分」。矩阵与 op 清单是生成文件，不在这里手写，避免和源码漂移。

## 13.1 IPC channel 矩阵

`src/main` 现有 119 个生产 `handleTrusted` channel 已逐个判定去向：留在 main **24**、一半 main 一半 daemon（`split`）**3**、转发到现有 op **39**、需要新增 op **53**。

- 完整矩阵：[P3-ipc-matrix.md](P3-ipc-matrix.md)（生成）；新增 op 的请求/响应/授权/调用方范围：[P3-ipc-ops.md](P3-ipc-ops.md)（生成）
- 手工维护的判定（按职责拆成四个文件，每个都在 20 KB 门禁内）：
  - `scripts/daemon-ipc-routing.json`：channel → 去向
  - `scripts/daemon-ipc-ops.json`：新 op 的 schema 与 `scopes`
  - `scripts/daemon-ipc-differences.json`：每个 `forward` 行与设备协议的语义差异
  - `scripts/daemon-ipc-remote-approvals.json`：允许远程设备调用的新 op（本批为空）
- 生成 `node scripts/daemon-ipc-matrix.mjs --write`；守卫 `scripts/daemon-ipc-matrix.test.ts`

守卫检查：新增 channel 未判定即失败（报错给出注册文件）；判定里残留已删除 channel 失败；`forward` 的 op 必须真出现在 `inner-mtls-dispatch*.ts` 的 `request.op === '…'` 分支，且必须写下语义差异；`split` 行必须同时写明 main 侧做什么、daemon op 是哪个；`desktopWorkbench` 的 surface/method 必须存在于 `DESKTOP_WORKBENCH_METHODS`；`new-op` 必须声明 `scopes`，含 `remote` 的必须在批准清单里，method 必须等于 channel 最后一段且全局唯一，path 必须在 `scripts/performance-paths.json` 里；两份生成文档与源码不一致即失败。

三条影响实现的结论：

1. **新增 op 用 surface/method 聚合。** 17 个新 op 承载 53 个 channel（如 `conversation:list` → `conversation` + `list`），沿用 `desktopWorkbench` 的既有约定：一个授权边界一个 op。
2. **新 op 默认只给本机。** `scopes` 默认 `["local"]`，本批一个都不向远程开放。写 `remote` 等于授权扩大，必须先改 `daemon-ipc-remote-approvals.json`，那需要维护者批准。
3. **同一份 userData 只能有一个写者。** `knownProjectDirectories = recentStore ∪ projectStore ∪ 会话 cwd`，它就是 daemon 的工作区授权输入。所以 `agent:chooseFolder`、`agent:recentFolders`、`agent:removeRecentFolder` 判为 `split`：选择框留在 main（只有窗口能做），canonical 校验、`rememberProject`、`setCurrentCwd` 与最近列表读写全部走 `workspaceSelection` / `projectStore`。B4-S 的静态检查要加一条：`src/main` 不得出现 `recentStore` / `projectStore` 的写入调用。

## 13.2 本机设备入网与 `scope: local`（**需要维护者确认**）

推荐方案：

1. daemon 在 `<userData>/daemon/` 写入一次性入网 secret（`0600`，与 socket 同权限级别）。
2. App（同一 uid）读取 secret，经 unix socket 完成 CSR 与 proof，得到带 `scope: local` 的 grant。
3. `scope: local` 的 grant 只在 unix socket 传输上有效；走 SSH 或 Relay 时返回 `device_not_authorized`。
4. 设备列表显示为「本机」，可撤销；撤销后 App 显示可操作的错误，不自动重新入网（做法见下文「重新入网」）。
5. secret 使用一次即作废。

需要确认的点：这等于承认「同一 uid 的进程可以自证为本机设备」。它不放宽任何现有授权（daemon 仍按 cwd/路径/操作重验），但比「每次启动重新配对」少一道人工确认。同一 uid 下的并发攻击者不在信任模型内，与此一致。

### secret 生命周期

| 条件 | 行为 |
|---|---|
| 启动时不存在有效 local grant | 生成新 secret（覆盖旧文件，`0600`，原子写） |
| 启动时已存在有效 local grant | 不生成 secret；旧 secret 文件被删除，避免它比 grant 活得更久 |
| secret 已被使用 | 立即删除文件；同一 secret 第二次出示返回 `pairing_secret_consumed` |
| secret 过期 | 与 pairing 的既有窗口一致（`PairingAuthority.begin` 的 `expiresAt`），过期即作废并要求重新入网 |
| secret 文件缺失、损坏或权限宽于 `0600` | fail closed：daemon 以 `daemon_enrollment_secret_*` 拒绝本机入网并记录原因，不回退到「无 secret 也放行」；UI 显示可操作错误 |

secret 是入网凭据，不是授权：拿到它只能走到「等待本机确认」那一步，grant 仍由 daemon 的现有 pairing 状态机签发，并可被撤销。

### 重新入网

撤销后 App 已经没有 grant，**不能再调用 daemon 的任何 op**（包括 `daemon.shutdown`），因此重新入网不能只靠协议：

1. UI 提供「重新连接本机后台服务」，二次确认（会中断运行中的 run）。
2. App 读 `daemon.lock` 登记的 pid 与身份（`readProcessIdentitySync`），重验 identity 后发 SIGTERM；不匹配则放弃并报错。这符合 CLAUDE.md「只停止登记且重验 identity 的进程」。
3. daemon 按 `shutdown` 语义收尾：先停远程设备通道，运行中的 run 等到安全点，否则标 `unknown`，不重放。
4. daemon 重启后满足「不存在有效 local grant」，生成新 secret；App 重新完成 CSR/proof 入网。

### 单实例

每份 userData 只保留一个有效 local grant。第二个 App 实例（或第二台声称是本机的设备）入网成功后，旧 local grant 立即作废，旧实例下一次请求得到 `device_not_authorized` 并提示「本机后台服务已在另一实例入网」。不做多实例共享 grant，否则「本机」就不再是单点身份。

## 13.3 生命周期

| 时机 | 行为 |
|---|---|
| App 启动 | 探活 `local.sock`：先连接，再做带协议版本的 info 握手；版本不一致即硬失败 |
| 需要拉起 | 沿用 `daemonLaunchEnvironment`，就绪等待上限 10 s，超时显示 `daemon_unavailable`（不重试拉起第二个） |
| App 退出 | 只关闭自己的连接，daemon 继续服务远程设备与运行中的 run |
| `daemon.shutdown` | 先停远程设备通道；运行中的 run 等到安全点，否则标 `unknown`，不重放 |
| 升级后版本不一致 | 硬失败；UI 提供「重启后台服务」（走 shutdown 语义），被打断的 run 记 `host_restarted`，不重放 |

确定性启动失败（`remote_lease_*`、`daemon_recorder_cli_unavailable`）已在 B4-F2 改为不重试的退出码，supervisor 只记机器码。

## 13.4 trace 推送

先沿用现有 `watch` 长轮询加 `traceDelta`：daemon 侧是事件源，main 侧的投递桥保持 16 ms 合批与背压，renderer 看到的通道与回执不变（`runTraces:*` 全部留在 main）。

预算：以本机 unix socket 为传输，首 token 与流式输出的 L2 计时相对「进程内」不得增加 10 ms 以上（P95，同机同负载，样本 ≥30；两侧用同一个 fake provider、串行测量并记录负载）。超出预算时再单独提出 push 订阅 op，不在本批默默加上。

## 13.5 dock badge、通知、未读会话

daemon 产生事件（run 终态、待答问题、未读变化），App 渲染 badge 与通知。App 未运行时不累积：daemon 只留带上限的环形缓冲加 cursor，重连时取最新一页并标 `partial`，不假装收到过全部事件。

## 13.6 按 grant scope 选策略（**需要维护者确认**）

`forward` 行里有两处与远程设备的既有语义**不等价**，直接转发会让本机能力缩水，或让远程策略反过来作用到本机：

| channel | 远程（现状） | 本机（现状） |
|---|---|---|
| `agent:start` → `submit` | `SCRY_REMOTE_PERMISSION_MODE` 覆盖权限模式；`resolveRemoteProjectDirectory` 限定工作区；`detail` 字段更少 | 用户选择的权限模式（含 `full_access` 的 Provider-specific 语义）；允许不绑定项目的空 cwd 会话；`AgentStartRequest` 字段更全 |
| `agent:deleteSession` → `sessionDelete` | 只允许删已归档会话，`confirm: false` | 原生确认框（`confirm: !isOwnedTestApp`），可删未归档会话 |

处理方式：daemon 内**按 grant scope 选策略**——`scope: local` 完全沿用当前 App 语义，远程设备保持现状，两者都不缩水。需要原生确认框的操作，确认框留在 main，用户确认后再转发；daemon 只对 `scope: local` 接受「已确认」的请求，远程请求仍按自己那条更严的规则判断。

其余 `forward` 行也逐条记了差异（分页上限、历史投影是否裁掉工具原文与文件足迹、命令集是否按 provider 白名单裁剪、`runControls` 是否受远程权限模式约束等），见矩阵的「差异与分工」列。L3 要补本机与远程的语义对照测试，不能只测转发成功。
