# Scry Evidence System

## 目标

把获批的 Analytics 叙事质感扩展到 Scry 九个真实表面，同时保留桌面工作台的空间记忆和操作密度。统一的是证据语言，不是把所有页面改成长滚动海报。

本目录现在是可验收的只读真实数据原型。`live-server.mjs` 仅监听 `127.0.0.1`，通过 Node 22 内置 `node:sqlite` 读取本机 Scry SQLite v8，并用 trace archive 补足 SQLite 不保存的用户 / Assistant 正文与工具明细。数据桥不可用时才回退到结构仿真，页面会明确显示 `FALLBACK`，不会把缺失值补成 0。

SQLite 与 archive 都不保存 Provider 当前运行态、MCP 认证、配置开关或完整 Skill inventory；这些字段在 live 模式保持“未知 / 未支持”。MCP 与 Skill 页面只表达当前会话真实观测到的调用证据，不把历史调用写成“当前已连接 / 已启用”。

## 九表面映射

| 表面 | 形态 | 设计重点 |
| --- | --- | --- |
| 分析 | 四章叙事证据页 | 近 30 天、覆盖、操作、风险；仅此页使用超大 story number |
| 诊断 | Verdict + master/detail | 先给处置结论，再给时间化证据与下一步 |
| 技能 | 全局 modal 账本 | Provider + cwd 上下文、project/user scope、逐行提交状态 |
| 欢迎页 | 本地就绪场 | Provider readiness、权限、最近项目、一个主 composer |
| MCP | Fleet modal | 配置、runtime、单测、认证四列绝不混为一个“状态” |
| 对话 | 稳定执行时间线 | 结论优先、调用和文件降为轻证据带、选中锚点跨面板一致 |
| 拓扑 | Session wall + inspector | 固定泳道与几何，选择只改变强调，不引发布局重排 |
| 分段 | Ribbon + ledger | Ribbon 只编码 duration；Token/API coverage 在账本说明 |
| 总览 | 360–400px 证据档案 | Sticky tabs、一行判词、最多 2×2 metrics、轮次排名 |

## 状态契约

- `exact`：完整可证明值。
- `trueZero`：查询或观测完整后得到的真实 0。
- `partial` / `lowerBound`：只显示已知下界，使用 `≥` 与斜纹。
- `unknown`：缺少证据，显示 `—`，不可换算为 0。
- `unsupported`：能力不存在，不可解释为关闭、正常或安全。
- `pending` / `running`：尚未收敛，不提前绘制成功态。
- danger audit 表达“观测并放行”，不声称阻止。

## 视觉系统

- Sans 负责结论与阅读，mono 负责范围、坐标、来源和机器状态。
- 青色 `--selected` 只表示当前选择；Provider 使用固定类别色；ok/warn/bad 只表达状态。
- 主要分区依赖留白和 hairline，不依赖圆角卡片墙。
- 深浅主题共享同一语义 token。
- 高频导航、composer、列表切换保持即时；只保留 140–180ms 的 hover/press 反馈，并尊重 `prefers-reduced-motion`。

## 原型交互

- 顶部可切换九个表面、真实会话、深浅主题和 `ready / partial / empty / error` 展示状态，并可刷新本机只读快照。
- Sidebar 和会话顶栏也可导航。
- Analytics 支持章节、日期和 Provider 高亮。
- Diagnostics、Graph、Segments 均支持 master/detail 选择。
- Chat 选择事件后，总览使用同一青色锚点。
- Skills 在 live 模式支持搜索真实调用证据，配置状态保持只读未知；结构仿真降级态才保留 enable/pending/error 演示。
- MCP 在 live 模式展示真实调用与 tools 展开；运行态、测试、认证未落库时动作禁用并标未知。
- Modal 支持 Escape、点击遮罩、焦点循环与焦点恢复。

## 生产实现边界

该原型没有改动 `src/`，`live-server.mjs` 只用于本机设计验收，不是新的生产数据通道。迁移到产品时应复用现有 preload / IPC 和 Provider adapter，并保持本稿已经验证的语义：SQLite 是账本、archive 是 transcript 补充、unknown 不等于 0、unsupported 不等于 safe、历史调用不等于当前连接。

## D-20261009-scry-overview-density · 总览间距修复

- Scope / status：Scry 总览；用户需求 confirmed，生产改动待用户视觉验收，不升级为全局密度偏好。
- Feedback：2026-10-09 当前用户截图与“优化下这块ui 空白太多了”；原始路径是总览 → 上下文/指标 → 会话 → 轮次数据。
- Rule / reason：紧凑侧栏避免标题、滚动区、卡片、分组的 padding/margin 累加；优先消除重复内缩，不缩小字体、不隐藏证据。复用现有 `OverviewPanel`、2×2 指标卡、主题 tokens；未创建新组件或数据通道。
- Applied：`src/renderer/codex-alignment.css` 的总览样式：标题栏实测 72→44px，滚动区横向内缩归子分组所有，卡片移除重复内边距，分组标题和会话行收紧，数据 tabs 上间距 16→8px。保持 unknown/partial 文案、数值等宽字形与原生按钮焦点路径。依据为本次渲染对比和项目密度合同；不是 Craft 的统一间距规则。
- Evidence：同一隔离 Electron fixture 的 380px 深色截图，首条轮次卡从约 604px 上移至 442px（截图暂存 `/tmp/scry-overview-before.png`、`/tmp/scry-overview-after.png`，不是永久资产）。深浅主题 × 340/380/535px，无横向溢出；鼠标切换会话数据、Shift+Tab/Enter 返回轮次数据通过。新增 `--overview-only` focused 入口，默认 UI gate 同时覆盖。
- Regression：修改前新增检查在旧样式上因 72px 标题栏、22px 上下文空隙失败。新增 fixture 首次执行有插值变量错误；键盘模拟随后补齐原生 char 事件。卡片高度随内容变化，验收锚点使用首条卡片顶部而非底部；窄幅换行实测 450.1px，顶部上限 460px 仅适用于该 fixture，不限制真实长文案。
- Checks：`render.test.tsx` 231 项、typecheck、build、完整 `test:renderer:ui`（含 Credits）通过。未安装/替换运行中的 `/Applications/Scry.app`，未在原截图的真实 Provider 会话重放；组件渲染不等于完整 App 验收。
- Next use：总览首屏只能看见摘要、轮次掉到屏外 → 检查实际 CSS 加载顺序与复合间距 → 在相同 fixture 上比较卡片起点，保留原字体、未知状态与鼠标/键盘操作。
