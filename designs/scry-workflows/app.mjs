import { catalog, copy, stageIds, workerStages } from './copy.mjs'
import { activeCount, createDemo, defaultConfig, stageState, transition, validConfig } from './demo-state.mjs'

document.title = copy.title
const storageKey = 'scry-workflow-prototype-v2'
let config = defaultConfig()
try {
  const saved = JSON.parse(localStorage.getItem(storageKey))
  if (validConfig(saved)) config = saved
} catch { /* Optional prototype preferences; no Provider access. */ }
let run = createDemo(config)
let playing = true
let detailStage = null
const app = document.querySelector('#app')
document.title = copy.title
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const button = (id, text, className = '', disabled = false) => `<button type="button" id="${id}" class="${className}" ${disabled ? 'disabled' : ''}>${escape(text)}</button>`
const on = (id, action) => document.getElementById(id)?.addEventListener('click', action)
const modelName = stage => `${catalog[run.config.stages[stage].provider].label} / ${run.config.stages[stage].model}`
const timestamp = tick => `${String(Math.floor(tick * 2 / 60)).padStart(2, '0')}:${String(tick * 2 % 60).padStart(2, '0')}`

function render(focusId) {
  const terminal = ['completed', 'stopped'].includes(run.status)
  const states = Object.fromEntries(workerStages.map(id => [id, stageState(run, id)]))
  const active = activeCount(run)
  const node = id => {
    const stage = states[id]
    return `<button id="stage-${id}" class="worker ${id} ${stage.state}" data-stage="${id}" aria-label="${escape(copy.nodeLabel(copy.stages[id].title, copy.stageStatus[stage.state], stage.done, stage.total))}">
      <span class="worker-heading"><strong>${escape(copy.stages[id].code)}</strong><span>${escape(copy.stageStatus[stage.state])}</span></span>
      <span class="model">${escape(modelName(id))}</span>
      <span class="progress"><span style="width:${stage.done / stage.total * 100}%"></span></span>
      <span class="agents">${run.tasks[id].map(task => `<i class="${task.state}" aria-hidden="true"></i>`).join('')}</span>
      <span class="worker-description">${escape(copy.stages[id].detail)}</span>
      <span class="worker-count">${escape(copy.counts(stage.done, stage.total))}</span>
    </button>`
  }
  app.innerHTML = `<main class="terminal ${playing ? '' : 'replay-paused'}">
    <header><div class="heading"><strong>${escape(copy.brand)}</strong><span>${escape(copy.heading)}</span><span class="run-status ${run.status}">${escape(copy.runStatus[run.status])}</span></div><div class="header-actions">${button('configure', copy.configure)}${button('pause', run.status === 'paused' ? copy.resume : copy.pause, '', terminal || run.status === 'stopping')}${button('stop', copy.stop, '', terminal || run.status === 'stopping')}</div></header>
    <div class="subhead"><span>${escape(copy.objective)}</span><span class="demo-label">${escape(copy.demo)}</span></div>
    <div class="legend">${stageIds.map(id => `<span class="${id}"><i></i>${escape(run.config.stages[id].model)} · ${escape(copy.stages[id].code)}</span>`).join('')}</div>
    <section class="stage-layout">
      <aside class="orchestrator plan"><div class="orchestrator-heading"><strong>${escape(run.config.stages.plan.model)}</strong><span>${escape(copy.orchestrator)}</span></div>
        <div class="script-title">${escape(copy.script)}</div>
        <pre class="script"><span>plan(objective)</span><span class="${run.phase === 'scan' ? 'current scan' : ''}">phase('scan')</span><span class="indent">parallel(files)</span><span class="${run.phase === 'edit' ? 'current edit' : ''}">phase('edit')</span><span class="indent">isolated(patches)</span><span class="${run.phase === 'verify' ? 'current verify' : ''}">phase('verify')</span><span class="indent">review(evidence)</span><span>return findings</span></pre>
        <dl><dt>${escape(copy.phaseLabel)}</dt><dd class="${run.phase}">${escape(run.phase)}</dd><dt>${escape(copy.agentsLabel)}</dt><dd>${active}</dd><dt>${escape(copy.contextLabel)}</dt><dd>${escape(copy.unknown)}</dd></dl>
        <div class="idle-state">◇ ${escape(run.status === 'stopped' ? copy.plannerStopped : terminal ? copy.plannerDone : copy.plannerIdle)}</div><p>${escape(copy.scriptHeld)}</p><div class="owner-end">${escape(copy.ownerEnd)}</div>
      </aside>
      <div class="graph">
        <svg class="connections" viewBox="0 0 1000 560" preserveAspectRatio="none" aria-hidden="true">
          <path class="edge owner" d="M0 44 H300"/><path class="edge owner" d="M500 88 V120"/>
          <path class="edge" d="M500 230 V280 M166 300 V280 H834 V300 M500 280 V300"/>
          <path class="edge" d="M166 444 V468 H834 V444 M500 444 V488"/>
          ${active > 0 ? `<path class="signal ${run.phase}" d="M500 230 V280 H${run.phase === 'scan' ? 166 : run.phase === 'edit' ? 500 : 834} V300"/>` : ''}
          ${run.status === 'completed' ? '<path class="signal plan" d="M500 444 V488"/>' : ''}
        </svg>
        <div class="main-node plan"><strong>${escape(modelName('plan'))} · ${escape(copy.mainSession)}</strong><span>${escape(copy.plannerRole)}</span><small>${escape(copy.project)}</small></div>
        <div class="runtime-node"><div class="runtime-title"><strong>${escape(copy.runtime)}</strong><span>${escape(copy.routing)}</span></div><div class="routing-row"><span>${escape(copy.routingModel)}</span><i class="route-bar models"></i><b>${escape(copy.routingModelValue)}</b></div><div class="routing-row"><span>${escape(copy.routingReady)}</span><i class="route-bar ready"></i><b>${escape(copy.routingReadyValue)}</b></div><div class="routing-row"><span>${escape(copy.routingEvidence)}</span><i class="route-bar evidence"></i><b>${escape(copy.routingEvidenceValue)}</b></div></div>
        <div class="runtime-caption"><span>${escape(copy.runtimeCaption)} <b>${escape(copy.active(active))}</b></span></div>
        <div class="workers">${workerStages.map(node).join('')}</div>
        <div class="signoff plan ${terminal ? 'arrived' : ''}"><strong>${escape(copy.signoff)}</strong><span class="${run.status === 'completed' ? 'warning' : ''}">${escape(run.status === 'completed' ? copy.signoffDone : run.status === 'stopped' ? copy.signoffStopped : copy.signoffWaiting)}</span><small>${escape(copy.signoffHint)}</small></div>
      </div>
    </section>
    <section class="console"><div class="console-heading"><strong>${escape(copy.events)}</strong><span><i class="live-dot ${playing && !terminal ? 'live' : ''}"></i>${escape(copy.eventSource)}</span></div><ol>${run.logs.slice(-6).map(event => `<li><time>${timestamp(event.tick)}</time><b class="${event.actor === 'main' ? 'plan' : event.actor}">${escape(event.actor)}</b><span>${escape(event.message)}</span></li>`).join('')}</ol></section>
    <footer><div class="playback">${button('play', playing ? copy.freeze : copy.play, '', terminal)}${button('advance', copy.next, '', terminal)}${button('replay', copy.replay)}</div><span class="footer-status">${escape(run.status === 'paused' ? copy.pauseNotice : run.status === 'stopping' ? copy.stopNotice : run.status === 'stopped' ? copy.stoppedNotice : terminal ? copy.finishedNotice : copy.noCharge)}</span></footer>
    </main><dialog id="configuration"></dialog><dialog id="details"></dialog>`
  on('configure', openConfiguration)
  on('play', () => { playing = !playing; render('play') })
  on('advance', () => { run = transition(run, 'advance'); render('advance') })
  on('replay', () => { run = createDemo(config); playing = true; render('replay') })
  on('pause', () => { run = transition(run, run.status === 'paused' ? 'resume' : 'pause'); render('pause') })
  on('stop', () => { playing = false; run = transition(run, 'stop'); render('advance') })
  for (const element of document.querySelectorAll('[data-stage]')) element.addEventListener('click', () => openDetails(element.dataset.stage))
  if (focusId) document.getElementById(focusId)?.focus()
}

