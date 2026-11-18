# 技术方案（已批准，2026-11-03）

采用 Orchestration V2 式路线：宿主常驻进程（daemon）拥有 Provider、连接和运行状态，用事件日志 + projection + 快照/cursor 订阅取代轮询。先做宿主 Provider 热池和 Desktop 长连接，约 3 个月完成到事件日志阶段。Scry 未对外发布，不保留旧协议兼容，只做连接时的版本硬校验。本地 replica 与二进制协议暂不做。

## 目标架构

```
 本机 Electron UI        Desktop 远程           iPhone
 (renderer 仍沙箱)        (经 SSH 转发)          (经 Relay 转发)
      │ unix socket            │ 4 条 mTLS lane        │ 4 条 mTLS lane
      ▼                        ▼                       ▼
 ┌──────────────────────── 宿主 daemon ─────────────────────────┐
 │ 连接入口与订阅 ──► Orchestrator ──► EventSink                  │
 │ 每请求按证书指纹鉴权   串行处理命令     事件/projection/回执      │
 │ 快照 + cursor 长轮询   只决定事件不做 I/O  与 outbox 同一事务提交 │
 │                                          │ 提交后取 outbox      │
 │ Recorder Core          Provider 热池  ◄── Effect worker         │
 │ 独立运行，无 SQLite     按 provider/      执行副作用并写回事件     │
 │ 只写 .scry/records     profile/cwd 常驻   进程丢失则作废不重放    │
 └──────┬──────────────────────┬───────────────────────────────────┘
        ▼                      ▼
   原始证据（长期保留）：transcript、Provider result、.scry/records；事件只引用，不替代
```

## 设计原则与不变量

1. **证据不被替代。** 原始 transcript、Provider result、hook 生命周期、`.scry/records` 继续长期保留；编排事件只引用它们（路径 + 偏移/哈希、record id），并原样携带 exact / estimated / partial / unavailable 等质量标记。
2. **鉴权每次重做。** 长连接、长轮询和订阅每次请求、每次唤醒都按对端证书指纹重新授权并检查证书有效期；撤销设备时主动关闭该指纹的所有连接。
3. **trust gate fail closed。** 预热仓库相关能力前必须先通过 canonical cwd + 内容/executable fingerprint 校验；热进程不绕过 trust。
4. **写操作绝不自动重放。** 字节未写出可以重发；已写出但未收到回执即为 unknown，只按 intent id 核对。宿主侧丢失进程的副作用作废，不重放。
5. **不缓存无版本的能力。** 热进程每次仍发实时查询；任何缓存都绑定 revision/fingerprint，切换 Provider/模型/权限/会话后不沿用旧能力。
6. **单路线不变。** Desktop 走 SSH、iOS 走 Relay，不做自动竞速或切换。
7. **不做协议兼容层。** 各阶段可直接换协议并删除旧分支；连接时只比对协议版本，不一致就明确报「请升级宿主/客户端」。

## 组件设计

### 1. 宿主 Provider 热池
解决当前最大瓶颈：Pi catalog p50 1888 ms、Provider controls 1304 ms 几乎都是冷启动。
- 把 `src/main/providers/pi-catalog.ts` 的停放机制泛化为 `ProviderWarmPool`，key = provider + profile + canonical cwd + executable fingerprint + 环境哈希。
- 只有读取成功才停放；失败、超时、提前退出立即关闭（沿用现有合同）。
- 会话聚焦或远程客户端打开会话时预热对应 key；会话活跃期间续期空闲 TTL，仍保留工作集上限。
- `providerControls`、`commands` 在宿主端按完整 key 单飞，结果不跨 revision 复用。
- 指标：`pi.catalog.probe` 拆出 cold/reused，目标是活跃会话命中率 ≥ 90%。

### 2. 传输层：多 lane 长连接 + 长轮询
- Desktop 新增 `RemoteLane`（TS），照 iOS `Lane.swift` 移植：control（写、stop、answer、短读）、status（liveRuns 长轮询）、watch（当前 run 长轮询）、bulk（history、大 trace、附件）。
- 重发规则：notSent 可在新连接重发至多 2 次；lost 只对可重放读重放一次，写报 unknown。客户端 20 s 空闲先关，避开宿主 30 s 超时。
- 取消一个请求就拆掉它所在的 lane；control lane 不可取消。
- Desktop 改用 `liveRuns` 长轮询，`watch` 加一个不带 shadow output 的变体，取代 1.5 s 的 `runState`+`poll` 短轮询。
- catalog 的 `info`+`projects`+`providers`+`sessionsPage` 合并成一次请求，revision 未变则返回短回应。
- 删除 one-shot 路径和旧能力分支；宿主撤销设备时按指纹 destroy 连接。

