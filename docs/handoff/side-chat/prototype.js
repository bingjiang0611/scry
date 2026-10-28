// Standalone design preview. No Provider, preload API, network calls or persistence.
const ICONS = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8L21 21l-5.7-.9a8.5 8.5 0 1 1 5.7-8.6Z"/><path d="M8 11h6m-3-3v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>',
  folder: '<path d="M3 7V5h6l2 2h10v13H3Z"/>', history: '<path d="M3 11a9 9 0 1 1 2.5 7M3 4v7h7m2-4v5l3 2"/>',
  arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m2-4c7 0 10-2 10-5"/>',
  file: '<path d="M14 2H5v20h14V7Zm0 0v5h5M8 12h8M8 16h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>', back: '<path d="m14 6-6 6 6 6"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/>', check: '<path d="m5 12 4 4L19 6"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M14 3v18"/>',
  overview: '<path d="M3 3h7v8H3zm11 0h7v4h-7zm0 8h7v10h-7zM3 15h7v6H3z"/>',
  diff: '<path d="M8 3v18m8-18v18M4 7h8m-3-3 3 3-3 3m11 7h-8m3-3-3 3 3 3"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 8 3 4-3 4m6 0h4"/>',
  agents: '<rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 3v4M1 12h3m16 0h3M8 12h.01M16 12h.01M9 16h6"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>'
}
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
const button = (action, label, image, className = '', extra = '') => `<button class="${className}" data-action="${action}" aria-label="${escape(label)}" title="${escape(label)}" ${extra}>${image ? icon(image) : escape(label)}</button>`
const state = {
  parent: 0, dark: true, narrow: false, showMain: false, notice: '',
  parents: [
    { active: null, open: [], picker: true, mainDraft: '', entries: [
      { id: 'a', title: COPY.sideTitles[0], draft: '', mode: 'live' },
      { id: 'b', title: COPY.sideTitles[1], draft: '', mode: 'approval' }
    ] },
    { active: 'c', open: ['c'], picker: false, mainDraft: '', entries: [
      { id: 'c', title: COPY.secondParentSide, draft: '', mode: 'empty' }
    ] }
  ]
}
const app = document.querySelector('#app')
const dialog = document.querySelector('#snapshot')
const historyMenu = document.querySelector('#history-menu')
let serial = 0
const current = () => state.parents[state.parent]
const entry = () => current().entries.find(item => item.id === current().active)
const tool = id => COPY.surfaces.find(item => item.id === id)
const itemFor = id => tool(id) ?? current().entries.find(item => item.id === id)

