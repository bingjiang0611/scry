# TASK-20260730-codepilot-workspace-editor — 对齐 CodePilot 0.62 工作区文件与 Markdown 编辑体验

> 本文档由 vibe-workflow 自动生成和维护，记录任务从摄入到交付的全过程。

## 基本信息

| 字段 | 值 |
|------|-----|
| 任务 | 在 Scry 中加入 CodePilot v0.62.0 的文件树管理、Markdown 单页 Live Preview 和输入框原生右键菜单 |
| 项目 | scry |
| 级别 | full |
| 开始时间 | 2026-07-30 22:57 CST |
| 状态 | 已完成 |

## 已否决方案与理由（持续追加，跨 Phase 不清空）

> 任何“考虑过但否决”的技术选择都记在这里，重点记录为什么否决。

| # | 否决的方案 | 为什么否决（实测 / 约束 / 事故 / 成本） | 记录于 | 日期 |
|---|-----------|----------------------------------------|--------|------|
| 1 | 把文件/目录扩展成 `AgentInputAttachment` | 会迫使四个 Provider adapter、历史 transcript 和图片渲染同时支持联合类型；可见 `@relative/path` 更小且可审计 | Phase 2 | 2026-07-30 |
| 2 | 在 renderer 直接使用 Node `fs` | 破坏 Electron 边界，无法集中做 cwd/symlink/Trash 安全门禁 | Phase 2 | 2026-07-30 |
| 3 | Trash 失败后永久删除 | 与“移入系统废纸篓，可恢复”的承诺冲突，危险且不可逆 | Phase 2 | 2026-07-30 |
| 4 | 首版自动保存 | Scry 没有跨 editor/tree owner 的 mutation coordinator；rename/delete 后延迟保存可能复活旧路径 | Phase 2 | 2026-07-30 |
| 5 | 只用 `mtimeMs` 做保存冲突检测 | 文件系统时间粒度可能漏掉同一时间片内的外部覆写；内容 revision 在 2 MiB 门禁内更可靠 | Phase 2 | 2026-07-30 |

## Phase 1 · 理解

- **Prior Art Check**: existing。Scry 已有图片附件（`src/renderer/App.tsx` / `src/main/index.ts`）、聊天 Markdown 渲染（`src/renderer/components/MarkdownImpl.tsx`）和会话删除右键菜单（`src/renderer/components/Sidebar.tsx`），但没有工作区文件 CRUD、文件编辑器或 Electron 原生输入菜单；本任务扩展既有链路，不并行新增第二套聊天/Markdown/侧栏系统。
- **调研核心结论**:
  - 文件系统侧：现有 IPC 只有选择目录、设置 cwd、剪贴板图片；新增文件 API 必须由 main 统一做真实路径边界、symlink 与 TOCTOU 防护。
  - Renderer 侧：cwd/会话切换由 `App.tsx` 协调；文件树应局部持有展开/刷新状态，文件预览复用右栏框架，避免树刷新带动整个对话流重渲染。
  - Markdown/菜单侧：现有 Markdown 仅聊天只读渲染，无 CodeMirror；composer 是受控 textarea，主进程没有原生 input context menu。
  - CodePilot v0.62.0 参考：文件树右栏、CodeMirror 6 decoration Live Preview、rename/delete 跨状态 owner transaction、系统 Trash fail-closed；明确不含多选、拖放、剪切粘贴、大目录虚拟化和外部 watcher。
- **充分性闸门**: verdict=pass。必备信息 7/7 已拿到：文件写入/读取两端、IPC/preload 公共契约、cwd 与右栏状态 owner、附件进入 Agent 请求的归一化/持久化链路、文件 mutation 安全边界、Markdown 当前依赖与性能边界、验证入口。二次检索补齐了 `normalizeAgentStartRequest`/provider attachment 链路，以及 overview/review 右栏互斥状态。
- **关键发现/疑点**: 用户没有进一步缩小截图范围，因此继续按 CodePilot v0.62.0 三项能力整套交付；实现应保持 Markdown 原文为唯一事实源，文件引用采用用户可见的 `@relative/path`，不扩张现有图片附件契约。

## Phase 2 · 方案

- **方案类型**: RFC
- **方案文件**: `docs/rfc/scry/codepilot-workspace-editor.md`
- **关键决策**: 右栏 workspace 模式；lazy file tree；main 侧 canonical path/symlink/Trash 门禁；文本手动保存 + SHA-256 revision 冲突保护；Markdown 同页编辑/预览；文件引用写成可见 `@relative/path`；Electron 原生 editable menu。
- **Critic 结果**: critic 两次运行均未在有界等待内返回，已终止空跑；主 agent 按同一清单完成兜底压测并采纳 4 个问题：IPC sender/逐分段 symlink 校验、所有离开动作统一 dirty guard、Agent turn 后树缓存失效、`mtimeMs` 改为内容 revision。无驳回项。
- **开放问题**: 无阻塞项；CodeMirror decoration Live Preview、相对图片、Mermaid/KaTeX 与大文档性能矩阵明确留给后续完全同构任务。

