const surfaceCatalog = [
  { id: "overview", label: "纵览", description: "查看当前会话的结论、调用与证据。", icon: "overview", available: true },
  { id: "files", label: "文件", description: "浏览、阅读并引用工作区文件。", icon: "files", available: true },
  { id: "diff", label: "Diff", description: "审阅当前任务产生的代码改动。", icon: "diff", available: true },
  { id: "terminal", label: "终端", description: "在当前工作区启动本地 shell。", icon: "terminal", available: "concept" },
  { id: "agents", label: "Agent", description: "观察子 Agent、等待与工作流。", icon: "agents", available: true }
];

const projectGroups = [
  { name: "scry", count: 3, open: true, sessions: [
    { title: "优化右侧 Surface 工作区", meta: "Codex · 现在", active: true, running: true },
    { title: "Evidence System 语义验收", meta: "Claude · 2h", active: false },
    { title: "四 Provider 回归", meta: "Qoder · 昨天", active: false }
  ]},
  { name: "etch", count: 2, open: false, sessions: [] }
];

const fileTree = [
  { depth: 0, name: "src", type: "folder", open: true },
  { depth: 1, name: "renderer", type: "folder", open: true },
  { depth: 2, name: "components", type: "folder", open: true },
  { depth: 3, name: "OverviewPanel.tsx", type: "file" },
  { depth: 3, name: "WorkspacePanel.tsx", type: "file" },
  { depth: 3, name: "TurnDiffReviewPanel.tsx", type: "file" },
  { depth: 2, name: "styles.css", type: "file" },
  { depth: 0, name: "CLAUDE.md", type: "file" }
];

const diffFiles = [
  { name: "App.tsx", path: "src/renderer/App.tsx", add: 38, del: 19 },
  { name: "RightSurfacePanel.tsx", path: "src/renderer/components/RightSurfacePanel.tsx", add: 214, del: 0 },
  { name: "styles.css", path: "src/renderer/styles.css", add: 96, del: 42 }
];

Object.assign(window, { surfaceCatalog, projectGroups, fileTree, diffFiles });
