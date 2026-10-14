# 桌面远程（SSH 首版）

两台机器都运行完整 Scry App。本机只是客户端；Provider、凭据、工作区、SQLite、trace archive 和 `.scry/records` 留在执行端。此实现不依赖 Herdr，不复用其配置、会话或运行进程。

## 连接

1. 在执行端打开「远程访问」，选择「启用并生成 SSH 邀请」。宿主只监听两个 `127.0.0.1` 端口，不开放 LAN 通配监听。
2. 在客户端侧栏打开「主机」页并选择「添加主机」（「设置 → 远程访问」只提供跳转），填写真实 SSH 主机名/IP、用户名、端口和 `scry-desktop1:` 邀请。
3. 比较客户端与执行端显示的设备公钥指纹。**必须在执行端的待确认列表批准该指纹**；SSH 登录成功不等于设备获批。
4. 客户端完成配对并连接主机。新建会话时在 composer 的执行位置选择器里选机器和该机器上的项目，再选 Provider/profile；已有远程会话从侧栏带主机标签的项目进入。项目必须已被执行端 Scry 识别；不会上传本地仓库或凭据。
5. 撤销访问应在执行端撤销设备；客户端「移除主机」只删除本地连接。已有设备重新配对前，需要先撤销旧 grant。

邀请有效期为两分钟；生成新邀请会取消之前未完成的手机或桌面邀请。获批证书的领取以宿主状态为准，不因邀请过期自行判定配对失败。客户端重开后可以继续领取待完成的配对。

SSH 使用独立的系统 `/usr/bin/ssh`，禁用 agent forwarding、控制连接复用及本地/远程命令；只转发宿主 loopback 上的配对与运行端口。首版不读取 SSH config 别名、ProxyCommand 或任意附加参数。需要已有 known_hosts 和可非交互使用的默认密钥/SSH agent。可先检查：

```sh
ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -p 22 USER@HOST true
```

TLS 1.3 固定宿主 CA，运行请求还要求获批的设备证书。CA 变化拒绝沿用连接。客户端私钥、证书和待核对回执由 Electron safeStorage 加密保存；加密不可用时不退回明文。

## D-20261014-machine-navigation：执行位置与会话归属

