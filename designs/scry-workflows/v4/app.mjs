import { copy, templateSource } from './copy.mjs'
import { createRun, isTerminal, limits, nodeSummary, queuedCount, requestStop, slotsUsed, start, tick, togglePause } from './state.mjs'

const app = document.querySelector('#app')
document.title = copy.title
let view = 'run'
let run = start(createRun())
let playing = true
let selected = null
let agentCandidate = false
let saveNotice = false
let timer = null

// Review deep links: ?view=plan|list|template and ?frame=N freeze a replay frame.
const params = new URLSearchParams(location.search)
if (copy.views[params.get('view')]) view = params.get('view')
const frame = Number.parseInt(params.get('frame') ?? '', 10)
if (Number.isInteger(frame) && frame > 0) {
  for (let i = 0; i < frame && !isTerminal(run); i++) run = tick(run)
  playing = false
}
if (copy.nodes[params.get('node')]) selected = params.get('node')

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

function activeNodes() {
  const active = new Set(run.tasks.filter(task => task.state === 'running' || task.state === 'stopping').map(task => task.node))
  if (run.branch && !run.report && run.loop.iteration === 1 && !run.tasks.some(task => task.node === 'fix' && task.state !== 'queued')) active.add('branch')
  if (run.report) active.add('return')
  return active
}

function dots(tasks) {
  return `<div class="dots">${tasks.map(task => {
    const restarted = task.attempt > 1
    return `<i class="dot ${task.state}${restarted ? ' restarted' : ''}" title="${escape(copy.detail.item(task.item))} ${escape(copy.detail.states[task.state])}"></i>`
  }).join('')}</div>`
}

function card(node, active, body) {
  const meta = copy.nodes[node]
  const isSelected = selected === node
  return `<button class="node${active ? ' active' : ''}${isSelected ? ' selected' : ''}" data-kind="${node}" data-node="${node}" aria-pressed="${isSelected}">
    <span class="node-head"><strong>${escape(meta.title)}</strong><span>${escape(meta.kind)}</span></span>
    <span class="node-model">${escape(meta.model)}</span>
    ${body}
    <span class="node-hint">${escape(meta.hint)}</span>
  </button>`
}

function taskCard(node, active, iteration = null) {
  const summary = nodeSummary(run, node, iteration)
  const queued = summary.queued ? ` · ${copy.queuedCount(summary.queued)}` : ''
  return card(node, active, `${dots(summary.tasks)}<span class="node-progress">${escape(copy.progress(summary.done, summary.total))}${escape(queued)}</span>`)
}

function branchCard(active) {
  const rows = run.branch ? copy.branchCounts(run.branch) : [copy.branchWaiting]
  return card('branch', active, `<span class="arms">${rows.map((row, index) => `<span class="arm ${run.branch ? `arm-${index}` : 'waiting'}">${escape(row)}</span>`).join('')}</span>`)
}

function checkCard(active) {
  const checks = run.loop.checks
  const pending = run.tasks.find(task => task.node === 'check' && task.state !== 'done')
  const lines = checks.map(check => `<span class="check-line ${check.outcome}">${escape(copy.checkResult(check))}</span>`)
  if (pending) lines.push(`<span class="check-line">${escape(copy.detail.states[pending.state])}</span>`)
  return card('check', active, `<span class="checks">${lines.join('') || '<span class="check-line">—</span>'}</span>`)
}

function returnCard(active) {
  const text = run.report ? copy.returnDone(run.report) : copy.returnWaiting
  return card('return', active, `<span class="node-progress">${escape(text)}</span>`)
}

function link(on) { return `<span class="link${on ? ' on' : ''}" aria-hidden="true"><i class="signal"></i></span>` }

function flow() {
  const active = activeNodes()
  const loopLabel = run.loop.iteration ? copy.loopTitle(run.loop.iteration) : copy.loopIdle
  const loopActive = active.has('fix') || active.has('check')
  return `<div class="flow">
    ${taskCard('scan', active.has('scan'))}
    ${link(active.has('verify'))}
    ${taskCard('verify', active.has('verify'))}
    ${link(active.has('branch') || loopActive)}
    ${branchCard(active.has('branch'))}
    ${link(loopActive)}
    <section class="loop${loopActive ? ' active' : ''}">
      <span class="loop-title">${escape(loopLabel)}</span>
      ${taskCard('fix', active.has('fix'), run.loop.iteration)}
      <span class="loop-back" aria-hidden="true">↓ ↺</span>
      ${checkCard(active.has('check'))}
    </section>
    ${link(active.has('return'))}
    ${returnCard(active.has('return'))}
  </div>`
}

