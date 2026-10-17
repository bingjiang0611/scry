# 桌面远程（SSH 首版）

两台机器都运行完整 Scry App。本机只是客户端；Provider、凭据、工作区、SQLite、trace archive 和 `.scry/records` 留在执行端。此实现不依赖 Herdr，不复用其配置、会话或运行进程。

## 连接

1. 在执行端打开「远程访问」，选择「启用并生成 SSH 邀请」。宿主只监听两个 `127.0.0.1` 端口，不开放 LAN 通配监听。
2. 在客户端侧栏打开「主机」页并选择「添加主机」（「设置 → 远程访问」只提供跳转），填写真实 SSH 主机名/IP、用户名、端口和 `scry-desktop1:` 邀请。
3. 比较客户端与执行端显示的设备公钥指纹。**必须在执行端的待确认列表批准该指纹**；SSH 登录成功不等于设备获批。
4. 客户端完成配对并连接主机。新建会话时在 composer 的执行位置选择器里选机器和该机器上的项目，再选 Provider/profile；已有远程会话从侧栏带主机标签的项目进入。默认列出执行端已识别的项目；支持目录选择的新版本还可点「选择其他目录…」，浏览或输入远程路径并明确授权。不会上传本地仓库或凭据。
5. 撤销访问应在执行端撤销设备；客户端「移除主机」只删除本地连接。已有设备重新配对前，需要先撤销旧 grant。

邀请有效期为两分钟；生成新邀请会取消之前未完成的手机或桌面邀请。获批证书的领取以宿主状态为准，不因邀请过期自行判定配对失败。客户端重开后可以继续领取待完成的配对。

SSH 使用独立的系统 `/usr/bin/ssh`，禁用 agent forwarding、控制连接复用及本地/远程命令；只转发宿主 loopback 上的配对与运行端口。首版不读取 SSH config 别名、ProxyCommand 或任意附加参数。需要已有 known_hosts 和可非交互使用的默认密钥/SSH agent。可先检查：

```sh
ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -p 22 USER@HOST true
```

TLS 1.3 固定宿主 CA，运行请求还要求获批的设备证书。CA 变化拒绝沿用连接。客户端私钥、证书和待核对回执由 Electron safeStorage 加密保存；加密不可用时不退回明文。

## 2026-10-17：远程会话操作与输入路由

此节替代下方历史记录中「远程没有置顶、重命名、Slash 或排队」的旧限制。

- Meta Prompts 保存打开前的机器、会话与草稿键；插入和返回都回到原会话，不写入隐藏的本机 composer。远程运行与队列在提示词库打开期间保持挂载；首轮采用原生 session 后同步迁移目标。
- 置顶、取消置顶、重命名、归档及恢复通过专用 typed IPC / mTLS 操作写入宿主 catalog。等待恢复/归属检查后、写入前再次校验 owner 与 canonical cwd。归档保留宿主原有停止运行语义，并取消客户端该会话队列。旧宿主未声明 `sessionActions` 时禁用操作，不做本机覆盖。桌面显式请求归档条目；手机旧目录接口仍默认隐藏归档。
- Slash 复用宿主现有 Provider/profile/cwd 命令发现接口，包括 skills。命令描述允许为空；发现失败保留错误，不查询本机目录作为替代。
- 每个远程 Provider/profile/会话最多排队 32 条文本消息，保存入队时的模型、effort 和权限。只有收到对应 intent 的明确终态才依次派发。导航不会丢队列；后台断连/读取连接状态失败会暂停，重连不自动发送。未知提交不得重试；核对后可移除未知队首再继续余下消息。队列仅保留在本次 App 进程内，不承诺崩溃恢复。
- 首轮的宿主 session 绑定持久化到回执，返回已有会话后仍可查运行状态。终态读取即使遇到视图取消，仍先收敛 App 持有的队列，避免回执已移除却永远等待。
- 回归：`remote-prompt-queue.test.ts`、远程 client/controller/IPC 测试；`node scripts/desktop-remote-ui-smoke.mjs --session-parity-only` 覆盖真实键鼠路由、Slash、元数据、采用后导航、后台重连暂停及终态导航竞争。`--negative-prompt-control` 故意恢复本机插入路由时必须失败。此 focused UI 入口已纳入 `test:renderer:ui` 和 `test:desktop-remote`。
- 验证记录：macOS / Node 24.18.0，`test:unit -- src scripts` 为 3288 passed / 4 既有 skipped；`typecheck`、`build`、完整 `test:renderer:ui`（含 Credits 与生产 IPC）通过。当前开发构建的真实临时宿主 TLS 验收证明元数据写入宿主 sidebar store、归档停止对应运行、未授权目录/撤销 owner 拒绝、手机归档仍隐藏。`performance:measure -- --scenario remote.trace.preview` ratchet 通过（1 条消息 / 2778 bytes），不据此宣称网络或真实 mac2 更快。
- 首轮验证记录：新增 `queueStore` 后旧 SSR fixture 漏传依赖，已补齐；坐标验收需先 hover 行，重命名关闭后的焦点恢复改为与本机相同的下一帧；宿主 info 精确断言已加入真实新增能力。并行工作区一度存在无关 `ConversationApi.fork` WIP，导致 type/允许列表测试失败，未修改其合同；对方移除 WIP 后复测通过。全量首跑超过工具的 120 秒进程期限；确认子进程收敛后用 360 秒外层预算完成（196 秒），未扩大任何用例超时。负向插入路由对照按预期失败。
- 本机与 mac2 的已安装 App 未替换；真实 SSH/mac2 原始会话交互仍待两端升级后重放。本次不将 Provider 能力差异抹平；图片附件上传、单个后台任务停止等旧缺口仍需独立补齐，不能据本节宣称远程已全功能等同本机。

## 2026-10-15：远端运行状态与侧栏一致性修复