### 3. 宿主 daemon
- 把 `HostController`、`RemoteHostService`、`InnerMtlsHost`、Provider adapter、热池和运行中的 run 从 Electron main 拆到独立 Node 进程，由 launchd（macOS）/ systemd user（Linux）托管。
- Electron main 变成本机客户端，和 Desktop 远程、iOS 走同一套协议；本机通道用 `0700` 目录下的 unix socket + 独立设备证书，不开网络端口。
- App 重启、升级 UI 不中断 Provider 运行和远程连接。
- 保留启动环境清洗、私有 CLI 绝对路径、进程身份登记与「只停止登记且重验 identity 的进程」；renderer 的 sandbox 边界不变。

### 4. 编排事件日志（V2 式）
- daemon 内的 Orchestrator 串行处理命令并决定事件，不做任何 Provider 或文件 I/O。
- EventSink 在同一 SQLite 事务里提交：事件、projection、命令回执、outbox 副作用请求。重复命令 id 返回同一回执，不重跑副作用。现有 session ledger 与 intent 回执并入此处。
- Effect worker 在提交后执行副作用并把结果作为新事件写回；Provider 进程丢失时未完成的副作用作废，不重放。
- Projection：会话列表（侧栏）、会话详情（按顺序的 turn 列表）、活跃 run、待处理提问/审批。客户端不自己拼顺序。
- 订阅 = 快照 + cursor：先返回序号 N 的快照，再只推 N 之后的事件；重连直接拿新快照。由长轮询承载，取代剩下的 catalog/runState/trace 轮询。
- 事件日志属于 App/daemon，不进入 `src/core/turn-recorder`；Recorder Core 继续无 SQLite、独立运行。

## 分阶段计划

P0–P4 约 11–14 周，每个阶段单独上线、单独测收益；P1 与 P2 可并行。工期是估算。

| 阶段 | 工期 | 交付物 | 验收标准 |
|---|---|---|---|
| P0 分段测量 | 2–3 天 | TLS connect/secureConnect/首字节、宿主 dispatch、Provider cold/reused 分段指标 | 能把每条慢路径拆到网络/宿主/Provider |
| P1 Provider 热池 | 1–1.5 周 | `ProviderWarmPool`、聚焦预热、宿主单飞 | 活跃会话 Pi catalog 与 Provider controls p50 < 100 ms；trust 失败仍拒绝 |
| P2 传输层 | 1.5–2 周 | Desktop 4 lane、长轮询、catalog 合批、版本硬校验、删 one-shot | 活跃会话握手数 = lane 数；空闲 RPC 降到每分钟个位数；断线写请求仍为 unknown |
| P3 宿主 daemon | 3–4 周 | 独立进程 + 系统托管、Electron main 改为本机客户端、打包与安装流程 | 退出/重启 App 时运行中的 run 与 iOS 连接不中断；发布验证与安全边界检查通过 |
| P4 编排事件日志 | 5–6 周 | Orchestrator、EventSink、effect worker、四个 projection、快照 + cursor 订阅；客户端去掉剩余轮询 | 幂等重放测试通过；事件可追溯到原始证据；打开已缓存会话的首屏由快照一次返回 |
| P5 按测量决定 | — | 只读本地 replica、二进制大块流、worker 解析 | 各自立项，需 P0 指标证明瓶颈在此 |

## 不做的事与已定决策

不做：路线竞速/自动切换、LAN 监听、协议兼容层、把原始 Provider 帧降级为可轮转日志、QUIC。

已定（2026-11-03，bob 确认）：
- **纯本机使用也走 daemon。** 本机与远程只维护一套数据流；关闭 App 窗口后 daemon 继续运行。
- **默认不随登录自启。** 打开 App 时拉起 daemon，关闭 App 后继续运行；设置里提供「登录时启动」开关，开启时才安装 launchd/systemd 服务。
- **事件日志放进现有 App SQLite。** 新增表，沿用 `db-migrations`。
- **已有本机会话先不迁移。** P4 只对新会话生效，老会话保留原只读路径；新路径稳定后再决定是否写导入器。

主要风险是 P3 的打包与安全边界（私有 CLI 路径、启动环境清洗、进程身份）和 P4 的证据溯源合同；两者都要在动代码前先写清楚。
