import { catalog, copy, stageIds } from './copy.mjs'
import { createDemo, defaultConfig, stageState, tasksFor, transition, validConfig } from './demo-state.mjs'

const storageKey = 'scry-workflow-prototype-v1'
let config = defaultConfig()
try {
  const saved = JSON.parse(localStorage.getItem(storageKey))
  if (validConfig(saved)) config = saved
} catch { /* Local prototype preferences are optional; never call a Provider. */ }
let current = createDemo(config)
let previous = null
let history = false
let selectedStage = 'scan'
let selectedTask = 0
const app = document.querySelector('#app')
document.title = copy.title

// All UI copy is centralized. Values inserted into templates are escaped, including localStorage data.
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const button = (id, label, className = '', disabled = false) => `<button id="${id}" class="${className}" ${disabled ? 'disabled' : ''}>${escape(label)}</button>`
const tag = (label, state) => `<span class="status ${state}"><i aria-hidden="true"></i>${escape(label)}</span>`
const modelName = assignment => `${catalog[assignment.provider].label} / ${assignment.model}`
const on = (id, handler) => document.getElementById(id)?.addEventListener('click', handler)

function render(focusId) {
  const run = history ? previous : current
  const terminal = ['completed', 'stopped'].includes(run.status)
  const completed = stageIds.filter(id => ['completed', 'partial'].includes(stageState(run, id).state)).length
  const tasks = tasksFor(run, selectedStage)
  selectedTask = Math.min(selectedTask, tasks.length - 1)
  const task = tasks[selectedTask]
  const assignment = run.config.stages[selectedStage]
  const hasResult = ['completed', 'unverified'].includes(task.state)
  app.innerHTML = `
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark" aria-hidden="true">S</span>${escape(copy.brand)}</div>
      <div class="workspace"><span class="eyebrow">${escape(copy.workspace)}</span><strong>${escape(copy.project)}</strong></div>
      <div class="nav-heading">${escape(copy.workflow)}</div>
      ${button('current', copy.current, history ? 'nav' : 'nav selected')}
      ${button('history', copy.history, history ? 'nav selected' : 'nav', !previous)}
      <div class="sidebar-bottom"><span class="intent-dot" aria-hidden="true"></span>${escape(copy.readIntent)}</div>
    </aside>
    <main>
      <header><div class="breadcrumb">${escape(copy.project)} <span>/</span> ${escape(copy.workflow)}</div><span class="demo-label">${escape(copy.demo)}</span></header>
      <section class="heading">
        <div><div class="eyebrow">${escape(copy.template)} <span class="mono">· DEMO-${String(run.number).padStart(3, '0')}</span></div><h1>${escape(copy.objective)}</h1><p>${escape(copy.scope)}</p></div>
        ${button('configure', copy.configuration, 'secondary')}
      </section>
      <section class="runbar" aria-label="${escape(copy.inspect)}">
        <div class="runfacts">${tag(copy.status[run.status], run.status === 'completed' ? 'partial' : run.status)}<span>${escape(copy.totalStages(completed))}</span><span class="numeric">${escape(copy.active(run.active, run.config.concurrency))}</span></div>
        <div class="actions">${history ? `<span>${escape(copy.readOnlyHistory)}</span>` : `${button('pause', run.status === 'paused' ? copy.resume : copy.pause, 'quiet', terminal || run.status === 'stopping')}${button('stop', copy.stop, 'quiet danger', terminal || run.status === 'stopping')}${button('advance', copy.next, 'primary', terminal)}`}</div>
      </section>
      <p class="notice" role="status">${escape(copy.notice[run.status])}</p>
      <div class="workbench">
        <section class="canvas">
          <div class="flow" aria-label="${escape(copy.workflow)}">${stageIds.map((id, i) => {
            const stage = stageState(run, id)
            return `<button class="node ${stage.state} ${selectedStage === id ? 'active' : ''}" data-stage="${id}" aria-pressed="${selectedStage === id}"><span class="node-top"><span class="step mono">0${i + 1}</span>${tag(copy.states[stage.state], stage.state)}</span><strong>${escape(copy.stages[id].title)}</strong><span class="node-model">${escape(modelName(run.config.stages[id]))}</span><span class="track"><span style="width:${stage.done / stage.total * 100}%"></span></span><span class="node-count numeric">${escape(copy.progress(stage.done, stage.total))}</span></button>`
          }).join('')}</div>
          <section class="task-section"><div class="section-heading"><h2>${escape(copy.stages[selectedStage].title)}</h2><span>${escape(copy.stages[selectedStage].description)}</span></div>
          <div class="task-list">${tasks.map((entry, i) => `<button class="task-row ${i === selectedTask ? 'selected' : ''}" data-task="${i}" aria-pressed="${i === selectedTask}"><span class="task-index numeric">${String(i + 1).padStart(2, '0')}</span><span class="task-name ${selectedStage === 'scan' ? 'mono' : ''}">${escape(entry.title)}</span>${tag(entry.verdict || copy.states[entry.state], entry.state)}<span class="chevron" aria-hidden="true">›</span></button>`).join('')}</div></section>
          <section class="events"><div class="section-heading"><h2>${escape(copy.events)}</h2><span class="mono">DEMO</span></div><ol>${run.logs.slice(-8).map((line, i) => `<li><span class="mono numeric">${String(Math.max(0, run.logs.length - 8) + i + 1).padStart(3, '0')}</span><p>${escape(line)}</p></li>`).join('')}</ol></section>
        </section>
        <aside class="inspector" aria-label="${escape(copy.selectedStage)}">
          <div class="eyebrow">${escape(copy.detail)}</div><h2>${escape(task.title)}</h2>${tag(task.verdict || copy.states[task.state], task.state)}
          <dl><dt>${escape(copy.requestedModel)}</dt><dd>${escape(modelName(assignment))}</dd><dt>${escape(copy.profile)}</dt><dd>${escape(assignment.profile === 'research' ? copy.piProfile : copy.defaultProfile)}</dd></dl>
          <div class="evidence-note">${escape(copy.modelUnknown)}</div>
          <h3>${escape(copy.prompt)}</h3><p>${escape(task.prompt)}</p>
          <h3>${escape(copy.result)}</h3><p class="result ${task.state}">${escape(hasResult ? task.result : copy.evidenceUnavailable)}</p>
          ${task.path ? `<code>${escape(task.path)}</code>` : ''}
          <details><summary>${escape(copy.evidence)}</summary><p>${escape(copy.evidenceLabel)}</p><span class="mono">DEMO-${String(run.number).padStart(3, '0')} / ${selectedStage} / ${selectedTask + 1}</span></details>
        </aside>
      </div>
      <footer>${escape(copy.frozen)}<span>${escape(copy.providerUnavailable)}</span></footer>
    </main>
    <dialog id="configuration"></dialog>`
  on('current', () => { history = false; render('current') })
  on('history', () => { history = true; render('history') })
  on('configure', openConfiguration)
  for (const [id, action] of [['pause', run.status === 'paused' ? 'resume' : 'pause'], ['stop', 'stop'], ['advance', 'advance']]) {
    on(id, () => { current = transition(current, action); render(id) })
  }
  for (const element of document.querySelectorAll('[data-stage]')) element.addEventListener('click', () => {
    selectedStage = element.dataset.stage
    selectedTask = 0
    render()
    document.querySelector(`[data-stage="${selectedStage}"]`).focus()
  })
  for (const element of document.querySelectorAll('[data-task]')) element.addEventListener('click', () => {
    selectedTask = Number(element.dataset.task)
    render()
    document.querySelector(`[data-task="${selectedTask}"]`).focus()
  })
  if (focusId) document.getElementById(focusId)?.focus()
}