- **反馈 / 采用**：用户截图中已输出工具结果却仍提示「等待远端派发」，运行会话缺少转圈且项目总在本地项目之后。复用本地 `sb-running` 样式和项目的置顶优先、最近活动时间排序，不增加另一套视觉规则。远端仍不提供本机专属的置顶、重命名和未读操作。
- **状态来源**：等待提示由当前 intent 与其对应的宿主运行状态派生；提交未确认、已记录、已派发、未知和终态分别处理。读取错误恢复后移除该读取错误，不清掉无关的回答/停止失败。终态单独刷新历史，目录轮询不反复重载全文。
- **侧栏刷新**：App 对已连接主机每 3 秒刷新共享 catalog，慢请求不叠加定时读取；离开远程会话后仍可观察其开始/结束。仅连接正常且 catalog 读取成功时使用宿主 `isActive` 显示转圈。断连或读取失败保留历史，但不把缓存当作运行证据。刷新周期不是实时推送 SLA；大量会话使 catalog 读取持续超过周期时，应升级为专用活动增量接口，而不是缩短轮询间隔。
- **输出缓存故障**：桌面 `runStatus` 复用已有的 `runState` 与 `poll` 接口，不再依赖包含 shadow output 的 `watch`。队列仍受原有上限约束；缺失内容写入 durable `truncated` 标记后可读取部分内容，terminal flush 仍报告 capture failure。未落盘的缺口和真正的读取失败继续报错，不伪造完整输出。模型服务的 403 访问限制仍是独立的 Provider 失败，Scry 不会解封账号或自动重发。
- **回归入口**：`RemoteLocation.test.tsx`、`desktop-client.test.ts`、`run-output-log.test.ts`；`node scripts/desktop-remote-ui-smoke.mjs --keep` 覆盖续聊、派发先于 trace、后台侧栏刷新、排序、错误恢复及终态历史刷新。`--negative-activity-control` 禁用周期刷新后必须失败；大于 512 KiB 的单次输出用例在旧实现上因 queue-full 失败。UI smoke 新增多个真实轮询阶段后，总进程预算从 35 秒调整为 55 秒，单条件 7 秒期限未变。
- **验证记录**：远程域与关联 renderer 单测共 319 项通过；typecheck/build 通过。UI fixture 覆盖终态 trace 读取失败时仍保留历史，以及筛选后保持远端项目折叠状态。初次并行扩大测试时，未改动的 Git diff 用例超过 5 秒；不加超时，单独检查和串行全域复测均通过。另有一次项目切换断言失败未能复现，不能据后续通过宣称根因已修复；已增加提交 cwd、切换前项目和切换后实际位置的诊断断言。原始等待提示与 queue-full 回归均在修复前失败，禁用侧栏周期刷新也按预期失败。
- **验收边界**：生产 React/CSS 的隐藏 Electron fixture 与本机真实 mTLS/临时持久化测试，不等于 mac2 上真实 Provider 的验收。没有修改凭据、发送真实模型请求或升级安装包。

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
- **当时的能力缺口**：文件只读抽屉与终端缺口已由下方「远程右侧工作区能力」替代；图片附件和后台任务单项停止仍未扩展。
- **catalog 读取**：共享 module store，每个连接在一次「已连接」期间读取一次，运行结束（settled/failed）后再刷新；不对侧栏持续轮询。当时远程目录只来自宿主 catalog；此限制已由下方 `D-20261015-custom-directory` 的明确用户授权扩展，catalog 刷新策略不变。
- **实现入口**：`LocationPicker.tsx`、`RemoteChat.tsx`、`HostsView.tsx`、`SidebarRemoteProjects.tsx`、`hooks/useRemoteCatalogs.ts`、`remote-location.css`、`hosts-view.css`；`DesktopRemote.tsx` 只保留配对表单、只读文件、宿主面板等共享块。删除 `MachineNavigation.tsx` 及其测试/CSS。
- **回归入口**：`RemoteLocation.test.tsx`（断线保留、乱序读取、无主机时与 `WorkdirPicker` 一致、已删除主机占位、读取失败标未知、离线连接按钮、主机名权限文案）。`node scripts/desktop-remote-ui-smoke.mjs --keep` 改为全程在生产 App 中验证：主机导航计数、位置选择器带草稿进入远程项目、双 Enter 只提交一次、原生 session 采用、停止/回答用账本 UUID、回答失败不显示成功、Provider/profile 隔离、新建会话留在同一机器、离线/读取失败/重连保留草稿且不重发、Provider 消失不代选、回到本机、设置跳转主机页、主机页项目入口、renderer 重载后侧栏远程会话及重连刷新 catalog。两个 mutation control 仍须失败。
- **发现并修复**：(1) 侧栏远程项目名先于主机标签被截断，改为标签优先收缩并只预留一个操作按钮宽度；(2) 「已记录提交，等待远端派发…」在远端意图结束后仍残留，改为只在提交中或远程运行仍活跃时显示——首个 effect 版修复在 smoke 中仍失败，改为派生条件后通过；(3) 主机页入站区重复标题。三处均加了 smoke 断言，并在撤回修复时确认断言失败（前两处）。
- **首轮失败记录**：完整 `test:renderer:ui` 首次在 desktop-remote smoke 的「remote Provider menu」超时：远程会话重挂载后 run controls 在 effect 中重置，测量坐标后布局移动，点击落到相邻的模型按钮。改为等待控件重置到 Provider 默认值后再点击（就绪条件，不是 sleep），随后连续 3 次通过。
- **验收边界**：smoke 的连接与 Provider 是 fixture，不证明真实 SSH、mac2 或日常安装版；没有发真实模型请求，未重新打包或安装；用户视觉认可待确认。

## D-20261015-custom-directory：远程自定义目录

