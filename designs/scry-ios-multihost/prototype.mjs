import { copy, fixtures } from './copy.mjs'

// This state is deliberately synthetic. There is no transport or credential code.
export function initialState() {
  return {
    scope: 'all', scenario: 'online', query: '',
    target: 'mac2', project: 'scry', provider: 'Codex', draft: copy.samplePrompt,
    conversation: 'a', followup: '', changedHost: false
  }
}

export function selectTarget(state, host) {
  if (state.target === host) return state
  return { ...state, target: host, project: null, provider: null, changedHost: true }
}

export function hostState(state, host) {
  if (['gatewayOffline', 'phoneRevoked'].includes(state.scenario)) return state.scenario
  return host === 'mac1' ? 'online' : state.scenario
}

export function canSend(state, host = state.target, conversation = false) {
  const available = (conversation ? ['online'] : ['online', 'empty']).includes(hostState(state, host))
  return available && (conversation ? Boolean(state.followup.trim()) : Boolean(state.project && state.provider && state.draft.trim()))
}

export function visibleSessions(state) {
  return fixtures.sessions.filter(session => {
    if (state.scope !== 'all' && session.host !== state.scope) return false
    if (state.scenario === 'phoneRevoked') return false
    if (session.host === 'mac2' && ['revoked', 'missing', 'unsupported', 'empty', 'loading'].includes(state.scenario)) return false
    return [session.title, session.project, session.provider, name(session.host)].join(' ').toLowerCase().includes(state.query.trim().toLowerCase())
  })
}

export function openedConversation(state) {
  return fixtures.sessions.find(session => session.id === state.conversation)
}

const name = id => fixtures.hosts.find(host => host.id === id).name
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const icons = {
  laptop: '<rect x="4" y="4" width="16" height="12" rx="1.5"/><path d="M2 20h20l-2-4H4z"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v11H3z"/>',
  gauge: '<path d="M4 18a9 9 0 1 1 16 0M12 13l4-5"/><circle cx="12" cy="13" r="1.5"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  next: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  edit: '<path d="M13 5H5v15h15v-8M12 12l-1 4 4-1 7-8-3-3z"/>',
  more: '<circle cx="4" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="20" cy="12" r="1"/>',
  lock: '<rect x="6" y="10" width="12" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
  file: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"/>'
}
const icon = (id, cls = '') => `<svg class="${cls}" aria-hidden="true" viewBox="0 0 24 24">${icons[id]}</svg>`
const action = (id, label, symbol) => `<button class="icon-button" data-action="${id}" aria-label="${escape(label)}">${icon(symbol)}</button>`
const statusLabel = status => ({ online: '', empty: '', offline: copy.offline, gatewayOffline: copy.unknown, phoneRevoked: copy.phoneRevoked, failed: copy.unknown, revoked: copy.revoked, missing: copy.missing, unsupported: copy.unsupported, loading: copy.unknown })[status]
const statusHtml = (state, host) => {
  const label = statusLabel(hostState(state, host))
  return label ? `<span class="host-status warning">${escape(label)}</span>` : ''
}

let state = initialState()
let activePicker = null
let feedbackTimer

function feedback(message) {
  const node = document.querySelector('#feedback')
  node.textContent = message
  node.classList.add('visible')
  clearTimeout(feedbackTimer)
  feedbackTimer = setTimeout(() => node.classList.remove('visible'), 5000)
}

function notice(host = null) {
  const globalFailure = ['gatewayOffline', 'phoneRevoked'].includes(state.scenario)
  if (!globalFailure && (host === 'mac1' || (!host && state.scope === 'mac1'))) return ''
  const message = copy.notices[state.scenario]
  if (!message) return ''
  const retry = ['offline', 'failed', 'gatewayOffline'].includes(state.scenario)
  const cacheVisible = ['offline', 'failed', 'gatewayOffline'].includes(state.scenario)
  return `<div class="notice"><span>${escape(message)}${cacheVisible ? `<small class="freshness">${escape(copy.cached)}</small>` : ''}</span><span class="notice-actions">${retry ? `<button data-action="retry">${escape(copy.retry)}</button>` : ''}<button data-action="detail">${escape(copy.details)}</button></span></div>`
}