function composer(side) {
  const busy = !side || entry()?.mode === 'live'
  const draft = side ? entry().draft : current().mainDraft
  return `<div class="composer-wrap"><div class="composer">
    <textarea id="${side ? 'side-input' : 'main-input'}" aria-label="${side ? COPY.sideHint : COPY.mainHint}" placeholder="${side ? COPY.sidePlaceholder : COPY.mainPlaceholder}">${escape(draft)}</textarea>
    <div class="composer-footer"><div class="composer-options">${icon('plus')}${icon('shield')}<span>${COPY.permission}</span></div>
      <div class="composer-options"><span>${COPY.model}</span>${button(busy ? 'stop' : 'send', busy ? COPY.stop : COPY.send, busy ? 'stop' : 'arrow', 'send')}</div>
    </div></div><div class="caption"><span>${side ? COPY.sideHint : COPY.mainHint}</span><span>${COPY.saved}</span></div></div>`
}
function sideBody() {
  const mode = entry().mode
  if (mode === 'empty') return `<div class="empty">${icon('chat')}<h3>${COPY.emptyTitle}</h3><p>${COPY.emptyBody}</p></div>`
  if (mode === 'error') return `<div class="user">${COPY.sideUser}</div><div class="error"><strong>${COPY.errorTitle}</strong><p>${COPY.errorBody}</p>${button('retry', COPY.retry)}</div>`
  if (mode === 'approval') return `<div class="user">${COPY.awaitingUser}</div><div class="error"><strong>${COPY.awaitingTitle}</strong><p>${COPY.awaitingBody}</p>${button('approval', COPY.approval)}</div>`
  return `<div class="user">${COPY.sideUser}</div><div class="assistant-label">${icon('chat')}${COPY.assistant}<span class="dot"></span>${COPY.running}</div>
    <div class="message">${COPY.sideBody}</div><div class="tool-row">${icon('file')}${COPY.toolSide}</div>
    <div class="tool-row">${icon('chevron')}${COPY.sideProgress}</div><div class="note">${COPY.overlap}</div>`
}
function picker() {
  return `<div class="picker scroll"><header class="picker-heading"><h2>${COPY.pickerTitle}</h2><p>${COPY.pickerBody}</p></header>
    <div class="surface-grid">
      <button class="surface-card surface-card--chat" data-action="new">
        ${icon('chat')}<span class="surface-card-copy"><strong>${COPY.createSide}</strong><span>${COPY.createDescription}</span></span>${icon('chevron')}
      </button>
      ${COPY.surfaces.map(item => `<button class="surface-card" data-action="tool:${item.id}">${icon(item.icon)}<strong>${item.title}</strong><span>${item.description}</span></button>`).join('')}
    </div></div>`
}
function surfaceTabs() {
  const parent = current()
  return `<div class="surfacebar"><div class="tabs" role="tablist" aria-label="${COPY.surfaceLabel}">
    ${!parent.open.length ? `<span class="surface-label">${COPY.surfaceLabel}</span>` : parent.open.map(id => {
      const item = itemFor(id)
      const selected = parent.active === id && !parent.picker
      return `<div class="tab ${selected ? 'active' : ''}">
        <button id="tab-${id}" data-action="tab:${id}" role="tab" aria-selected="${selected}" aria-controls="surface-body" tabindex="${parent.active === id ? 0 : -1}">${icon(item.icon ?? 'chat')}<span>${escape(item.title)}</span>${item.mode === 'approval' ? `<span class="attention" aria-label="${COPY.attention}">${icon('alert')}</span>` : ''}</button>
        ${button(`close:${id}`, COPY.closeTab(item.title), 'close')}
      </div>`
    }).join('')}
    </div><div class="surface-actions">${parent.picker && parent.active ? button('back', COPY.back, 'back') : ''}${button('menu', COPY.addSurface, 'plus')}${button('history', COPY.history, 'history')}</div></div>`
}
function rightContent() {
  const parent = current()
  if (parent.picker) return picker()
  const surface = tool(parent.active)
  if (surface) return `<div class="scroll"><div class="empty">${icon(surface.icon)}<h3>${surface.title}</h3><p>${surface.description}</p><div class="note">${COPY.toolPreview}</div></div></div>`
  const side = entry()
  return `<div class="side-title"><div class="side-title-row"><h2>${escape(side.title)}</h2>${side.mode === 'live' ? `<span class="status"><span class="dot"></span>${COPY.running}</span>` : ''}</div>
    <button class="origin" data-action="snapshot">${icon('branch')}${state.parent ? COPY.originOther : COPY.origin}${icon('chevron')}</button></div>
    <div class="shared">${icon('folder')}<span>${COPY.shared}</span><span class="shared-detail">${COPY.sharedDetail}</span></div>
    <div class="scroll">${sideBody()}</div>${composer(true)}`
}
function sidebar() {
  return `<aside class="sidebar"><div class="traffic" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="side-new">${icon('plus')} ${COPY.newSession}</div><div class="section-label">${COPY.projects}</div><div class="project">${icon('folder')}${COPY.project}</div>
    ${COPY.parentTitles.map((title, index) => `<button class="session" data-action="parent:${index}" aria-pressed="${state.parent === index}"><span class="session-name">${title}</span><span class="session-meta"><span class="dot"></span>${COPY.sideCount(state.parents[index].entries.length)}${index === 0 ? `<span class="attention">${COPY.attention}</span>` : ''}</span></button>`).join('')}
    <div class="sidebar-bottom">${icon('folder')}${COPY.local}</div></aside>`
}
function mainChat() {
  return `<section class="chat main"><div class="head"><strong>${COPY.parentTitles[state.parent]}</strong><div class="tools"><span class="status"><span class="dot"></span>${COPY.running}</span>${button('picker', COPY.openSurface, 'panel')}</div></div>
    <div class="scroll"><div class="turn-marker"><span>${COPY.mainTurn}</span><span>${COPY.latest}</span></div><div class="user">${state.parent ? COPY.otherUser : COPY.mainUser}</div>
      <div class="assistant-label">${icon('chat')}${COPY.assistant}</div><div class="message">${state.parent ? COPY.otherBody : COPY.mainBody}</div>
      <div class="file-line">${icon('file')}<code>${COPY.file}</code></div><div class="tool-row">${icon('check')}${COPY.toolMain}</div><div class="tool-row">${icon('chevron')}${COPY.mainProgress}</div>
    </div>${composer(false)}</section>`
}
function render() {
  document.title = COPY.title
  document.body.classList.toggle('dark', state.dark)
  const activeScene = current().picker ? 'picker' : entry()?.mode
  app.innerHTML = `<header class="designbar"><div><span class="brand">${COPY.brand}</span><span class="designnote">${COPY.demo}</span></div>
    <nav class="controls">${Object.entries(COPY.modes).map(([key, label]) => button(`mode:${key}`, label, null, '', `aria-pressed="${activeScene === key}"`)).join('')}
      <span class="divider"></span>${button('narrow', COPY.narrow, null, '', `aria-pressed="${state.narrow}"`)}${button('theme', COPY.theme, 'sun')}</nav></header>
    <main class="stage"><div class="window ${state.narrow ? 'narrow' : ''} ${state.showMain ? 'show-main' : ''}">${sidebar()}<div class="workspace">
      <div class="mobile-switch">${button('main', COPY.mainTab, null, '', `aria-pressed="${state.showMain}"`)}${button('side', COPY.surfaceLabel, null, '', `aria-pressed="${!state.showMain}"`)}</div>
      ${mainChat()}<section class="chat side">${surfaceTabs()}<div id="surface-body" class="surface-body" ${current().picker ? '' : `role="tabpanel" aria-labelledby="tab-${current().active}"`}>${rightContent()}</div></section>
    </div></div><footer class="footer"><span ${state.notice ? 'role="status"' : ''}>${state.notice ? COPY[state.notice] : COPY.footer}</span><span><a href="README.md">${COPY.designLink}</a>${COPY.separator}<a href="technical-plan.md">${COPY.techLink}</a></span></footer></main>`
}
function showSnapshot() {
  dialog.innerHTML = `<div class="dialog-title"><h2 id="snapshot-title">${COPY.snapshotTitle}</h2>${button('dialog-close', COPY.close, 'close')}</div>
    <dl><dt>${COPY.source}</dt><dd>${COPY.parentTitles[state.parent]}</dd><dt>${COPY.boundary}</dt><dd>${state.parent ? COPY.snapshotBoundaryOther : COPY.snapshotBoundary}</dd>
      <dt>${COPY.captured}</dt><dd>${COPY.snapshotTime}</dd><dt>${COPY.included}</dt><dd>${state.parent ? COPY.snapshotIncludedOther : COPY.snapshotIncluded}</dd>
      <dt>${COPY.excluded}</dt><dd>${state.parent ? COPY.snapshotExcludedOther : COPY.snapshotExcluded}</dd></dl><p>${COPY.snapshotNote}</p>`
  dialog.setAttribute('aria-labelledby', 'snapshot-title')
  dialog.showModal()
}
function showMenu(action, contents) {
  historyMenu.innerHTML = contents
  const bounds = app.querySelector(`[data-action="${action}"]`).getBoundingClientRect()
  historyMenu.style.top = `${bounds.bottom + 8}px`
  historyMenu.style.left = `${Math.max(8, bounds.right - 300)}px`
  historyMenu.showPopover()
}
function showHistory() {
  showMenu('history', `<h3>${COPY.history}</h3><p>${COPY.historyHint}</p>${current().entries.map(item => `<button data-action="restore:${item.id}">${icon('chat')}<span>${escape(item.title)}</span>${item.mode === 'approval' ? `<span class="attention">${COPY.attention}</span>` : ''}</button>`).join('')}`)
}
function showSurfaceMenu() {
  showMenu('menu', `<h3>${COPY.addSurface}</h3><button data-action="new">${icon('chat')}${COPY.createSide}</button>${COPY.surfaces.map(item => `<button data-action="tool:${item.id}">${icon(item.icon)}${item.title}</button>`).join('')}`)
}
function activate(id) {
  const parent = current()
  if (!parent.open.includes(id)) parent.open.push(id)
  parent.active = id
  parent.picker = false
  state.showMain = false
}
function act(action) {
  const [kind, value] = action.split(':')
  state.notice = ''
  let focus = action
  if (kind === 'snapshot') return showSnapshot()
  if (kind === 'dialog-close') return dialog.close()
  if (kind === 'history') return showHistory()
  if (kind === 'menu') return showSurfaceMenu()
  if (kind === 'picker') { current().picker = true; state.showMain = false; focus = 'new' }
  if (kind === 'back') { current().picker = false; focus = `tab:${current().active}` }
  if (kind === 'mode') {
    if (value === 'picker') current().picker = true
    else {
      if (state.parent === 0) for (const id of ['files', 'a', 'b']) activate(id)
      activate(current().entries[0].id)
      entry().mode = value
    }
    state.showMain = false
  }
  if (kind === 'narrow') state.narrow = !state.narrow
  if (kind === 'theme') state.dark = !state.dark
  if (kind === 'parent') state.parent = Number(value)
  if (kind === 'main' || kind === 'side') state.showMain = kind === 'main'
  if (kind === 'tab' || kind === 'tool' || kind === 'restore') {
    activate(value)
    if (historyMenu.matches(':popover-open')) historyMenu.hidePopover()
    focus = `tab:${value}`
  }
  if (kind === 'close') {
    const parent = current()
    const index = parent.open.indexOf(value)
    parent.open = parent.open.filter(id => id !== value)
    if (parent.active === value) parent.active = parent.open[index] ?? parent.open[index - 1] ?? null
    parent.picker = !parent.active || parent.picker
    focus = parent.picker ? 'new' : `tab:${parent.active}`
  }
  if (kind === 'new') {
    if (historyMenu.matches(':popover-open')) historyMenu.hidePopover()
    const id = `new${++serial}`
    current().entries.push({ id, title: COPY.untitled, draft: '', mode: 'empty' })
    activate(id)
  }
  if (kind === 'send' || kind === 'retry' || kind === 'approval') state.notice = 'sentPreview'
  if (kind === 'stop') state.notice = 'stoppedPreview'
  render()
  if (kind === 'new') document.querySelector('#side-input')?.focus()
  else app.querySelector(`[data-action="${focus}"]`)?.focus()
}
app.addEventListener('click', event => {
  const target = event.target.closest('[data-action]')
  if (target) act(target.dataset.action)
})
historyMenu.addEventListener('click', event => {
  const target = event.target.closest('[data-action]')
  if (target) act(target.dataset.action)
})
dialog.addEventListener('click', event => {
  if (event.target.closest('[data-action="dialog-close"]')) dialog.close()
})
app.addEventListener('input', event => {
  if (event.target.id === 'side-input') entry().draft = event.target.value
  if (event.target.id === 'main-input') current().mainDraft = event.target.value
})
app.addEventListener('keydown', event => {
  if (event.key === 'Escape' && current().picker && current().active) { event.preventDefault(); act('back'); return }
  if (event.target.getAttribute('role') !== 'tab') return
  const tabs = [...app.querySelectorAll('[role="tab"]')]
  const index = tabs.indexOf(event.target)
  let next
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
  if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
  if (event.key === 'Home') next = 0
  if (event.key === 'End') next = tabs.length - 1
  if (next === undefined) return
  event.preventDefault()
  act(tabs[next].dataset.action)
})
render()
