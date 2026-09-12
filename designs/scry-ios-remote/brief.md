# Scry iOS Remote 设计 brief · 2026-09-12

## D-20260912-scry-ios-remote

- Scope：`/Users/baobingjiang/IdeaProjects/vibecoding/scry`，独立 HTML 高保真交互原型。
- Status：需求已确认；视觉方案 candidate，尚未获用户认可。
- Feedback：用户要求“让子agent负责设计一份设计稿”；不要求实现 SwiftUI 或真实远程功能。
- Authority：产品约束见 `docs/research/scry-ios-remote-research.md`，协议与状态语义见 `docs/research/scry-ios-remote-technical-plan.md`。

## 目标

用户离开电脑后，在 iPhone 上查看和继续自己的开发任务，处理阻塞、审阅改动，并在需要时操作文件和终端。默认优先“接下来需要我做什么”，不把手机做成桌面三栏缩略图或服务器监控大屏。

## 硬约束 H

- H1：仅 iOS，公开发布、海外优先兼顾大陆。设计稿用英文产品文案＋中文设计说明；这是原型默认，不是已批准语言策略。
- H2：Mac 锁屏/熄屏且系统醒着、Scry 仍运行时可工作；睡眠/退出 App 显示离线，不显示误导的绿色正常。
- H3：owner-device 最大功能权限，包含任务、文件、受管理终端和可远程 trust 审批。Full access 不等于 root 或跳过设备/指纹授权。
- H4：首发后台提醒；通知是进入任务的入口，不是执行成功或批准证明。
- H5：Provider 差异显式；停止已请求≠停止已确认；缺少 cost/token 不显示零；连接中断时保留缓存但禁止发送/批准，不自动重试。
- H6：只允许本目录文件改动。不得修改生产 src、scripts、package、既有设计目录、技术方案、运行时目录；不得启动真实 App/Provider、执行 shell 命令功能或连接真实账户。
- H7：全合成内容，原型明确标注 Interactive prototype / sample data；示例 Mac/项目为 Studio Mac / storefront，不复制参考截图内私人业务文本或地址。

## 可协商视觉方向 S

- S1：沿用 Scry 的克制浅色、细分割、深灰正文、小面积蓝色操作与琥珀色待处理状态；不要营销渐变、过量卡片或常驻技术小字。颜色为本稿候选，不升级为全局偏好。
- S2：iOS 单手操作、底部主导航、原生感 sheet 与清晰返回关系；44pt 左右触控目标，核心正文 15–17px。
- S3：突出运行→待处理→审阅→继续的任务路径；完整权限保留可见入口，不代表所有管理开关都铺在首页。

## 一份原型、两个信息结构候选

在同一个可交互原型中提供外部/可收起的设计控制器（不占手机正式界面）：

- A · Tasks first（主推荐）：跨已连接电脑的任务列表，顶部当前范围，Needs attention 紧凑置顶；点任务进入会话，Machines 独立 tab。
- B · Machine first：先选电脑→项目→任务；沿用相同内容、视觉和详情交互，比较额外层级与跨机切换成本。
- 不做两套仅换色的稿。详情页可共用，一份设计稿足够；用户选择方向后才允许生产集成。

## 应有画面与轻交互

1. 任务首页：运行、待审批、已完成；按状态筛选/搜索；新任务。
2. 会话：消息、紧凑工具活动、变更摘要；Provider/Model/Full access sheet；发送合成后续消息、请求停止→待确认示例。
3. 审批 sheet：明确命令/作用域/目标主机，批准/拒绝；指纹变化示例应重新确认。手机断连不可批准。
4. Changes / 文件：查看 diff，文件列表和只读/编辑入口；可模拟编辑保存冲突，不需完整 IDE。
5. Terminal：受管理 shell 输出、输入框与控制权；桌面占用时显示 Take control 确认，不混入两端输入；完全不执行真实命令。
6. Machines / Pair：扫码配对分步示意（无相机或网络实际请求），Mac locked + awake / offline / revoked 等状态；最大权限确认与可撤销设备。
7. Settings：后台提醒、保持 Mac 唤醒说明、设备访问；不需要付费墙或账号营销首页。

桌面视口用约 390×844 的手机画框；手机宽度 full-bleed、safe-area、无伪造 9:41/电量/动态岛/虚拟键盘。状态控制器可测试 offline/approval-stale/empty/long-content。演示流程不使用 alert() 冒充完成。

## 参考与复用（主会话已实际读取）

- P-SCRY-COMPOSER：`designs/scry-composer-refresh/preview-v4.png` 与 `_d_meta.json`。观察到独立项目上下文、简洁输入容器、Provider/Model 次级设置和明确完全访问；该版本 needs-review，且有用户 WIP。借信息层级，不照搬桌面大输入框，不复制业务文案或改原文件。
- R-local-scry-light：`designs/scry-ui-refresh/reference-current-light.png`（旧桌面截图，非当前版本验收）；浅色、细分割、蓝色操作与会话/证据分区。借视觉节制，不复制三栏、token 仪表盘与私人文本。源码 tokens：`designs/scry-ui-refresh/prototype.css`。没有已绑定的 native DS。
- D-20260910-qoder-background-work：`designs/scry-background-work/brief.md`；需求强调紧凑任务行、停止回执不当作终态、quiet/unknown 显式。属于行为参考，不是移动端视觉认可。
- T3/Codex 公开功能资料已在研究文档中检索；本次未实操其 iOS，也未把营销/文字资料当成实际移动截图。
- 图片只供本机只读参考，不能复制私人截图到新目录或公开原型。

## 制作与验收分工

- 子 agent：依据此 brief 完成视觉构思和 HTML/样式/模拟交互、设计说明、静态自检；只在 `designs/scry-ios-remote/` 写入，不提交、不起服务、不驱动浏览器、不写全局设计库。
- 主会话：收回后审查 diff、实际 browser relay 预览与关键交互，登记资产与设计库、只提交本次文件。子 agent 无 browser 能力时不得声称已视觉验证。
- 产物：`Scry iOS Remote.html`（入口）、本地必要 assets、`research.md`、`design-notes.md`。可采用本地 React bundle，多文件自包含，不依赖外部 CDN；优先复用已存在 vendor 并先核对路径/许可证。元数据通过 baoyu `record-asset.mjs`，状态 needs-review。
- 验收分开：源码/静态检查；浏览器视觉/点击；真实 iPhone/SwiftUI/APNs 均未验证；用户视觉认可待确认。

## 沉淀

本文件为本任务项目需求与后续验收的权威入口，完成后注册到 design-loop 本机索引。不新增全局审美规则，不宣称产物 approved。

## 当前交付回执 · 2026-09-12

- 子 agent 已交付 `Scry iOS Remote.html`，主会话完成事件路由、离线/停止/审批、终端控制权与设备撤销等源码修正。
- 合成事件/状态测试 `node --test designs/scry-ios-remote/prototype.test.cjs`：10 项通过；本地 HTML 返回 HTTP 200；资源与 JS 语法检查通过。
- 浏览器 relay 不可用：未做真实浏览器点击、截图/布局或 console 验证；未做 iPhone/SwiftUI/APNs 验收。
- 当前 SHA-256：`4d6a4a8cc00fd5384592f3b960c20fca0e6b6d1eaecf7932fcf91cc54dd0bf4b`。成品 needs-review，未获用户视觉认可。
- 详情与明确未完成的搜索/完整编辑器/Provider 选择等交互见 `design-notes.md`，不把模拟原型称为实际产品。
- 下一步：用户查看本机预览，恢复 browser relay 后做目视/点击检查，再根据选定方向修订；不直接接入生产。