function sessionRow(session) {
  const status = hostState(state, session.host)
  const active = session.active && status === 'online'
  return `<button class="session" data-session="${session.id}"><span class="title-line"><strong>${escape(session.title)}</strong><span class="time">${escape(session.time)}</span></span><span class="metadata"><span class="host-tag">${escape(name(session.host))}</span><span>·</span><span>${escape(session.project)}</span><span>·</span><span>${escape(session.provider)}</span></span>${active ? `<span class="active-state"><i class="dot"></i>${escape(copy.executing)}</span>` : session.active ? `<span class="metadata">${escape(copy.lastRunning)}</span>` : ''}</button>`
}

function sessionList() {
  const list = visibleSessions(state)
  if (!list.length) {
    const loading = state.scenario === 'loading' && state.scope === 'mac2'
    const empty = state.scenario === 'empty' && state.scope === 'mac2' && !state.query
    return `<div class="empty">${icon('laptop')}<strong>${escape(loading ? copy.loading : empty ? copy.noSessions : copy.noMatches)}</strong>${empty ? `<p>${escape(copy.noSessionsDetail)}</p><button class="text-action" data-action="start-mac2">${escape(copy.newTask)}</button>` : ''}</div>`
  }
  const active = list.filter(session => session.active && hostState(state, session.host) === 'online')
  const recent = list.filter(session => !active.includes(session))
  return `${active.length ? `<h3 class="section-label">${escape(copy.running)}</h3>${active.map(sessionRow).join('')}` : ''}${recent.length ? `<h3 class="section-label">${escape(copy.recent)}</h3>${recent.map(sessionRow).join('')}` : ''}${state.scope === 'all' && ['loading', 'empty'].includes(state.scenario) ? `<p class="footer-state">${escape(state.scenario === 'loading' ? copy.loadingPartial : copy.emptyPartial)}</p>` : ''}`
}

function home() {
  return `<div class="safe-top"></div><header class="header"><div><h2>${escape(copy.sessions)}</h2><button class="scope" data-action="scope">${escape(state.scope === 'all' ? copy.allHosts : name(state.scope))}${icon('down')}</button></div><button class="icon-button primary" data-action="new" aria-label="${escape(copy.newTask)}">${icon('edit')}</button></header><div class="search">${icon('search')}<input id="search" aria-label="${escape(copy.search)}" placeholder="${escape(copy.search)}" value="${escape(state.query)}"></div>${notice()}<div class="scroll" id="session-list">${sessionList()}</div><div class="safe-bottom"></div>`
}

function contextRow(kind, symbol, title, value, tail = '', disabled = false) {
  return `<button class="context-row" data-action="${kind}" ${disabled ? 'disabled' : ''}>${icon(symbol)}<span class="context-text"><span class="field-label">${escape(title)}</span><span class="field-value">${escape(value)}</span></span>${tail}${icon('next', 'chevron')}</button>`
}

function composer(chat = false) {
  const host = chat ? openedConversation(state).host : state.target
  return `<div class="composer-wrap ${chat ? 'chat-composer' : ''}"><div class="composer"><textarea id="${chat ? 'followup' : 'draft'}" aria-label="${escape(chat ? copy.followup : copy.composer)}" placeholder="${escape(chat ? copy.followup : copy.composer)}">${escape(chat ? state.followup : state.draft)}</textarea><div class="composer-tools">${action('attachment', copy.attachment, 'plus')}<button class="send" id="${chat ? 'chat-send' : 'new-send'}" data-action="${chat ? 'send-followup' : 'send-new'}" ${canSend(state, host, chat) ? '' : 'disabled'}>${escape(copy.send(name(host)))}</button></div></div><div class="control-line">${icon('lock')}<span>${escape(chat ? openedConversation(state).provider : state.provider || copy.selectProvider)}</span></div>${!chat && state.changedHost && (!state.project || !state.provider) ? `<div class="composer-caption">${escape(copy.folderNeeded)}</div>` : ''}</div>`
}

