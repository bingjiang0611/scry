# Scry 左栏动态 Tab

## D-20261018-scry-sidebar-activity

- Scope / status：Scry 桌面端；用户需求已确认，成品待重启后验收。
- Feedback：2026-10-18 当前会话，用户先认可 ClaudeDevs 视频左栏动效，再要求「可以为 scry 左侧边栏加一个 tab 做成这种效果吗？」。
- 方向：保留默认「项目」，增加「动态」。用户已明确选定参考和局部实现，不另做多方向原型。
- 目标：并行会话状态变化时，用户能追踪同一会话去了哪里，而不是看到旧行消失、新行出现。

## 参考 → 动作 → 检查

原始来源：https://x.com/ClaudeDevs/status/2110445844675838148 。读取原帖子，并下载其公开原视频查看全段抽帧和 0.5–3 秒左栏密集抽帧；不据录屏声称对方实现用了某个动画库或曲线。

| 原视频区域 / 观察 | 本次采用 | 检查 |
| --- | --- | --- |
| Working → Completed：同一行移动，邻居让位 | 同级稳定 key，原生 Web Animations 位移动画；批量读取布局后再写入 | 跨组后 DOM 节点与焦点不变；存在非零位移动画 |
| Needs input 出现在上方 | 等待回复 → 运行中 → 最近 | 问题状态优先于运行状态 |
| 动画克制，无整屏闪光 | 仅 320ms 缓出位移，沿用 Scry tokens | 不依赖背景粒子或装饰；减少动态效果时禁用位移 |
| 参考将终态写作 Completed | 不照抄标签 | 本机 catalog 不含可靠成功/失败结论，未运行只放「最近」 |

复用：直接使用 `Sidebar.tsx` 的 SessionRow、逻辑会话行、悬浮信息、点击、置顶、归档、重命名入口与现有颜色。个人库检索 Scry / sidebar / activity / 侧栏 / 动态及 component/page：没有更合适的动画组件；不引入依赖或另一套状态机。

Craft 对应：容器只用于明确项目/动态切换，不新增卡片套卡片；计数使用等宽数字；动效属于辅助信息，必须保留静态及 reduced-motion 路径。

## 范围与约束

- 本次改展示层，不改 IPC、Provider、持久化、权限、远端协议。
- 动态页明确标「本机会话」；远程项目沿用原项目页。
- 原生会话状态使用现有运行/提问集合；逻辑会话沿用其 authoritative activeRunId。
- `最近` 包含没有活动运行的历史，不代表成功，也不重新推断时间戳。
- 保留 catalog 原有顺序，不按 token/progress 重排。按住鼠标到点击完成期间冻结位置，避免目标在 press/release 之间换位；普通悬停不冻结分组。
- 每组最多渲染 40 条，最多 120 行。超量显示真实数量及搜索提示；搜索先过滤整个已加载 catalog，再限制显示。所有历史仍可从原项目页访问。若真实使用需要同时查看更多历史，再引入虚拟化或分页，不无界增加 DOM。
- Tab 支持方向键 / Home / End；切换 Tab 不持久化，App 下次加载仍默认项目页。

## 实现与复用入口

- `src/renderer/sidebar-activity.ts`：真实 catalog → 带稳定身份的视图投影。
- `src/renderer/components/SidebarActivity.tsx`：接收 entries 和 renderEntry，负责分组、位移、减少动态效果及按下期间位置保护；无数据请求。
- `src/renderer/components/sidebar-activity.css`：局部主题样式。
- `scripts/fixtures/sidebar-activity-smoke.tsx`：使用真实 Sidebar 的隔离展示，不连接用户数据或 Provider。
- `scripts/sidebar-activity-ui-checks.mjs`：原生坐标输入与键盘验证，接入现有 renderer UI runner。

```bash
SCRY_SIDEBAR_ACTIVITY_SCREENSHOT=/tmp/scry-sidebar-activity node scripts/session-capability-ui-smoke.mjs --sidebar-activity-only
npm run test:unit -- src/renderer/sidebar-activity.test.ts src/renderer/components/render.test.tsx src/renderer/sidebar-hit-area.test.ts
```

## 验证与限制

