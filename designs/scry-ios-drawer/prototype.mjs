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
    chart: 'cost',
    breakdown: 'model',
    llmRange: 24,
    llmMetric: 'speed',
    llmSelected: null,
    skillScope: 'project',
    metaSelected: null,
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
  box: '<path d="m12 3 8 4.2v9.6L12 21l-8-4.2V7.2z"/><path d="M4 7.2 12 11.4l8-4.2M12 11.4V21"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 5.5v-1a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  'chevron-left': '<path d="m15 5-7 7 7 7"/>'
}

const icon = (name, size = 20) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${icons[name]}</svg>`

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

// 工具行的可用性由主机能力决定；不可用时给原因，不给假入口。
export function toolRows(capabilities = {}) {
  return copy.toolRows.map(row => {
    const openable = capabilities[row.id] !== false
    return {
      ...row,
      available: openable,
      statusText: openable ? row.status : copy.toolUnavailable(copy.toolGated[row.id] ?? copy.panel.unavailable),
      openable
    }
  })
}

export function canOpenTool(row) {
  return row.openable === true
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

const PANEL_KINDS = ['analytics', 'llm', 'skills', 'mcp', 'meta']
const PANEL_TITLES = () => ({ analytics: copy.analytics.title, llm: copy.llm.title, skills: copy.skills.title, mcp: copy.mcp.title, meta: copy.meta.title })

function panelHeadHtml(board) {
  return `<header class="panel-head">
    <button type="button" class="hit" data-act="panel-back" aria-label="${escape(copy.panel.back)}">${icon('chevron-left', 21)}</button>
    <div class="panel-title-group">
      <h2 class="panel-title">${escape(PANEL_TITLES()[board.kind])}</h2>
      <p class="panel-sub">${escape(copy.panel.provenance(copy.hostOne, '21:32'))}</p>
    </div>
    <button type="button" class="hit" data-act="panel-refresh" aria-label="${escape(copy.panel.refresh)}">${icon('refresh', 19)}</button>
  </header>`
}

// 与 Mac 的 usage-section-head / 清单头同构：标题 + 右侧控件或计数。
function sectionHeadHtml(label, meta = '', extra = '') {
  return `<div class="p-head"><h3 class="p-title">${escape(label)}</h3>${extra}${meta ? `<span class="p-meta">${escape(meta)}</span>` : ''}</div>`
}

function segmentedHtml(group, options, value) {
  return `<div class="segmented is-compact" role="group">
    ${options.map(option => `<button type="button" data-act="seg" data-group="${escape(group)}" data-value="${escape(String(option.value))}"
      aria-pressed="${String(value) === String(option.value)}">${escape(option.label)}</button>`).join('')}
  </div>`
}

function legendHtml(items, { selected = null, action = null } = {}) {
  return `<div class="p-legend">${items.map((item, index) => item.action
    ? `<button type="button" class="p-legend-item${selected === item.label ? ' is-selected' : ''}" data-act="${item.action}"
        data-value="${escape(item.label)}" aria-pressed="${selected === item.label}"><i class="mark is-${item.tone ?? 'model' + index}"></i>${escape(item.label)}</button>`
    : `<span><i class="mark is-${item.tone ?? 'model' + index}"></i>${escape(item.label)}</span>`).join('')}</div>`
}

// 面积图只画真实序列；y 轴按本图峰值归一化，不补点、不插值。
function areaChartHtml(series, ticks, tones = ['codex', 'claude', 'qoder']) {
  const W = 340, H = 112, T = 8, B = 16
  const peak = Math.max(...series.flat(), 0.0001)
  const px = (index, count) => (index / (count - 1)) * W
  const py = value => T + (1 - Math.min(value, peak) / peak) * (H - T - B)
  const paths = series.map((points, index) => {
    const tone = tones[index % tones.length]
    const line = points.map((value, i) => `${i ? 'L' : 'M'}${px(i, points.length).toFixed(1)} ${py(value).toFixed(1)}`).join(' ')
    return `<path class="area tone-${tone}" d="${line} L${W} ${H - B} L0 ${H - B} Z"/><path class="line tone-${tone}" d="${line}"/>`
  }).join('')
  return `<div class="chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(copy.analytics.byProvider)}">
      <line class="grid" x1="0" y1="${py(peak / 2).toFixed(1)}" x2="${W}" y2="${py(peak / 2).toFixed(1)}"/>
      <line class="axis" x1="0" y1="${H - B}" x2="${W}" y2="${H - B}"/>
      ${paths}
    </svg>
    <div class="chart-ticks">${ticks.map(tick => `<span>${escape(tick)}</span>`).join('')}</div>
  </div>`
}

function tableHtml(head, rows) {
  return `<table class="p-table">
    <colgroup><col /><col class="w-cost" /><col class="w-share" /><col class="w-token" /></colgroup>
    <thead><tr>${head.map((cell, index) => `<th scope="col"${index ? ' class="num"' : ''}>${escape(cell)}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

// 1/5 分析：顺序照抄 AnalyticsView —— 范围、总览（成本 + 构成）、每日图、按 Provider、Token、明细表。
function analyticsPanelHtml(board) {
  const state = board.state
  const data = fixtures.panels.analytics
  const metric = state.chart === 'tokens' ? 'tokens' : 'cost'
  const rows = state.breakdown === 'day' ? data.breakdownDay : data.breakdownModel
  return `<div class="p-toolbar">
    ${segmentedHtml('range', copy.analytics.ranges.map(days => ({ value: days, label: copy.analytics.rangeLabelOf(days) })), state.range)}
    <span class="p-toolbar-note">${escape(data.period)}</span>
  </div>

  <section class="p-card">
    <div class="p-cost">
      <p class="p-eyebrow">${escape(copy.analytics.totalLabel)}</p>
      <strong class="p-cost-value">${escape(data.cost)}</strong>
      <p class="p-evidence">${escape(data.costEvidence)}</p>
    </div>
    <div class="p-composition">
      <p class="p-eyebrow">${escape(copy.analytics.composition)}</p>
      <div class="p-stack" role="img" aria-label="${escape(copy.analytics.composition)}">
        ${data.composition.map(item => `<span class="is-${item.provider}" style="flex-basis:${Math.round(item.share * 100)}%"></span>`).join('')}
      </div>
      <ul class="p-key">
        ${data.composition.map(item => `<li><span><i class="mark is-${item.provider}"></i>${escape(item.label)}</span><b>${Math.round(item.share * 100)}%</b></li>`).join('')}
      </ul>
    </div>
  </section>

  <section class="p-card">
    ${sectionHeadHtml(metric === 'cost' ? copy.analytics.dailyCost : copy.analytics.dailyTokens, '',
      segmentedHtml('chart', [{ value: 'cost', label: copy.analytics.cost }, { value: 'tokens', label: copy.analytics.tokenToggle }], metric))}
    ${legendHtml(data.composition.map(item => ({ label: item.label, tone: item.provider })))}
    ${areaChartHtml(data.series[metric], data.days)}
  </section>

  <section class="p-card">
    ${sectionHeadHtml(copy.analytics.byProvider)}
    <ul class="p-provider-rows">
      ${data.composition.map(item => `<li>
        <i class="mark is-${item.provider}"></i><b>${escape(item.label)}</b>
        <span class="p-dim">${Math.round(item.share * 100)}%</span><strong>${escape(item.cost)}</strong>
      </li>`).join('')}
    </ul>
  </section>

  <section class="p-card">
    ${sectionHeadHtml(copy.analytics.tokens)}
    <dl class="p-metrics">
      ${analyticsMetrics().map(row => `<div>
        <dt>${escape(row.label)}</dt>
        <dd class="${row.unavailable ? 'is-unavailable' : ''}">${escape(row.value)}</dd>
        <span class="p-evidence">${escape(row.evidence)}</span>
      </div>`).join('')}
    </dl>
  </section>

  <section class="p-card">
    ${sectionHeadHtml(copy.analytics.details, '', segmentedHtml('breakdown',
      [{ value: 'model', label: copy.analytics.model }, { value: 'day', label: copy.analytics.day }], state.breakdown))}
    ${tableHtml(
      [state.breakdown === 'day' ? copy.analytics.day : copy.analytics.model, copy.analytics.columns.cost, copy.analytics.columns.share, copy.analytics.columns.token],
      rows.map(row => `<tr>
        <th scope="row"><i class="mark is-${row.provider ?? 'codex'}"></i><b>${escape(row.label)}</b></th>
        <td class="num${row.approximate ? ' is-approximate' : ''}">${escape(row.cost)}</td>
        <td class="num">${row.share ? escape(row.share) : ''}</td>
        <td class="num${row.lowerBound ? ' is-lower-bound' : ''}">${escape(row.token)}</td>
      </tr>`).join(''))}
    <p class="p-note">${escape(copy.analytics.legendNote)}</p>
    <button type="button" class="see-all" data-act="panel-refresh">${escape(copy.panel.more)}</button>
  </section>`
}

// 2/5 LLM 性能：顺序照抄 LlmPerformancePanel —— 范围、运行中会话、历史（指标 + 图例 + 曲线 + 模型对比）。
function llmPanelHtml(board) {
  const state = board.state
  const data = fixtures.panels.llm
  const metric = state.llmMetric === 'firstToken' ? 'firstToken' : 'speed'
  const spec = copy.llm.metrics[metric]
  const history = data.history
  return `<div class="p-toolbar">
    ${segmentedHtml('llm-range', copy.llm.ranges.map(range => ({ value: range.hours, label: range.label })), state.llmRange)}
  </div>

  <section class="p-card">
    ${sectionHeadHtml(copy.llm.runningRegion, '',
      `<span class="p-live"><i aria-hidden="true"></i>${escape(copy.llm.running(data.running.length))}</span>`)}
    ${data.running.map(run => `<div class="p-run">
      <div class="p-run-head">
        <i class="mark is-codex"></i>
        <div class="p-run-model"><b>${escape(run.model)}</b><span>${escape(copy.llm.sessions(run.sessions.length))} · ${escape(run.state)}</span></div>
        <div class="p-run-cell"><span>${escape(copy.llm.average)}</span><strong>${escape(run.speed)}<small>${escape(copy.llm.speedUnit)}</small></strong></div>
        <div class="p-run-cell"><span>${escape(copy.llm.firstToken)}</span><strong>${escape(run.firstToken)}<small>${escape(copy.llm.seconds)}</small></strong></div>
      </div>
      <p class="p-evidence">${escape(run.coverage)}</p>
      <ul class="p-run-sessions">
        ${run.sessions.map(session => `<li><b>${escape(session.provider)}</b><span>${escape(session.cwd)}</span><em>${escape(session.state)}</em></li>`).join('')}
      </ul>
    </div>`).join('')}
  </section>

  <section class="p-card">
    ${sectionHeadHtml(copy.llm.history(history.range), '', segmentedHtml('llm-metric',
      [{ value: 'speed', label: copy.llm.metrics.speed.label }, { value: 'firstToken', label: copy.llm.metrics.firstToken.label }], metric))}
    <div class="p-chart-controls"><span class="p-unit">${escape(spec.unit)}</span><span class="p-dim">${escape(history.truncated)}</span></div>
    ${legendHtml(history.models.map((model, index) => ({ label: model, tone: 'model' + index, action: 'llm-select' })), { selected: state.llmSelected })}
    ${areaChartHtml(history[metric], history.ticks, ['model0', 'model1'])}
    ${sectionHeadHtml(copy.llm.comparison)}
    ${tableHtml(
      [copy.analytics.model, copy.llm.metrics.speed.label, copy.llm.metrics.firstToken.label, copy.llm.unitSamples],
      history.comparison.map(row => `<tr>
        <th scope="row"><b>${escape(row.model)}</b></th>
        <td class="num">${escape(row.speed)}</td>
        <td class="num">${escape(row.firstToken)}</td>
        <td class="num">${escape(row.samples)}</td>
      </tr>`).join(''))}
  </section>`
}

// 3/5 技能：照 CapabilitiesModal 的 skills 视图 —— 能力说明、来源分页、搜索 + 显示 N / 总数、名称/描述/来源、发现证据脚注。
function skillsPanelHtml(board) {
  const state = board.state
  const data = fixtures.panels.skills
  const scope = state.skillScope ?? data.scopes[0].id
  const scopeLabel = copy.skills.scopes[scope]
  const rows = data.rows.filter(row => row.scope === scope).slice(0, data.shown)
  return `<div class="p-toolbar">
    <span class="p-provider">${escape(data.provider)}</span>
    <span class="p-toolbar-note">${escape(copy.skills.intro)}</span>
  </div>

  <div class="p-scope-tabs" role="tablist" aria-label="${escape(copy.skills.scopeLabel)}">
    ${data.scopes.filter(item => item.id !== 'provider' || item.count > 0).map(item => `<button type="button" role="tab"
      class="${scope === item.id ? 'active' : ''}" aria-selected="${scope === item.id}" data-act="seg" data-group="skill-scope" data-value="${item.id}">
      ${escape(copy.skills.scopes[item.id])}<span>${item.count}</span></button>`).join('')}
  </div>

  <div class="p-search-row">
    <label class="p-search">${icon('search', 15)}<input type="search" data-skill-search placeholder="${escape(copy.skills.searchPlaceholder(scopeLabel))}" aria-label="${escape(copy.skills.search)}"></label>
    <span class="p-count">${escape(copy.panel.shown(rows.length, data.total))}</span>
  </div>

  ${rows.length === 0
    ? `<div class="p-empty"><b>${escape(copy.skills.empty(scopeLabel))}</b><p>${escape(copy.skills.emptyBody)}</p></div>`
    : `<ul class="p-skills">${rows.map(row => `<li class="p-skill">
        <div class="p-skill-name"><b>${escape(row.name)}</b><span class="badge draft">${escape(copy.skills.scopesShort[row.scope])}</span></div>
        <p class="p-skill-desc">${escape(row.description)}</p>
        <div class="p-skill-source"><span>${escape(copy.skills.source)}</span><code>${escape(row.dir)}</code></div>
      </li>`).join('')}</ul>`}

  <div class="p-footnote"><b>${escape(copy.skills.footnote)}</b><p>${escape(copy.skills.footnoteBody)}</p></div>`
}

// 4/5 MCP：照 McpTrustPanel —— live 状态、策略网格、报告标签与来源、风险发现、Fleet inventory、策略与审计。只有刷新与扫描。
function mcpPanelHtml(board) {
  const data = fixtures.panels.mcp
  const policy = data.policy
  return `<div class="p-toolbar is-actions">
    <button type="button" class="p-button" data-act="panel-refresh">${icon('refresh', 15)}${escape(copy.mcp.refreshLive)}</button>
    <button type="button" class="p-button" data-act="panel-refresh">${icon('refresh', 15)}${escape(copy.mcp.scan)}</button>
  </div>

  <section class="p-card">
    ${sectionHeadHtml(copy.mcp.liveTitle, copy.mcp.liveSummary(data.live.length))}
    <ul class="p-live">
      ${data.live.map(item => `<li><i class="dot ${item.tone}"></i><span class="p-live-name">${escape(item.name)}</span>
        <span class="p-dim">${escape(item.label)}${item.tools != null ? ` · ${item.tools} tools` : ''}</span></li>`).join('')}
    </ul>
  </section>

  <section class="p-card">
    ${sectionHeadHtml(copy.mcp.summaryTitle, copy.mcp.servers(data.servers))}
    <dl class="p-grid-2">
      <div><dt>${escape(copy.mcp.policy)}</dt><dd class="tone-${policy.tone}">${escape(policy.label)}</dd></div>
      <div><dt>${escape(copy.mcp.criticalHigh)}</dt><dd>${policy.criticalHigh}</dd></div>
      <div><dt>${escape(copy.mcp.policyBlocks)}</dt><dd>${policy.policyBlocks}</dd></div>
      <div><dt>${escape(copy.mcp.auditHash)}</dt><dd class="mono">${escape(policy.auditHash)}</dd></div>
    </dl>
    <div class="p-labels">${data.labels.map(label => `<span class="trust-label tone-${label.tone}">${escape(label.label)}</span>`).join('')}</div>
    <p class="p-note">${escape(copy.panel.reportNote(data.report.id, data.report.rule, data.report.who))}</p>
  </section>

  <section class="p-card">
    ${sectionHeadHtml(copy.mcp.findings, String(data.findings.length))}
    <div class="p-severity-strip">
      ${['critical', 'high', 'warn', 'info'].map(severity => `<span class="trust-label tone-${severity === 'info' ? 'info' : severity === 'warn' ? 'warn' : 'bad'}">
        ${escape(copy.mcp.severity[severity])} ${data.severityCounts[severity]}</span>`).join('')}
    </div>
    ${data.findings.length === 0 ? `<p class="p-dim p-pad">${escape(copy.mcp.noFindings)}</p>` : data.findings.map(finding => `
      <div class="p-finding">
        <span class="trust-label tone-${finding.severity}">${escape(copy.mcp.severity[finding.severity])}</span>
        <div><b>${escape(finding.title)}</b>
          <span class="p-dim">${escape(finding.rule)} · ${escape(finding.target)} · ${escape(copy.mcp.decision[finding.decision])}</span></div>
      </div>`).join('')}
  </section>

  <section class="p-card">
    ${sectionHeadHtml(copy.mcp.inventory, String(data.targets.length))}
    ${data.targets.map(target => `<div class="p-target">
      <div class="p-target-head"><b>${escape(target.name)}</b><span class="trust-label tone-${target.tone}">${escape(target.badge)}</span></div>
      <p class="p-dim">${escape(target.meta)}</p>
      <p class="p-src">${escape(target.path)}</p>
      <div class="p-labels">${target.labels.map(label => `<span class="trust-label tone-${label.tone}">${escape(label.label)}</span>`).join('')}</div>
    </div>`).join('')}
  </section>

  <section class="p-card">
    ${sectionHeadHtml(copy.mcp.policyAudit, copy.mcp.notes(data.audit.length))}
    <dl class="p-audit">${data.audit.map(row => `<div><dt>${escape(row.label)}</dt><dd>${escape(row.value)}</dd></div>`).join('')}</dl>
  </section>`
}

// 5/5 Meta Prompts：照 MetaPromptsView —— 搜索 + 条数、列表（标题 + 首行 + 复制）、详情（正文 + 字数 + 放入输入框 + 复制）。
function metaPanelHtml(board) {
  const data = fixtures.panels.meta
  const selected = data.prompts.find(prompt => prompt.id === (board.state.metaSelected ?? data.selected)) ?? data.prompts[0]
  return `<div class="p-search-row">
    <label class="p-search">${icon('search', 15)}<input type="search" data-meta-search placeholder="${escape(copy.meta.searchPlaceholder)}" aria-label="${escape(copy.meta.search)}"></label>
    <span class="p-count">${escape(copy.meta.count(data.prompts.length))}</span>
  </div>

  <ul class="p-prompts">
    ${data.prompts.map(prompt => `<li class="p-prompt${prompt.id === selected.id ? ' is-selected' : ''}">
      <button type="button" class="p-prompt-main" data-act="seg" data-group="meta-select" data-value="${prompt.id}" aria-pressed="${prompt.id === selected.id}">
        <b>${escape(prompt.title)}</b><span>${escape(prompt.body.split('\n')[0])}</span>
      </button>
      <button type="button" class="p-icon-button" data-act="meta-copy" data-value="${escape(prompt.title)}"
        aria-label="${escape(copy.meta.copy)}" title="${escape(copy.meta.copy)}">${icon('copy', 16)}</button>
    </li>`).join('')}
  </ul>

  <section class="p-card">
    <div class="p-prompt-head"><h3 class="p-title">${escape(selected.title)}</h3>
      <span class="p-icon-group">
        <button type="button" class="p-icon-button" data-act="seg" data-group="meta-edit" aria-label="${escape(copy.meta.edit)}" title="${escape(copy.meta.edit)}">${icon('pencil', 16)}</button>
        <button type="button" class="p-icon-button" data-act="seg" data-group="meta-remove" aria-label="${escape(copy.meta.remove)}" title="${escape(copy.meta.remove)}">${icon('archive', 16)}</button>
      </span>
    </div>
    <pre class="p-body-text">${escape(selected.body)}</pre>
    <div class="p-prompt-foot">
      <span class="p-dim">${escape(copy.meta.chars(Array.from(selected.body).length))}</span>
      <div class="p-actions">
        <button type="button" class="p-button" data-act="meta-insert">${escape(copy.meta.insert)}</button>
        <button type="button" class="p-button is-primary" data-act="meta-copy" data-value="${escape(selected.title)}">${icon('copy', 15)}${escape(copy.meta.copy)}</button>
      </div>
    </div>
  </section>
  <p class="p-note p-pad">${escape(copy.panel.macOnly)}</p>`
}

const PANEL_BODIES = { analytics: analyticsPanelHtml, llm: llmPanelHtml, skills: skillsPanelHtml, mcp: mcpPanelHtml, meta: metaPanelHtml }

function panelHtml(board) {
  return `<div class="panel-home">
    <div class="safe-top"></div>
    ${panelHeadHtml(board)}
    <div class="panel-body">${PANEL_BODIES[board.kind](board)}</div>
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
  if (PANEL_KINDS.includes(board.kind)) {
    return `<div class="device"><div class="phone" data-board="${board.id}">${panelHtml(board)}</div></div>`
  }
  const body = homeBodyHtml(board)
  const drawerOpen = board.state.drawer
  return `<div class="device"><div class="phone" data-board="${board.id}">
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
  </div></div>`
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
    case 'seg': {
      const group = target.dataset.group
      const value = target.dataset.value
      if (group === 'range') state.range = Number(value)
      else if (group === 'chart') state.chart = value
      else if (group === 'breakdown') state.breakdown = value
      else if (group === 'llm-range') state.llmRange = Number(value)
      else if (group === 'llm-metric') state.llmMetric = value
      else if (group === 'skill-scope') state.skillScope = value
      else if (group === 'meta-select') state.metaSelected = value
      else return flash(boardId, copy.panel.macOnly)
      return rerender(boardId)
    }
    case 'llm-select':
      state.llmSelected = state.llmSelected === target.dataset.value ? null : target.dataset.value
      return rerender(boardId)
    case 'meta-copy': return flash(boardId, copy.meta.copied(target.dataset.value ?? ''))
    case 'meta-insert': return flash(boardId, copy.meta.inserted)
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