- **范围 / 状态**：Scry 桌面端；需求已确认，成品视觉与日常配置验收待完成。2026-10-14 用户反馈重启后看不到 mac2，询问新建会话是否应该选择机器，随后要求“优化吧”。
- **信息结构**：侧栏「新会话执行位置」先选本机或已保存主机，再点「新建会话」。远程项目、Provider/profile、模型与历史来自该主机，不继承本机运行环境。切换这个选择器只改变下一次新建的目标，不迁移当前会话。
- **连接方向**：设置区分「我连接的主机」和「允许设备访问本机」。后者是入站授权（如 iPhone），不是本机连接过的 mac2 列表。远程主机打开主内容区；本机会话列表、会话顶栏和远程会话顶栏标明归属。
- **状态语义**：保存不等于在线。共享列表每 3 秒向 main 读取状态；失败保留已有身份并标为未知。离线不能发送，不回退本机；显式重连保留草稿且不自动重发。已有会话锁定项目与 Provider/profile，缺失的运行环境不自动代选。目录与历史请求分别取消，避免重连时相互覆盖。
- **保存边界**：连接仍由 main 在当前 `userData/desktop-connections/desktop-client.state` 加密保存。验收配置与日常配置不同；本轮未把测试私钥导入日常 App，也未完成日常 App 对 mac2 的正式配对。日常配置必须通过新的邀请与宿主指纹批准。
- **参考 / 保留**：复核 T3 Code 原始 `docs/user/remote-access.md` 的独立远端运行环境语义；采用机器先于项目的归属关系，不引入其外部服务或配置。复用 Scry 的 DesktopRemote、ChatTurn、设置框、主题 tokens 与既有 SSH/mTLS 通道；不扩大远程终端、附件或本地文件能力。
- **实现入口（已被下方方向 B 替换）**：`src/renderer/components/MachineNavigation.tsx`、`src/renderer/hooks/useDesktopConnections.ts`、`src/renderer/App.tsx`、`src/renderer/components/DesktopRemote.tsx`；设置接线在 `RemotePairing.tsx` / `Modals.tsx`。
- **回归入口（已被下方方向 B 替换）**：`MachineNavigation.test.tsx` 覆盖断线保留、读取失败、乱序响应和失效目标；`node scripts/desktop-remote-ui-smoke.mjs --keep` 用生产 App/CSS、隔离 bridge 和原生坐标/键盘验证分流、设置分区、renderer 重载、离线与重连、Provider 消失和已有会话归属。`--negative-machine-control` 故意恢复本机新会话路由，必须失败；原有 `--negative-control` 仍必须捕获远程任务暴露本地停止按钮。
- **发现并修复**：原生命中检查发现远程绝对定位页面遮挡侧栏；已有会话重连用例先失败，证明目录与历史共用取消序号会丢弃新目录。两者修复后保留回归。隐藏 Electron 截图需等待实际动画/绘制，不能用刚出现的 DOM 冒充已完成绘制。
- **本轮检查**：macOS / Node 22.22.1；`npm run typecheck`、`npm test`（218 文件 / 2733 测试通过，3 个真实探针跳过，shell 通过）、`npm run build`、完整 `npm run test:renderer:ui`、`git diff --check` 均通过。两个 mutation control 均以预期原因失败。此前失败记录未抹去，也未扩大超时或弱化断言。
- **设计库回执**：`P-SCRY-DESKTOP-REMOTE` 原位登记并可检索，build 退出 0；全库 check 退出 1，仅报告 5 个既有失效来源：`P-PI-MODEL-SELECTOR`、`D-20260912-scry-ios-remote`、`D-20261008-scry-ios-continuity`、`P-SCRY-SESSION-HISTORY`、`D-20261010-scry-llm-sidebar`。本轮没有修改这些来源，也没有提升为全局偏好或视觉认可。
- **验收边界**：上述脚本的连接与 Provider 是 fixture，不证明日常 App 已保存 mac2 或当前安装包已升级。真实配对、当前安装版重启后显示及用户视觉认可仍需分别验收；没有新发真实模型请求。
- **下次检查**：改新会话入口或连接列表时，验证“所选机器 → 该机器的项目与 Provider → 固定会话归属”；离线、未知、目标删除均不得静默回落本机。只有补齐远端 typed API 与验收，才扩展尚不支持的远程功能。

### 2026-10-14 反馈：远程并入统一会话流程（替代上面的侧栏选择器与远程专用页）

- **用户反馈**：看过 0.2.183 远程页后要求“重新出设计稿”。主机用单独页面管理；Agent 交互流程只用一套；新建会话时选择机器和目录；“只是 Agent 执行位置变了，不要提高用户理解成本”。
- **受影响部分**：侧栏常驻的「新会话执行位置」下拉和「远程主机」卡片改为一个「主机」导航页。表单式远程左栏、独立标题和“返回”取消，远程会话复用本机的 ChatView/composer/右侧面板。「本机完全访问」文案错误，应写明执行主机。
- **保留**：上面的状态语义、连接方向和会话锁定规则不变。
- **原型**：`designs/scry-unified-remote/Unified Remote.html` 与 `brief.md`。方向 A 把机器和目录做成两个选择器；方向 B 用一个双栏位置选择器。用户选择 **B**。

### 方向 B 实现（2026-10-14）

