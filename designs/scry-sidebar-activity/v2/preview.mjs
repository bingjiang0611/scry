import { copy } from './copy.mjs'
import { initialState, transition, visibleItems } from './model.mjs'

const $ = id => document.getElementById(id)
document.title = copy.title
for (const node of document.querySelectorAll('[data-copy]')) node.textContent = copy[node.dataset.copy]
$('search').placeholder = copy.search
$('search').setAttribute('aria-label', copy.search)
$('tasks').setAttribute('aria-label', copy.activity)

const icons = {
  input: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8.7 3.7a1.5 1.5 0 0 1 2.6 0l6.1 10.6a1.5 1.5 0 0 1-1.3 2.2H3.9a1.5 1.5 0 0 1-1.3-2.2z" stroke="currentColor" stroke-width="1.4"/><path d="M10 7v4m0 2.2v.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  working: '',
  completed: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="4" y="3.5" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="m4 12.5-1.5 3h15l-1.5-3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>'
}
let state = initialState()
let query = ''
let timer = null
let playing = false
let playIndex = 0
const actions = ['resume', 'complete', 'input', 'reorder', 'groups']
const sequence = actions.filter(action => action !== 'groups')
const nodes = new Map()
const systemMotion = matchMedia('(prefers-reduced-motion: reduce)')
$('reduced').checked = systemMotion.matches
const reduceMotion = () => systemMotion.matches || $('reduced').checked

function updateSelection() {
  for (const task of state.tasks) nodes.get(task.id)?.setAttribute('aria-current', String(task.id === state.selected))
  const selected = state.tasks.find(task => task.id === state.selected)
  $('detail-title').textContent = copy.labels[selected.id]
  $('detail-status').textContent = copy.groups[selected.group]
}

function createNode(item) {
  const node = document.createElement(item.heading ? 'h2' : 'button')
  node.dataset.key = item.key
  if (item.heading) {
    node.id = item.key
    node.className = 'group-heading'
    node.textContent = copy.groups[item.group]
  } else {
    node.className = 'task'
    const title = document.createElement('span')
    title.className = 'task-title'
    title.textContent = copy.labels[item.id]
    const icon = document.createElement('span')
    icon.className = 'task-icon'
    node.append(title, icon)
    node.title = copy.labels[item.id]
    node.addEventListener('pointerdown', pause)
    node.addEventListener('click', () => {
      pause()
      state = { ...state, selected: item.id }
      updateSelection()
      const task = state.tasks.find(task => task.id === item.id)
      $('announcement').textContent = copy.selected(copy.labels[item.id], copy.groups[task.group])
    })
  }
  nodes.set(item.key, node)
  return node
}

function render(animate = true) {
  const root = $('tasks')
  const focused = document.activeElement
  // Capture the currently displayed positions before canceling interrupted motion.
  const previous = new Map([...root.children].map(node => [node.dataset.key, node.getBoundingClientRect()]))
  for (const node of root.children) node.getAnimations().forEach(animation => animation.cancel())
  const items = visibleItems(state, query, copy.labels)
  const keys = new Set(items.map(item => item.key))
  for (const node of [...root.children]) if (!keys.has(node.dataset.key)) node.remove()
  let cursor = root.firstElementChild
  for (const item of items) {
    const node = nodes.get(item.key) ?? createNode(item)
    if (!item.heading) {
      node.dataset.group = item.group
      node.setAttribute('aria-describedby', `group-${item.group}`)
      node.querySelector('.task-icon').innerHTML = icons[item.group]
    }
    if (node !== cursor) root.insertBefore(node, cursor)
    cursor = node.nextElementSibling
  }
  root.hidden = !items.length
  $('empty').hidden = !!items.length
  updateSelection()
  // One read batch, then one animation batch. Titles and tasks share the same layout.
  const next = new Map([...root.children].map(node => [node, node.getBoundingClientRect()]))
  if (animate && !reduceMotion()) {
    for (const [node, rect] of next) {
      const before = previous.get(node.dataset.key)
      const delta = before ? before.top - rect.top : 8
      if (delta || !before) node.animate([
        { transform: `translateY(${delta}px)`, opacity: before ? 1 : 0 },
        { transform: 'translateY(0)', opacity: 1 }
      ], { duration: 420, easing: 'cubic-bezier(.22,1,.36,1)' })
    }
  }
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true })
}

function pause() {
  clearTimeout(timer)
  timer = null
  playing = false
  $('play').textContent = copy.play
}

function apply(action) {
  state = transition(state, action)
  $('event').textContent = action === 'reset' ? copy.initial : copy.actions[action][0]
  render()
}

function tick() {
  if (playIndex === sequence.length) {
    pause()
    $('event').textContent = copy.finished
    return
  }
  apply(sequence[playIndex++])
  $('step').textContent = copy.step(playIndex, sequence.length)
  timer = setTimeout(tick, 2400)
}

$('play').addEventListener('click', () => {
  if (playing) return pause()
  state = initialState()
  query = ''
  $('search').value = ''
  render()
  playIndex = 0
  playing = true
  $('play').textContent = copy.pause
  $('event').textContent = copy.initial
  $('step').textContent = copy.step(0, sequence.length)
  timer = setTimeout(tick, 1200)
})
$('reset').addEventListener('click', () => {
  pause()
  query = ''
  $('search').value = ''
  $('step').textContent = ''
  apply('reset')
})
for (const [index, action] of actions.entries()) {
  const button = document.createElement('button')
  button.className = 'action-button'
  const number = document.createElement('span')
  number.className = 'action-number'
  number.setAttribute('aria-hidden', 'true')
  number.textContent = String(index + 1).padStart(2, '0')
  const text = document.createElement('span')
  text.className = 'action-copy'
  for (const [index, label] of copy.actions[action].entries()) {
    const line = document.createElement('span')
    line.className = index ? 'action-description' : 'action-name'
    line.textContent = label
    text.append(line)
  }
  button.append(number, text)
  button.addEventListener('click', () => { pause(); $('step').textContent = ''; apply(action) })
  $('actions').append(button)
}
$('search').addEventListener('input', event => { pause(); query = event.target.value; render() })
for (const name of ['narrow', 'light']) $(name).addEventListener('change', event => {
  document.documentElement.classList.toggle(name, event.target.checked)
})
function cancelMotion() {
  if (reduceMotion()) for (const node of nodes.values()) node.getAnimations().forEach(animation => animation.cancel())
}
$('reduced').addEventListener('change', cancelMotion)
systemMotion.addEventListener('change', cancelMotion)
document.addEventListener('visibilitychange', () => { if (document.hidden) pause() })
window.addEventListener('pagehide', pause)
$('play').textContent = copy.play
$('event').textContent = copy.initial
render(false)