- Node 24 / macOS arm64；focused unit：3 文件、249 项通过；typecheck 通过。
- 隔离 Electron：11 项检查通过，覆盖 Tab 键盘、选择、跨组身份/焦点、实际动画、按下期间保护、置顶/归档、减少动态效果、数量上限、搜索/空态、返回原项目页、卸载。
- 反向验证：临时禁用位移动画后，专项在 `State transition has no real layout animation` 处失败；恢复后通过。
- 首轮 UI 测试把原有无限 spinner 当作位移动画等待，后改为只观察 data-motion-key 节点。后续一次原生输入在焦点尚未落定前发出，已补显式焦点条件；没有扩大超时或跳过断言。
- 实际查看深/浅色截图；独立视觉评审指出密度和控件对比度问题，已收紧组间距、提高副标题与操作颜色。浅色截图最初早于绘制及 CSS transition 收敛，已等待真实主题样式、有限动画结束与两帧绘制后重拍。
- `npm run performance:measure`：40 项已有计数，5 次采样，ratchet passed。它不测新增动画帧率，不能据此宣称 L2/L3 更快。
- `npm run test:renderer:ui`：侧栏、Credits、预览、会话性能、后台任务、Steer、远程与 source-control 夹具通过；最后统一对话 fork 流程在“打开源对话”超时。用旧 Sidebar 作对照，仍在 fork 流程失败，但落在后续“归档后找回侧栏会话”，不把两个失败说成同一断言已证实无关。
- `npm run install:mac:dev`：全量测试出现多处超时及 backend conversation-management 历史预算断言失败，600 秒期限到达；未走到打包和安装。失败模块未导入本次 renderer；未修改其断言或用户已有 main WIP。结束时无本次 vitest/install 进程；系统负载很高（失败后 load average 约 532），不是动效性能测量。
- 最终当前源码 `npm run build` 通过（工作区版本在并行任务中由 0.2.198 更新为 0.2.199）；未自动退出或重启用户 App。
- 真实 App 与真实 Provider 多会话动效尚未验收。安装门禁通过后，由用户手动重启，再重放运行 → 等待回复 → 停止、搜索/切换/归档及窄侧栏。

## 共享检索回执

已注册 `D-20261018-scry-sidebar-activity`，生成本机索引并用该 ID 检索命中当前文档。全库 check 仍失败：5 个既有来源路径失效（Pi 模型选择器、Scry iOS remote、iOS continuity、session history、LLM sidebar）；未删除旧来源来凑通过。本条保存与检索成功，不等于全库健康。

## 下次使用

用户要求状态列表动效时：先复用真实身份与状态投影，再实现同级 keyed 行的位移；检查可中断动画、焦点、按下期间点击对象、减少动态效果和列表上限。此次只确认需求，不升级为全局审美偏好，也不把夹具通过当作用户验收。

## 门禁修复与隔离安装（2026-10-18）

用户授权继续排查并安装。原工作区的历史预算 WIP 保持不动；从已提交的 `a54e07c` 创建隔离工作区 `/tmp/scry-sidebar-install-dOx1Jc/source`，使用已有 Node 22.23.1 / npm 10.9.8 与本机依赖，不将未提交的 main 改造混入安装产物。

