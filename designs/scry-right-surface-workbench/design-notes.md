# Scry Right Surface Workbench

## 范围

- 只优化 Scry 右侧面板，不重做左侧会话导航与主对话流。
- 把现有 `OverviewPanel`、`WorkspacePanel`、`TurnDiffReviewPanel` 从互斥模式收敛到统一 Surface 容器。
- 终端来自用户提供的 t3code 截图，是本稿唯一概念能力；生产实现前必须新增 PTY 生命周期、权限边界、shell 环境隔离与恢复策略。
- 不加入 Browser Surface：Scry 的产品身份是本地 Agent 观测与治理，本轮没有足够理由引入浏览器运行时。

## 设计系统

- 完全复用 Scry 现有 `src/renderer/styles.css` 的深浅主题语义 token、三栏工作台密度、mono 证据层与青色选择锚点。
- t3code 只提供信息架构参考：Surface 空状态、标签页、添加菜单、最大化、关闭与终端容器。
- 高频 tab 切换即时完成；只给菜单进入和按钮按压 120–160ms 反馈，并尊重 `prefers-reduced-motion`。

## 关键变化

| Before | After | Why |
| --- | --- | --- |
| `rightPanelMode` 在 `overview / review / workspace` 三者间互斥 | 一个 Surface 容器管理 `纵览 / 文件 / Diff / 终端 / Agent` | 用户保留上下文，不必在模式切换时丢失选择和滚动位置 |
| 每个右栏都有不同标题栏和关闭方式 | 统一标签栏、添加、最大化和隐藏控制 | 降低重新识别成本，后续新增 Surface 不再复制壳层 |
| 打开右栏直接进入固定内容 | 可关闭到明确的“打开 Surface”空状态 | 让右栏是用户选择的工作区，而非永久占位的信息墙 |
| 纵览承载所有内容入口 | 纵览只解释当前会话；文件、Diff、Agent 各自独立 | 保持 Scry 的证据语义边界，避免把工具面板混成仪表盘 |
| 终端能力不存在 | 原型可预览，但始终显示“概念 Surface / 需要 PTY 后端” | 不把设计模拟伪装成已经可用的产品能力 |

## 核心路径

1. 点击标签切换已打开的 Surface。
2. 点击标签图标处关闭；关闭全部后进入 Surface 选择空状态。
3. 点击 `+` 从菜单添加或激活 Surface。
4. 最大化右栏时保留左侧会话导航，隐藏主对话区；恢复后回到三栏。
5. 隐藏右栏后，从主顶栏右侧按钮重新打开。
6. 文件筛选和选择、Diff 文件选择、终端清屏、主题切换均可交互。

## 语义声明

原型中的会话数字明确标为“示例数据”，不连接 Scry IPC、Provider、SQLite 或真实 PTY。生产迁移时必须继续遵守 `CLAUDE.md` 的 `exact / trueZero / partial / unknown / unsupported` 语义，不能把缺失字段补成 0。

## 参考来源

- Scry：`src/renderer/components/OverviewPanel.tsx`、`WorkspacePanel.tsx`、`TurnDiffReviewPanel.tsx`、`AppShell.tsx`、`styles.css`、`session-evidence.css`
- t3code：[pingdotgg/t3code](https://github.com/pingdotgg/t3code)，重点参考 `apps/web/src/components/RightPanelTabs.tsx` 与 `apps/web/src/components/chat/PanelLayoutControls.tsx`
- 用户截图：`assets/t3code-surface-empty.png`、`assets/t3code-terminal.png`
