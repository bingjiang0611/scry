const copy = {
  title: 'Agent 卡片', version: 'A · 精简版 v2', demo: '静态示例',
  theme: '切换明暗主题', stateLabel: '示例状态',
  states: { running: '等待结果', unknown: '状态未知', completed: '已完成', failed: '失败' },
  eyebrow: '会话 / Pi', session: '实现 M0 初版',
  message: 'M0 初版代码已写入 worktree，正在完成静态检查。尚未运行测试或构建，也未提交、安装；写入结束后由我统一验证。',
  worker: 'worker', provider: 'Pi', age: '已观测 14m',
  ageLabel: '从收到启动回执起计时，不是精确进程运行时间',
  details: '详情', detailsLabel: '任务详情', capability: '不可单独停止',
  safety: '停止本轮会结束主会话观测，不保证后台子 Agent 已停止。',
  scope: '仅展示已观测任务，清单可能不完整。',
  fields: { task: '任务 ID', receipt: '启动回执', source: '计时依据', result: '状态依据', control: '停止限制', scope: '观测范围' },
  id: 'f7cb2107-7306-41f0-9ca7-fb2b975ab7ba', receipt: '20:04:54',
  timing: '自收到启动回执起计时，非精确进程运行时间。',
  source: {
    running: '收到启动回执，尚未收到终态；不代表已核验后台进程。',
    unknown: '父轮已结束，但 Provider 未提供子 Agent 终态，不能确认它已结束。',
    completed: '示例：Provider 明确上报完成终态。',
    failed: '示例：Provider 明确上报失败终态。'
  },
  files: '本轮文件', toolEvidence: '工具证据', fileRead: 'R', fileCount: '9',
  contextNote: '文件统计属于整轮工具证据，不归属于此子 Agent。'
}
const icons = {
  agent: '<rect x="4" y="5" width="16" height="14" rx="4"/><path d="M9 2v3m6-3v3M8 10h.01M16 10h.01M8 14h8"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  theme: '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>'
}
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`
const app = document.querySelector('#app')
let status = 'running'
let expanded = false
let light = false

function render() {
  app.innerHTML = `
  <header class="study-bar">
    <div class="study-identity"><strong>${copy.title}</strong><span>${copy.version}</span></div>
    <div class="study-tools">
      <label class="sr-only" for="state">${copy.stateLabel}</label>
      <select id="state">${Object.entries(copy.states).map(([key, label]) => `<option value="${key}" ${key === status ? 'selected' : ''}>${label}</option>`).join('')}</select>
      <button class="theme-button" aria-label="${copy.theme}" title="${copy.theme}">${icon('theme')}</button>
    </div>
  </header>
  <main>
    <div class="preview-label">${copy.demo}</div>
    <section class="chat-preview" aria-label="${copy.session}">
      <header class="session-header"><span>${copy.eyebrow}</span><strong>${copy.session}</strong></header>
      <div class="conversation">
        <p class="assistant-message">${copy.message}</p>
        <article class="agent-task" data-status="${status}" aria-label="${copy.worker}">
          <header class="task-header">
            <span class="agent-symbol">${icon('agent')}</span>
            <div class="task-identity"><strong>${copy.worker}</strong><span>${copy.provider}</span></div>
            <span class="status"><i aria-hidden="true"></i>${copy.states[status]}</span>
            <span class="elapsed" title="${copy.ageLabel}">${copy.age}</span>
          </header>
          <details class="evidence" ${expanded ? 'open' : ''}>
            <summary aria-label="${copy.detailsLabel}"><span class="capability">${copy.capability}</span><span class="details-label">${copy.details}${icon('chevron')}</span></summary>
            <dl>
              <div><dt>${copy.fields.task}</dt><dd><code>${copy.id}</code></dd></div>
              <div><dt>${copy.fields.receipt}</dt><dd><time>${copy.receipt}</time></dd></div>
              <div><dt>${copy.fields.source}</dt><dd>${copy.timing}</dd></div>
              <div><dt>${copy.fields.result}</dt><dd>${copy.source[status]}</dd></div>
              <div><dt>${copy.fields.control}</dt><dd>${copy.safety}</dd></div>
              <div><dt>${copy.fields.scope}</dt><dd>${copy.scope}</dd></div>
            </dl>
          </details>
        </article>
        <div class="files-context" title="${copy.contextNote}">${icon('file')}<span>${copy.files}</span><span class="files-evidence">${copy.toolEvidence}</span><span class="file-read">${copy.fileRead}<b>${copy.fileCount}</b></span></div>
      </div>
    </section>
  </main>`
  document.querySelector('#state').addEventListener('change', event => {
    status = event.target.value
    render()
    document.querySelector('#state').focus()
  })
  document.querySelector('.theme-button').addEventListener('click', () => {
    light = !light
    document.documentElement.dataset.theme = light ? 'light' : 'dark'
  })
  document.querySelector('details').addEventListener('toggle', event => {
    expanded = event.target.open
  })
}
render()