- 根因：`64955fa` 明确取消侧栏已存档对话入口，并已有对应 SSR 断言，但统一会话的三组 UI smoke 仍查找旧入口。干净隔离源码复现 `fork conversation in sidebar` 超时。
- 改法：先打开真实会话，再通过原生 UI 存档；断言侧栏入口消失、当前视图仍支持恢复/删除。fork 的共享副本场景保持源视图打开，通过生产 IPC 清理另一个 owner，继续通过原生 UI 验证源视图的重新核对/回收；保留原有 fingerprint、归档字节、Provider 未执行、最后 owner 清理与回执断言。
- 坐标输入：复用现有 `nativeUiPointer`，等待稳定布局并检查原生 pointerup 的可信事件与命中目标。不会重发未知点击，不扩大单用例期限。
- 修复后统一会话完整 UI/IPC 通过：18 次仅测试 Provider 调用，2 次隔离 App 重启，证据 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-unified-rendering-ZmCs5c/verification.json`。这些重启仅属于临时 fixture，不是用户正在运行的 App。
- 干净版本 conversation-management 与 performance-measure 共 16 项通过；后者已有 `c13cd2d` 的 collector 按场景过滤修复，未修改性能 workload 或测试时限。原工作区的预算 WIP 仍交由其原任务维护，不声称已修完该改造。
- 扩大检查另发现原生点击后焦点未落定就 insertText，以及会话容器已出现但管理按钮尚未可用两处夹具时序问题；改为检查真实 focus/disabled 状态后输入，不加 sleep、重试或更大期限。模型夹具 focused 通过；统一会话再次完整通过，证据 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-unified-rendering-y4UHeE/verification.json`。
- renderer 组合运行前面的全部子门禁通过，末项统一会话因三个串联命令的 300 秒外层期限中断；中断后确认无该工作区子进程，未将组合命令记为通过。独立运行的同一统一会话脚本已完整通过。CLI release：32 文件 / 587 项及 npm 包 smoke 通过，版本仍为 0.2.49；App 候选版本为 0.2.200。
- 隔离版本首次 `install:mac:dev` 全量结束：3350 passed / 3 failed / 4 既有 opt-in skipped。两项 Pi 测试错误假定当前 Node 必须能被 Rotom 选中；生产合同实际要求 Rotom >=24，而 App CI 使用 22。仅修测试的版本条件及探测数量预期，不改生产版本要求。Node 22 focused 24 项、Node 24 focused 17 项通过；counter workload 未变，Node 22 的 `providers.pi-environment/subprocess.node` 五次采样仍为 1、ratchet passed，报告 `/tmp/scry-sidebar-install-dOx1Jc/pi-counter-check/measure.json`。计数测试修改单独提交。
- 其余失败为既有 remote-workbench 真 Git 用例 15 秒超时；不扩大期限。调整为单 worker 后该文件 7 项通过，其中原失败用例约 1.9 秒；并行 Node 24 专项也曾超时，串行后 17 项通过。这是环境/并发下的验证差异，不声称生产性能被修复。后续按 `typecheck → test:unit --maxWorkers=1 → test:shell → pack:artifact → install-macos.mjs` 完成与原安装脚本相同的检查，唯一差别是 unit 文件串行；不绕过打包或安装校验。

### 最终安装结果

- 冻结源码：`a0451299ebc608f53e5ca0f989ef095849e9c42f`；App 0.2.200 / CLI 0.2.49。只包含该冻结提交，不含主工作区随后提交的远程改动或尚未提交的历史预算/设置 UI 改造。
- Node 22.23.1 串行全量：272 文件 / 3353 项通过，4 项原有 opt-in 保持 skipped；typecheck、shell 通过。完整日志 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-c037f239054ea175.log`。未新增 skip 或修改任何单项 timeout。
- 初次打包因工作区以符号链接复用 node_modules，electron-builder 漏收 transitive dependency `cross-spawn`，被原完整性检查拒绝；未安装该不完整包。将同一已安装依赖原样复制到隔离工作区（APFS clone，不改 lock 版本）后重新打包，完整性检查验证 311 项运行时依赖、298091342 bytes，低于原 346030080 bytes 上限。
- 原 `pack:artifact` 完整通过：App/CLI build、开发签名、资源完整性、external-links、renderer crash recovery、安全/终端/文件、远程宿主 smoke 均通过。随后原 `install-macos.mjs` 成功安装到 `/Applications/Scry.app`；上一包保留在 `/Applications/.Scry.app.backup`。日志 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-8bfefc5acc29541f.log`。
- 安装后 plist=0.2.200，私有 CLI=0.2.49，`codesign --verify --deep --strict` 通过；安装包与目标 `app.asar` SHA-256 一致：`c64d54747be719632f3db9173d02f439a1bab67ec25387cc7a3e9ffe2b6f3bc5`。属于 Apple Development 本机包，不是 Developer ID 公证发布。
- 未停止、启动或重启用户正在运行的 Scry；用户手动重启后才加载动态 Tab。真实会话多状态动效仍待用户验收。隔离工作区和产物保留在 `/tmp/scry-sidebar-install-dOx1Jc/`；未留下活跃测试或安装进程。