- **信息结构**：侧栏去掉「新会话执行位置」与远程卡片，新增常驻「主机」导航（显示已连接/总数；读取失败时不显示数字）。主机页分两节：「我连接的主机」（添加、连接、完成配对、断开、项目入口、移除）与「允许其他设备访问本机」（复用 `RemotePairing`），两个方向不混排。
- **统一会话**：远程会话与本机共用 `ChatView`、composer、顶栏和侧栏行样式。远程位置只出现在三处：composer 执行位置、顶栏主机标签、侧栏项目上的主机标签。没有保存主机时，composer 渲染与原 `WorkdirPicker` 逐字相同（单测比较 SSR 输出）。
- **执行位置选择器**：双栏，左栏本机 / 已保存主机及状态 / 管理主机，右栏为本机目录或该主机 catalog 里的项目。只在未绑定会话的新草稿上出现；已有会话锁定机器、项目与 Provider/profile。切换位置只把草稿文本带到空目标，不带附件；不迁移会话。
- **离线与缺失**：composer 上方提示条说明未连接、未知、待配对或主机已删除，并给出显式「连接」；不回退本机、不自动重发。远程运行中或回执未知时禁止发送，不提供排队。Provider/profile 消失时显示「原 Provider / profile 已不可用」占位，不代选。
- **权限文案**：远程权限去掉「本机」并附主机名，例如「完全访问 · mac2」，说明为「Agent 以 mac2 上的用户权限运行」。
- **能力缺口**：远程文件为顶栏按钮打开的只读抽屉；图片附件直接提示不支持；后台任务不暴露单项停止。
- **catalog 读取**：共享 module store，每个连接在一次「已连接」期间读取一次，运行结束（settled/failed）后再刷新；不对侧栏持续轮询。远程目录只来自宿主 catalog 的项目，不浏览远端任意文件夹。
- **实现入口**：`LocationPicker.tsx`、`RemoteChat.tsx`、`HostsView.tsx`、`SidebarRemoteProjects.tsx`、`hooks/useRemoteCatalogs.ts`、`remote-location.css`、`hosts-view.css`；`DesktopRemote.tsx` 只保留配对表单、只读文件、宿主面板等共享块。删除 `MachineNavigation.tsx` 及其测试/CSS。
- **回归入口**：`RemoteLocation.test.tsx`（断线保留、乱序读取、无主机时与 `WorkdirPicker` 一致、已删除主机占位、读取失败标未知、离线连接按钮、主机名权限文案）。`node scripts/desktop-remote-ui-smoke.mjs --keep` 改为全程在生产 App 中验证：主机导航计数、位置选择器带草稿进入远程项目、双 Enter 只提交一次、原生 session 采用、停止/回答用账本 UUID、回答失败不显示成功、Provider/profile 隔离、新建会话留在同一机器、离线/读取失败/重连保留草稿且不重发、Provider 消失不代选、回到本机、设置跳转主机页、主机页项目入口、renderer 重载后侧栏远程会话及重连刷新 catalog。两个 mutation control 仍须失败。
- **发现并修复**：(1) 侧栏远程项目名先于主机标签被截断，改为标签优先收缩并只预留一个操作按钮宽度；(2) 「已记录提交，等待远端派发…」在远端意图结束后仍残留，改为只在提交中或远程运行仍活跃时显示——首个 effect 版修复在 smoke 中仍失败，改为派生条件后通过；(3) 主机页入站区重复标题。三处均加了 smoke 断言，并在撤回修复时确认断言失败（前两处）。
- **首轮失败记录**：完整 `test:renderer:ui` 首次在 desktop-remote smoke 的「remote Provider menu」超时：远程会话重挂载后 run controls 在 effect 中重置，测量坐标后布局移动，点击落到相邻的模型按钮。改为等待控件重置到 Provider 默认值后再点击（就绪条件，不是 sleep），随后连续 3 次通过。
- **验收边界**：smoke 的连接与 Provider 是 fixture，不证明真实 SSH、mac2 或日常安装版；没有发真实模型请求，未重新打包或安装；用户视觉认可待确认。

## 0.2.183 安装准备（2026-10-14）