function newTask() {
  const status = hostState(state, state.target)
  const blocked = !['online', 'empty'].includes(status)
  return `<div class="safe-top"></div><header class="simple-header"><h2 class="screen-title">${escape(copy.newTask)}</h2></header><div class="new-main"><div class="context">${contextRow('target', 'laptop', copy.host, copy.targetValue(state.target))}${contextRow('project', 'folder', copy.folder, state.project || copy.selectFolder, '', blocked)}${contextRow('provider', 'gauge', copy.provider, state.provider || copy.selectProvider, '', blocked)}</div>${notice(state.target)}${composer()}</div><div class="safe-bottom"></div>`
}

function conversation() {
  const session = openedConversation(state)
  const mac2 = session.host === 'mac2'
  const readable = state.scenario !== 'phoneRevoked' && (session.host === 'mac1' || !['revoked', 'missing', 'unsupported', 'empty', 'loading'].includes(state.scenario))
  return `<div class="safe-top"></div><header class="chat-header">${action('back', copy.arrowBack, 'back')}<div class="chat-heading"><h2>${escape(session.title)}</h2><div class="metadata"><span class="host-tag">${escape(name(session.host))}</span><span>·</span><span>${escape(session.project)}</span><span>·</span><span>${escape(session.provider)}</span>${mac2 ? `<span>·</span><span>${escape(copy.viaGateway)}</span>` : ''}</div></div>${action('more', copy.more, 'more')}</header>${notice(session.host)}<div class="scroll"><div class="conversation">${readable ? `<p class="chat-time">${escape(copy.chatTime)}</p><div class="user-message">${escape(mac2 ? copy.chatUser : session.title)}</div><div class="assistant-message"><p>${escape(copy.chatReply)}</p><p>${escape(copy.chatReply2)}</p></div><div class="evidence">${icon('file')}${escape(copy.evidence)}</div>` : `<div class="empty">${icon('laptop')}<strong>${escape(state.scenario === 'empty' ? copy.noSessions : state.scenario === 'loading' ? copy.loading : statusLabel(state.scenario))}</strong></div>`}</div></div>${composer(true)}<div class="safe-bottom"></div>`
}

function render() {
  document.title = copy.title
  document.querySelector('#app').innerHTML = `<div class="workspace"><p class="eyebrow">${escape(copy.eyebrow)}</p><h1>${escape(copy.heading)}</h1><p class="intro">${escape(copy.intro)}</p><div class="prototype-label">${escape(copy.prototype)}</div><div class="toolbar"><span class="chosen-direction">${escape(copy.direction)}</span><label>${escape(copy.scenario)}<select id="scenario">${Object.entries(copy.scenarios).map(([value, label]) => `<option value="${value}" ${state.scenario === value ? 'selected' : ''}>${escape(label)}</option>`).join('')}</select></label><a href="brief.md">${escape(copy.notes)}</a></div><div class="boards">${[home(), newTask(), conversation()].map((content, index) => `<section class="board"><h2 class="board-label">${escape(copy.boardLabels[index])}</h2><div class="phone" id="screen-${index}">${content}</div><p class="board-note">${escape(copy.boardNotes[index])}</p></section>`).join('')}</div><p class="endnote">${escape(copy.demoFoot)}<br>${escape(copy.version)}</p></div>`
}

