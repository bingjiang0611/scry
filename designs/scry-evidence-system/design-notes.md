# Scry Evidence System

## 目标

把获批的 Analytics 叙事质感扩展到 Scry 九个真实表面，同时保留桌面工作台的空间记忆和操作密度。统一的是证据语言，不是把所有页面改成长滚动海报。

本目录是结构仿真原型，不读取 Provider、SQLite、会话归档或本机配置。页面内所有数字均明确标注为示例数据。

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
| 总览 | 336px 证据档案 | Sticky tabs、一行判词、最多 2×2 metrics、轮次排名 |

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

- 顶部可切换九个表面、深浅主题和 `ready / partial / empty / error` 状态。
- Sidebar 和会话顶栏也可导航。
- Analytics 支持章节、日期和 Provider 高亮。
- Diagnostics、Graph、Segments 均支持 master/detail 选择。
- Chat 选择事件后，总览使用同一青色锚点。
- Skills 支持搜索和逐行 enable/pending/error 演示。
- MCP 支持测试、认证动作和 tools 展开。
- Modal 支持 Escape、点击遮罩、焦点循环与焦点恢复。

## 生产实现边界

该原型没有改动 `src/`。真实实现前必须先修正 Analytics Top-N 查询、Diagnostics MCP identity union、Segments coverage、Overview scope 与 danger capability 等语义问题；当前主工作树另有 OAuth/Provider 改动，因此后续实现应在该基线落盘后再分批迁移。