function openConfiguration() {
  const dialog = document.querySelector('#configuration')
  const draft = structuredClone(config)
  dialog.innerHTML = `<form id="config-form"><div class="dialog-heading"><h2>${escape(copy.configure)}</h2>${button('close', copy.cancel, 'quiet')}</div><p>${escape(copy.configHint)}</p>
    <div class="config-grid config-labels"><span>${escape(copy.workflow)}</span><span>${escape(copy.provider)}</span><span>${escape(copy.profile)}</span><span>${escape(copy.model)}</span></div>
    ${stageIds.map(id => `<div class="config-grid"><strong>${escape(copy.stages[id].title)}</strong><select id="${id}-provider" aria-label="${escape(copy.fieldLabel(copy.stages[id].title, copy.provider))}">${Object.entries(catalog).map(([key, value]) => `<option value="${key}" ${key === draft.stages[id].provider ? 'selected' : ''}>${escape(value.label)}</option>`).join('')}</select><select id="${id}-profile" aria-label="${escape(copy.fieldLabel(copy.stages[id].title, copy.profile))}"></select><select id="${id}-model" aria-label="${escape(copy.fieldLabel(copy.stages[id].title, copy.model))}"></select></div>`).join('')}
    <div class="concurrency"><label for="concurrency">${escape(copy.concurrency)}</label><input id="concurrency" type="number" min="1" max="4" step="1" value="${draft.concurrency}" required><span>${escape(copy.concurrencyHint)}</span></div>
    <div class="boundary"><strong>${escape(copy.readIntent)}</strong><p>${escape(copy.readBoundary)}</p></div>
    <p id="config-message" role="status"></p><div class="dialog-actions">${button('save', copy.save, 'secondary')}${button('start', copy.start, 'primary')}</div></form>`
  dialog.setAttribute('aria-labelledby', 'config-title')
  dialog.querySelector('h2').id = 'config-title'
  const message = document.querySelector('#config-message')
  const updateChoices = id => {
    const assignment = draft.stages[id]
    const provider = catalog[assignment.provider]
    document.getElementById(`${id}-profile`).innerHTML = provider.profiles.map(profile => `<option value="${profile}" ${profile === assignment.profile ? 'selected' : ''}>${escape(profile === 'research' ? copy.piProfile : copy.defaultProfile)}</option>`).join('')
    document.getElementById(`${id}-model`).innerHTML = `<option value="">${escape(copy.selectModel)}</option>` + provider.models.map(model => `<option value="${escape(model)}" ${model === assignment.model ? 'selected' : ''}>${escape(model)}</option>`).join('')
  }
  for (const id of stageIds) {
    updateChoices(id)
    document.getElementById(`${id}-provider`).addEventListener('change', event => {
      draft.stages[id] = { provider: event.target.value, profile: 'default', model: '' }
      updateChoices(id)
    })
    for (const field of ['profile', 'model']) document.getElementById(`${id}-${field}`).addEventListener('change', event => { draft.stages[id][field] = event.target.value })
  }
  document.getElementById('concurrency').addEventListener('input', event => { draft.concurrency = Number(event.target.value) })
  document.getElementById('config-form').addEventListener('submit', event => event.preventDefault())
  for (const element of dialog.querySelectorAll('button')) element.type = 'button'
  on('close', () => dialog.close())
  const apply = () => {
    if (!validConfig(draft)) { message.textContent = copy.invalid; return false }
    config = structuredClone(draft)
    return true
  }
  on('save', () => {
    if (!apply()) return
    try { localStorage.setItem(storageKey, JSON.stringify(config)); message.textContent = copy.saved }
    catch { message.textContent = copy.saveFailed }
  })
  on('start', () => {
    if (!apply()) return
    // Never discard an active sample. Finish/stop it before creating another run.
    if (!['completed', 'stopped'].includes(current.status)) return
    previous = structuredClone(current)
    current = createDemo(config, current.number + 1)
    history = false
    selectedStage = 'scan'
    selectedTask = 0
    dialog.close()
    render('configure')
  })
  document.getElementById('start').disabled = !['completed', 'stopped'].includes(current.status)
  if (document.getElementById('start').disabled) message.textContent = copy.finishFirst
  dialog.showModal()
}

render()
