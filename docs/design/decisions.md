# Scry 设计决策记录

本文件是带日期决策的导航入口。规范见 [DESIGN.md](../../DESIGN.md)；历史数值、截图结论和验证结果只对当时版本成立，后续改动不自动继承。原始记录按职责完整移入同目录文档，各主题内按时间顺序排列。

- [设计系统地基与迁移](decisions-foundations.md)
- [组件、浮层与反馈](decisions-components-overlays.md)
- [证据呈现与工作区](decisions-evidence-workspace.md)

本次工作区可读性、密度与统计脚注修正的三轮评审、评分和最终验证，统一见 [工作区 UI hill-climb](workspace-ui-hill-climb.md)。

## 输入框权限菜单只显示选项名称（2026-11-21）

权限说明移到悬停提示和无障碍描述，避免长文案溢出菜单；保留警告图标和选中标记，不改变授权行为。组件回归覆盖可见文字和说明；在 Chrome 中用实际组件确认深浅主题下可打开菜单、选择权限。

以下保留历史标题入口，兼容原有章节链接；正文仅保存在对应主题文件。

## 设计系统初版提取与真机抽查（2026-10-21）

[查看原始记录](decisions-foundations.md#设计系统初版提取与真机抽查2026-10-21)。

### 可复用实现的验证（2026-10-21）

[查看原始记录](decisions-foundations.md#可复用实现的验证2026-10-21)。

## 侧栏「动态」的加强（2026-10-21）

[查看原始记录](decisions-evidence-workspace.md#侧栏动态的加强2026-10-21)。

## 总览证据块：横向刻度（2026-10-22）

[查看原始记录](decisions-evidence-workspace.md#总览证据块横向刻度2026-10-22)。

## 已回答问答块：台账式记录（2026-10-23）

[查看原始记录](decisions-evidence-workspace.md#已回答问答块台账式记录2026-10-23)。

## 设计系统地基：尺度 token 与债务棘轮（2026-11-15）

[查看原始记录](decisions-foundations.md#设计系统地基尺度-token-与债务棘轮2026-11-15)。

## 按钮收敛：Button 与 IconButton（2026-11-15）

[查看原始记录](decisions-components-overlays.md#按钮收敛button-与-iconbutton2026-11-15)。

## 通知与标签页收敛：Notice、Tabs、Segmented（2026-11-15）

[查看原始记录](decisions-components-overlays.md#通知与标签页收敛noticetabssegmented2026-11-15)。

## 侧栏：字号与间距清零（2026-11-15）

[查看原始记录](decisions-evidence-workspace.md#侧栏字号与间距清零2026-11-15)。

## 对话与工具证据：字号、间距与颜色清零（2026-11-15）

[查看原始记录](decisions-evidence-workspace.md#对话与工具证据字号间距与颜色清零2026-11-15)。

## 输入框、总览、设置与清单、分析视图与其余界面：全局清零（2026-11-15）

[查看原始记录](decisions-foundations.md#输入框总览设置与清单分析视图与其余界面全局清零2026-11-15)。

### 两个中途发现并修正的问题

[查看原始记录](decisions-foundations.md#两个中途发现并修正的问题)。

## PR CI 发现的两处行为回归（2026-11-15）

[查看原始记录](decisions-foundations.md#pr-ci-发现的两处行为回归2026-11-15)。

## 浮层层级 token（2026-11-16）

[查看原始记录](decisions-components-overlays.md#浮层层级-token2026-11-16)。

## 菜单 primitive（2026-11-16）

[查看原始记录](decisions-components-overlays.md#菜单-primitive2026-11-16)。

## 不做通用 toast，Meta Prompts 改为就近反馈（2026-11-16）

[查看原始记录](decisions-components-overlays.md#不做通用-toastmeta-prompts-改为就近反馈2026-11-16)。

## 后台通知（2026-11-16）

[查看原始记录](decisions-components-overlays.md#后台通知2026-11-16)。

## 工作区可读性与密度：第 1 轮评审修正（2026-11-16）

[查看原始记录](decisions-evidence-workspace.md#工作区可读性与密度第-1-轮评审修正2026-11-16)。

## 统计脚注减重：第 2 轮评审修正（2026-11-16）

[查看原始记录](decisions-evidence-workspace.md#统计脚注减重第-2-轮评审修正2026-11-16)。

## Antigravity 菜单与回复减重（2026-11-21）

Provider 菜单只显示 Antigravity 名称，不把未知的账号标识当成登录状态，也不常驻条款或进程说明。对话不再展开用户级规则清单；权限检查、实际工具放行来源和 MCP 信任风险不变。验证：渲染测试覆盖历史规则元数据不显示；Electron Provider 菜单 smoke 验证名称、图标及原有选择和焦点行为。

## 新建会话不等目录刷新（2026-11-21）

空会话在本机确认重置后即可发送，命令和技能目录随后刷新；打开已有会话仍等历史确认。Electron loading smoke 暂停目录刷新，验证新会话的发送按钮已可用。
