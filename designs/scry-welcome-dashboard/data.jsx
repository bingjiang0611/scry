// 真实探测值：取自本机 Scry 0.2.44 冷启动 welcome（reference-current-welcome.png）。
// 原型不连 Provider，不新增任何看似真实的业务状态；未捕获字段一律标「未知 / 运行后采集」。

const PROVIDERS = [
  {
    id: 'claude',
    name: 'Claude Code',
    path: '/Users/baobingjiang/.local/bin/claude',
    short: '~/.local/bin/claude',
    version: '2.1.216',
    transport: 'Agent SDK',
    state: 'available'
  },
  {
    id: 'codex',
    name: 'Codex',
    path: '/Applications/ChatGPT.app/Contents/Resources/codex',
    short: 'ChatGPT.app/…/codex',
    version: '26.803.41515 (app)',
    transport: 'app-server',
    state: 'available'
  },
  {
    id: 'qoder',
    name: 'Qoder',
    path: '/Users/baobingjiang/.nvm/versions/node/v24.18.0/bin/qodercli',
    short: '~/.nvm/…/bin/qodercli',
    version: '1.1.16',
    transport: 'Qoder Agent SDK',
    state: 'available'
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    path: '/Users/baobingjiang/.opencode/bin/opencode',
    short: '~/.opencode/bin/opencode',
    version: '1.17.18',
    transport: 'server SDK',
    state: 'available'
  }
];

// 实现里的真实文案（ChatView.tsx providerReadiness / composer placeholder / WorkdirPicker）。
const READINESS = {
  tone: 'ok',
  summary: '4/4 个 Provider 可用',
  detail: '本机可执行文件已确认；账号与用量状态在运行后采集'
};

// 重新扫描中：已知的 agents 不会消失，只是版本信息在补齐——
// 文案取 ChatView.tsx 的 agentScanning 分支，不伪造“重新发现”的假结果。
const READINESS_SCANNING = {
  tone: 'ok',
  summary: '4/4 个 Provider 可用',
  detail: '已发现本机可执行文件；正在补齐版本信息'
};

const BOUND_PROJECT = {
  name: 'vibecoding',
  path: '/Users/baobingjiang/IdeaProjects/vibecoding'
};

// 本机真实存在的工作目录（聚合壳 + 三个子项目）。
// 只放名字与完整路径——会话数、最后使用时间这类字段原型拿不到，就不编。
const PROJECTS = [
  BOUND_PROJECT,
  { name: 'Nib', path: '/Users/baobingjiang/IdeaProjects/vibecoding/Nib' },
  { name: 'scry', path: '/Users/baobingjiang/IdeaProjects/vibecoding/scry' },
  { name: 'etch', path: '/Users/baobingjiang/IdeaProjects/vibecoding/etch' }
];

const RUN_CONTROLS = {
  model: '自动模型',
  permission: '默认审批'
};

const WELCOME_COPY = {
  unbound: '可直接发起任务；需要读写项目文件时再选择工作目录，执行证据默认保留在本机。',
  // 已绑定态的项目名由下方上下文条讲（含完整路径），副文案不再重复一遍。
  bound: '核对 Provider、权限与模型后即可输入任务，执行证据默认保留在本机。'
};

Object.assign(window, {
  PROVIDERS,
  READINESS,
  READINESS_SCANNING,
  BOUND_PROJECT,
  PROJECTS,
  RUN_CONTROLS,
  WELCOME_COPY
});