## Phase 3 · 代码 & CR 循环

- **实现范围**: 新增 shared workspace 契约、main 文件安全层、6 个精确 preload API、Electron 原生编辑菜单、右栏 lazy 文件树、CRUD/Trash、自定义管理菜单、文本编辑器、Markdown 同页预览、composer 路径引用、dirty guard 与响应式样式。
- **安全边界**: 相对路径/canonical cwd/逐分段 symlink 校验；保护目录大小写不敏感；文件 2 MiB 与目录 2,000 项门禁；二进制及无效 UTF-8 拒绝编辑；SHA-256 revision 阻止覆盖外部修改；删除只走 `shell.trashItem`。
- **CR Round 1**: 发现并修复 7 项：带空格引用重复插入、节点菜单冒泡、异步树/文件旧响应覆盖新状态、保护目录大小写绕过、折叠 workspace 无法一键恢复、Agent 完成触发重复初始请求、菜单贴边溢出及搜索框与自定义菜单冲突。blocker/major 归零。
- **CR Round 2**: 发现并修复 2 项：无效 UTF-8 被替换字符吞掉导致潜在保存破坏、筛选命中子文件时父目录被隐藏。补回归测试后自审未发现剩余 blocker/major。
- **静态验证**: `npm run typecheck` 通过；定向 121/121 通过；全量 60 个测试文件通过、3 个跳过，共 631/631 已执行测试通过；`npm run build` 通过；`git diff --check` 通过。

## Phase 4 · 验证

- **L1 静态 oracle**:
  - `npm run typecheck` 通过（node + web）。
  - 定向测试 121/121 通过；全量测试 60 个文件通过、3 个跳过，共 631/631 个已执行测试通过。
  - `npm run build` 通过；`git diff --check` 通过。
- **L2 运行时 smoke**:
  - 启动真实 Electron 开发构建，独立 bundle id / user data 隔离既有 Scry 实例。
  - 窗口正常启动，workspace preload 六个 API 均存在；主界面、右栏与 overview 切换无崩溃、无 ErrorBoundary。
- **L3 端到端用户路径**:
  - 通过 macOS 原生目录选择器打开 Scry 仓库，右栏树正确隐藏受保护目录。
  - 经 UI 新建 Markdown 文件，完成源文编辑、同页实时预览与手动保存；制造 dirty 状态后验证离开确认和 reload 放弃确认。
  - 验证编辑器与 composer 的 Electron 原生右键菜单。
  - 经文件菜单验证加入对话（可见 `@relative/path`）、重命名及“移入系统废纸篓”；临时验收文件已从工作区移除，可从 Finder 废纸篓恢复。
  - 展开 `src/renderer/components` 并搜索 `WorkspacePanel`，筛选保留父目录链；关闭再打开文件栏后 620px 宽度恢复。
  - CDP 分别在 1280×838 和 1024×768 检查布局，窄屏右栏正确覆盖主区，页面无水平溢出，树节点展开态 ARIA 正确。
- **未覆盖 / 残余风险**:
  - 本次没有发送真实 Provider 请求；文件引用的首版契约是用户可见文本，不改变 Provider attachment。
  - 未实现且未宣称 CodePilot 的 CodeMirror decoration、自动保存、相对图片、Mermaid/KaTeX 与大目录虚拟化。

## 交付摘要

- **最终状态**: 完成。
- **完成时间**: 2026-07-30 23:53 CST。
- **交付内容**: 安全 workspace 文件服务、右栏文件树与 CRUD/Trash、同页 Markdown 编辑预览、聊天路径引用、dirty guard、原生输入菜单、响应式与宽度持久化。
- **Commit**: 本次交付提交（最终 hash 见 Git 历史）。
- **总耗时**: 约 56 分钟。

## 复盘

- **最耗时的低效环节**: macOS 把两个相同 bundle id 的 Electron 开发实例归并，Computer Use 初次命中了旧窗口；复制 Electron App、修改临时 bundle id 并使用独立 user data 后才稳定完成 L3。
- **未产生价值的尝试**: critic 两次在有界等待内都没有返回结果，主 agent 按 RFC 清单自审完成兜底。
- **可复用教训**: 多个 Electron 开发实例并存时，GUI 验收不能只靠窗口标题；需要唯一 bundle id、完整 app path 和独立调试端口共同隔离。
- **待用户反馈**: 交付后的直接体验、最不满意点及希望下次默认保留/删减的流程，收到后再决定是否沉淀为长期偏好。