- 新侧栏使主机列表成为启动读取路径。真实隔离 App 在 `safeStorage.isEncryptionAvailable()` 内阻塞；诊断日志显示 ready/window/renderer 均已完成，随后只有该方法的 start、没有 end。原外链 fixture 只向主进程发 SIGTERM，未可靠收敛其子进程，组合命令和独立 smoke 均曾超时；这些失败不计为通过。
- 修复：空配置仅返回内存中的空列表，不初始化钥匙串或落盘私钥。已有状态解密及每次持久化仍检查安全存储；配对先成功加密保存，才发布连接及发出网络证明。加密失败不留下“已保存”连接，不发 SSH 请求；已有密文解密失败仍报错，不伪装成空列表。mTLS、宿主指纹批准与未知回执规则不变。
- 新回归：`desktop-client.test.ts` 检查上述空读取、失败前拒绝联网和密文读取失败；外链 fixture 对意外钥匙串访问直接抛错，旧实现明确失败。原始、不替换存储结果的诊断在修复后也完成了全部外链检查。fixture 超时现使用既有 `stopOwnedApp` 按身份收敛进程，并保留失败目录，不加大其 30 秒限时。
- 冻结产物：App **0.2.183**，私有 CLI **0.2.49**，`app.asar` SHA-256 **`07bf7d339ceca352b7f465d5e227450fb20f6f88da96dbfb8c6062724be6c2cc`**。Apple Development 签名，非公证发布版。
- 最终 gate：Node 22.22.1；typecheck、218 文件 / 2735 单测、shell、完整 renderer UI、CLI release 581 测试与 package smoke、打包体积/资源检查、packaged Electron 安全/文件/远程宿主 smoke 全部通过。3 个真实探针跳过，没有新发真实模型请求。
- 安装交接：冻结包与一次性安装入口在 `/Users/baobingjiang/Downloads/Scry-0.2.183-install-7EwEFn/`。`install.command` 复用原子安装器，校验版本、签名及上述 hash，保留旧 App 备份，启动后观察 20 秒。已实测运行中拒绝安装：现有 0.2.182 的 hash 未变，未产生安装完成回执。
- **安装更新**：用户随后明确要求“直接帮我安装好，我负责重启”。2026-10-14 18:55 已通过仓库 `scripts/install-macos.mjs` 原子安装到 `/Applications/Scry.app`，未退出、停止或启动 App。安装后版本 0.2.183、签名及上述 hash 核对通过；旧进程 PID 56237 仍在运行，重启后的运行版本尚未验收。
- **安装回执与备份**：实际回执是上述目录的 `install-only-result.json`，日志 `install-only.log`；不再运行旧的安装入口。0.2.182 备份在 `/Applications/.Scry.app.backup`，此前已有备份另存为 `/Applications/.Scry.app.backup-preserved-61334a9d-9515-45d6-b57a-4d62ffdec45c`。mac2 的 0.2.182 宿主未改动；日常客户端正式配对仍待完成。

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

### mac2：首次 SSH 启动尝试（历史记录）

- 隔离副本：`~/scry-remote-acceptance-0.2.180-GqVCV3/Scry.app`，独立 HOME、userData 和新建 Git workspace，没有覆盖已有 App/项目或接管会话。
- 外验阶段快照的 `app.asar` SHA-256：`db967f6297b0426788b02ca24ba3a830d5cb8e03370936d37f8c4de0724d2b2b`。SSH 传输后哈希一致，mac2 `codesign --verify --deep --strict` 通过。它是 Apple Development 签名的开发包，不是 notarized 发布包。
- mac2 macOS 26.3.2 / arm64 上，两个启动进程均消失；第二次受控启动明确返回 `SIGKILL`。12:50:37 的端点安全日志针对 Scry PID 49656 记录 `mac_non_white_proc` 与 `ssh_reject`，疑似企业安全策略拦截。没有关闭安全软件、改名或重签绕过。
- 当时 App 尚未初始化运行数据，未执行桌面配对、跨机意图提交或真实模型请求。只读取了独立 Pi SDK 的版本；没有使用 Herdr。
- 已删除测试用 OpenAI Codex OAuth 凭据副本；原始凭据未由本任务改写。无该隔离 App 的残留进程。安装包、空运行数据配置和日志留在隔离目录供排查。
- mac2 安装快照早于最后补充的客户端 SSH 退出状态修复。用户随后正常启动该 App，并明确选择使用当前实例继续下列验收；此前 `SIGKILL` 的原因仍未查清，不能据此断言 SSH 后台启动已经恢复。

### mac2：当前实例的最小真实双机流程通过

用户明确允许使用当前宿主数据目录，并在宿主 UI 登记测试项目、核对设备指纹及批准配对。另行确认 Pi 的 `full_access`（无 Scry 沙箱），只授权一次不调用工具的计算请求。

