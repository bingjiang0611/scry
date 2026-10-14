# 桌面远程（SSH 首版）

两台机器都运行完整 Scry App。本机只是客户端；Provider、凭据、工作区、SQLite、trace archive 和 `.scry/records` 留在执行端。此实现不依赖 Herdr，不复用其配置、会话或运行进程。

## 连接

1. 在执行端打开「远程访问」，选择「启用并生成 SSH 邀请」。宿主只监听两个 `127.0.0.1` 端口，不开放 LAN 通配监听。
2. 在客户端选择「连接桌面主机」，填写真实 SSH 主机名/IP、用户名、端口和 `scry-desktop1:` 邀请。
3. 比较客户端与执行端显示的设备公钥指纹。**必须在执行端的待确认列表批准该指纹**；SSH 登录成功不等于设备获批。
4. 客户端完成配对，连接主机，然后选择远端项目、Provider/profile 和会话。项目必须已被执行端 Scry 识别；不会上传本地仓库或凭据。
5. 撤销访问应在执行端撤销设备；客户端「忘记」只删除本地连接。已有设备重新配对前，需要先撤销旧 grant。

邀请有效期为两分钟；生成新邀请会取消之前未完成的手机或桌面邀请。获批证书的领取以宿主状态为准，不因邀请过期自行判定配对失败。客户端重开后可以继续领取待完成的配对。

SSH 使用独立的系统 `/usr/bin/ssh`，禁用 agent forwarding、控制连接复用及本地/远程命令；只转发宿主 loopback 上的配对与运行端口。首版不读取 SSH config 别名、ProxyCommand 或任意附加参数。需要已有 known_hosts 和可非交互使用的默认密钥/SSH agent。可先检查：

```sh
ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -p 22 USER@HOST true
```

TLS 1.3 固定宿主 CA，运行请求还要求获批的设备证书。CA 变化拒绝沿用连接。客户端私钥、证书和待核对回执由 Electron safeStorage 加密保存；加密不可用时不退回明文。

## 行为与边界

- 远程发送复用 App 的规范执行入口、权限/trust 检查、停止升级、归档和 managed recorder 两阶段提交，不走另一套简化执行器。
- 本机选中的会话不会被后台远程发送替换。会话 diff 按 Provider/profile/cwd/原生 session 归属；切换展示不重命名其他会话的基线。
- `recorded` 只表示宿主账本收到意图，不表示 Provider 成功。丢失回执标为 `unknown`；用原意图 ID 查询，不自动换 ID 重发。查询暂未找到意图也不能证明旧请求绝未执行。
- 同一连接还有未知回执时阻止新发送/忘记，避免失去核对身份。先恢复连接并检查远端状态。无法核实时保留现场，不声称已失败或已成功。
- SSH 进程退出后，连接列表返回 `disconnected`；发送前已知离线的请求直接拒绝，不制造未知回执。仍在运行的 SSH 进程不等于每次宿主请求都成功，网络错误仍须按具体回执核对。
- SSH 端口在宿主重启后复用。端口占用或配置损坏会显示桌面监听恢复失败；不会撤销设备，也不会因此停用手机配对/中继。释放占用后重启宿主可恢复原端口。
- 关闭桌面监听会断开其通道，但不撤销手机设备或停止已有 Agent。监听存续期间，配对仍受短时邀请约束；不是只有邀请有效期内才监听。
- 远程文件只读。远程工具正文引用和后台任务不能调用客户端的本地文件/Provider 接口；首版不提供单个远程后台任务停止、终端、附件上传或本地文件写入。
- Scry 不是沙箱。Provider 最终以执行端本机用户权限运行；仓库 MCP/Hook/plugin/recorder callback 仍按既有 fingerprint/trust 合同执行。
- 生产包默认启用远程宿主组装；开发环境需 `SCRY_REMOTE_HOST=1`。设置 `SCRY_REMOTE_RELAY_ENABLED=0` 可只用 SSH、不拨公网 relay；不要用于仍需手机中继的进程。

## 明确上限

| 项目 | 首版上限 / 超限行为 |
| --- | --- |
| 结构化 TLS 证据响应 | 4 MiB；超限拒绝，不伪造完整内容 |
| archive 历史 | 每页 2 轮；显式加载更早记录，snapshot 变化需重新读取 |
| catalog / watch | 每次至多 100 页，catalog 总数至多 10,000；超限报错 |
| 待核对提交回执 | 至多 256；只删除已知终态/确定拒绝项，不逐出运行中或未知项 |
| 会话 diff 基线 | 最多保留 64 份非活动基线；活动 capture 不逐出。重启或逐出后明确标为 `resumed` 重锚 |

