# TASK-20260731-run-controls-cache-agent-menu — 缓存模型目录并修复 Agent 菜单遮挡

> 本文档由 vibe-workflow 自动生成和维护，记录任务从摄入到交付的全过程。

## 基本信息

| 字段 | 值 |
|------|-----|
| 任务 | 避免每次打开会话都重新显示“读取模型”，并修复 Agent 下拉菜单重叠导致名称不可见 |
| 项目 | scry |
| 级别 | small |
| 开始时间 | 2026-07-31 10:59 CST |
| 状态 | 已完成 |

## 已否决方案与理由（持续追加，跨 Phase 不清空）

| # | 否决的方案 | 为什么否决（实测 / 约束 / 事故 / 成本） | 记录于 | 日期 |
|---|-----------|----------------------------------------|--------|------|
| 1 | 永久静态模型表 | Provider 原生目录会变化，且 effort 与具体模型绑定；会重新引入此前已否决的假状态 | P3 | 2026-07-31 |
| 2 | 只延长 main adapter 的 30 秒 TTL | renderer 仍会先清空 UI；同 Agent 重选时 effect 甚至不会重跑，无法解决永久“读取模型…” | P3 | 2026-07-31 |
| 3 | 让 Agent 菜单覆盖左侧栏 | 会遮挡会话导航且仍依赖不稳定的内容宽度；正确边界是从触发器向主区展开 | P3 | 2026-07-31 |

## Phase 3 · 代码 & CR 循环

- `src/renderer/hooks/useIntegrations.ts`
  - 重复选择同一 Agent 时不再清空已经可用的模型目录。
  - 增加按 `Provider + cwd` 隔离的 renderer 内存缓存；切回已加载的 Provider 时先同步恢复目录，再后台刷新。
  - 后台刷新失败时保留旧目录，不退回假定模型或重新阻塞选择器。
- `src/renderer/components/Pickers.tsx`、`src/renderer/styles.css`
  - Agent 菜单从触发器左边缘向主内容区展开，固定响应式宽度。
  - Agent 名称获得独立的弹性与截断边界，状态标记不再挤掉名称。
- `src/renderer/components/render.test.tsx`
  - 新增“同 Agent 不重置、跨 Provider 才重置”的回归测试。
- 本地 CR：逐段复核状态切换、缓存隔离、异步请求序号和菜单 CSS；未发现 blocker。

## Phase 4 · 验证

### L1 · 静态 oracle

- `npm run typecheck`：通过。
- `npm test`：647 passed，3 skipped；首次在受限沙箱内有 6 个 Unix socket 用例因 `EPERM` 失败，随后在允许本地 socket 的环境完整重跑通过。
- `npm run build`：通过，main/preload/renderer 生产构建成功。
- `git diff --check`：通过。

### L2 · 运行时 smoke

- 开发版 Electron 通过 `npm run dev -- --remoteDebuggingPort 9444` 启动，Provider 检测、历史会话、composer 与 Agent 菜单均正常。
- `npm run install:mac` 成功替换 `/Applications/Scry.app`。
- 完全退出旧进程后从 `/Applications` 冷启动新安装包成功，历史数据与 Provider 探测正常。

### L3 · 用户路径

- 同目录 Qoder 会话切换：首次目录加载后有 17 个选项；切换到另一个 Qoder 会话后，0ms、200ms 均保持“自动模型”、可操作。
- 跨 Agent：Qoder → Codex → Qoder，切回 Qoder 的第一帧即恢复 17 个选项，没有出现“读取模型…”。
- Agent 菜单：
  - 1280 宽开发窗口：菜单边界 `301–587px`，Claude Code / Codex / Qoder / OpenCode 名称全部可见。
  - 1024 宽开发窗口：菜单边界 `281–567px`，`body.scrollWidth === 1024`，四个名称均无裁切。
  - 新安装包冷启动后实点菜单，四个 Agent 名称完整可见。
- Browser Harness 录制：`/Users/baobingjiang/.config/browser-harness/agent-workspace/recordings/scry-cache-menu`（8 frames）。

## 交付摘要

- 模型目录现在采用 stale-while-revalidate：已读到的目录立即复用，后台继续刷新，不再每次切会话都阻塞交互。
- Agent 菜单改为向主内容区展开，并在窄窗中保持名称可读。
- 已重新安装并冷启动验收 `/Applications/Scry.app`。

## 复盘

- 根因不是 Provider 读取本身慢，而是 renderer 主动丢弃已知目录；同 Agent 重选时依赖又不变化，导致 effect 不再触发并永久停在 loading。
- 浮层的锚点方向必须由所在布局边界决定；位于主区左下角的触发器不应使用 `right: 0` 向侧栏扩张。
- 安装包验收必须确认旧进程彻底退出后再冷启动，否则可能把替换前的 renderer 误当成新构建。