- 客户端：最终本地 `0.2.180` 开发包，独立 userData，所有本地 Provider 禁用；使用登录用户的系统 keychain 加密设备凭据，没有明文降级。首次给客户端设置空 HOME 时，系统查不到默认 keychain，安全存储按合同拒绝；改回登录 HOME 后加密存储正常，App 数据仍独立。
- 宿主：上节 `db967f…` 快照，正常启动的 `~/scry-remote-acceptance-0.2.180-GqVCV3/Scry.app`；实际数据目录为 `~/Library/Application Support/scry`，不是第一次尝试的隔离 userData。没有覆盖 App、替换宿主配置或接管已有会话。**这不是最新客户端和最新宿主使用同一产物的双机验收。**
- 工作区：`~/scry-remote-acceptance-0.2.180-GqVCV3/workspace`，仅本次新建的 Git 仓库。宿主项目列表为空时没有发送请求，也没有手工改写授权文件；用户完成文件夹选择后才继续。
- Provider：宿主已有 `Pi · Rotom`，profile `pi:rotom`，上游 `qoder` / `ultimate`，`effort=low`。宿主账本和 archive 的 `runtime:controls` 均保存了这些参数及 `full_access`。

| 检查 | 结果与证据 |
| --- | --- |
| 真实 SSH 与设备授权 | 系统 SSH 转发两个宿主 loopback 端口；固定 CA 的 mTLS 配对，用户在宿主确认设备指纹后才取得证书并连接 |
| 真实 UI 发送 | 本地完整 App 中用原生鼠标/键盘选控件并发送一次 `Do not call tools or read/write files. Compute 137 × 29 and reply with the integer only.`；本地显示远端回复 `3973` |
| 规范执行与防重 | 宿主账本只有 1 个 `intent_recorded`、1 个对应的 `run_settled`；通过客户端 `runStatus` 再确认终态，未重发请求 |
| archive 与 recorder | 经真实 SSH 读取 archive：1 轮、`done=true`、无 error、`hasOlder=false`；工作区只有 1 个 `completed` record，用户文本与助手 `3973` 一致 |
| CLI 独立核对 | 宿主私有 CLI `0.2.49` 的 `turns list/summary/verify` 与 `doctor`：1 轮 completed、0 pending、verify 无错误、doctor healthy |
| SQLite 投影与计费缺口 | 只读查询本轮 run ID：`spans` 中有 result，`model_usage` 中有正确的 10,937 input / 27 output tokens；但 `usage_ledger` 为 0 行，计费账本断言失败，不能记为通过 |
| 工具与文件 | record 的工具列表为 `available + []`；测试仓库 `git status --porcelain=v1 --untracked-files=all` 为空。另在客户端原生点击 README，远端内容正确且没有编辑控件 |
| 真实断线与重连 | 仅停止已核对身份、属于测试客户端的 SSH 子进程；连接 API 返回 disconnected，使用已保存配对重连成功，仍读到同一轮历史和同一个 record，没有新增模型请求 |

关联标识：

- 宿主账本 run：`418409b7-4876-4b02-a1e2-c83eb9a9d0d3`
- 规范 Scry run：`remote-run-mv7q5x6r-0`
- 原生 session：`01a13915-80c6-70b5-81d2-83dec3dfb462`
- record：`99dfed93cf2571c038c23206e343430b`，文件 `.scry/records/00000000000000000001-99dfed93cf2571c038c23206e343430b.json`

轮次耗时 15,090 ms；Provider 用量证据为 input 10,937、output 27、total 10,964 tokens。reasoning 19 已包含在 output 中，不再相加。`costUsd=0` 只是 SDK/记录给出的字段，**没有核实 Qoder 实际扣费，不能据此宣称免费**。模型耗时为 `partial/estimated`，危险操作分类为 unavailable；CLI 另有 model identity / turn role / task link 的 `legacy_unset` advisories，不能把它们当成完整身份或无风险证据。

**首次验收的计费缺口（保留历史失败）**：首次 SQLite 验收要求 `usage_ledger` 有本轮 token 条目，实际断言失败。随后独立诊断确认 token 已进入 `spans/model_usage`，但计费账本确实为空，没有通过重跑改写这个失败。代码定位发现 `src/shared/billing.ts` 的 `billingProviderForUpstream()` 没有 `qoder` 分支，`src/main/billing-ledger.ts` 会跳过未识别计费 Provider 的条目；这些源码不是桌面远程改动引入的。当时尚未修复并做对照验证，不能把执行/记录成功扩大为计费验收成功。后续修复与新轮次复测见下节；这条旧记录没有补账。