- **反馈 / 授权**：2026-10-15 用户指出 mac2 只有 workspace 可选，要求「要支持自定义选择」，并在明确权限问题后选择「任意可访问目录」：已配对 owner 可以浏览宿主当前用户可读取/遍历的目录，只有明确选择后才授权为可运行项目。原有项目内移动浏览接口仍受已授权根限制；新增专用操作不是把旧接口改为全盘文件代理。
- **交互**：远程项目栏新增「选择其他目录…」。弹窗标题与说明明确执行主机；支持主目录、上一级、子文件夹、输入绝对路径或 `~/` 后按 Enter 浏览、分页和选择当前目录。浏览/取消不授权，不更改草稿；确认选择后只切换新草稿的位置，不启动 Provider、不自动发送、不迁移已有会话。选中的目录加入宿主已有项目授权体系，因此其他已配对 owner 也可访问；保留原 Provider 权限和仓库 trust/fingerprint 检查。
- **边界**：固定 `desktopDirectory` RPC，先验证 mTLS peer 的当前 owner grant，再解析 list/select；不传 shell、命令、URL、CA 或本机文件路径。宿主用 canonical directory、R_OK/X_OK 检查和原有 `rememberProject` 持久化。`select` 单独授权，`list` 无写入；文件/缺失/不可读路径拒绝。符号链接目录返回宿主真实路径，可越出 HOME，这是用户明确授权的范围，不承诺沙箱。
- **能力差异**：宿主 info 仅在真实接入目录授权后发布 `directorySelection: true`；新客户端连旧宿主保留 catalog 与会话功能，但禁用自定义入口并提示升级，不探测假能力或回落本机。
- **上限**：每页 100 个目录、单目录最多 10,000 个可访问子目录，路径最多 4096 字符。按完整排序结果的 SHA-256 绑定分页快照，变动时报错而非混页；到达上限明确报错。只有实际超大目录需求超过上限时，再改为流式扫描与可恢复分页，不隐性截断。
- **实现**：共享 typed API、preload/生产 IPC wrapper、DesktopRemoteClient、InnerMtlsHost、HostController/工厂/service、生产 main 授权接线；`desktop-directory-picker.ts` 复用 canonical 工作区能力；`RemoteDirectoryPicker.tsx` 复用 ModalFrame 与按钮/主题样式。目录弹窗 portal 到 document.body，避开 composer transform 对 fixed overlay 的包含块影响；关闭后恢复执行位置入口焦点。
- **已验证**：focused 65 用例及 typecheck 通过。真实临时文件系统覆盖新目录、普通文件、缺失/不可读目录、目录/文件/失效符号链接、canonical 授权、分页与快照变动、持久化失败和旧项目浏览权限；真实 TLS 走新增读/选 RPC，并验证设备撤销后拒绝。生产 IPC wrapper 对 20 个方法逐一证明不可信 sender/frame/origin 不能执行特权 listener。移除目录操作的 owner check 后 focused 回归明确失败，恢复后通过。
- **UI 回归**：生产 App 隔离 Electron 使用原生鼠标/Enter：旧宿主 capability unavailable、取消/焦点/草稿、浏览不授权、非法路径、分页、断线阻断、未确认授权提示、pending 双击不重复选择、确认后切换草稿但不发送；1000×600 及标准窗口验证 modal 位于文档 overlay 层且不超出视口。上一条 hover 稳定性断言保留。
- **首轮发现**：关闭 modal 时在仍生效的焦点陷阱中聚焦入口会被覆盖，改为打开前把返回焦点交给 ModalFrame；渲染图发现 composer 的 transform 把 fixed modal 限制在输入框内，改用 portal 并增加真实布局断言。新增目录使旧 fixture 的「最后一个项目」不再是 Project B，改按完整路径定位，不弱化原断言。
- **参考**：[WAI-ARIA APG Modal Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) 原始规范用于初始焦点、Tab 包含和返回合理入口；复用已有 ModalFrame，不把 portal 或固定尺寸宣称为规范要求。短窗口渲染图已检查，用户视觉认可仍独立待确认。
- **打包首轮问题**：Node 22 全量 2835 测试通过（3 个真实探针跳过），CLI release 581 测试/package smoke 通过。首次 pack 因手动 Node rebuild 留下 Electron `arm64--146` 的 `.forge-meta`、实际 addon 却为 ABI 127，builder 误判已重建；强制 electron-rebuild 后 native/完整安全主用例通过。随后 files-only 原生点击两次未打开预期文件；旧 0.2.187 同用例通过，而只增加只读事件观测的 0.2.189 诊断也通过，说明时序敏感，不能把首轮失败抹为成功。fixture 原先只等待 DOM 出现，现先滚动、用 Page.captureScreenshot 等实际绘制，再重新测量/命中并执行原生鼠标；原断言、超时和权限拒绝检查不变，改后 focused 文件链接检查通过。原始 pack/重查/诊断日志保留，宿主 smoke 随后因严格 info 断言尚未包含新 `directorySelection: true` 而失败；更新为完整的新 envelope 深比较（不删除原字段断言），并增加打包宿主真实 TLS 的 browse 不落盘、显式选择才写 canonical recent-folder grant、catalog 可见、尾空格路径保留、不启动 Agent/不建 records，以及撤销后 list/select 均拒绝的集成场景，focused 通过。完整 artifact/UI gate 结果后续追加。
- **最终 gate / 来源**：冻结构建 `0936c23f35e32ca7afa79363db87f1281cebbd4e`，版本 0.2.189，CLI 保持 0.2.49。macOS / Node 22.22.1：typecheck、227 文件 / 2835 单测（3 个真实探针跳过）、shell、CLI release 581 测试/package smoke、`pack:artifact`（含签名资源检查、外链、完整 Electron security、文件链接与打包宿主 TLS 场景）均最终通过；完整 renderer UI 含 Credits 与目录选择也通过。renderer 首轮曾报不含具体断言的 Script failed to execute；只增加失败时的 fixture URL/有限 DOM 日志，未改成功路径/断言/超时，focused 与完整复查通过，首轮原因仍未确认。没有把首次失败改写为成功。CLI 未改，未另行重跑 Node 20/24 本地矩阵；真实 Provider 请求不在本次验收范围。
- **main 集成**：在其他任务提交后的 clean `b7a81cd` 上合入本次五个提交，未混入或回退并行改动。集成代码 `2c6994e` 的 Node 22 typecheck、6 文件 / 66 focused 测试及当前 main 的完整 remote UI fixture 均通过；原有 Source Control 等脚本/实现保留。这是 main 的集成检查，不是把含其他任务的 main 重新打包或安装；实际安装来源仍是上面的冻结提交与 hash。
- **设计库回执**：更新原 `P-SCRY-DESKTOP-REMOTE` 权威来源后 build 退出 0，搜索「远程自定义目录」返回该唯一来源；全库 check 退出 1，仍只有同文列出的 5 个既有失效来源，没有本次新增缺失项。库检查不证明视觉认可。
- **安装 / 身份**：本机 `/Applications/Scry.app` 与 mac2 原宿主路径均升级为同一 0.2.189，`app.asar` SHA-256 `a94d0824ddf6252271153fa9974f70c18a9b458afc55ae2566c7a4829f6ebc86`，两端严格 codesign 校验通过，开发签名、非公证发布。客户端沿用当前保存的 mac2 与 `test@30.7.226.226:22`，host ID、connection ID、固定 CA 和设备授权不变；没有迁移凭据、新配对、放松 SSH 校验或重发旧请求。0.2.188 仅为 hover 候选，未安装；本次由 0.2.189 一并交付。冻结包不含共享主目录中其他任务的后续提交，不能把后续 main 验证与本包来源混为一谈。
- **真实交互**：安装版原生鼠标交替悬停本机/mac2 五次，菜单和机器行各维度偏移均 <0.5 CSS px，未改变当前位置；mac2 主目录真实返回 38 个文件夹。浏览/取消时 catalog 项目不变，关闭恢复入口焦点与草稿。经路径输入与原生 Enter，选择用户目录外的 `/private/tmp/scry-directory-picker-189-OGBbRe/project with space `（含尾空格）；只有点击「选择此目录」后才出现在 catalog，新草稿位置准确更新但没有发送或启动 Agent。宿主重启后该 canonical 授权仍可读，原设备继续通过 SSH+mTLS 连接。
- **清理 / 无新增执行**：先把客户端新草稿恢复为原 workspace，再通过宿主可信 renderer 的正常 `window.scry.removeProject` API 只移除空验收项目；最终重启后 catalog 仅剩原 workspace，自定义入口仍 available。空临时目录已用 rmdir 删除，没有直接改授权文件或数据库。原会话重新打开仍显示 `5587`，机器/目录通过静态顶栏锁定（不是可编辑选择器）；archive 为 1 turn / 原 Scry run。原 JSONL 账本仍 36 行，SHA-256 `9892306b714fa47e3de6dc3ca888940b70c254b13c1caf9c46f6dd85ee2bb44a` 完全不变；canonical records 仍 4 个、CLI verify 0 errors / 0 open turns，Git clean。SQLite 按原 run 过滤仍只有一条 usage（10952/6、cost NULL）；全表另有两条既有历史用量，验收助手最初把「对应一条」误断言为「全表一条」，已读回并按正确范围核对，没有删改数据。无新增意图、会话或模型请求。
- **现场 / 限制**：私有回执、首轮失败、后续 gate、真实 modal/hover 截图及辅助脚本存于 `/Users/baobingjiang/Downloads/Scry-0.2.189-directory-acceptance/`，未保存凭据备份。验收助手还曾误把既有会话的静态顶栏当作 disabled picker；读回确认旧结果已打开后只完成后续检查，没有重发业务动作。客户端已显式断开并关闭；SIGTERM 未使其退出，随后按精确 PID/包路径用 NSRunningApplication 正常终止。mac2 最终宿主 PID 4020 保持运行，仅监听 127.0.0.1:64050/64051，临时调试进程/端口已关闭；原包备份和冻结构建现场保留。功能与上述双机场景已验证，用户视觉认可待确认。

## D-20261015-location-hover：执行位置菜单悬停稳定性