function openDetails(stage) {
  playing = false
  render()
  detailStage = stage
  const dialog = document.querySelector('#details')
  dialog.innerHTML = `<div class="dialog-heading"><h2>${escape(copy.stages[stage].title)} · ${escape(copy.stageDetail)}</h2>${button('close-details', copy.close)}</div><p>${escape(copy.evidence)}</p><div class="detail-model"><span>${escape(copy.requestedModel)} · ${escape(modelName(stage))}</span><small>${escape(copy.actualModel)}</small></div>${stage === 'edit' ? `<p class="warning">${escape(copy.simulatedEdit)}</p>` : ''}<div class="detail-tasks">${run.tasks[stage].map(task => `<details><summary><span>${escape(task.title)}</span><b class="${task.state}">${escape(copy.taskStatus[task.state])}</b></summary><p>${escape(task.state === 'unverified' ? copy.results.unverified : task.state === 'completed' ? copy.results[stage] : copy.emptyResult)}</p></details>`).join('')}</div>`
  dialog.setAttribute('aria-label', copy.stageDetail)
  on('close-details', () => dialog.close())
  dialog.addEventListener('close', () => { document.querySelector(`[data-stage="${detailStage}"]`)?.focus(); detailStage = null }, { once: true })
  dialog.showModal()
}

function openConfiguration() {
  playing = false
  render()
  const draft = structuredClone(config)
  const dialog = document.querySelector('#configuration')
  dialog.innerHTML = `<div class="dialog-heading"><h2>${escape(copy.configure)}</h2>${button('close-config', copy.close)}</div><p>${escape(copy.configHint)}</p>
    ${stageIds.map(id => `<fieldset><legend>${escape(copy.stages[id].title)}</legend><label>${escape(copy.provider)}<select id="${id}-provider">${Object.entries(catalog).map(([key, value]) => `<option value="${key}" ${key === draft.stages[id].provider ? 'selected' : ''}>${escape(value.label)}</option>`).join('')}</select></label><label>${escape(copy.profile)}<select id="${id}-profile"></select></label><label>${escape(copy.model)}<select id="${id}-model"></select></label></fieldset>`).join('')}
    <p id="config-message" role="status"></p><div class="dialog-actions">${button('save', copy.save, 'primary')}</div>`
  dialog.setAttribute('aria-label', copy.configure)
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
  on('close-config', () => dialog.close())
  on('save', () => {
    if (!validConfig(draft)) { message.textContent = copy.invalid; return }
    config = structuredClone(draft)
    try { localStorage.setItem(storageKey, JSON.stringify(config)); message.textContent = copy.saved }
    catch { message.textContent = copy.saveFailed }
  })
  dialog.addEventListener('close', () => document.getElementById('configure').focus(), { once: true })
  dialog.showModal()
}

render()
const timer = window.setInterval(() => {
  if (!playing || document.hidden || ['completed', 'stopped'].includes(run.status)) return
  const focused = document.activeElement?.id
  run = transition(run, 'advance')
  render(focused)
}, 1800)
window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true })