如果日常会话触及证据响应或回执上限，下一步应增加带 snapshot 的证据分页或安全的终态对账，而不是截断后假装完整、删除未知项或无限扩大缓冲。

## 本地验证

```sh
npm run test:desktop-remote
node scripts/desktop-remote-ui-smoke.mjs --negative-control  # 预期失败：仅在 fixture bundle 去掉远程任务保护
```

- host smoke：隐藏、隔离的真实 Electron main/preload、TLS 配对/授权及假 Codex Provider。检查精确记录、实际 Git 文件变更的两轮累计 diff、Mac 接管展示、并行会话、重复/丢失回执、问题停止、Provider 失败和撤销。
- DOM smoke：真实组件、鼠标/键盘输入与 mock bridge。检查首次启用宿主、发送防重、双 run ID、profile 选择、权限重置、上下文隔离、回答失败和远程后台任务保护。它不证明真实 SSH 或 Provider。
- DOM fixture 已接入 `test:renderer:ui`；生产宿主 fixture 已接入 `smoke:electron` 的打包门禁。

## 0.2.180 验收记录（2026-10-14）

- 本地环境：macOS 27.2.0 / arm64，Node 22.22.1 / npm 10.9.4，Electron 42.10.1。最终 `npm test`：213 文件 / 2704 测试通过，3 文件 / 3 真实探针跳过，shell 通过。`typecheck`、完整 `test:renderer:ui`、`check:cli-release`（581 测试及安装 smoke）和最终 `pack:artifact`（含打包安全及宿主 smoke）通过。
- 最终本地产物：`dist/mac-arm64/Scry.app`；`app.asar` SHA-256 为 `1d6ce4d70059a635aac95c983d31465beebc5cfac1b2696bccb7af4e3f6d18fa`，主可执行文件 CDHash 为 `922b115dc74704c55aaabe0236c31dc277ab85f3`。该最终产物尚未传到 mac2；请勿将下列较早安装快照当作它的跨机通过证据。
- SSH 退出回归先在旧实现失败（仍返回 `connected`），修复后验证断开状态、发送前拒绝、无虚假未知回执及重新连接。
- DOM negative control 仅在测试 bundle 移除远程后台任务保护，按预期失败，证明断言能捕获本地停止按钮泄漏。
- npm 12.2.0 的 `npm pack --json` 对象输出不符合现有 CLI smoke 的数组合同，首次 CLI gate 因此失败；没有放宽断言，改用上述 npm 10 完成检查。
- 首次外链 smoke 等待原生 `show` 事件失败。测试 App 的 macOS `prohibited` activation policy 可使 `showInactive()` 后仍隐藏。fixture 改为观察真实生产 `showInactive()` 调用，保留全程不抢焦点、动画帧、原生坐标点击、外链分发及不安全导航断言；不修改生产可见性策略。

### mac2：已安装，启动受阻，未完成跨机验收

- 隔离副本：`~/scry-remote-acceptance-0.2.180-GqVCV3/Scry.app`，独立 HOME、userData 和新建 Git workspace，没有覆盖已有 App/项目或接管会话。
- 外验阶段快照的 `app.asar` SHA-256：`db967f6297b0426788b02ca24ba3a830d5cb8e03370936d37f8c4de0724d2b2b`。SSH 传输后哈希一致，mac2 `codesign --verify --deep --strict` 通过。它是 Apple Development 签名的开发包，不是 notarized 发布包。
- mac2 macOS 26.3.2 / arm64 上，两个启动进程均消失；第二次受控启动明确返回 `SIGKILL`。12:50:37 的端点安全日志针对 Scry PID 49656 记录 `mac_non_white_proc` 与 `ssh_reject`，疑似企业安全策略拦截。没有关闭安全软件、改名或重签绕过。
- App 尚未初始化运行数据，因此未执行桌面配对、跨机意图提交或真实模型请求。只读取了独立 Pi SDK 的版本；没有使用 Herdr。
- 已删除测试用 OpenAI Codex OAuth 凭据副本；原始凭据未由本任务改写。无该隔离 App 的残留进程。安装包、空运行数据配置和日志留在隔离目录供排查。
- mac2 安装快照早于最后补充的 SSH 退出状态修复。后续应先由设备管理员批准最终开发包，再更新隔离副本并重新执行配对、最小模型任务和 archive/records 核对；当前本地门禁不能替代这一步。

源方案与历史基线见 [调研记录](research/scry-desktop-remote-host-feasibility.md)。