- **反馈 / 范围**：用户截图指出「鼠标放到上面的时候会跳变」；项目级修复需求已确认，成品视觉认可待确认。只修复双栏执行位置菜单，不改变机器/项目选择、草稿、连接或配对语义。
- **根因**：菜单使用 bottom 锚定，高度却由当前右栏内容决定。本机最近目录较多、远程项目较少时，悬停预览会把高度从约 323px 改为 210px；菜单顶边和左侧机器行随之移动约 114px，固定鼠标甚至不再命中原选项。
- **修复 / 上限**：`remote-location.css` 将菜单高度设为 `min(360px, 40vh)`，只随窗口变化，不随悬停内容变化；两栏分别滚动，不压缩机器行。40vh 兼顾居中欢迎页和底部会话 composer，短窗口不越出顶部。保留原 hover/focus 预览与显式选择，未保存主机的 `WorkdirPicker` 不受影响。只有实际布局超出此窗口比例约束时，再评估已有定位层的可用空间测量，不预建一套定位框架。
- **复用 / 参考**：复用当前 `.menu`、`.mitem` 和列内滚动模式。[WAI-ARIA APG Menu and Menubar](https://www.w3.org/WAI/ARIA/apg/patterns/menubar/) 原文的子菜单指针交互与焦点规则，支持保持路径可达、焦点与当前选择分离；本组件仍是已有 dialog，不冒充 menu/menubar。来源只作交互参考，不把固定高度说成 W3C 强制要求。
- **回归**：扩展生产 App 的隔离 Electron smoke，12 条最近目录与 2 个远程项目构成不同内容高度；用原生 mouseMoved 交替悬停 4 次，比较菜单及每个机器行的 x/y/width/height（容差 <0.5 CSS px），验证原坐标仍命中原机器、hover 不改变执行机器、不建会话也不提交草稿。另验证 1000×600 短窗口和截图。`--negative-hover-control` 只在 fixture 撤回固定高度，仍明确失败。
- **首轮检查**：先补断言确认旧实现失败。修复后的检查还捕获了菜单入场动画的 0.51px 位移，改为等待现有有限动画完成后测量，不增加 sleep 或扩大容差。最初 `100vh - 160px` 的限制在短窗口会越出顶部，依据失败改为 40vh，原断言保留并通过。
- **最终证据**：0.2.188 候选的完整单测、安全 smoke 与 renderer UI 检查通过；首次 pack 的私有 CLI --version 失败原因未确认，同一产物的资源检查复查通过，未据此宣称首次命令成功，也未安装该候选。hover 修复随后一并进入上述 0.2.189 冻结构建，完整 artifact/UI gate 最终通过，并在真实安装版用原生鼠标交替悬停五次验证，菜单与机器行位移均 <0.5 CSS px。真实截图与早期负对照/失败日志保存于上述 0.2.189 私有证据目录。本条继续由 `P-SCRY-DESKTOP-REMOTE` 检索，不新增平行规范或全局审美偏好；用户视觉认可仍待确认。

## 2026-10-15：编辑连接地址，不重新配对

- **用户反馈**：mac2 的 IP 从 `30.7.225.156` 变为 `30.7.226.226`。地址是 SSH 路由信息，不是 Scry 主机身份；用户确认直接优化现有主机页。
- **交互**：展开已保存主机 →「编辑连接地址」。复用现有配对表单样式与 `ModalFrame`，预填主机名/IP、用户名和端口；未修改时不能保存。保存期间输入框只读、操作按钮禁用，保留键盘焦点。取消不写入并恢复入口焦点；失败留在弹窗并显示错误。
- **保存合同**：只更新经过 main 验证的 `DesktopSshTarget`，保留 connection ID、主机 CA 指纹、客户端身份/证书、待完成配对、意图回执与会话关联。保存会关闭原 SSH 隧道，不停止远端任务，不自动重连、重发或重新配对；用户随后显式「连接」。新地址仍走原来的 SSH 校验和已固定的 mTLS 主机身份校验。
- **实现**：`DesktopRemoteAPI.updateSsh` → typed preload → 生产 IPC trust wrapper → `DesktopRemoteClient.updateSsh`；renderer 不能传入新 CA、证书、任意 SSH 参数或命令。地址与 connect/disconnect 共用生命周期队列。
- **并发回归**：复现了旧回执响应在地址保存期间返回，后续保存把旧地址写回的问题。最小测试先失败（磁盘 hostname 仍为 `desktop.example`），再把快照生成与连接替换发布放进现有保存队列，避免排队中的旧状态覆盖新路由。加密保存失败仍不发布新地址。
- **检查**：focused 38 个用例通过，包含原始 TLS 连接在改地址后复用证书、不重新配对；生产 IPC wrapper 拒绝外部 sender/frame/origin。UI smoke 覆盖预填、取消/焦点、端口验证、保存错误、双 Enter 单次保存、只读字段保留焦点、主机身份保留、显式重连、不启动 Provider。`--negative-address-control` 故意自动重连，断言明确失败。
- **首次失败**：新表单测试沿用了 composer 的 rawKeyDown 助手，缺少原生表单提交所需的 Enter keypress；补齐真实按键序列。随后发现所有输入框 disabled 会在保存失败后丢失焦点；改为 readOnly，按钮仍 disabled，增加焦点和不可修改断言。
- **调研与取舍**：[VS Code Remote SSH 原文](https://code.visualstudio.com/docs/remote/ssh)，「Remember hosts and advanced settings / SSH Targets」：已保存 Host 与可编辑 HostName 分离。采用身份与路由分离、原位修改和显式重连；不引入自由文本 SSH 配置或任意参数入口。该任务是已有页面的同模式修复，不新增另一套机器导航。
- **交付产物**：冻结源码 `20e7693e2a3505f404e49f137e74516b31d3b8c2`，App **0.2.187**、私有 CLI **0.2.49**，已原子安装 `/Applications/Scry.app`，旧包保留 `/Applications/.Scry.app.backup`。`app.asar` SHA-256 `35c899954931e70d877a89c6314865f7d385c4fbb8af99fa2d40f30dd99c0637`，签名验证通过；mac2 保持此前已验收的 0.2.184，不需要升级宿主协议。
- **冻结检查**：Node 22.22.1；typecheck、222 文件 / 2790 单测通过（另 3 文件 / 3 真实探针跳过）、shell、CLI release 581 测试/package smoke、build、打包资源/security/文件/远程宿主 fixture 全通过。完整 renderer UI 首轮在 Meta Prompts 原生输入测试超时；0.2.186 基线单项与不改源码的完整复查均通过，首轮日志保留，原因未证实，不能把重跑说成已修复。并发测试首轮 typecheck 还发现泛型 spy 类型过宽，改为 `MockInstance<typeof fs.rename>` 后通过。
- **真实改地址**：当前客户端配置已有 `mac2`，与原验收连接的 ID、host ID 和 CA SHA-256 完全一致。直接在该已保存主机的编辑表单中，用原生输入改为 `test@30.7.226.226:22` 并保存；公开连接字段除 hostname 外逐项相同，意图列表不变且状态为 disconnected。随后手动「连接」，原有 SSH 校验和已固定 CA 的 mTLS 均通过，catalog 返回 1 项目 / 4 会话，没有新配对、迁移凭据或本机 run。
- **重启后**：使用同一已安装 hash、同一 userData 重启，地址/连接 ID/CA 指纹/证书有效期保持一致，仍是 disconnected，不自动重连。手动连接后从侧栏重开原生 session `01a13a7d-339c-741a-a1e2-5031ab3df8da`，真实界面显示 5587；history 为 available / trace_archive / 1 轮，Provider 锁定且不显示位置切换。本次未再次发送模型请求。
- **最终持久化核对**：远端 JSONL 账本完整解析 36 个事件，原意图 `ae934709-dd4e-4414-a040-fc453843ffbc` 只派发/结束各一次；ledger run UUID `91172fec-5407-4b8a-bd8f-0fbeef66564a` 映射 Scry run `remote-run-mv8476or-0`，最后事件仍是原请求的 run_settled。SQLite `usage_ledger` 恰有 1 条对应行，input/output 10952/6、cost NULL，与归档一致；其 session_id 是 Scry 聚合键，不冒充 Provider 原生 session。旧式 `sessions/turns` 表为空，不作为远程账本或 canonical record 的替代证据。`turns verify` 再次通过（4 records / 0 errors / 0 open turns），远端 Git 仍 clean，记录文件仍只有原先 3 个加已授权的第 4 个。
- **验收记录与边界**：私有证据保存在 `/Users/baobingjiang/Downloads/Scry-0.2.187-remote-acceptance/`，含 manifest、gate 原始日志、实际表单/重开会话截图、公开状态读回、账本/SQLite/CLI 收据。旧临时客户端目录已不存在，因此没有伪称复用旧临时 profile；本次原位修改当前已保存且同身份的 mac2。首次重启调试进程在检查前退出，最终另一次已完整验证，不用旧端点失败推断业务结果。验收助手曾因输入选择与 DOM selector 假设错误超时，读回确认未保存/已打开后才修正检查，没有重发业务请求。已断开并退出本次调试 App，未停止 mac2 宿主，临时密文备份已删除。用户视觉验收仍待确认；开发签名版本，不是公证发布版。
- **下次复用**：已配对主机仅网络位置变化 → 原位编辑路由、保存后显式连接 → 检查身份/回执不变、重启地址保留、无自动重发。身份或证书确实改变时不套用此流程，仍按配对/trust 合同处理。本条是项目级需求确认与实现证据，不提升为全局审美偏好。
- **设计库回执**：原有 `P-SCRY-DESKTOP-REMOTE` 来源已更新；`library.py build` 与 `search '编辑连接地址'` 均退出 0，命中本文件的新内容。全库 `check` 仍退出 1：5 个既有缺失来源（`P-PI-MODEL-SELECTOR`、`D-20260912-scry-ios-remote`、`D-20261008-scry-ios-continuity`、`P-SCRY-SESSION-HISTORY`、`D-20261010-scry-llm-sidebar`），未为凑通过删除来源。

### 方向 B 的 0.2.184 双机验收（2026-10-14，历史现场）

- 冻结源码 `acaee62e2a08f15c03ed670740a602fcbf6e6626`，构建目录 `/tmp/scry-unified-release-Nz6fgx`；本机与 mac2 均安装 0.2.184、私有 CLI 0.2.49，`app.asar` SHA-256 均为 `a0ce8fccd5a01ebdb6418e0a7477c7042b69095cdc725bb80ebb709ecf5a7e2f`。开发签名，非公证发布版。
- 冻结目录的 typecheck、2740 单测/3 跳过、shell、CLI release 581 测试/package smoke、打包/资源/Electron security/宿主 fixture，以及完整 renderer UI gate 全通过。首次在共享工作区的安装 gate 遇到并行文件链接 WIP，3 个断言失败；未安装该版本，改为冻结源码独立构建，没有混入或修复无关改动。
- 真实 App 经主机页连接、双栏位置选择进入原临时 workspace；Pi · Rotom / Qoder Ultimate 仅发送一次无工具算术请求 `151 × 37`，返回 `5587`。原生 session `01a13a7d-339c-741a-a1e2-5031ab3df8da`，Scry run `remote-run-mv8476or-0`，record `2a485cbdc8625200d71636cb09dff14e` / sequence 4。工具与文件操作均为空，duration 7170ms，input/output 10952/6，cost 未提供，不记作 0。
- 远端 `.scry/records` 从 3 增至 4；`turns verify` 成功，`turns summary <session>` 为一轮 completed / 10958 tokens / 0 calls。身份扩展字段仍为 legacy_unset，危险操作分类 unavailable，不把覆盖缺失报告成无风险。
- 客户端真实只读抽屉读取远端 README；已有会话位置隐藏、Provider 锁定。主机页主动断开后，返回侧栏会话，未发送草稿完整保留、发送禁用，按 Enter 不发送；显式重连后草稿仍在，远端 history 为 available/trace_archive/一轮 done，正文 5587，客户端 localRuns 始终为空。
- 本地证据 `/tmp/scry-unified-real-Nz6fgx/`（gate 日志、after-send/reconnected/offline JSON、截图）；远端证据 `/Users/test/scry-unified-real-Nz6fgx/`。后续本机验收进程退出、旧 IP SSH 超时，未执行 App 重启后重开与最终 SQLite 数值核对。用户随后提供新 IP，本节不是这些剩余项已通过的声明。

## 0.2.183 安装准备（2026-10-14）

- 新侧栏使主机列表成为启动读取路径。真实隔离 App 在 `safeStorage.isEncryptionAvailable()` 内阻塞；诊断日志显示 ready/window/renderer 均已完成，随后只有该方法的 start、没有 end。原外链 fixture 只向主进程发 SIGTERM，未可靠收敛其子进程，组合命令和独立 smoke 均曾超时；这些失败不计为通过。
- 修复：空配置仅返回内存中的空列表，不初始化钥匙串或落盘私钥。已有状态解密及每次持久化仍检查安全存储；配对先成功加密保存，才发布连接及发出网络证明。加密失败不留下“已保存”连接，不发 SSH 请求；已有密文解密失败仍报错，不伪装成空列表。mTLS、宿主指纹批准与未知回执规则不变。
- 新回归：`desktop-client.test.ts` 检查上述空读取、失败前拒绝联网和密文读取失败；外链 fixture 对意外钥匙串访问直接抛错，旧实现明确失败。原始、不替换存储结果的诊断在修复后也完成了全部外链检查。fixture 超时现使用既有 `stopOwnedApp` 按身份收敛进程，并保留失败目录，不加大其 30 秒限时。
- 冻结产物：App **0.2.183**，私有 CLI **0.2.49**，`app.asar` SHA-256 **`07bf7d339ceca352b7f465d5e227450fb20f6f88da96dbfb8c6062724be6c2cc`**。Apple Development 签名，非公证发布版。
- 最终 gate：Node 22.22.1；typecheck、218 文件 / 2735 单测、shell、完整 renderer UI、CLI release 581 测试与 package smoke、打包体积/资源检查、packaged Electron 安全/文件/远程宿主 smoke 全部通过。3 个真实探针跳过，没有新发真实模型请求。
- 安装交接：冻结包与一次性安装入口在 `/Users/baobingjiang/Downloads/Scry-0.2.183-install-7EwEFn/`。`install.command` 复用原子安装器，校验版本、签名及上述 hash，保留旧 App 备份，启动后观察 20 秒。已实测运行中拒绝安装：现有 0.2.182 的 hash 未变，未产生安装完成回执。
- **安装更新**：用户随后明确要求“直接帮我安装好，我负责重启”。2026-10-14 18:55 已通过仓库 `scripts/install-macos.mjs` 原子安装到 `/Applications/Scry.app`，未退出、停止或启动 App。安装后版本 0.2.183、签名及上述 hash 核对通过；旧进程 PID 56237 仍在运行，重启后的运行版本尚未验收。
- **安装回执与备份**：实际回执是上述目录的 `install-only-result.json`，日志 `install-only.log`；不再运行旧的安装入口。0.2.182 备份在 `/Applications/.Scry.app.backup`，此前已有备份另存为 `/Applications/.Scry.app.backup-preserved-61334a9d-9515-45d6-b57a-4d62ffdec45c`。mac2 的 0.2.182 宿主未改动；日常客户端正式配对仍待完成。

## 远程右侧工作区能力（2026-10-15）

- 远程会话复用本地右侧标签、文件编辑器、源代码管理、终端、Agents 与会话 Diff。文件支持编辑、创建、重命名、移动和移到废纸篓；源代码管理复用同一业务校验、快照和操作日志。外部打开作用于**宿主**默认应用，不会将宿主路径交给客户端文件接口。
- `info.workbench: 1` 声明真实协议能力。旧宿主缺失声明时保留只读文件兼容入口，终端和源代码管理要求更新宿主；不能仅删掉提示后调用客户端 API。
- 桌面专用 `desktopWorkbench` 只接受枚举的 typed 操作；不会放宽手机工作区接口。每次请求绑定已授权 canonical cwd，并校验证书、文件修订或仓库身份。异步预检后、文件/Git 写入前再次检查授权。终端按证书及 canonical cwd 隔离，`scopeId` 只分组，不授权；旧 epoch 不能输入、调整或关闭。
- 文件、Git、终端输入都不自动重试。终端输出使用带 stream 身份的读取游标和累计 ACK，只有累计 ACK 可安全重复；丢失最终确认仍能交付退出事件。离开页面会分离输出消费者，不终止 Shell，也不会因未读输出耗尽内存而长期卡住；重开后从宿主录制追赶。
- 工作区 RPC 继续遵守现有 TLS 帧与响应上限。完整文本响应序列化后超过 3 MiB 转入分页只读视图，单次写入还受请求帧上限约束；若需要编辑超限文件，须先扩展带修订校验的分块传输合同，不能静默截断或放宽任意路径访问。
- 新回归 `src/renderer/remote-workbench.test.ts` 使用真实临时文件和 Git、实际终端管理器配合 PTY fixture，覆盖跨工作区/证书拒绝、修订冲突、撤权后的写入拒绝，以及丢失最终 ACK 后不重放输入仍交付退出。`desktop-client-ipc.test.ts` 通过生产注册 wrapper 拒绝非可信 sender/frame/origin。
- mac2 真机：在隔离目录运行同一 **0.2.191 开发构建**，`app.asar` SHA-256 为 `5830c9a0b8bd928d86e66cedc210a7a7b0b30fcb171731050fe441e934fb8b49`。真实文件写入/修订冲突/创建重命名、Git 暂存提交、原生 PTY cwd/输入、累计 ACK 重复、分离后超过 1 MiB 输出继续完成、录制追赶和旧 writer 拒绝均通过。现有 mac2 App 未替换，测试实例已收敛；没有真实付费 Provider 请求，Agent 生命周期使用打包 Codex fixture。未执行 GitHub 推送、PR 或远程用户界面逐项坐标验收，不把协议/宿主验收写成这些路径已通过。
- 本地检查：Node 22.22.1 下 typecheck、88 项当前定向测试、完整 renderer UI、CLI release（993 测试及 package smoke）、打包/资源/安全 smoke 通过。全量以 `npm run test:unit -- --maxWorkers=1 && npm run test:shell` 完成：252 文件 / 3167 测试通过，3 个真实探针保持跳过，shell 通过；日志 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-1fbf3dcba62fe1cc.log`。此前并行全量出现工作区 Git 用例 5 秒超时，随后默认双 worker 的复测又出现既有 Git push 用例超时并触及命令期限；当时机器 load average 为 39.72。本次未删除断言、扩大测试超时或跳过 Git 用例，最后将 worker 降为 1。最终全量运行还包含另一并行任务对 `source-control/service.test.ts` 的 15 秒真实 Git allowance 调整，该文件不纳入本次提交，因此不能把 3167 通过宣称为原 5 秒预算已恢复绿色。通过临时 Vitest transform、保持仓库文件不变的对照中，HEAD 原始测试定义配当前实现得到 26 通过 / 1 个 push 用例 5.44 秒超时；再用 HEAD 的 service/GitHub 实现单独运行该项，3.74 秒通过（其余 26 项未运行）。这些结果支持继续单列 Git fixture/负载问题，不证明所有环境下的原预算都稳定；原始失败不被最终通过抹去。npm 12 的 CLI package smoke 还曾因 `npm pack --json` 返回对象而失败；使用仓库已有 Node 22/npm 10 后原断言通过，没有为此修改 CLI。
- mac2 前两次启动收到 `SIGKILL`，未进入测试；签名和传输 hash 一致，系统日志显示允许执行，终止来源未查明。用户确认环境限制应已解除后，同一目录、同一签名与 hash 的构建通过；没有通过改签名、停用安全软件或替换旧 App 绕过。
- 复验入口：先构建 `npm run pack:artifact`，再显式运行 `node scripts/validate-mac2-workbench.mjs --host=user@hostname`。只创建临时 App、HOME、userData 和工作区，不安装到 `/Applications`，不停止现有实例；保留隔离构建路径供复盘。

## 行为与边界

- 远程发送复用 App 的规范执行入口、权限/trust 检查、停止升级、归档和 managed recorder 两阶段提交，不走另一套简化执行器。
- 本机选中的会话不会被后台远程发送替换。会话 diff 按 Provider/profile/cwd/原生 session 归属；切换展示不重命名其他会话的基线。
- `recorded` 只表示宿主账本收到意图，不表示 Provider 成功。丢失回执标为 `unknown`；用原意图 ID 查询，不自动换 ID 重发。查询暂未找到意图也不能证明旧请求绝未执行。
- 同一连接还有未知回执时阻止新发送/忘记，避免失去核对身份。先恢复连接并检查远端状态。无法核实时保留现场，不声称已失败或已成功。
- SSH 进程退出后，连接列表返回 `disconnected`；发送前已知离线的请求直接拒绝，不制造未知回执。仍在运行的 SSH 进程不等于每次宿主请求都成功，网络错误仍须按具体回执核对。
- SSH 端口在宿主重启后复用。端口占用或配置损坏会显示桌面监听恢复失败；不会撤销设备，也不会因此停用手机配对/中继。释放占用后重启宿主可恢复原端口。
- 关闭桌面监听会断开其通道，但不撤销手机设备或停止已有 Agent。监听存续期间，配对仍受短时邀请约束；不是只有邀请有效期内才监听。
- 支持上述工作区协议的远端可编辑文件并运行宿主终端。远程工具正文引用和后台任务不能调用客户端的本地文件/Provider 接口；单个远程后台任务停止、附件上传及客户端本地文件写入不在此扩展范围。
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

## 0.2.192 日常 App 更新准备与安装状态（2026-10-16）

- 发布工作区：本机 `/private/tmp/scry-release-0.2.192.TFUyJY/source`，分支 `release/desktop-0.2.192`；mac2 `/Users/test/scry-release-0.2.192.lELi5B/source`。未带入原工作区未提交的 Provider/conversation 改动。运行时代码冻结在 `60394ce`，包含 `bd60826` 的远程工作区与 `1c30b76` 的 Chromium 辅助功能崩溃恢复修复；后续仅改发布检查、安装错误诊断和本记录。
- 最终开发签名 App **0.2.192**、私有 CLI **0.2.49**；`app.asar` SHA-256 为 `d848a439178ab4f75e7a124d0d89036544110539b970a0903afb85a81ca9b1df`。未公证。两端最终候选 App 的签名、SHA、311 项必需运行时依赖及 `smoke:electron` 均通过，包含真实文件/Git/PTY、录制追赶、旧 writer 拒绝、renderer crash recovery；没有付费 Provider、GitHub push 或 PR 验收。
- 首次隔离发布目录链接到原工作区 `node_modules`，打包只收集直接依赖，漏掉 `cross-spawn`、`stream-chain`、`@peculiar/asn1-*` 等必需依赖。该包未安装；改用独立实体依赖后重建。新增 archive 依赖完整性检查：缺依赖包以非零退出，完整旧包与最终包均通过；不以源码依赖目录存在替代安装包证据。
- 验证范围：添加窗口修复前，mac2 Node 22.22.1 的全量 unit 为 **3167 passed / 3 skipped**（252 passed / 3 skipped 文件），CLI 发布检查 **586 passed**，shell 与分段 renderer UI 均通过。窗口修复后重新 typecheck、运行 renderer-security/window-chrome **21 passed**，并在两端重跑最终 build、打包/安全/远程宿主 smoke。真实 Git 场景沿用既有同类的 15 秒预算；原 5 秒超时与缓存 UI 等待失败日志保留，没有删除断言。安装器核心另有 **7 passed**；最初误用 `node --test` 导致 Vitest runner 错误，随后使用项目 `npm run test:unit -- scripts/install-macos-core.test.mjs`，两份日志均保留。
- **本机安装成功、尚未重启**：官方 `scripts/install-macos.mjs` 将最终包原子安装到 `/Applications/Scry.app`，安装后的版本、SHA 和签名通过。当前会话所在旧主进程 PID 52364 未结束；不能据磁盘版本宣称当前窗口已运行新代码。原 0.2.191 自动备份保留于 `/Applications/.Scry.app.backup`；原有 0.2.190 备份另存 `/Applications/.Scry.app.backup-preserved-before-0.2.192-5db01e7c-f133-4250-9e42-cf80ab64ecf7`。
- **历史尝试：另装到 mac2 `/Applications` 失败、已回滚**：同一包在暂存目录通过全部打包检查，但安装到 `/Applications/Scry.app` 后，私有 CLI `--version` 收到 `SIGKILL`。诊断期间目标副本 `codesign --verify --deep --strict` 返回 0，SHA 与冻结包相同；两次只读版本检查都被终止。安装器每次回滚，目标 App 不再存在，原日常 PID 4020 与其 `/Users/test/scry-remote-acceptance-0.2.180-GqVCV3/Scry.app` 保持运行（App 0.2.189，不能从目录名推断版本）；原日常 userData 未切换。
- 安全日志在对应执行时间记录 `com.alibaba.endpoint.aliedr.ne` 给 Scry 进程标记 `mac_non_white_proc`、`ssh_reject`。这些标签也出现在通过检查的暂存实例，因此不能单靠标签归因，尚无直接证据确定发送 `SIGKILL` 的调用者。若未来改装至 `/Applications`，需要宿主维护者核对该路径及 SSH 启动策略；准确追踪终止者需要管理员级 Endpoint Security 信号审计，普通账号运行 `eslogger signal` 已返回 `ES_NEW_CLIENT_RESULT_ERR_NOT_PRIVILEGED`。未关闭安全软件、未改签名、未换安装路径绕过。临时重复读取和复制签名诊断已从安装器移除，只保留退出信号与 PID 说明。
- **日常界面验收未执行**：不能用隔离 smoke 代替日常操作。mac2 随后已按维护者要求直接替换原安装（见下）；待重启本机 Scry 后，再按日常配对重放文件编辑/保存、Git、终端切换/重连/追赶、未保存确认和侧栏排序。真实写入仍限新建临时验证目录，不修改用户项目。
- 证据目录：`/private/tmp/scry-release-0.2.192.TFUyJY/logs/`。关键文件：`local-final-192-packaged.log`、`mac2-final-192-packaged.log`、`local-install.log`、`mac2-install-signature-diagnostic.log`、`mac2-endpoint-policy.log`、`incomplete-package-control.log`、`previous-package-dependencies-control.log`。失败包归档与 mac2 的 `Scry.incomplete-deps.app` 保留供复盘，不作为可安装候选。

### 同日追加：直接替换 mac2 当前安装成功

- 维护者明确要求不再创建隔离环境，直接替换当前安装。实际日常 App 是 `/Users/test/scry-remote-acceptance-0.2.180-GqVCV3/Scry.app`；目录名来自历史验收，安装前真实版本为 0.2.189。后续未新建 App/HOME/userData 测试环境，直接更新原路径，保持安装器全部校验。
- 正常退出旧 PID 4020 后，完整备份原 userData 到 `/Users/test/scry-upgrade-backups/0.2.192-direct-4088e06f-ccd4-4518-9123-5c3311c4ee42/userData`（备份根目录权限 0700）。使用标准安装器和 `SCRY_INSTALL_DIR=/Users/test/scry-remote-acceptance-0.2.180-GqVCV3` 原子替换该 App；CLI 版本校验通过，未跳过发布验证。旧 0.2.189 App 留在该目录 `.Scry.app.backup`，此前备份另存 `.Scry.app.backup-preserved-before-0.2.192-afe0aa44-7a61-4bbb-8b7e-cf17be79cc57`。
- 当前安装版本 **0.2.192**，SHA 与冻结包相同，严格深层签名验证通过。通过正常 LaunchServices 启动，新主进程 **PID 32276** 使用原 `/Users/test/Library/Application Support/scry`；原 hostId、CA 指纹保留，pairing-state.json 与停机备份逐字节相同，原桌面端口 **64050/64051** 均由新 PID 监听。
- 直接替换原路径成功，因此 `/Applications` 的历史终止问题不再阻塞当前升级，也未获得或使用管理员审计权限。没有关闭安全软件、重签或改变原安装路径。
- 本机 `/Applications/Scry.app` 也已替换为同一 **0.2.192**，但当前会话仍由旧 PID 52364 承载；为避免中断本次操作，尚未重启。**剩余动作：维护者退出并重开本机 Scry，然后继续日常远程界面验收。**
- 实际安装日志：`logs/mac2-direct-install.log`；启动/版本/签名日志：`logs/mac2-direct-start.log`；实际 PID、原 userData、配对和端口回执：`logs/mac2-direct-upgrade-state.json`。以上日志均在本机 `/private/tmp/scry-release-0.2.192.TFUyJY/` 下。

### 日常界面首次重放：部分完成，不作整体验收通过

- 本机已重启，实际日常主进程为 PID **21554**；版本 0.2.192，安装包 SHA 与上述冻结值一致。mac2 原路径的 PID 32276 仍运行。直接使用原日常 App、userData 和已保存配对，没有新建测试 App 或隔离 userData。
- 原 mac2 配对复连已确认：最初 20 秒等待未满足，随后实际界面显示 `主机 已连接 1 / 1 台`。远程目录浏览、输入路径、明确选择已确认，执行位置显示 `mac2 / /Users/test/scry-daily-ui.THymIn`。右侧 Surface 工作区及纵览曾打开；最大化/隐藏按钮可见，但未据此宣称所有面板交互已通过。
- 侧栏语义树当前顺序包含本机 `pi` → mac2 `rotom-team` → 本机 `myNote` → mac2 `workspace` → 本机 `Nib`。这证明该次列表中本机与远程项目混排；没有完整重放视觉滚动排序或受控活动时间变化。
- 自动化多次返回 `stale_ref`、`unknown` 或后置条件失败；窗口也出现未由本轮预期动作选择的本机会话/新会话。并行操作、自动聚焦或自动化定位问题尚未完成归因，不直接认定是用户操作或产品故障。发现 Terminal 曾在前台，后由用户将 Scry 置前；搜狗拼音也曾把 ASCII `mac2` 转成中文。后续原生 setText 验证过字面值 `mac2`，结束时读取到的输入法与原先相同，仍为搜狗拼音。
- 为避免向错误工作区发送写操作，**编辑保存、未保存确认、Git 暂存提交、终端输入输出/分离重连、面板恢复与尺寸交互均未验收**。只通过 SSH 创建数据专用临时 Git 目录 `/Users/test/scry-daily-ui.THymIn` 和基线提交 `56b469b`；停止时仍 clean，`alpha.txt` 为 `daily acceptance baseline`。该初始化不算 UI 保存或提交证据；未发送验收用 Provider 请求，未改用户项目。
- 证据摘录：`logs/daily-ui-evidence.txt`；范围与状态：`logs/daily-ui-acceptance.json`，均位于上述发布目录。下一步需先建立稳定、可归因的桌面控制，或由维护者操作真实界面、助手独立核对 mac2 落盘/Git/终端证据；不以 CLI 代做写入替代日常 UI 验收。

## 0.2.193 后台实例对真实 mac2 验收（2026-10-16）

维护者随后明确改为“起一个 test 实例在后台操作”。本轮使用独立、隐藏的正式打包 App 测试客户端，连接仍在运行的真实 mac2 0.2.192 宿主，不操作共享前台窗口；不是新的日常窗口验收通过声明。只复制原配对的**加密**连接文件到权限 0700 的临时 userData，由原安全存储代码解密；不导出明文设备密钥、不复制 Provider 凭据、不替换 `window.scry`，也不启用测试 Provider。UI 动作通过已有 Electron fixture 相同的 CDP 原生指针/输入路径执行，SSH 只准备临时数据和独立读回结果，不代做 UI 保存或提交。

### 发现与修复

- 后台真实客户端稳定复现菜单问题：当前机器为 mac2 时，`querySelector('button[aria-checked="true"], button:not(:disabled)')` 仍按 DOM 顺序命中第一个可用的本机按钮。其 focus handler 将右侧项目列切成本机。修复为先找 checked 按钮，再单独回退到首个可用按钮；未放宽授权或引入本机 API fallback。该问题不等于已经证明远程文件写到了本机，也不能据此把此前全部桌面定位异常归为同一原因。
- 远程终端的无障碍标签原来固定为“本机终端”，现复用现有 `machineLabel`，真实 UI 验证为 `mac2终端`；本机默认标签不变。
- 源码修复提交 `d7e6a8e`，分支 `fix/remote-picker-focus-0.2.193`。开发签名候选 App **0.2.193**、私有 CLI **0.2.49**，`app.asar` SHA-256 **`98a13c298f4c249b1640d038d859da517c7b1e1aec8db750933ecfbf71049b83`**。未公证；候选位于 `/private/tmp/scry-release-0.2.192.TFUyJY/source/dist/mac-arm64/Scry.app`；验收当时尚未替换日常 App，随后的两端安装见下文。

### 实际通过范围

| 场景 | 结果与独立证据 |
| --- | --- |
| 原配对、远程选目录 | 原 pinned mTLS 身份复连，UI 明确选择 `/Users/test/scry-background-ui.iYz1An` |
| 文件编辑、保存 | UI 保存 `alpha.txt`，SSH 精确读回 `daily UI saved on real mac2\n` |
| 未保存确认 | 改动后切主机页，取消确认保留编辑器草稿；磁盘仍是已保存内容 |
| 面板交互 | 原生坐标拖拽改变宽度，最大化/恢复均验证实际状态 |
| Git 暂存、提交 | UI 确认时暂存并提交；宿主提交 `939e1dc52e6d1290d3e3d3363eae75e678970516` 仅含 `alpha.txt`，最终 clean；重连 UI 从宿主操作历史显示“提交 · 已确认” |
| 真实 PTY | UI 输入命令后显示临时 cwd 和经 SSH 对照的宿主名；输出标记由 printf 参数拼接产生，不能用输入回显冒充执行结果 |
| 标签分离、追赶 | 切到文件再回终端，后续输出可见 |
| 断开、重连 | 测试客户端未连接时，独立读宿主该终端的 UTF-16LE 录制确认后续输出已产生；重连 UI 追赶同一 terminal ID，无替代 Shell |
| 退出、录制回放 | Shell 退出后清屏再回放可见实际标记；回放前后无新活动 Shell |

这些检查分阶段完成，未隐去首轮脚本失败。目录加载只读期间的输入、旧选择器、窄面板隐藏复选框、提交状态文案匹配等自动化错误均保留日志。尤其一次确认提交后过早把“正在执行已确认的操作”当作完成：随后先独立查明提交已落地，再从 UI 操作历史核对，**没有重发提交**。

### 回归与清理

- 新菜单焦点回归在旧实现上明确失败 `Remote picker initial focus moved to local machine`；修复后完整 `desktop-remote-ui-smoke.mjs` 通过，覆盖本机/远程菜单、目录选择、hover、旧宿主 unavailable、共享面板和受控侧栏活动排序。首次修复后 suite 曾在 Markdown 展开源码前超时；新增鼠标事件收据证明当时坐标实际命中标题，随后在滚动后等待绘制同步，不增加原超时、不删断言，最终完整 suite 通过。
- Node 22.22.1 驱动下，typecheck、受影响 unit **23 passed**、`pack:artifact`（311 项必需依赖、安全、文件、PTY、宿主协议等）和严格深层签名检查通过。0.2.192 的历史全量单测数字不冒充 0.2.193 全量重跑。
- 后台实例已退出，PID 79684 已不存在；该 userData 没有存活进程。验证其新建的远程终端剩余 **0** 后，删除了临时 userData 及加密连接副本；原前台 App、原配对和真实宿主未停止。临时 Git 目录、宿主录制与截图保留供复盘。验收未发起 Provider 对话、GitHub push 或 PR。
- 通过回执：`logs/background-live-verified.json`；原始分阶段日志：`logs/background-live-final-193.log`、`logs/background-live-final-reconnect-193-api.log`；截图：`logs/background-live-ui/remote-file-saved.png`、`git-confirmed-after-reconnect.png`、`reconnected-same-pty.png`、`terminal-replayed.png`；清理回执：`logs/background-live-cleanup.json`。以上均相对于 `/private/tmp/scry-release-0.2.192.TFUyJY/`。
- 后台验收时日常客户端/宿主为 0.2.192，验证的是修复客户端 0.2.193 与宿主 0.2.192 的兼容路径；日常新主进程启动后的验收尚未执行。

### 随后按明确选择更新两端（不重启）

维护者选择“两端都更新”，并保留“不立即重启或停止当前任务”的约束。标准 `install-macos.mjs` 已在两端原安装路径原子替换为 **0.2.193**；未停止原进程，未改 userData、签名或安全策略。

| 项目 | 已验证状态 | 证据 |
| --- | --- | --- |
| 本机安装 | `/Applications/Scry.app` 为 0.2.193，CLI 0.2.49，311 项依赖检查、严格深层签名检查通过 | `logs/local-install-193.log`、`logs/local-193-installed-verify.log` |
| mac2 安装 | 原 `/Users/test/scry-remote-acceptance-0.2.180-GqVCV3/Scry.app` 为 0.2.193，相同 ASAR SHA-256，CLI/311 项/签名检查通过 | `logs/mac2-install-193.log`、`logs/mac2-193-installed-verify.log` |
| 原进程与配对 | 本机 PID 21554、mac2 PID 32276 未改变；mac2 配对文件安装前后 SHA-256 同为 `86e51dc75521564afd145b97396f01d7953eaa4ad0ae0adb7c67371b4d7981fb`；原进程仍监听 64050/64051 | `logs/mac2-193-before-install.log`、`logs/mac2-193-installed-verify.log`、`logs/mac2-193-process-and-backup.log` |
| 回滚包 | 两端 `.Scry.app.backup` 均为刚替换的 0.2.192；此前的备份先独立改名保留，未删除 | `logs/local-193-backup-preservation.json`、`logs/mac2-193-backup-preservation.json` |

mac2 新暂存目录的内置 CLI 检查收到 `SIGKILL`（PID 82944），完整首轮失败保存在 `logs/mac2-193-preinstall-verify.log`。没有在该路径循环重试；沿用原路径的标准安装器及其最终目标 CLI 校验成功，随后完整 packaged 检查亦通过。信号来源仍未知，不能据此归因特定安全软件；若需归因，须由管理员开展信号审计。目前不是安装阻碍。

**当前是“安装包已更新、原进程未重启”，不是两端新主进程都已运行验收通过。下一步由维护者在空闲时退出并重开两端；本机重启会中断当前会话，不自动执行。** 最新安装状态：发布目录的 `deployment-state.json`；后台验收回执保留其安装前的历史范围。