function openPicker(kind) {
  activePicker = kind
  const dialog = document.querySelector('#picker')
  const heading = ({ scope: copy.chooseScope, target: copy.chooseHost, project: copy.projectTitle, provider: copy.providerTitle, manage: copy.manageTitle, detail: copy.detailTitle })[kind]
  let content
  if (kind === 'scope' || kind === 'target') {
    const selected = kind === 'scope' ? state.scope : state.target
    const all = kind === 'scope' ? `<button class="sheet-row" data-choice="all">${icon('laptop')}<span class="row-main"><strong>${escape(copy.allHosts)}</strong></span>${selected === 'all' ? icon('check', 'check') : ''}</button>` : ''
    const hosts = fixtures.hosts.filter(host => host.id === 'mac1' || state.scenario !== 'missing')
    content = `${all}<p class="sheet-label">${escape(copy.pairedHosts)}</p>${hosts.map(host => `<button class="sheet-row" data-choice="${host.id}">${icon('laptop')}<span class="row-main"><strong>${escape(host.name)}</strong><small>${escape(copy.hostMeta(host.id))}</small></span>${statusHtml(state, host.id)}${selected === host.id ? icon('check', 'check') : ''}</button>`).join('')}<button class="add-row" data-action="manage">${icon('laptop')}${escape(copy.manageHosts)}</button>`
  } else if (kind === 'manage' || kind === 'detail') {
    content = `<p class="pair-body">${escape(kind === 'manage' ? copy.manageBody : copy.detailBody(state.scenario))}</p><p class="pair-boundary">${escape(copy.manageBoundary)}</p><button class="text-action" data-action="close">${escape(copy.gotIt)}</button><p class="pair-foot">${escape(copy.manageFoot)}</p>`
  } else {
    const options = kind === 'project' ? fixtures.projects[state.target] : fixtures.providers[state.target]
    const selected = kind === 'project' ? state.project : state.provider
    content = options.map(value => `<button class="sheet-row" data-choice="${escape(value)}">${icon(kind === 'project' ? 'folder' : 'gauge')}<span class="row-main"><strong>${escape(value)}</strong><small>${escape(name(state.target))}</small></span>${selected === value ? icon('check', 'check') : ''}</button>`).join('')
  }
  dialog.innerHTML = `<div class="grabber"></div><header class="sheet-header"><h2>${escape(heading)}</h2>${action('close', copy.close, 'close')}</header>${content}`
  dialog.setAttribute('aria-label', heading)
  if (!dialog.open) dialog.showModal()
}

function handleChoice(value) {
  const dialog = document.querySelector('#picker')
  if (activePicker === 'scope') state.scope = value
  if (activePicker === 'target') state = selectTarget(state, value)
  if (activePicker === 'project') state.project = value
  if (activePicker === 'provider') state.provider = value
  // Close before replacing page nodes so native dialog focus restoration works.
  dialog.close()
  render()
  document.querySelector(`[data-action="${activePicker}"]`)?.focus({ preventScroll: true })
}

function handleAction(kind) {
  if (['scope', 'target', 'manage', 'detail'].includes(kind)) return openPicker(kind)
  if (kind === 'close') return document.querySelector('#picker').close()
  if (kind === 'retry') return feedback(copy.retryDemo)
  if (kind === 'new' || kind === 'start-mac2') {
    const host = kind === 'start-mac2' ? 'mac2' : state.scope === 'all' ? state.target : state.scope
    state = selectTarget(state, host)
    render()
    document.querySelector('#screen-1').scrollIntoView({ block: 'nearest', inline: 'center' })
    document.querySelector('[data-action="target"]').focus({ preventScroll: true })
    return
  }
  if (kind === 'project' || kind === 'provider') {
    return ['online', 'empty'].includes(hostState(state, state.target)) ? openPicker(kind) : feedback(copy.blocked)
  }
  if (kind === 'send-new' || kind === 'send-followup') {
    return feedback(copy.demoSend(name(kind === 'send-new' ? state.target : openedConversation(state).host)))
  }
  if (kind === 'attachment') return feedback(copy.attachmentDemo)
  if (kind === 'back') return document.querySelector('#screen-0').scrollIntoView({ block: 'nearest', inline: 'center' })
  if (kind === 'more') return feedback(copy.approvalDemo(name(openedConversation(state).host)))
}

if (typeof document !== 'undefined') {
  render()
  document.addEventListener('click', event => {
    const choice = event.target.closest('[data-choice]')
    if (choice) return handleChoice(choice.dataset.choice)
    const session = event.target.closest('[data-session]')
    if (session) {
      state.conversation = session.dataset.session
      render()
      document.querySelector('#screen-2').scrollIntoView({ block: 'nearest', inline: 'center' })
      return
    }
    const button = event.target.closest('[data-action]')
    if (button) handleAction(button.dataset.action)
  })
  document.addEventListener('input', event => {
    if (event.target.id === 'search') {
      state.query = event.target.value
      document.querySelector('#session-list').innerHTML = sessionList()
    }
    if (event.target.id === 'draft' || event.target.id === 'followup') {
      state[event.target.id] = event.target.value
      document.querySelector('#new-send').disabled = !canSend(state)
      document.querySelector('#chat-send').disabled = !canSend(state, openedConversation(state).host, true)
    }
  })
  document.addEventListener('change', event => {
    if (event.target.id === 'scenario') {
      state.scenario = event.target.value
      render()
    }
  })
}
