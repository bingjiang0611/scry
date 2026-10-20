const copy = {
  title: 'Agent 卡片', version: '设计稿 v1', demo: '静态示例 · 不连接运行任务',
  options: [{ id: 'card', name: 'A · 紧凑卡片', note: '推荐' }, { id: 'inline', name: 'B · 内联任务行', note: '' }],
  theme: '切换明暗主题', stateLabel: '示例状态', states: { running: '等待结果', unknown: '状态未知', completed: '已完成', failed: '失败' },
  eyebrow: '会话 / Pi', session: '实现 M0 初版', turn: '当前轮次',
  message: 'M0 初版代码已写入 worktree，正在完成静态检查。尚未运行测试或构建，也未提交、安装；写入结束后由我统一验证。',
  worker: 'worker', tool: 'Agent', provider: 'Pi', age: '已观测 14m', ageLabel: '从收到启动回执起计时，不是精确进程运行时间',
  evidence: '任务证据', safety: '不支持单独停止；停止本轮不保证子 Agent 已停止。',
  scope: '仅展示已观测任务，清单可能不完整。',
  fields: { task: '任务 ID', receipt: '启动回执', source: '计时依据', result: '状态依据' },
  id: 'f7cb2107-7306-41f0-9ca7-fb2b975ab7ba', receipt: '20:04:54', timing: '自收到启动回执起计时，非精确进程运行时间。',
  source: {
    running: '收到启动回执，尚未收到终态；不代表已核验后台进程。',
    unknown: '父轮已结束，但 Provider 未提供子 Agent 终态。',
    completed: '示例：Provider 明确上报完成终态。',
    failed: '示例：Provider 明确上报失败终态。'
  },
  unknownNotice: '未收到子 Agent 终态，不能确认它已结束。',
  files: '本轮文件', toolEvidence: '工具证据', fileRead: 'R', fileCount: '9',
  contextNote: '文件统计属于整轮工具证据，不归属于此子 Agent。',
  rationale: {
    card: { heading: 'A / 独立但不抢戏', text: '用轻边框划清任务边界。状态、时长靠右；完整 ID 和计时依据收进「任务证据」。停止限制始终可见。' },
    inline: { heading: 'B / 更轻的聊天节奏', text: '去掉卡片外壳，用短轨道衔接正文。适合聊天流中频繁出现的任务；证据展开后仍留在同一条阅读路径。' }
  },
  designNote: '两版均不新增进度、Token、工具数或单独停止能力。示例状态仅用于比较视觉，不模拟运行操作。',
  footer: '确认方向后再接入现有任务卡片。'
}
const icons = {
  agent: '<rect x="4" y="5" width="16" height="14" rx="4"/><path d="M9 2v3m6-3v3M8 10h.01M16 10h.01M8 14h8"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  theme: '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>'
}
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`
const app = document.querySelector('#app')
let variant = 'card'
let status = 'running'
let expanded = false
let light = false
function render() {
  const rationale = copy.rationale[variant]
  app.innerHTML = `
  <header class="study-bar">
    <div class="study-identity"><strong>${copy.title}</strong><span>${copy.version}</span></div>
    <div class="variants" role="group" aria-label="${copy.title}">${copy.options.map(option => `<button type="button" data-variant="${option.id}" aria-pressed="${variant === option.id}">${option.name}${option.note ? `<small>${option.note}</small>` : ''}</button>`).join('')}</div>
    <div class="study-tools"><label class="sr-only" for="state">${copy.stateLabel}</label><select id="state">${Object.entries(copy.states).map(([key, label]) => `<option value="${key}" ${key === status ? 'selected' : ''}>${label}</option>`).join('')}</select><button class="theme-button" aria-label="${copy.theme}" title="${copy.theme}">${icon('theme')}</button></div>
  </header>
  <main>
    <div class="preview-label"><span>${copy.demo}</span><span>${copy.turn}</span></div>
    <section class="chat-preview" aria-label="${copy.session}">
      <header class="session-header"><span>${copy.eyebrow}</span><strong>${copy.session}</strong></header>
      <div class="conversation">
        <p class="assistant-message">${copy.message}</p>
        <article class="agent-task ${variant}" data-status="${status}" aria-label="${copy.worker}">
          <header class="task-header">
            <span class="agent-symbol">${icon('agent')}</span>
            <div class="task-identity"><strong>${copy.worker}</strong><span>${copy.tool}</span></div>
            <span class="status"><i aria-hidden="true"></i>${copy.states[status]}</span>
            <span class="elapsed" title="${copy.ageLabel}">${copy.age}</span>
          </header>
          <div class="task-body">
            ${status === 'unknown' ? `<p class="unknown-notice">${copy.unknownNotice}</p>` : ''}
            <div class="task-meta"><span>${copy.provider}</span><span aria-hidden="true">·</span><span>${copy.scope}</span></div>
            <p class="safety">${icon('info')}<span>${copy.safety}</span></p>
            <details class="evidence" ${expanded ? 'open' : ''}>
              <summary>${icon('chevron')}<span>${copy.evidence}</span></summary>
              <dl>
                <div><dt>${copy.fields.task}</dt><dd><code>${copy.id}</code></dd></div>
                <div><dt>${copy.fields.receipt}</dt><dd><time>${copy.receipt}</time></dd></div>
                <div><dt>${copy.fields.source}</dt><dd>${copy.timing}</dd></div>
                <div><dt>${copy.fields.result}</dt><dd>${copy.source[status]}</dd></div>
              </dl>
            </details>
          </div>
        </article>
        <div class="files-context" title="${copy.contextNote}">${icon('file')}<span>${copy.files}</span><span class="files-evidence">${copy.toolEvidence}</span><span class="file-read">${copy.fileRead}<b>${copy.fileCount}</b></span></div>
      </div>
    </section>
    <aside class="design-notes"><h1>${rationale.heading}</h1><p>${rationale.text}</p><p class="design-boundary">${copy.designNote}</p><span>${copy.footer}</span></aside>
  </main>`
  document.querySelectorAll('[data-variant]').forEach(button => button.addEventListener('click', () => { variant = button.dataset.variant; render(); document.querySelector(`[data-variant="${variant}"]`).focus() }))
  document.querySelector('#state').addEventListener('change', event => { status = event.target.value; render(); document.querySelector('#state').focus() })
  document.querySelector('.theme-button').addEventListener('click', () => { light = !light; document.documentElement.dataset.theme = light ? 'light' : 'dark' })
  document.querySelector('details').addEventListener('toggle', event => { expanded = event.target.open })
}
render()
