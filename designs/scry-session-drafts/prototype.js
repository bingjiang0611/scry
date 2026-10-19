const copy = window.draftCopy
const byId = id => document.getElementById(id)
const sessions = copy.groups.flatMap(group => group.sessions)
let activeId = 'issue'
let variant = 'a'
let sentText = ''

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function folderIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'folder')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', 'M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3Z')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.5')
  path.setAttribute('stroke-linejoin', 'round')
  svg.append(path)
  return svg
}

function renderSidebar() {
  const fragment = document.createDocumentFragment()
  for (const group of copy.groups) {
    const section = element('section', 'project')
    const heading = element('div', 'project-name')
    heading.append(folderIcon(), element('span', '', group.name))
    section.append(heading)
    for (const session of group.sessions) {
      const hasDraft = session.input.trim().length > 0
      const row = element('button', 'session')
      row.type = 'button'
      row.dataset.sessionId = session.id
      row.setAttribute('aria-current', String(session.id === activeId))
      row.setAttribute('aria-label', copy.sessionLabel(session, hasDraft))
      row.title = session.title
      const main = element('span', 'session-main')
      const glyph = element('span', 'glyph', 'π')
      glyph.setAttribute('aria-hidden', 'true')
      main.append(glyph)
      const draft = element('span', 'draft', copy.draft)
      if (hasDraft && variant === 'a') main.append(draft)
      main.append(element('span', 'session-title', session.title))
      const meta = element('span', 'session-meta')
      if (hasDraft && variant === 'b') meta.append(draft)
      meta.append(element('span', 'time', session.time))
      if (session.unread) {
        const unread = element('span', 'unread')
        unread.setAttribute('aria-label', copy.unread)
        meta.append(unread)
      }
      row.append(main, meta)
      if (session.running) {
        const running = element('span', 'running')
        running.setAttribute('aria-label', copy.running)
        row.append(running)
      }
      row.addEventListener('click', () => {
        activeId = session.id
        sentText = ''
        renderSidebar()
        renderConversation()
        byId('sessions').querySelector(`[data-session-id="${activeId}"]`).focus({ preventScroll: true })
      })
      section.append(row)
    }
    fragment.append(section)
  }
  const focusedId = document.activeElement?.dataset.sessionId
  byId('sessions').replaceChildren(fragment)
  if (focusedId) byId('sessions').querySelector(`[data-session-id="${focusedId}"]`).focus({ preventScroll: true })
}

function renderConversation() {
  const session = sessions.find(item => item.id === activeId)
  const group = copy.groups.find(item => item.sessions.includes(session))
  byId('breadcrumb').textContent = group.name
  byId('conversation-title').textContent = session.title
  byId('input').value = session.input
  byId('send').disabled = session.input.trim().length === 0
  const user = element('div', 'user-message', sentText || copy.sampleUser)
  const assistant = element('div', 'assistant-message')
  assistant.append(element('div', 'assistant-mark', 'π'), element('div', '', sentText ? copy.sent : copy.sampleAssistant))
  if (!sentText) assistant.append(element('div', 'usage', copy.sampleUsage))
  byId('transcript').replaceChildren(user, assistant)
}

function renderVariants() {
  byId('variants').replaceChildren(...copy.variants.map(option => {
    const button = element('button', '', option.label)
    button.type = 'button'
    button.setAttribute('aria-pressed', String(option.id === variant))
    button.addEventListener('click', () => {
      variant = option.id
      renderVariants()
      renderSidebar()
      byId('variants').querySelector(`[aria-pressed="true"]`).focus()
    })
    return button
  }))
  const current = copy.variants.find(option => option.id === variant)
  byId('recommendation').textContent = current.recommendation
  byId('rationale').textContent = current.rationale
}

for (const [id, value] of Object.entries({
  eyebrow: copy.eyebrow, 'review-title': copy.heading, 'projects-label': copy.projects,
  'settings-label': copy.settings, 'local-label': copy.local, 'composer-label': copy.editor,
  'permission-label': copy.permission, 'provider-label': copy.provider, 'model-label': copy.model,
  'simulation-note': copy.simulation, 'try-it': copy.tryIt
})) byId(id).textContent = value

document.title = copy.title
byId('input').placeholder = copy.placeholder
byId('send').setAttribute('aria-label', copy.send)
byId('send').title = copy.send
byId('theme').textContent = copy.light
byId('theme').addEventListener('click', () => {
  const isLight = document.documentElement.dataset.theme !== 'light'
  document.documentElement.dataset.theme = isLight ? 'light' : 'dark'
  byId('theme').textContent = isLight ? copy.dark : copy.light
})
byId('input').addEventListener('input', event => {
  sessions.find(item => item.id === activeId).input = event.target.value
  byId('send').disabled = event.target.value.trim().length === 0
  renderSidebar()
})
byId('send').addEventListener('click', () => {
  const session = sessions.find(item => item.id === activeId)
  sentText = session.input
  session.input = ''
  renderSidebar()
  renderConversation()
})
renderVariants()
renderSidebar()
renderConversation()
