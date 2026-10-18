# 主机页并入设置·远程访问 / 2026-10-18

任务：用户日常在另一台 Mac 上跑 Agent；主机管理不再占用侧栏一级入口，统一收进「设置 → 远程访问」。成功标准：侧栏没有「主机」项后，用户仍能在设置里完成添加/连接/断开/编辑地址/移除主机、生成 SSH 邀请、手机扫码配对与吊销，且 LocationPicker 的「管理主机…」落到这里。

感受：这是一页"管理"，不是仪表盘。状态一眼可扫（状态点 + 文字），动作就地完成；删掉成段解释小字，只保留安全关键事实（指纹核对、邀请失效）。沿用 Scry 深色 tokens 与设置弹窗模式，不新造视觉身份。

约束：
- H1 出站「我连接的主机」与入站「允许其他设备访问本机」是两个方向，分区呈现，不合并列表（HostsView 注释、scry-unified-remote brief H5）。
- H2 状态必须诚实：连接状态读取失败显示"状态未知"+ 重试，不显示成断开或 0；中继休眠、未启用是真实状态文案（CLAUDE.md 第 1 条）。
- H3 配对安全事实不可删：等待确认设备显示指纹并要求与手机核对；SSH 邀请含短时 secret 的提示保留；编辑地址后需手动重连的说明保留。
- H4 删除侧栏主机入口与 HostsView 后，composer LocationPicker「管理主机…」必须改指向设置·远程访问；远程会话本身不依赖主机页（会话归侧栏远程项目分组）。
- S1 信息减法：默认状态只显示名称、状态、动作。辅助说明不常驻；空态只说明下一步，异常态只说明当前阻碍。指纹核对、邀请失效、保存后需重连等会改变用户决定的安全事实保留在对应流程。
- A1 设置弹窗从 920×620 加宽到 1040×720 是否影响其他 tab：外观/已存档内容少，加宽无害，待用户确认。
- A2 本设计稿以本地假数据演示，所有连接、配对、复制与授权动作都不触发真实主机、剪贴板或中继。

范围：侧栏 nav 删除「主机」；HostsView 三个能力（出站列表、SSH 入站、手机配对）并入 RemotePairing 所在设置 tab 并重排；LocationPicker 的管理入口改跳设置。不做：远程会话视图、composer 结构、Provider 能力变化。最初只做原型；用户随后说“没问题 落地吧”，授权按精简后的 A 稿实施。

现状：HostsView（整页 860px max-width，header + 两 section）与 RemotePairing（设置 tab 内单列，h2/h3 + 成段小字 + "打开主机页"跳转按钮）双入口并存。生产 tokens：`src/renderer/styles.css`（--bg/#07090d 等深色为主）；组件样式 `hosts-view.css`、`desktop-remote.css`。

复用：P-SCRY-DESKTOP-REMOTE（docs/desktop-remote.md，身份与路由分离、原位编辑）；scry-unified-remote（designs/scry-unified-remote，H5 两方向分离沿用）；个人库无匹配的设置页组件。