function runtimePanel() {
  const used = slotsUsed(run)
  const checks = run.tasks.filter(task => task.system && task.state !== 'queued').length
  const cells = Array.from({ length: limits.concurrency }, (_, index) => `<i class="${index < used ? 'used' : ''}"></i>`).join('')
  const budgetPct = Math.max(0.4, run.budgetUsed / limits.budget * 100)
  return `<section class="runtime">
    <div class="runtime-title"><strong>${escape(copy.runtime.title)}</strong></div>
    <div class="metric"><span>${escape(copy.runtime.slots)}</span><span class="slots">${cells}</span><b>${used} / ${limits.concurrency}</b><small>${escape(copy.runtime.slotsHint)}</small></div>
    <div class="metric"><span>${escape(copy.runtime.budget)}</span><span class="meter"><i style="width:${budgetPct}%"></i></span><b>${run.budgetUsed} / ${limits.budget}</b><small>${escape(copy.runtime.budgetHint)}</small></div>
    <div class="metric compact"><span>${escape(copy.runtime.queued)}</span><b>${queuedCount(run)}</b><span>${escape(copy.runtime.checks)}</span><b>${checks}</b><small>${escape(copy.runtime.checksHint)}</small></div>
  </section>`
}

function detailPanel() {
  if (!selected || !['scan', 'verify', 'fix', 'check'].includes(selected)) return ''
  const tasks = run.tasks.filter(task => task.node === selected)
  const restarted = tasks.some(task => task.attempt > 1)
  const rows = tasks.map(task => `<tr class="${task.state}">
    <td>${escape(task.system ? copy.detail.round(task.iteration) : copy.detail.item(task.item))}${task.node === 'fix' ? ` · ${escape(copy.detail.round(task.iteration))}` : ''}</td>
    <td>${task.system ? '—' : escape(copy.detail.attempt(task.attempt, limits.maxRestarts + 1))}</td>
    <td>${escape(copy.detail.states[task.state])}</td>
    <td>${escape(task.outcome ? copy.detail.outcomes[task.outcome] : copy.detail.none)}</td>
  </tr>`).join('')
  return `<section class="detail">
    <div class="detail-head"><strong>${escape(copy.detail.title)} · ${escape(copy.nodes[selected].title)}</strong><button data-close>${escape(copy.detail.close)}</button></div>
    ${restarted ? `<p class="detail-note">${escape(copy.detail.restartNote)}</p>` : ''}
    <div class="detail-scroll"><table>${rows}</table></div>
  </section>`
}

function programPanel() {
  const active = activeNodes()
  const p = copy.program
  return `<aside class="program">
    <div class="program-head"><strong>${escape(p.model)}</strong><span>${escape(p.role)}</span></div>
    <dl>
      <dt>${escape(p.source)}</dt><dd>${escape(p.sourceValue)}</dd>
      <dt>${escape(p.revision)}</dt><dd>a41c…9e07</dd>
      <dt>${escape(p.programRevision)}</dt><dd>r3</dd>
      <dt>${escape(p.size)}</dt><dd>${escape(p.sizeValue)}</dd>
      <dt>${escape(p.entry)}</dt><dd>${escape(p.entryValue)}</dd>
    </dl>
    <pre class="code">${p.lines.map(line => `<span data-kind="${line.id}" class="${active.has(line.id) ? 'current' : ''}" style="--depth:${line.depth}">${escape(line.text)}</span>`).join('')}</pre>
  </aside>`
}

function sessionBox() {
  const text = run.report ? copy.session.done : run.status === 'stopped' ? copy.session.stopped : copy.session.waiting
  return `<div class="session"><strong>${escape(copy.session.title)}</strong><span>${escape(text)}</span></div>`
}

