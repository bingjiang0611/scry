// Prototype-only copy and fictional sample conversations. No product state is read.
window.draftCopy = {
  title: 'Scry · 会话草稿设计稿',
  eyebrow: 'SCRY / DESIGN PREVIEW',
  heading: '切走了，草稿仍有迹可循。',
  variants: [
    { id: 'a', label: 'A · 标题前标记', recommendation: '推荐 A', rationale: '草稿紧邻标题；时间、未读与运行状态保留原位。无需弹窗，点回会话继续写。' },
    { id: 'b', label: 'B · 右侧标签', recommendation: '备选 B', rationale: '标题起点一致，草稿集中在右侧；代价是时间和运行状态一侧更拥挤。' }
  ],
  light: '浅色预览',
  dark: '深色预览',
  projects: '项目',
  settings: '设置',
  local: '本机',
  draft: '草稿',
  running: '正在运行',
  unread: '有新结果，未查看',
  editor: '消息输入框',
  placeholder: '继续这个会话…',
  permission: '本机完全访问',
  provider: 'Pi',
  model: 'GPT-6.1 Sol · 默认',
  send: '模拟发送',
  simulation: '示例交互 · 不连接 Agent，不保存到真实会话',
  tryIt: '试试：输入 → 切换会话 → 点回继续；清空或模拟发送后标记消失。',
  sampleUser: '帮我检查一下这次改动，先给出结论。',
  sampleAssistant: '已检查相关改动。接下来可以继续核对边界情况，或补充需要验证的场景。',
  sampleUsage: 'in 3.2k   out 1.9k   dur 57.5s   tools 1',
  sent: '消息已在设计稿中模拟发送。',
  sessionLabel: (session, hasDraft) => `${session.title}${hasDraft ? '，有草稿' : ''}${session.running ? '，正在运行' : ''}`,
  groups: [
    { name: 'dev-agent', sessions: [
      { id: 'paper', title: '看下这篇论文：https://arxiv.org/abs/2601.01234', time: '1m', running: true, input: '' },
      { id: 'project', title: '了解下这个项目', time: '1m', running: false, input: '' },
      { id: 'issue', title: '排查下这个问题', time: '6m', running: false, input: '发布成功了，帮我检查一下安装后的版本。' }
    ] },
    { name: 'myNote', sessions: [
      { id: 'notes', title: '整理这周的阅读笔记', time: '2m', running: false, input: '把关键结论整理成一份笔记，保留原文链接。' }
    ] },
    { name: 'scry', sessions: [
      { id: 'remote', title: '把这个已归档远程会话恢复到侧栏', time: '7m', running: true, input: '先检查归档记录，再给出恢复方案。' },
      { id: 'perf', title: '检查会话切换的性能', time: '25m', running: false, unread: true, input: '' },
      { id: 'review', title: '看下这个改动', time: '33m', running: false, input: '' }
    ] }
  ]
}