调研：
| 来源/区域 | 观察 | 采用/不采用 | 动作/检查 |
| --- | --- | --- | --- |
| Chrome Remote Desktop 官方帮助 · Set up Remote Access vs Access a computer | 入站（这台电脑被访问）与出站（访问别的电脑）是两个命名清晰的分区；一次性码带有效期 | 采用两方向分区与"邀请/配对码有时效"的行内提示 | 方向 A/B/C 都保持两分区；码区显示有效期 |
| [VS Code Remote-SSH 文档](https://code.visualstudio.com/docs/remote/ssh) · Remember hosts / SSH Targets，以及官方 ssh-explorer-connect.png 图 | 已保存主机集中管理；显示名（Host）与路由地址（HostName）分离；引导式添加；截图中设备图标与主机名沿同一边线排列 | 采用身份/地址分行显示、原位编辑地址；不采用自由 SSH config 编辑 | 主机行 label + user@host:port 两级；编辑地址弹窗沿用现有 |
| 项目 docs/desktop-remote.md | 同上，且已落地 | 沿用 | 不引入第二套机器导航 |
| 用户截图（侧栏 主机 1/1） | 一级导航承载低频管理任务，占用常驻位置 | 删除该入口 | 三个方向均演示无主机入口的侧栏与 LocationPicker 落点 |

方向（同内容、同视口对比，见 remote-access-settings.html）：

| 方向 | 信息优先级/任务路径 | 满足 | 放弃 | 风险 |
| --- | --- | --- | --- | --- |
| A 分区单栏 | 出站主机列表在上（行内展开详情），入站「SSH 邀请 / 手机配对」两卡片在下；顺设置 tab 单列滚动 | H1/H2/H3, S1 | 长内容需滚动 | 配对 QR 在 730px 栏宽内偏左，用两栏码区缓解 |
| B 列表-详情 | tab 内左列主机+方向项，右列详情 | H1/H3 | 嵌套第二级导航 | 与设置 rail 视觉重复；2–5 台主机时左列空荡 |
| C 本机优先 | 入站「这台电脑」卡片置顶，出站列表在后 | H1 | 与现主机页顺序相反 | 日常出站路径变长；卡片化有装饰风险 |

推荐 A：设置是管理语义，单栏分区改动最小、最诚实；B 的 master-detail 超出 2–5 台主机的规模；C 把低频入站放到日常出站前面。

补充调研：Designeer 入口实际请求返回 HTTP 403，未作为已查看的视觉参考。已直接读取 VS Code 官方 `https://code.visualstudio.com/assets/docs/remote/ssh/ssh-explorer-connect.png`，借鉴紧凑主机行、图标与身份对齐，不借其高饱和整行选中颜色。

用户反馈（2026-10-18）：选择 A，并要求“把一些小字都去掉，按照文字最好的方式来，简洁些”。已应用：删去默认页的连接方向说明、主机计数、卡片说明、重复授权状态和常驻安全段落；区标题改为动宾结构「连接其他主机 / 允许访问本机」；空态缩为「没有主机 / 在远端生成 SSH 邀请后添加」；安全信息移动到编辑、邀请和配对弹窗，不删除真实后果。此反馈确认的是本项目 A 稿的文案方向，成品仍待用户确认。本轮文案集中到 `copy.ts`。外部原始参考补读 Apple 官方 Sharing 帮助页（https://support.apple.com/guide/mac-help/change-sharing-settings-on-mac-mh11848/mac）：访问功能以具体名称标识，授权信息在操作流程中展开；只借其按任务呈现的文字方式，不照搬其权限机制。

本轮验证：strict TypeScript 与 esbuild 通过；Chrome 1512×708 的最终默认截图确认卡片不再有说明段落、主机身份左对齐；空态读回简短下一步；SSH 邀请弹窗读回短时有效与旧邀请失效提示。待确认按钮调用 timeout 后恢复同一 tab 只读核对，仍为默认态，未将该路径算作本轮通过、未重发。真实配对不在设计稿范围。

视觉自查（2026-10-18）：推荐稿已在 Chrome 1512×708 查看默认、展开详情、空列表和添加主机弹窗；状态未知与待确认已有状态读回。后续截图与 recover 超时，最终几处文字/CSS 调整未获得新截图。减掉页面顶部重复说明，只保留两个方向标题；主机状态与身份保持同一行，次级地址使用等宽字体；设置 rail 不再重复解释入口。Craft 应用：主机计数使用 tabular nums；即时 hover 不加延时过渡；根背景与深色画布一致。独立评审尝试受阻：评审 agent 无法访问 browser artifact 指定路径，因此没有把它算作通过。

验收：设计稿阶段——用户确认方向与配套改动（侧栏、LocationPicker 落点、弹窗加宽）。实现阶段——侧栏无主机入口；设置·远程访问复用原有添加/连接/断开/编辑/移除/邀请/配对/吊销 API；状态未知与空态诚实显示；受影响自动测试通过。真实 App 验收等待用户手动重启后进行，不把安装或样例测试当成真实配对通过。

## 生产落地 / 2026-10-18

- 用户授权：本轮“没问题 落地吧”。保留精简 A 的结构，不再重新比较方向；不把实施授权等同于真实 App 的最终视觉验收。
- 实现：删除侧栏主机项和 `hosts` 视图；设置远程分区直接展示主机管理；位置菜单改为“管理远程访问…”，直达目标分区且保留当前草稿。`HostsView.tsx` 保留源码路径以复用连接能力，但不再是页面路由。
- 默认减法：只显示身份、地址、真实状态与动作；没有计数、方向说明或常驻安全段落。地址是已选 A 稿的次级身份信息。安全后果放在 SSH 邀请、手机配对和地址编辑流程；文案集中在 `src/renderer/constants/copy.ts`。
- 状态诚实：中继文案改为“中继已配置”，不把配置事实写成在线证明；手机状态读取失败清除当前授权投影并显示未知，不伪装为空列表。
- 独立视觉评审：已读取当前隔离 Electron `remote-settings.png` 和 VS Code 原始参考。建议把入站双卡改纵向、隐藏地址、把添加按钮移到分区标题。均未采纳：前两项改变了已选 A 的双卡/身份布局，第三项偏离已确认页头动作；本次没有新的用户证据支持重新调整结构。保留两个方向标题、无重复计数、真实状态文字。评审不证明交互或用户认可。
- 自动交互：现有隔离 Electron fixture 使用生产 App/renderer 与原生坐标和键盘输入，验证直达远程设置且不丢草稿、返回焦点、嵌套弹窗 Escape 仅关闭子层、手机码有效期/指纹提示、未知/休眠/关闭状态，以及地址修改后的手动重连与不启动 Provider。真实手机/SSH 未操作。
- 反向对照：`--negative-settings-control` 故意把直达入口指到外观，回归在“manage hosts opens remote settings directly”处失败；正常实现通过。
- 首轮问题：新增验收对邀请文案和管理入口使用了旧字符串，分别失败；核对实际集中管理的文案后修正选择器。新空态回归还证明：已读到空列表后发生读取失败，旧实现仍会显示“没有主机”；已修复为读取失败时不显示空态。保留失败日志，未删断言、放宽超时或重试未知写入。
- 性能：映射中的 `navigation.catalog` 没有对应计数 collector，首次测量明确失败。实际已有 `files.fixed-operations`（包含固定 catalog 与 drafts 工作量）3 次计数通过 ratchet；高负载下不作毫秒或页面更快的结论。记录 `/tmp/scry-performance-remote-settings/measure.json`。
- 扩大检查未全绿：`npm run test:unit` 首轮 3352 通过、8 失败、4 跳过；包含现有 main/history 的 32 KiB 合同失败、主进程超时和 Codex 子进程 SIGABRT。Node v24.18.0，负载约 24–30（10 核）；不将这些失败隐藏或直接归因为负载。
- `npm run test:renderer:ui` 的 Credits、远程 UI/会话 parity、source-control 与 ownership 均通过，最终统一对话 fork 超时。对照检查使用不含本次 renderer 改动的 HEAD 临时副本，叠加同一现有 main WIP：该副本和当前 App 的 focused unified-conversation 都在既有 32 KiB 预期失败，证明该合同问题不依赖本次设置改动。首次 fork 超时仍保留为未解决的时序失败。
- 当前版本 0.2.200：focused 265 项通过；`typecheck:web` 与 build 通过。Node 类型检查先因并行新增 `conversation-history-reader.test.ts` 的 unknown 报错失败；最后重新核对当前 WIP，则为 `conversation-history.ts` / `conversation-service.ts` 与 `conversation-handoff-budget.ts` 的导出/参数合同不一致。本次未修改这些 main 文件。
- 一次 full remote smoke 在 90 秒总预算处超时，PID 61896 已退出；保留首次失败。调查发现该轮已经走到主机展开，新增的轮询状态场景与原有完整交互共享总预算。将新增场景搬到同一 fixture 的 `--remote-settings-only`，并同时纳入 `test:renderer:ui` 和 `test:desktop-remote`，没有删除断言或扩大超时。调整后 default、`--session-parity-only`、`--remote-settings-only` 三组均通过。最终默认画面已读取 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-desktop-remote-ui-QZIKWG/remote-settings-focused.png`。
- 安装未执行：当前全量/Node gate 未通过，不能绕过正常打包安装流程。本次只保留本地 renderer 与相关测试/设计记录提交，不推送；未自动关闭、启动或连接任何真实主机。需现有 main/history 改动维护者处理合同与类型失败后，再按原流程安装；安装后由用户手动重启验收。
- 设计记录已保存并通过 `library.py search '统一远程访问' --kind page` 找到原 ID；build 成功。全库 check 仍因之前五条 stale 来源失败，本次没有删除那些指针。