function logPanel() {
  const rows = run.logs.slice(-6).reverse().map(entry => `<li><time>${escape(copy.log.time(entry.tick))}</time><span class="actor" data-actor="${entry.actor}">${escape(entry.actor)}</span><span>${escape(copy.logText[entry.kind](entry))}</span></li>`).join('')
  return `<section class="log"><div class="log-head"><strong>${escape(copy.log.title)}</strong><span>${escape(copy.log.source)}</span></div><ol>${rows}</ol></section>`
}

function legend() {
  return `<div class="legend">${Object.entries(copy.legend).map(([state, label]) => `<span><i class="dot ${state === 'stalled' ? 'done restarted' : state}"></i>${escape(label)}</span>`).join('')}</div>`
}

function runView() {
  return `<div class="run-layout">
    ${programPanel()}
    <div class="canvas">
      ${sessionBox()}
      <span class="drop" aria-hidden="true"></span>
      ${runtimePanel()}
      ${flow()}
      ${legend()}
      ${detailPanel()}
    </div>
  </div>
  ${logPanel()}`
}

function table(head, rows) {
  return `<table class="grid">${head ? `<tr>${head.map(cell => `<th>${escape(cell)}</th>`).join('')}</tr>` : ''}${rows.map(row => `<tr>${row.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</table>`
}

function planView() {
  const p = copy.plan
  return `<section class="sheet">
    <div class="sheet-head"><h2>${escape(p.title)}</h2><span>${escape(p.revision)}</span></div>
    <p class="sheet-note">${escape(p.note)}</p>
    <div class="sheet-grid">
      <div><h3>${escape(p.phases)}</h3>${table(null, p.phaseRows)}<h3>${escape(p.roles)}</h3>${table(null, p.roleRows)}</div>
      <div>
        <h3>${escape(p.checks)}</h3>${table(p.checkHead, p.checkRows)}<p class="caution">${escape(p.checkWarning)}</p>
        <h3>${escape(p.limits)}</h3>${table(null, p.limitRows)}<p class="sheet-note">${escape(p.size)}</p>
        <h3>${escape(p.cost)}</h3><p class="caution">${escape(p.costValue)}</p>
      </div>
    </div>
    <div class="sheet-actions"><button class="primary" data-confirm>${escape(p.confirm)}</button><button data-view="template">${escape(p.source)}</button><button data-view="template">${escape(p.edit)}</button><button data-view="run">${escape(p.cancel)}</button></div>
  </section>`
}

function listView() {
  const l = copy.list
  const rows = l.rows.map((row, index) => `<tr><td>${escape(row.name)}</td><td>${escape(row.session)}</td><td class="${row.tone}">${escape(row.status)}</td><td>${escape(row.agents)}</td><td>${escape(row.budget)}</td><td><button ${index === 0 ? 'data-view="run"' : ''}>${escape(row.action)}</button></td></tr>`).join('')
  return `<section class="sheet">
    <div class="sheet-head"><h2>${escape(l.title)}</h2><span>${escape(l.hint)}</span></div>
    <table class="grid runs"><tr>${l.head.map(cell => `<th>${escape(cell)}</th>`).join('')}</tr>${rows}</table>
    <p class="sheet-note">${escape(l.resumeNote)}</p><p class="sheet-note">${escape(l.freshNote)}</p>
  </section>`
}

function templateView() {
  const t = copy.template
  const groups = Object.entries(t.scopes).map(([scope, label]) => `<div class="tpl-group"><h3>${escape(label)}</h3>${t.items.filter(item => item.scope === scope).map(item => `<div class="tpl-item${item.selected ? ' selected' : ''}"><span>${escape(item.name)}</span><code>${escape(item.id)}</code></div>`).join('')}</div>`).join('')
  const lines = templateSource.split('\n').map((line, index) => `<span><b>${index + 1}</b>${escape(line)}</span>`).join('')
  const diff = t.diffRows.map(row => `<tr><td class="${row.tone}">${escape(row.label)}</td><td><s>${escape(row.from)}</s></td><td>${escape(row.to)}</td></tr>`).join('')
  return `<section class="tpl">
    <nav class="tpl-list">${groups}<p class="sheet-note">${escape(t.sameName)}</p></nav>
    <div class="tpl-editor">
      <div class="tpl-bar"><strong>${escape(t.draft)}</strong><span class="verify">✓ ${escape(t.valid)}</span><span class="warning">${escape(t.runnable)}</span></div>
      <pre class="source" aria-label="${escape(t.sourceTab)}">${lines}</pre>
    </div>
    <div class="tpl-side">
      <h3>${escape(t.diffTitle)}</h3><table class="grid">${diff}</table>
      <h3>${escape(t.agentTitle)}</h3>
      <textarea placeholder="${escape(t.agentPlaceholder)}" rows="2"></textarea>
      <p class="sheet-note">${escape(t.agentCost)}</p>
      <button data-agent>${escape(t.agentSend)}</button>
      ${agentCandidate ? `<p class="sheet-note">${escape(t.agentNote)}</p>` : ''}
      <p class="caution">${escape(t.stale)}</p><button>${escape(t.staleMerge)}</button>
      <div class="tpl-actions"><button class="primary" data-save>${escape(t.save)}</button><button data-save>${escape(t.saveAs)}</button><button data-save>${escape(t.runOnce)}</button></div>
      <p class="sheet-note">${escape(saveNotice ? t.prototypeNote : t.saveNote)}</p>
    </div>
  </section>`
}

function header() {
  const status = view === 'run' ? copy.status[run.status] : copy.viewStatus[view]
  const tone = view === 'run' ? run.status : 'paused'
  const runControls = view === 'run' ? `
    <button data-pause ${['running', 'paused'].includes(run.status) ? '' : 'disabled'}>${escape(run.status === 'paused' ? copy.actions.resume : copy.actions.pause)}</button>
    <button data-stop ${isTerminal(run) ? 'disabled' : ''}>${escape(run.status === 'stopping' ? copy.actions.stopAgain : copy.actions.stop)}</button>` : ''
  return `<header>
    <div class="heading"><strong>${escape(copy.brand)}</strong><span>${escape(copy.heading)}</span><span class="run-status ${tone}">${escape(status)}</span></div>
    <nav class="tabs" role="tablist">${Object.entries(copy.views).map(([id, label]) => `<button role="tab" aria-selected="${view === id}" data-view="${id}">${escape(label)}</button>`).join('')}</nav>
    <div class="header-actions">${runControls}</div>
  </header>
  <div class="subhead"><span>${['run', 'plan'].includes(view) ? escape(copy.goal) : ''}</span><span class="demo-label">${escape(copy.fixture)}</span></div>`
}

function footer() {
  if (view !== 'run') return ''
  return `<footer><div class="playback">
    <button data-play>${escape(playing ? copy.actions.freeze : copy.actions.play)}</button>
    <button data-step ${isTerminal(run) ? 'disabled' : ''}>${escape(copy.actions.step)}</button>
    <button data-replay>${escape(copy.actions.replay)}</button>
  </div><span>${escape(copy.usage)}</span></footer>`
}

function render() {
  const body = { run: runView, plan: planView, list: listView, template: templateView }[view]()
  app.innerHTML = `<main class="terminal">${header()}${body}${footer()}</main>`
}

function schedule() {
  clearInterval(timer)
  timer = null
  if (playing && view === 'run' && !document.hidden && !isTerminal(run)) {
    timer = setInterval(() => { run = tick(run); if (isTerminal(run)) schedule(); render() }, 900)
  }
}

app.addEventListener('click', event => {
  const target = event.target.closest('button')
  if (!target) return
  if (target.dataset.view) { view = target.dataset.view; saveNotice = false }
  else if (target.dataset.node) selected = selected === target.dataset.node ? null : target.dataset.node
  else if ('close' in target.dataset) selected = null
  else if ('pause' in target.dataset) run = togglePause(run)
  else if ('stop' in target.dataset) run = requestStop(run)
  else if ('play' in target.dataset) playing = !playing
  else if ('step' in target.dataset) run = tick(run)
  else if ('replay' in target.dataset || 'confirm' in target.dataset) { run = start(createRun()); selected = null; playing = true; view = 'run' }
  else if ('agent' in target.dataset) agentCandidate = true
  else if ('save' in target.dataset) saveNotice = true
  render()
  schedule()
})
document.addEventListener('visibilitychange', schedule)
window.addEventListener('pagehide', () => clearInterval(timer))

render()
schedule()