范围限制：本次只证明上述 Pi→Qoder、单轮无工具场景。其他 Provider、真实工具执行、问题回答、运行中取消等只保留各自既有本地/假 Provider 检查结论；没有用这次计算任务替代它们的双机验收，也没有验证 SSH 后台启动、LAN 直连或 notarized 发布。

验收后断开并关闭本地测试 App（核对并收敛其 4 个进程），不停止用户的 mac2 App。配对仍保留，可在 mac2「远程访问」撤销 `mac2 acceptance` 设备。凭据仅在客户端独立 userData 中加密保存；没有从宿主复制 Provider 凭据。测试 session、record 和现场证据均保留：

- 客户端：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-desktop-client-acceptance-Y7TGvk/`，含 history、回执、文件读取、断线重连及 cleanup JSON；这是临时验收目录，不是正式安装配置。
- 宿主：`~/scry-remote-acceptance-0.2.180-GqVCV3/acceptance-*.json` 为 CLI 和只读 SQLite 核对结果；实际 archive / SQLite 留在当前宿主 userData，canonical records 留在上述 workspace。

## 2026-10-14：0.2.181 计费修复与同包双机复测

### 修复与冻结产物

- 源码提交 `57c0e47906cfe1a45c209340fdcf53d54eae2aaa`：共享上游映射识别 `qoder`；Pi adapter 保留 Qoder tokens，但不把 USD 模型目录的零价占位当成实际收费证据，与原生 Qoder adapter 的未知美元成本语义一致。没有推算 credits 或美元费用，也没有改写历史 DB。
- 新回归贯穿 Pi RPC fixture → result/modelUsage → 实际计费行生成函数。旧实现明确失败：预期 1 条账本记录，实际 0 条。修复后还要求 `provider=qoder`、tokens 正确、`cost=null`，且 result/modelUsage 不再输出零美元。
- App `0.2.181`，私有 CLI 仍为 `0.2.49`。开发签名产物，**不是 notarized release**。本任务隔离源码和构建位于 `/tmp/scry-billing-release-nitWAN`；没有纳入同时进行的 Meta Prompts UI 改动。共享工作区曾因该 UI 的 `IconName` 类型错误中断发布检查，未修改那部分代码；下列完整检查均在冻结的隔离源码上重新执行。主分支后来独立更新的 `0.2.182` 不属于本次同包验收。
- 两端 `app.asar` SHA-256 均为 `a7857121fd0274e47e304e8e46e5f48e6ad5f215df8e5e30fdbd444beaba707c`。mac2 的 `codesign --verify --deep --strict` 通过。

### 安装与启动边界

SSH 下正常 AppleEvent quit 成功，随后 LaunchServices `open` 返回 0，但新进程 `61539` 退出。针对该 PID 的系统日志出现 `mac_non_white_proc` / `ssh_reject` 标签；这只是线索，不能据此确定退出原因，也不能宣称 SSH 启动已修复。没有换启动方式、重签名或绕过终端防护。

用户随后打开的实际仍是旧 `0.2.180`，检查哈希后拒绝在旧包上复测。确认无活跃会话并正常退出后，复用仓库的原子安装 helper 更新原位置；安装前及 staging 校验时均检查 App 已退出。旧包留在 `.Scry.app.backup`。用户再次正常打开后，实际进程 `4470`、磁盘版本、哈希及两个 loopback listener 均符合预期：

- 实际宿主：`/Users/test/scry-remote-acceptance-0.2.180-GqVCV3/Scry.app`。目录名保留历史版本号，**包内版本已是 0.2.181**。
- 数据目录：`/Users/test/Library/Application Support/scry`；工作区、原设备 grant、CA 和端口 `64050/64051` 保持不变。
- 测试客户端使用同一 `0.2.181` 产物及原隔离客户端 userData，正常登录 HOME 提供系统 keychain；不是日常本地 App 的安装配置。

### 实际验证

| 项目 | 结果与证据 |
| --- | --- |
| 本地完整门禁 | Node 22.22.1 / npm 10.9.4，macOS arm64：`npm run check:cli-release`（含 typecheck、581 tests 与包安装 smoke）、`npm test`（214 files / 2706 tests，3 个真实探针 skipped，shell PASS）、`npm run test:renderer:ui`、`SCRY_RELEASE_BUILD=0 npm run pack:artifact`（含 build、packaged 检查及 Electron smoke）、`git diff --check` 均通过 |
| 同包真实执行 | 已保存配对经 SSH + pinned mTLS 重连成功。新建 Pi · Rotom session，Qoder Ultimate、low、full_access；仅提交一次“139 × 31，只回复整数，不调用工具或读写文件”，答案 `4309`，工具证据为 `available + []` |
| SQLite 计费修复 | 只读查询本轮 canonical run：`usage_ledger` 恰好 1 行，`provider=qoder`、`source=pi_rpc`、input 10,937 / output 6 / reasoning 0；`cost=null`。`spans` 和 `model_usage` 也各有 1 条对应结果，USD cost 均为 null |
| archive / recorder | 真实 SSH 读取该新 session：1 轮，done、无 error、hasOlder=false。新增 canonical record 为 completed，prompt、`4309`、tokens 一致，usage 不含 `costUsd` |
| CLI 独立核对 | 私有 CLI `turns list/summary/verify`、`doctor` 均成功。默认 summary 明确是新 session 的 1 轮，total tokens 10,943，`costUsd=null`；全工作区 verify 为 2 records（旧 1 + 新 1）、无 errors，doctor healthy、0 pending |
| 防重与旧数据 | 宿主 durable ledger 中该 run 的 `intent_recorded`、`run_dispatched`、`run_settled` 各 1 条，无 failed/cancelled；确认终态后客户端未决回执为 0。旧 run 的 `usage_ledger` 仍为 0 行，未补写旧账；工作区 Git 状态为空 |

验收辅助脚本曾有三处合同误读：用流式 `text_delta` 读取已合并的 archive `model/text`；把默认 session summary 当成全工作区；把已确认终态后会移除的客户端回执当成历史账本。保留这些首轮断言失败，按现有合同修正后核对**同一轮已保存证据**；提交次数改由宿主 durable ledger 证明。没有重发模型请求，也没有放宽生产实现或测试。

关联标识：

- 客户端 intent：`751cda24-b27e-4d62-8b80-187ca8dafbbc`
- 宿主 ledger run：`4e9db673-1abf-43df-911c-6c1f91cf5bf5`
- canonical run：`remote-run-mv7u0g8z-0`；result span：`pi-mv7u0lxa-8`
- native session：`01a13978-1ff2-768a-8906-e6fb2b8f59ee`；native turn：`87e0b717`
- record：`0492a47470f0403d57e3c3e73ed72bd4`，文件 `.scry/records/00000000000000000002-0492a47470f0403d57e3c3e73ed72bd4.json`

**范围与最终状态**：这次证明新增 Pi→Qoder 用量的归属、持久化和未知金额语义，不证明 Qoder 实际扣费或完整账单对账；旧漏记数据未修复。真实场景仍限单轮、无工具；SSH 启动失败原因、LAN 直连、其他 Provider 与 notarized release 不在通过范围。已断开并关闭本地测试客户端的 4 个已核对身份进程；mac2 宿主仍运行，配对、测试 session、records、旧包备份及证据保留。

证据索引：

- 本地：`/tmp/scry-billing-acceptance-Gzn1Bo/`，含 `manifest.json`、`verified-evidence.json`、`verify-evidence.mjs`、history、receipt、`host-evidence/` 和 `cleanup.json`。
- 宿主：`/Users/test/scry-remote-acceptance-0.2.181-kwEx9g/`，含安装/启动日志、`running-host.json`、`billing-sqlite.json`、canonical record 副本、CLI 输出、`remote-ledger-selection.json` 和 `final-host-state.json`；原始 DB 与 records 仍在正常宿主数据目录及工作区。
- 完整门禁日志：`/Users/baobingjiang/.pi/agent/sessions/--Users-baobingjiang-IdeaProjects-vibecoding-scry--/sol-pi/01a13631-477e-74cf-8324-a004d6063f2c/evidence-preserving-reducer/objects/1f/1f225c55e143f1993934b20edd22118bc664da23b3c3a4d645aa06e158e02f1c.txt`。

源方案与历史基线见 [调研记录](research/scry-desktop-remote-host-feasibility.md)。
