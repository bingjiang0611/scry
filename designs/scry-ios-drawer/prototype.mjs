import { copy, fixtures } from './copy.mjs'

// 纯状态：合成数据 + 可验证的列表规则。渲染在文件后半段。
export const RECENT_LIMIT = 4

export function initialState(overrides = {}) {
  return {
    tab: 'recent',
    drawer: false,
    search: false,
    query: '',
    menu: null,
    renaming: null,
    confirming: null,
    toast: null,
    collapsed: [],
    hostMenu: false,
    range: 30,
    expanded: 'srv1',
    sessions: fixtures.sessions.map(session => ({ ...session })),
    archived: [],
    ...overrides
  }
}

// 相对时间只用于展示；排序一律用 minutes。
export function relativeTime(minutes) {
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${Math.round(minutes)} 分钟前`
  const hours = minutes / 60
  if (hours < 22) return `${Math.round(hours)} 小时前`
  if (hours < 40) return '昨天'
  if (minutes < 60 * 24 * 7) return '本周'
  return '更早'
}

export function matches(session, query) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [session.title, session.project, session.provider, session.cwd]
    .join(' ')
    .toLowerCase()
    .includes(needle)
}

// 等待决定的行提到最上面，并从其余列表移出：手机上同一证据不重复渲染。
export function attention(state) {
  return state.sessions
    .filter(session => session.waiting && matches(session, state.query))
    .sort((a, b) => a.minutes - b.minutes)
}

export function pinned(state) {
  return state.sessions
    .filter(session => session.pinned && !session.waiting && matches(session, state.query))
    // pinnedMinutes 是“多少分钟前置顶”，越小越新，与 Mac 的 pinnedAt 倒序一致。
    .sort((a, b) => (a.pinnedMinutes ?? 0) - (b.pinnedMinutes ?? 0))
}

export function recents(state) {
  return state.sessions
    .filter(session => !session.pinned && !session.waiting && matches(session, state.query))
    .sort((a, b) => a.minutes - b.minutes)
}

export function projectGroups(state) {
  const groups = new Map()
  for (const session of state.sessions) {
    if (session.pinned || session.waiting || !matches(session, state.query)) continue
    const group = groups.get(session.cwd) ?? { cwd: session.cwd, name: session.project, sessions: [] }
    group.sessions.push(session)
    groups.set(session.cwd, group)
  }
  return [...groups.values()]
    .map(group => ({ ...group, sessions: group.sessions.sort((a, b) => a.minutes - b.minutes) }))
    .sort((a, b) => a.sessions[0].minutes - b.sessions[0].minutes)
}

// “查看全部 N 个会话”统计当前查询下真正有行可看的会话。
export function visibleCount(state) {
  return attention(state).length + pinned(state).length + recents(state).length
}

export function canOpen(session) {
  return session.openable !== false
}

export function togglePin(state, id) {
  const target = state.sessions.find(session => session.id === id)
  if (!target) return state
  const sessions = state.sessions.map(session => session.id !== id ? session
    : session.pinned ? stripPin(session) : { ...session, pinned: true, pinnedMinutes: 0 })
  return { ...state, sessions, menu: null }
}

function stripPin(session) {
  const { pinned, pinnedMinutes, ...rest } = session
  return rest
}

export function renameSession(state, id, title) {
  const value = title.trim().slice(0, 120)
  if (!value) return state
  return { ...state, sessions: state.sessions.map(session => session.id === id ? { ...session, title: value } : session) }
}

// 存档从所有列表移除并保留在已存档集合里，恢复走 restoreSession。
export function archiveSession(state, id) {
  const target = state.sessions.find(session => session.id === id)
  if (!target) return state
  return {
    ...state,
    sessions: state.sessions.filter(session => session.id !== id),
    archived: [{ ...target, running: false, waiting: false, pinned: false }, ...state.archived]
  }
}

export function restoreSession(state, id) {
  const target = state.archived.find(session => session.id === id)
  if (!target) return state
  return { ...state, archived: state.archived.filter(session => session.id !== id), sessions: [...state.sessions, target] }
}

export function toggleProject(state, cwd) {
  return {
    ...state,
    collapsed: state.collapsed.includes(cwd)
      ? state.collapsed.filter(value => value !== cwd)
      : [...state.collapsed, cwd]
  }
}

// MARK: - 渲染

const icons = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  down: '<path d="m7 10 5 5 5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.5V10h-5.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.2A1.6 1.6 0 0 0 7.5 19l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.7 13H3.5a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.5-2.5l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 11 3.7V3.5a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1z"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.7l2 2h7.3a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  pin: '<path d="M9 3.5h6l-.7 5.2 3.2 3.1H15v5.5l-3 3-3-3v-5.5H6.5l3.2-3.1z"/>',
  pencil: '<path d="M4 20h4L20 8l-4-4L4 16z"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2"/><path d="M5.5 9v9a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M10 13h4"/>',
  undo: '<path d="M9 7 4 12l5 5"/><path d="M4 12h9a6 6 0 0 1 6 6v1"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.2v.6"/>',
  play: '<circle cx="12" cy="12" r="8.5"/><path d="M10.5 9.2v5.6l4.5-2.8z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 6.5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  hand: '<path d="M9 12V6.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M15 11V7.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.2a5 5 0 0 1-4.2-2.3L4 14.5a1.6 1.6 0 0 1 2.6-1.8L9 15"/>',
  tray: '<path d="M4.5 14 7 5.5h10L19.5 14"/><path d="M4.5 14h4l1.2 2.2h4.6L15.5 14h4v3.6a1.4 1.4 0 0 1-1.4 1.4H5.9a1.4 1.4 0 0 1-1.4-1.4z"/>',
  chart: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5.5"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3 9 9M15 15l2.7 2.7M17.7 6.3 15 9M9 15l-2.7 2.7"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0z"/><path d="M12 17v4"/>',
  doc: '<path d="M6 3.5h7l5 5V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z"/><path d="M13 3.5V9h5"/><path d="M9 13h6M9 16.5h4"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10" rx="2"/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10"/>',
  'chevron-left': '<path d="m15 5-7 7 7 7"/>'
}

const icon = (name, size = 20) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${icons[name]}</svg>`

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

// 工具行的可用性由主机能力决定；不可用时给原因，不给假入口。
export function toolRows() {
  return copy.toolRows.map(row => ({
    ...row,
    statusText: row.available ? row.status : copy.toolUnavailable(row.status),
    openable: row.available
  }))
}

export function canOpenTool(row) {
  return row.available === true
}

// 缺失的指标保持 unavailable，绝不折成 0。
export function analyticsMetrics() {
  return fixtures.panels.analytics.metrics.map(metric => ({
    label: metric.label,
    value: metric.known ? metric.value : copy.panel.unavailable,
    evidence: metric.evidence,
    unavailable: !metric.known
  }))
}

function toolRowHtml(row) {
  return `<li class="tool-row-wrap">
    <button type="button" class="tool-row${row.openable ? '' : ' disabled'}" data-act="tool-${row.id}"
      ${row.openable ? '' : 'disabled aria-disabled="true"'}>
      <span class="tool-icon">${icon(row.icon, 19)}</span>
      <span class="tool-text">
        <span class="tool-name">${escape(row.label)}</span>
        <span class="tool-status${row.tone === 'warn' ? ' warn' : ''}">${escape(row.statusText)}</span>
      </span>
      ${row.openable ? icon('chevron', 13) : ''}
    </button>
  </li>`
}

function toolsHtml(board) {
  return `<div class="scroll">
    <section class="section">
      <p class="section-label">${escape(copy.toolsLabel)}</p>
      <ul class="tools">${toolRows().map(toolRowHtml).join('')}</ul>
      <p class="section-note">${escape(copy.toolsNote)}</p>
    </section>
    <div class="scroll-tail"></div>
  </div>`
}

function rowHtml(board, session, { indent = false, showProject = true } = {}) {
  const meta = [session.provider, showProject ? session.project : null].filter(Boolean).join(' · ')
  const openable = canOpen(session)
  const badge = session.waiting ? `<span class="badge waiting">${escape(copy.waiting)}</span>`
    : session.running ? `<span class="badge running">${escape(copy.running)}</span>`
      : session.draft ? `<span class="badge draft">${escape(copy.draft)}</span>`
        : `<span class="time">${escape(relativeTime(session.minutes))}</span>`
  return `<li class="row-wrap">
    <button type="button" class="row${indent ? ' indented' : ''}${openable ? '' : ' disabled'}"
      data-row="${escape(session.id)}" ${openable ? '' : `aria-disabled="true" title="${escape(copy.noSessionHint)}"`}>
      <span class="row-main">
        <span class="row-title">${escape(session.title)}</span>
        <span class="row-meta">
          <span class="row-context">${escape(meta)}</span>
          <span class="row-state">${openable ? badge : `<span class="time">${escape(copy.notOpenable)}</span>`}</span>
        </span>
      </span>
      ${openable ? '' : '<span class="row-lock" aria-hidden="true">!</span>'}
    </button>
  </li>`
}

function groupHtml(board, group) {
  const collapsed = board.state.collapsed.includes(group.cwd)
  return `<li class="group">
    <div class="group-head">
      <button type="button" class="group-toggle" data-act="collapse" data-cwd="${escape(group.cwd)}"
        aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${escape(group.name)}：${collapsed ? copy.expand : copy.collapse}">
        <span class="group-caret${collapsed ? ' folded' : ''}">${icon('down', 14)}</span>
        <span class="group-icon">${icon('folder', 17)}</span>
        <span class="group-name">${escape(group.name)}</span>
        <span class="group-count">${group.sessions.length}</span>
      </button>
      <button type="button" class="row-action" data-act="new-in-project" data-cwd="${escape(group.cwd)}"
        aria-label="${escape(copy.newSession)}：${escape(group.name)}">${icon('plus', 18)}</button>
    </div>
    ${collapsed ? '' : `<ul class="rows">${group.sessions.map(session => rowHtml(board, session, { indent: true })).join('')}</ul>`}
  </li>`
}

function listHtml(board) {
  const state = board.state
  if (state.tab === 'tools') return toolsHtml(board)
  const needs = attention(state)
  const pins = pinned(state)
  const recent = recents(state)
  const groups = projectGroups(state)
  const total = visibleCount(state)
  const empty = total === 0

  if (empty) {
    return `<div class="empty">
      <p class="empty-title">${escape(copy.noMatchesTitle)}</p>
      <p class="empty-body">${escape(copy.noMatchesDetail)}</p>
    </div>`
  }

  if (state.tab === 'projects') {
    return `<div class="scroll">
      <ul class="groups">${groups.map(group => groupHtml(board, group)).join('')}</ul>
      <div class="scroll-tail"></div>
    </div>`
  }

  const shown = recent.slice(0, RECENT_LIMIT)
  const overflow = total - needs.length - pins.length - shown.length
  return `<div class="scroll">
    ${needs.length ? `<section class="section">
      <p class="section-label">${escape(copy.sectionNeedsYou)}</p>
      <ul class="rows">${needs.map(session => rowHtml(board, session)).join('')}</ul>
    </section>` : ''}
    ${pins.length ? `<section class="section">
      <p class="section-label">${escape(copy.sectionPinned)}</p>
      <ul class="rows">${pins.map(session => rowHtml(board, session)).join('')}</ul>
    </section>` : ''}
    ${recent.length ? `<section class="section">
      <p class="section-label">${escape(copy.sectionRecent)}</p>
      <ul class="rows">${shown.map(session => rowHtml(board, session, { showProject: true })).join('')}</ul>
    </section>` : ''}
    ${overflow > 0 ? `<button type="button" class="see-all" data-act="see-all">${escape(copy.seeAll(total))}</button>` : ''}
    <div class="scroll-tail"></div>
  </div>`
}

function headerHtml(board) {
  const state = board.state
  if (!state.search) {
    return `<div class="drawer-head">
      <h2 class="drawer-title">${escape(copy.drawerTitle)}</h2>
      <button type="button" class="hit" data-act="search" aria-label="${escape(copy.search)}">${icon('search', 21)}</button>
    </div>`
  }
  return `<div class="drawer-head searching">
    <div class="search-field">
      ${icon('search', 17)}
      <input type="search" data-search-input value="${escape(state.query)}" placeholder="${escape(copy.searchField)}"
        aria-label="${escape(copy.search)}" autocomplete="off" spellcheck="false">
    </div>
    <button type="button" class="text-action" data-act="search-cancel">${escape(copy.cancel)}</button>
  </div>`
}

function tabsHtml(board) {
  const state = board.state
  const tab = (id, label) => `<button type="button" role="tab" id="tab-${id}" aria-selected="${state.tab === id}"
    aria-controls="drawer-list" class="tab${state.tab === id ? ' active' : ''}" data-act="tab-${id}">${escape(label)}</button>`
  return `<div class="tabs" role="tablist" aria-label="${escape(copy.tabRecent)} / ${escape(copy.tabProjects)} / ${escape(copy.tabTools)}">
    ${tab('recent', copy.tabRecent)}${tab('projects', copy.tabProjects)}${tab('tools', copy.tabTools)}
  </div>`
}

function footerHtml(board) {
  return `<div class="drawer-foot">
    <p class="host-line"><span class="status-dot" aria-hidden="true"></span>${escape(copy.hostOne)} · ${escape(copy.version)}</p>
    <div class="foot-actions">
      <button type="button" class="primary-pill" data-act="new">
        ${icon('plus', 18)}<span>${escape(copy.newSession)}</span>
      </button>
      <button type="button" class="round" data-act="settings" aria-label="${escape(copy.settings)}">${icon('gear', 20)}</button>
    </div>
    <button type="button" class="archived-link" data-act="archived">${escape(copy.archivedSessions)}
      <span class="archived-count">${board.state.archived.length}</span>${icon('chevron', 13)}</button>
  </div>`
}

function drawerHtml(board) {
  const state = board.state
  const open = state.drawer
  return `<div class="scrim${open ? ' open' : ''}" data-act="close" aria-hidden="true"></div>
  <aside class="drawer${open ? ' open' : ''}" role="dialog" aria-modal="true" aria-label="${escape(copy.openList)}"
    aria-hidden="${open ? 'false' : 'true'}" ${open ? '' : 'inert'}>
    ${headerHtml(board)}
    ${tabsHtml(board)}
    <div id="drawer-list" role="tabpanel" aria-labelledby="tab-${state.tab}" class="drawer-list">${listHtml(board)}</div>
    ${footerHtml(board)}
  </aside>`
}

function homeBodyHtml(board) {
  const state = board.state
  if (board.kind !== 'evidence') {
    const recent = state.sessions.filter(session => !session.waiting).sort((a, b) => a.minutes - b.minutes).slice(0, 3)
    return `<div class="home-body">
      <div class="peek">
        <p class="section-label">${escape(copy.recentPeek)}</p>
        <ul class="rows">${recent.map(session => rowHtml(board, session, { showProject: true })).join('')}</ul>
      </div>
    </div>`
  }
  return `<div class="home-body evidence">
    <div class="card warn">
      <div class="card-line">
        ${icon('alert', 18)}
        <div class="card-text">
          <p class="card-title">${escape(copy.failureTitle)}</p>
          <p class="card-body">${escape(copy.failureDetail)}</p>
        </div>
      </div>
      <div class="card-actions">
        <button type="button" class="text-action strong" data-act="refresh">${escape(copy.retry)}</button>
        <button type="button" class="text-action" data-act="refresh">${escape(copy.details)}</button>
      </div>
    </div>
    <div class="card">
      <div class="card-line">
        ${icon('play', 18)}
        <div class="card-text">
          <p class="card-title">${escape(copy.returnToTask)}</p>
          <p class="card-body">${escape(copy.returnToTaskDetail)}</p>
        </div>
      </div>
      <div class="card-actions">
        <button type="button" class="text-action strong" data-act="open-running">${escape(copy.continueTask)}</button>
      </div>
    </div>
    <div class="card">
      <div class="card-line">
        ${icon('tray', 18)}
        <div class="card-text">
          <p class="card-title">${escape(copy.queueTitle)}</p>
          <p class="card-body">${escape(copy.queueUnknown)}</p>
        </div>
      </div>
      <div class="card-actions">
        <button type="button" class="text-action strong" data-act="waiting">${escape(copy.queueAction)}</button>
        <button type="button" class="text-action" data-act="waiting">${escape(copy.remove)}</button>
      </div>
    </div>
  </div>`
}

function composerHtml() {
  return `<div class="composer-wrap">
    <div class="composer">
      <div class="chips">
        <button type="button" class="chip" data-act="project">${icon('folder', 14)}<span>scry</span>${icon('down', 12)}</button>
        <button type="button" class="chip" data-act="provider"><span>Codex</span>${icon('down', 12)}</button>
      </div>
      <div class="composer-row">
        <button type="button" class="composer-plus" data-act="attach" aria-label="${escape(copy.addAttachment)}">${icon('plus', 20)}</button>
        <input class="composer-field" type="text" placeholder="${escape(copy.composerPlaceholder)}"
          aria-label="${escape(copy.composerPlaceholder)}" autocomplete="off" spellcheck="false">
        <button type="button" class="composer-send" data-act="send" aria-label="${escape(copy.send)}">${icon('send', 17)}</button>
      </div>
    </div>
  </div>`
}

function panelHeadHtml(board, title) {
  return `<header class="panel-head">
    <button type="button" class="hit" data-act="panel-back" aria-label="${escape(copy.panel.back)}">${icon('chevron-left', 21)}</button>
    <div class="panel-title-group">
      <h2 class="panel-title">${escape(title)}</h2>
      <p class="panel-sub">${escape(copy.panel.provenance(copy.hostOne, '21:32'))}</p>
    </div>
    <button type="button" class="hit" data-act="panel-refresh" aria-label="${escape(copy.panel.refresh)}">${icon('refresh', 19)}</button>
  </header>`
}

function analyticsPanelHtml(board) {
  const data = fixtures.panels.analytics
  return `<div class="range-row" role="group" aria-label="${escape(copy.analytics.rangeLabel)}">
    <div class="segmented">
      ${copy.analytics.ranges.map(days => `<button type="button" data-act="range" data-days="${days}"
        aria-pressed="${board.state.range === days}">${escape(copy.analytics.rangeLabelOf(days))}</button>`).join('')}
    </div>
  </div>
  <section class="panel-block">
    <p class="stat-label">${escape(copy.analytics.cost)}</p>
    <p class="stat-value">${escape(data.cost)}</p>
    <p class="stat-evidence">${escape(copy.analytics.costEvidence)}</p>
  </section>
  <ul class="metric-grid">
    ${analyticsMetrics().map(metric => `<li class="metric${metric.unavailable ? ' is-unavailable' : ''}">
      <p class="metric-label">${escape(metric.label)}</p>
      <p class="metric-value">${escape(metric.value)}</p>
      <p class="metric-evidence">${escape(metric.evidence)}</p>
    </li>`).join('')}
  </ul>
  <section class="panel-block">
    <p class="section-label">${escape(copy.analytics.breakdown)}</p>
    <ul class="bar-rows">
      ${data.rows.map(row => `<li class="bar-row">
        <span class="bar-name">${escape(row.name)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.round(row.share * 100)}%"></span></span>
        <span class="bar-value">${escape(row.value)}</span>
      </li>`).join('')}
    </ul>
    <p class="limit-note">${escape(copy.analytics.breakdownNote)}</p>
    <button type="button" class="see-all" data-act="panel-refresh">${escape(copy.panel.more)}</button>
  </section>`
}

function mcpPanelHtml(board) {
  const data = fixtures.panels.mcpTrust
  return `<section class="panel-block">
    <p class="stat-label">${escape(copy.mcpTrust.summaryLabel)}</p>
    <p class="stat-value ok">${escape(copy.mcpTrust.summary)}</p>
    <p class="stat-evidence">${escape(copy.mcpTrust.summaryNote)}</p>
    <p class="stat-evidence">${escape(copy.mcpTrust.mode)}</p>
  </section>
  <ul class="servers">
    ${data.servers.map(server => {
      const open = board.state.expanded === server.id
      const count = server.findings.length
      return `<li class="server">
      <button type="button" class="server-head" data-act="mcp-toggle" data-id="${server.id}" aria-expanded="${open}">
        <span class="dot ${server.tone}"></span>
        <span class="server-text">
          <span class="server-name">${escape(server.name)}</span>
          <span class="server-meta">${escape(server.transport)} · ${escape(server.digest)}</span>
        </span>
        <span class="badge ${server.tone === 'warn' ? 'waiting' : 'draft'}">${escape(server.state)}</span>
        ${count ? icon('down', 14) : ''}
      </button>
      ${open && count ? `<ul class="findings">
        ${server.findings.map(finding => `<li class="finding">
          <span class="badge ${finding.severity === 'warn' ? 'waiting' : 'draft'}">${escape(copy.mcpTrust.severityLabel[finding.severity] ?? finding.severity)}</span>
          <span>${escape(finding.text)}</span>
        </li>`).join('')}
      </ul>` : ''}
    </li>`}).join('')}
  </ul>
  <div class="card">
    <div class="card-line">
      ${icon('lock', 18)}
      <div class="card-text">
        <p class="card-title">${escape(copy.panel.macOnly)}</p>
        <p class="card-body">${escape(copy.mcpTrust.actionNote)}</p>
      </div>
    </div>
  </div>`
}

function panelHtml(board) {
  const title = board.kind === 'analytics' ? copy.analytics.title : copy.mcpTrust.title
  return `<div class="panel-home">
    <div class="safe-top"></div>
    ${panelHeadHtml(board, title)}
    <div class="panel-body">${board.kind === 'analytics' ? analyticsPanelHtml(board) : mcpPanelHtml(board)}</div>
    <div class="safe-bottom"></div>
  </div>`
}

function topbarHtml(board) {
  return `<header class="topbar">
    <button type="button" class="hit" data-act="drawer" aria-label="${escape(copy.openList)}" aria-expanded="${board.state.drawer}">${icon('menu', 21)}</button>
    <button type="button" class="host-chip" data-act="host" aria-haspopup="menu">
      <span class="status-dot" aria-hidden="true"></span>
      <span>${escape(copy.hostOne)}</span>
      ${icon('down', 13)}
    </button>
    <button type="button" class="hit" data-act="refresh" aria-label="刷新会话">${icon('refresh', 20)}</button>
  </header>`
}

function overlaysHtml(board) {
  const state = board.state
  const parts = []
  if (state.hostMenu) {
    parts.push(`<div class="popover-scrim" data-act="host-close"></div>
    <div class="menu host-menu" role="menu" aria-label="${escape(copy.hostMenuTitle)}">
      <p class="menu-note">${escape(copy.hostMenuNote)}</p>
      <button type="button" role="menuitem" class="menu-item" data-act="host-pick">
        <span class="menu-icon">${icon('check', 16)}</span><span>${escape(copy.hostOne)}</span>
      </button>
      <div class="menu-divider"></div>
      <button type="button" role="menuitem" class="menu-item" data-act="connect">
        <span class="menu-icon">${icon('plus', 16)}</span><span>${escape(copy.connectAnother)}</span>
      </button>
    </div>`)
  }
  if (state.menu) {
    const session = state.sessions.find(value => value.id === state.menu.id)
    if (session) {
      const archiveLabel = session.running || session.waiting ? copy.menuArchiveRunning : copy.menuArchive
      parts.push(`<div class="popover-scrim" data-act="menu-close"></div>
      <div class="menu row-menu" role="menu" style="top:${state.menu.top}px; right:${state.menu.right}px">
        <button type="button" role="menuitem" class="menu-item" data-act="menu-pin" data-id="${escape(session.id)}">
          <span class="menu-icon">${icon('pin', 16)}</span><span>${session.pinned ? escape(copy.menuUnpin) : escape(copy.menuPin)}</span>
        </button>
        <button type="button" role="menuitem" class="menu-item" data-act="menu-rename" data-id="${escape(session.id)}">
          <span class="menu-icon">${icon('pencil', 16)}</span><span>${escape(copy.menuRename)}</span>
        </button>
        <div class="menu-divider"></div>
        <button type="button" role="menuitem" class="menu-item" data-act="menu-archive" data-id="${escape(session.id)}">
          <span class="menu-icon">${icon('archive', 16)}</span><span>${escape(archiveLabel)}</span>
        </button>
      </div>`)
    }
  }
  if (state.renaming) {
    const session = state.sessions.find(value => value.id === state.renaming.id)
    parts.push(`<div class="popover-scrim" data-act="sheet-close"></div>
    <form class="sheet" data-act="noop" aria-label="${escape(copy.renameTitle)}">
      <p class="sheet-title">${escape(copy.renameTitle)}</p>
      <input type="text" class="sheet-input" data-rename-input value="${escape(session?.title ?? '')}"
        placeholder="${escape(copy.renamePlaceholder)}" aria-label="${escape(copy.renamePlaceholder)}">
      <div class="sheet-actions">
        <button type="button" class="text-action" data-act="sheet-close">${escape(copy.cancel)}</button>
        <button type="button" class="text-action strong" data-act="save-rename">${escape(copy.save)}</button>
      </div>
    </form>`)
  }
  if (state.confirming) {
    parts.push(`<div class="popover-scrim" data-act="sheet-close"></div>
    <div class="sheet" role="alertdialog" aria-label="${escape(copy.archiveTitle)}">
      <p class="sheet-title">${escape(copy.archiveTitle)}</p>
      <p class="sheet-body">${escape(state.confirming.running ? copy.archiveBodyRunning : copy.archiveBody)}</p>
      <div class="sheet-actions">
        <button type="button" class="text-action" data-act="sheet-close">${escape(copy.cancel)}</button>
        <button type="button" class="text-action strong" data-act="confirm-archive">${escape(state.confirming.running ? copy.archiveRunningAction : copy.archiveAction)}</button>
      </div>
    </div>`)
  }
  if (state.toast) {
    parts.push(`<div class="toast" role="status">
      <span>${escape(state.toast.text)}</span>
      ${state.toast.undo ? `<button type="button" class="toast-undo" data-act="undo">${icon('undo', 15)}<span>${escape(copy.undo)}</span></button>` : ''}
    </div>`)
  }
  return parts.join('')
}

function boardHtml(board) {
  if (board.kind === 'analytics' || board.kind === 'mcp') {
    return `<div class="phone" data-board="${board.id}">${panelHtml(board)}</div>`
  }
  const body = homeBodyHtml(board)
  const drawerOpen = board.state.drawer
  return `<div class="phone" data-board="${board.id}">
    <div class="home" ${drawerOpen ? 'aria-hidden="true"' : ''}>
      <div class="safe-top"></div>
      ${topbarHtml(board)}
      ${board.kind === 'evidence' ? `<button type="button" class="banner" data-act="waiting">${icon('hand', 16)}<span>${escape(copy.waitingBanner)}</span></button>` : ''}
      ${body}
      ${composerHtml()}
      <div class="safe-bottom"></div>
    </div>
    ${drawerHtml(board)}
    ${overlaysHtml(board)}
  </div>`
}

// 供检查与运行时共用：按画板 id 渲染完整手机视图。
export function renderBoard(id) {
  return boardHtml(board(id))
}

function boardsHtml() {
  return copy.boards.map(meta => `<section class="board" id="board-${meta.id}">
    <p class="board-label">${escape(meta.label)}</p>
    ${boardHtml(board(meta.id))}
    <p class="board-note">${escape(meta.note)}</p>
  </section>`).join('')
}

// 每块画板一个独立状态，互不影响评审。
const boardStates = new Map()
function board(id) {
  if (!boardStates.has(id)) {
    const meta = copy.boards.find(value => value.id === id)
    const kind = meta?.id ?? 'home'
    boardStates.set(id, {
      id,
      kind,
      state: initialState({
        drawer: kind === 'recent' || kind === 'projects' || kind === 'tools',
        tab: kind === 'projects' ? 'projects' : kind === 'tools' ? 'tools' : 'recent'
      })
    })
  }
  return boardStates.get(id)
}

function rerender(boardId) {
  if (typeof document === 'undefined') return
  const node = document.querySelector(`[data-board="${boardId}"]`)
  if (!node) return
  const fresh = board(boardId)
  node.outerHTML = boardHtml(fresh)
}

function rerenderListOnly(boardId) {
  if (typeof document === 'undefined') return
  const node = document.querySelector(`[data-board="${boardId}"] #drawer-list`)
  if (node) node.innerHTML = listHtml(board(boardId))
}

function flash(boardId, text, undo = null) {
  const value = board(boardId)
  value.state.toast = { text, undo }
  rerender(boardId)
  if (typeof window !== 'undefined') {
    window.clearTimeout(value.toastTimer)
    value.toastTimer = window.setTimeout(() => {
      value.state.toast = null
      rerender(boardId)
    }, 5_000)
  }
}

function openRowMenu(boardId, id) {
  const value = board(boardId)
  const phone = document.querySelector(`[data-board="${boardId}"]`)
  const row = phone?.querySelector(`[data-row="${id}"]`)
  if (!phone || !row) return
  const phoneBox = phone.getBoundingClientRect()
  const rowBox = row.getBoundingClientRect()
  value.state.menu = {
    id,
    top: Math.round(rowBox.bottom - phoneBox.top - 8),
    right: Math.max(12, Math.round(phoneBox.right - rowBox.right))
  }
  rerender(boardId)
}

function handleAction(boardId, action, target, event) {
  const value = board(boardId)
  const state = value.state
  switch (action) {
    case 'drawer': state.drawer = true; return rerender(boardId)
    case 'close': state.drawer = false; state.search = false; state.hostMenu = false; return rerender(boardId)
    case 'search': {
      state.search = true
      rerender(boardId)
      const input = document.querySelector(`[data-board="${boardId}"] [data-search-input]`)
      input?.focus()
      input?.setSelectionRange(input.value.length, input.value.length)
      return undefined
    }
    case 'search-cancel': state.search = false; state.query = ''; return rerender(boardId)
    case 'tab-recent': state.tab = 'recent'; return rerender(boardId)
    case 'tab-projects': state.tab = 'projects'; return rerender(boardId)
    case 'tab-tools': state.tab = 'tools'; return rerender(boardId)
    case 'range': state.range = Number(target.dataset.days); return rerender(boardId)
    case 'mcp-toggle': {
      state.expanded = state.expanded === target.dataset.id ? null : target.dataset.id
      return rerender(boardId)
    }
    case 'panel-back':
    case 'panel-refresh':
      return flash(boardId, copy.panel.readOnly)
    case 'see-all': state.tab = 'projects'; return rerender(boardId)
    case 'collapse': {
      state.collapsed = toggleProject(state, target.dataset.cwd).collapsed
      return rerender(boardId)
    }
    case 'new-in-project': return flash(boardId, copy.feedback.newSession)
    case 'new': return flash(boardId, copy.feedback.newSession)
    case 'settings': return flash(boardId, copy.feedback.settings)
    case 'archived': return flash(boardId, copy.feedback.archivedList)
    case 'refresh': return flash(boardId, copy.feedback.refresh)
    case 'host': state.hostMenu = true; return rerender(boardId)
    case 'host-close': state.hostMenu = false; return rerender(boardId)
    case 'host-pick': state.hostMenu = false; return flash(boardId, copy.feedback.hostFilter)
    case 'connect': state.hostMenu = false; return flash(boardId, copy.feedback.connect)
    case 'attach': case 'project': case 'provider': case 'focus': return flash(boardId, copy.feedback.send)
    case 'send': return flash(boardId, copy.feedback.send)
    case 'open-running': case 'waiting': return flash(boardId, copy.feedback.openSession(copy.returnToTask))
    case 'menu-close': state.menu = null; return rerender(boardId)
    case 'menu-pin': {
      const session = state.sessions.find(item => item.id === target.dataset.id)
      const wasPinned = Boolean(session?.pinned)
      togglePin(state, target.dataset.id)
      return flash(boardId, wasPinned ? copy.feedback.unpin(session.title) : copy.feedback.pin(session.title))
    }
    case 'menu-rename': state.menu = null; state.renaming = { id: target.dataset.id }; return rerender(boardId)
    case 'menu-archive': {
      const session = state.sessions.find(item => item.id === target.dataset.id)
      state.menu = null
      if (session?.running || session?.waiting) { state.confirming = { id: session.id, running: true }; return rerender(boardId) }
      archiveSession(state, target.dataset.id)
      return flash(boardId, copy.feedback.archived(session?.title ?? ''), session?.id ?? null)
    }
    case 'sheet-close': state.renaming = null; state.confirming = null; return rerender(boardId)
    case 'save-rename': {
      const input = document.querySelector(`[data-board="${boardId}"] [data-rename-input]`)
      const id = state.renaming?.id
      state.renaming = null
      renameSession(state, id, input?.value ?? '')
      return flash(boardId, copy.renamed)
    }
    case 'confirm-archive': {
      const id = state.confirming?.id
      const session = state.sessions.find(item => item.id === id)
      state.confirming = null
      archiveSession(state, id)
      return flash(boardId, copy.feedback.archived(session?.title ?? ''), id)
    }
    case 'undo': {
      const id = state.toast?.undo
      if (!id) return
      const archived = state.archived.find(item => item.id === id)
      restoreSession(state, id)
      return flash(boardId, copy.feedback.restored(archived?.title ?? ''))
    }
    case 'noop': return event?.preventDefault()
    default: return undefined
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const app = document.querySelector('#app')
    if (app) {
      app.innerHTML = `<main class="workspace">
        <h1>${escape(copy.heading)}</h1>
        <p class="intro">${escape(copy.intro)}</p>
        <p class="prototype-label">${escape(copy.prototype)}</p>
        <p class="hint">${escape(copy.hint)}</p>
        <div class="zoom" role="group" aria-label="${escape(copy.zoom.label)}">
          <button type="button" class="zoom-button" data-zoom="fit" aria-pressed="true">${escape(copy.zoom.fit)}</button>
          <button type="button" class="zoom-button" data-zoom="full" aria-pressed="false">${escape(copy.zoom.full)}</button>
        </div>
        <div class="boards">${boardsHtml()}</div>
        <p class="footer-note"><a href="brief.md">${escape(copy.brief)}</a></p>
      </main>`
    }
    document.addEventListener('click', event => {
      const zoom = event.target.closest('[data-zoom]')
      if (zoom) {
        document.body.dataset.zoom = zoom.dataset.zoom
        for (const button of document.querySelectorAll('.zoom-button')) {
          button.setAttribute('aria-pressed', String(button === zoom))
        }
        return undefined
      }
      const action = event.target.closest('[data-act]')
      if (action) {
        const phone = action.closest('[data-board]')
        event.preventDefault()
        return handleAction(phone.dataset.board, action.dataset.act, action, event)
      }
      const row = event.target.closest('[data-row]')
      if (row) {
        const phone = row.closest('[data-board]')
        const value = board(phone.dataset.board)
        const session = value.state.sessions.find(item => item.id === row.dataset.row)
        if (!session) return
        return flash(phone.dataset.board, copy.feedback.openSession(session.title))
      }
      return undefined
    })
    document.addEventListener('contextmenu', event => {
      const row = event.target.closest('[data-row]')
      if (!row) return
      event.preventDefault()
      openRowMenu(row.closest('[data-board]').dataset.board, row.dataset.row)
    })
    let pressTimer = null
    document.addEventListener('pointerdown', event => {
      const row = event.target.closest('[data-row]')
      if (!row) return
      const boardId = row.closest('[data-board]').dataset.board
      pressTimer = window.setTimeout(() => openRowMenu(boardId, row.dataset.row), 480)
    })
    document.addEventListener('pointerup', () => window.clearTimeout(pressTimer))
    document.addEventListener('pointercancel', () => window.clearTimeout(pressTimer))
    // 03 号画板默认展开一次行菜单，让评审不用先猜长按。
    openRowMenu('projects', 's6')
    document.addEventListener('input', event => {
      const input = event.target.closest('[data-search-input]')
      if (!input) return
      const boardId = input.closest('[data-board]').dataset.board
      board(boardId).state.query = input.value
      rerenderListOnly(boardId)
    })
  })
}
