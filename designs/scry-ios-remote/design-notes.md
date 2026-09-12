# Scry iOS Remote · Design notes

## 设计判断

**推荐方向 A · Tasks first。** 首页先回答“接下来需要我做什么”：`Needs attention` 将待审批压到首屏，其下是运行中、完成和缓存任务；Machines 是独立主导航，不把主机管理吞掉任务路径。点任务进入同一份详情交互，详情内以 Session / Changes / Terminal 分段切换。

**比较方向 B · Machine first。** 通过原型外部的 `B · Machine first` 控制器切换首页：先展示 `Studio Mac` 的连接/锁屏状态与 `storefront` 项目，再展示该主机的待处理和任务。这保留相同内容、视觉和详情页，但多一层主机上下文，适合多 Mac 用户；对于离开电脑只想处理阻塞的单机用户，入口成本高于 A。

这两个方向不是换色：A 的第一视觉锚点是任务状态，B 的第一视觉锚点是机器与项目范围。用户确认方向后才进入生产集成，本稿不替用户批准。

## 结构与视觉

- 390 × 844 的目标手机画框（较矮桌面视口按可用高度收缩）；窄屏 full-bleed。用 `env(safe-area-inset-top/bottom)` 给真实系统 inset 留位，不绘制 9:41、电量、动态岛或虚拟键盘。
- 浅色、细分割、低饱和蓝色动作、绿色完成、琥珀待处理。大标题只做页面定位，任务行用约 15–16px 正文和 44px 以上点击高度；不常驻技术说明，不做桌面三栏缩小或营销 hero。
- 底部四项导航固定为 Tasks / Machines / Activity / Settings。重要写操作在原生感 sheet 内二次确认；外部结构控制器不属于正式手机界面。
- 状态语义保持诚实：Offline 顶部明确“cached data is readable / sending and approvals disabled”；审批变化显示 `CHANGED` 与重新审阅；停止显示 `Stop requested · confirmation pending`，没有伪造成功；缓存任务显示 `Cached`，不等同于当前在线状态。
- Provider / Full access / trust 的差异在 Run controls 与 Approval 文案中分开出现。owner-device 权限在 Machines 中可见，但说明不是 root、不会绕过 macOS 权限。
- 文件页用文件列表 + 只读 diff；编辑入口在断网时 disabled。Terminal 只展示受管理 shell、control lease 与“sample only”，没有执行真实命令的路径。

## 覆盖画面与点击路径

1. **任务主路径（推荐 A）**：Tasks → Needs attention → Review request → Approve once / Reject；或 Tasks → running task → Session。
2. **任务详情**：Session ↔ Changes ↔ Terminal；Stop → Stop this task? → Request stop，回执仍为 requested / pending。
3. **审阅路径**：Tasks → completed task → Changes → file → read-only diff → Preview edit conflict（仅冲突画面，不包含完整编辑器）。
4. **主机路径（B 与 Machines）**：外部切换 B → Studio Mac / storefront → Machines → Pair with QR code → Simulate scanned code → “confirm on Studio Mac” toast；Machines 也可进入权限说明。
5. **设置路径**：Settings → Task updates toggle（模拟）或 Keep Mac available → sheet，展示锁屏、耗电、系统睡眠/退出 Scry 的边界。
6. **断网路径**：外部 Offline → Tasks / Session / Approval / Changes / Terminal；可读缓存保留，发送、批准、拒绝、编辑和终端输入 disabled，并可通过顶部 banner 识别。
7. **异常状态**：外部 Stale approval → Approval 页面显示 fingerprint changed；Empty → Tasks 空状态；长命令在 approval target 中自然换行。

## 实现说明

- 入口是单文件 `Scry iOS Remote.html`，状态与视图使用原生 JavaScript，不依赖 CDN / npm / Provider / 账户。
- inline SVG 只承担通用线性图标；`icon.png` 是为 pin-to-home-screen 准备的本地 512px 合成图标。
- `data-screen-label` 标识主要页面，数据全部合成；所有按钮通过事件委托驱动局部状态、sheet、toast 与路由。
- 方向/状态控制器位于手机画框外，通过左上角 Design controls 展开；窄屏隐藏该控制器，不侵入 app 正式页面。

## 测试路线与未验证

### 已做的静态检查

- 检查入口为单 HTML，含 mobile viewport、apple web app、safe-area、icon link；资源仅引用同目录 `icon.png`。
- 使用 Node `vm.Script` 对抽出的 inline script 做语法编译检查；用 Python 检查 HTML 必需标签与 `icon.png` 512 × 512；用 `git diff --check` 检查本目录文本。
- 使用 `record-asset.mjs` 登记入口后，确认生成的 `_d_meta.json` 状态为 `needs-review`（仅资产登记，不是视觉批准）。

### 当前未验证

- 子 agent 未做浏览器验证。主会话已启动仅绑定 loopback、仅服务本原型目录的 HTTP 预览，入口返回 200；调用 browser relay open 返回“browser relay 不可用”。因此没有截图、视觉像素、控制台错误或真实浏览器点击回放，不以 Node 测试冒充视觉验收。
- 未在真实 iPhone / Safari 主屏安装，未验证刘海 safe-area、系统键盘、动态字体、VoiceOver、横竖屏或深色模式。
- 未验证 SwiftUI、APNs、Mac 锁屏/睡眠、电源策略、蜂窝网络、托管中继、加密配对或任何真实 Provider；原型明确不代表这些能力已实现。
- 未执行真实文件保存冲突、终端输入或审批，只模拟其 UI 状态与禁止写入语义。
- 本稿暂未实现搜索/筛选、新任务完整创建与结果生命周期、Provider/Model 实际切换、完整文本编辑器、Quiet hours 选择，以及双主机项目导航。B 目前用于比较“主机上下文置顶”和 A 的任务优先级，不代表完整多主机产品流程。对应设置明确为 layout preview，不视为可用功能。

## 主会话回收修正与检查 · 2026-09-12

- 修复 sheet 内 stopPropagation 截断文档事件委托的问题；改为捕获阶段委托，空白 sheet 点击不误关，支持 Escape 关闭。
- 修复 Offline 下绿色 Connected/You control，持久展示停止待确认；重复审批保持 pending，过期请求先复核，不把拒绝发送当作 Provider 已收到。
- 任务标题/Provider/diff 随实际选中示例切换；输入文本转义，空任务/空消息验证；通知开关保留模拟状态。
- 补终端控制权确认与设备撤销示例；撤销不停止已有任务、切换 Offline 演示不能恢复已撤销权限。
- 将审批例子明确为独立项目 Hook trust，避免 Full access 下错误暗示普通命令一定触发原生审批。
- 源码采用 `prototype.test.cjs` 的 Node VM 最小 document/event 替身测试：**10 项通过**。它检查实际脚本模板/状态与事件处理器，不使用浏览器/DOM 布局引擎，不证明视觉和真实点击行为。
- 资源检查：仅引用本目录 `icon.png`，512 × 512；无 CDN。`git diff --check` 通过，HTML HTTP 入口 200。未构建产品 App。
- 验证命令：`node --test designs/scry-ios-remote/prototype.test.cjs`。
- 主入口 SHA-256：`4d6a4a8cc00fd5384592f3b960c20fca0e6b6d1eaecf7932fcf91cc54dd0bf4b`；状态 needs-review，用户尚未认可。
- 预览：`http://127.0.0.1:54396/Scry%20iOS%20Remote.html`（当前本机临时服务；不是公网地址，也不能直接用 iPhone 的 127.0.0.1 访问 Mac）。
