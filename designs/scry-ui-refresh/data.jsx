const scryPrototypeData = {
  projects: [
    {
      id: 'unbound',
      name: '不绑定项目',
      path: '未关联工作目录',
      sessions: [
        { id: 'external', provider: 'qoder', title: 'https://code.alibaba…', age: '18h', tone: 'muted' }
      ]
    },
    {
      id: 'treehouse',
      name: 'rate-native',
      path: '~/.treehouse/rate-native-3b0c3e/6/rate-native',
      sessions: [
        { id: 'hello', provider: 'claude', title: 'hello', age: '6d', tone: 'claude' },
        { id: 'workflow', provider: 'qoder', title: '/rate-native-rate-workflow 84441887', age: '1w', tone: 'qoder' },
        { id: 'question', provider: 'qoder', title: '修复验证是否通过？', age: '1w', tone: 'qoder' }
      ]
    },
    {
      id: 'local',
      name: 'rate-native',
      path: '~/IdeaProjects/rate-native',
      sessions: [
        { id: 'ok-1', provider: 'codex', title: '只回复 OK，不读文件…', age: '7d', tone: 'codex' },
        { id: 'ok-2', provider: 'codex', title: '只回复 OK，不读文件…', age: '7d', tone: 'codex' }
      ]
    }
  ],
  assistant: {
    intro: '你好！有什么可以帮你的吗？',
    lead: '我看到你这是在 rate-native 聚合工作区里（treehouse worktree），可以做的事情很多，比如：',
    bullets: [
      ['需求交付', '从 Aone 工单/钉钉文档摄入到代码交付的端到端流程', 'rate-workflow'],
      ['查业务知识', '评价业务规则、链路、接口协议', 'rate-doc'],
      ['代码 / 分支 / CR', '切分支、建变更、发二方包、部署预发、代码评审', ''],
      ['前端', 'rate-list / rate-detail 等页面改动、真机自测、设计稿转代码', ''],
      ['配置查改', 'Switch / Diamond 线上值查询与发布', 'ali-config']
    ],
    outro: '几个 MCP 服务当前未授权。本会话是非交互模式，相关能力在授权前不可用。'
  },
  metrics: {
    contextUsed: '40.6k',
    contextWindow: '1000.0k',
    contextPercent: 4,
    totalTokens: '41.1k',
    input: 2,
    output: 416,
    cacheWrite: '40.6k',
    duration: '37.5s',
    api: '10.8s',
    calls: 0,
    hooks: 7,
    danger: 0
  }
}

Object.assign(window, { scryPrototypeData })
