结论：通过（核验方按评审直接修复，`cddafcfd` 与后续提交；剩余 2 项列为 P4-4 前的后续项）

# W16 核验（核验方，2026-11-21，执行方提交 `1e1d740c`、`97eee80a`、`33106a97`、`24b2000c`）

## 默认路径：未受影响

- **daemon 侧**：只有 on 模式才宣告和挂载 `subscribe`；`off`、未设置和 `shadow` 下返回 `unsupported_op`；网络端点不带 `localEndpoint`。
- **App 侧**：只有 `daemonInfo.subscribe === 1` 时才走订阅路径，否则原来的 `appEvents`、watch、`liveRuns`、`DaemonRunDiscovery` 路径逐行不变。
- **其他改动**：W11 的 N1 逻辑、W10 与 W17 的桥接测试都通过。性能预算和棘轮没有改动。

## 评审发现与处理

维护者要求核验方直接收尾，以下都已修复：

| # | 问题 | 处理 |
|---|---|---|
| B1 | `activeRuns` 快照的 `LIMIT 256` 可能挤掉正在运行的 run | 所有未结束的 run 一律带上，只对 24 h 内已结束的 run 限 256 条；补测试（1 个运行中的 run 加 300 个已结束的 run），变异后测试失败 |
| B2 | reset 后，快照里没有的 run 永远停在「运行中」 | 快照之后，对 App 仍视为运行中、但快照里没有的 run，各探测一次 `runState`：结果是已结束或未知就收尾（未知记为 `interrupted`）；结果仍在运行，说明快照早于该 run 记录，保持不动。补测试，变异后测试失败 |
| B3 | 两个门控测试测不到东西 | 新增 `connectForRunMode` 并加测试；新增 `host-process-subscribe-network.test.ts`，通过真实网络 `InnerMtlsHost` 验证已配对的远程桌面拿到 `unsupported_op`。变异「网络端点暴露 localEndpoint」会被拦下 |
| S1 | 新订阅者会收到最多 512 条旧提示的重放 | 没有游标的请求，只返回当前状态类提示，不重放；补测试（首次连接，以及 App 重启后） |
| S3 | 每次快照都全表读取会话，而 App 用不到 | App 只请求 `activeRuns`（P4-4 再加 `sessions`）；本地读取会话时加 `LIMIT pageSize+1` |
| S5 | 回复中有未知事件类型时，丢掉了同一回复里的提示 | 提示照常投递，事件不应用，游标作废，下次拉快照；补测试 |
| S6 | 翻页时用了最后一页的 `seq` | 在 protocol §5 写明：保留第一页的 `seq` |
| S7 | 8 ms 场景没有覆盖每次提交的新增工作 | 场景里挂上提交观察者；缓存 `MAX(seq)` 语句 |

## 后续项（不阻塞，P4-4 之前处理）

- **S2**：daemon 从 on 重启到 off 时，App 仍停留在订阅路径（只会警告），必须重启 App。on 是开发用的实验开关，切换本来就要重启。现在警告里已写明「需要重启 Scry」。
- **S4**：终态缺失 trace 时，归档回退会读取整个会话历史；实时与归档重叠时的去重没有测试。P4-4 改为按 run 读取归档时，一并补测试。

## 复跑（Linux）

- `typecheck` 通过。
- orchestration 与 daemon 在未设置、`shadow`、on 三种模式下各 88 个文件、371 个用例全部通过。
- `src/main` 3,679 个用例中 3,674 个通过，失败的 2 个是以 root 运行导致的已知用例。
- scripts 测试 79/79 通过；`main-import-boundary` 通过。
