// Synthetic event/state checks only. This is not a browser, layout or iOS test.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const html = fs.readFileSync(path.join(__dirname, 'Scry iOS Remote.html'), 'utf8')
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1])

function harness() {
  const app = { innerHTML: '' }
  const listeners = new Map()
  const timers = new Map()
  let nextTimer = 0
  const document = {
    querySelector: selector => selector === '#app' ? app : null,
    querySelectorAll: () => [],
    addEventListener: (type, callback, capture) => listeners.set(type, { callback, capture })
  }
  const context = vm.createContext({ document, window: {
    clearTimeout: id => timers.delete(id),
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id }
  } })
  scripts.forEach(script => new vm.Script(script).runInContext(context))
  return {
    get rendered() { return app.innerHTML },
    get clickCapture() { return listeners.get('click').capture },
    click(dataset, { disabled = false, scrim = false, nested = false } = {}) {
      const target = { dataset, disabled, classList: { contains: name => scrim && name === 'sheet-scrim' } }
      target.closest = () => target
      const origin = nested ? { closest: () => target } : target
      listeners.get('click').callback({ target: origin })
    },
    input(id, value) { listeners.get('input').callback({ target: { id, value } }) },
    escape() { listeners.get('keydown').callback({ key: 'Escape' }) },
    flushToasts() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()) }
  }
}

test('entry is local-only and the actual script compiles/renders', () => {
  assert.equal(scripts.length, 1)
  assert.doesNotMatch(html, /<(?:script|link)[^>]*(?:src|href)="https?:/)
  assert.match(html, /viewport-fit=cover/)
  const h = harness()
  assert.match(h.rendered, /Interactive prototype · sample data/)
  assert.equal(h.clickCapture, true, 'delegated clicks must run before the existing sheet propagation stop')
})

test('sheet actions dispatch; sheet body clicks do not dismiss; Escape closes', () => {
  const h = harness()
  h.click({ action: 'pair' })
  assert.match(h.rendered, /role="dialog"/)
  h.click({ action: 'close-modal' }, { scrim: true, nested: true })
  assert.match(h.rendered, /role="dialog"/)
  h.click({ action: 'pair-simulate' })
  assert.doesNotMatch(h.rendered, /role="dialog"/)
  assert.match(h.rendered, /confirm owner access/)
  h.click({ action: 'pair' })
  h.escape()
  assert.doesNotMatch(h.rendered, /role="dialog"/)
})

test('offline machine-first is not shown connected', () => {
  const h = harness()
  h.click({ mode: 'machine' })
  h.click({ state: 'offline' })
  assert.match(h.rendered, /Last known: locked · awake/)
  assert.doesNotMatch(h.rendered, />Connected</)
  h.click({ action: 'open-approval' })
  assert.match(h.rendered, /data-action="approve" disabled/)
  h.click({ action: 'approve' })
  assert.match(h.rendered, /approval not sent/)
})

test('stop remains pending after toast clears, and cannot be requested offline', () => {
  const h = harness()
  h.click({ screen: 'session', task: 'checkout' })
  h.click({ state: 'offline' })
  h.click({ action: 'stop-run' })
  h.click({ action: 'confirm-stop' })
  assert.doesNotMatch(h.rendered, /<strong>Stop requested/)
  h.click({ state: 'offline' })
  h.click({ action: 'confirm-stop' })
  h.flushToasts()
  assert.match(h.rendered, /STOP REQUESTED/)
  assert.match(h.rendered, /data-action="stop-run" disabled/)
})

test('changed approval needs a new review and duplicate reply stays pending', () => {
  const h = harness()
  h.click({ state: 'stale' })
  h.click({ action: 'open-approval' })
  h.click({ action: 'approve' })
  assert.match(h.rendered, /--updateSnapshot/)
  assert.match(h.rendered, />Approve once</)
  assert.doesNotMatch(h.rendered, /Reply sent/)
  h.click({ action: 'approve' })
  h.flushToasts()
  assert.match(h.rendered, /Reply sent · confirmation pending/)
  h.click({ action: 'approve' })
  assert.match(h.rendered, /Reply already submitted/)
})

test('task and file identity follow selection', () => {
  const h = harness()
  h.click({ screen: 'changes', task: 'copy' })
  assert.match(h.rendered, /<h1>Update empty cart copy<\/h1>/)
  assert.match(h.rendered, /COMPLETED · CODEX/)
  assert.match(h.rendered, /src\/cart\/EmptyCart.tsx/)
  assert.doesNotMatch(h.rendered, /checkout\/checkout.tsx/)
  h.click({ screen: 'changes', task: 'checkout' })
  h.click({ action: 'select-file', file: '1' })
  assert.match(h.rendered, /loading-state.test.tsx · read-only preview/)
  h.click({ screen: 'changes', task: 'totals' })
  assert.match(h.rendered, /Diff evidence is unavailable/)
})

test('terminal writer control is exclusive in the mock state', () => {
  const h = harness()
  h.click({ screen: 'terminal' })
  h.click({ state: 'terminal-owner' })
  assert.match(h.rendered, /Desktop controls/)
  assert.match(h.rendered, /data-action="terminal-send" disabled/)
  h.input('terminal-input', 'echo demo')
  h.click({ action: 'terminal-send' })
  assert.doesNotMatch(h.rendered, /Sample input submitted/)
  h.click({ action: 'take-control' })
  assert.match(h.rendered, /Take terminal control\?/)
  h.click({ action: 'confirm-control' })
  assert.match(h.rendered, /You control/)
  h.click({ action: 'terminal-send' })
  assert.match(h.rendered, /execution not confirmed/)
})

test('revocation stays effective when the offline demo toggle is used', () => {
  const h = harness()
  h.click({ action: 'machine-detail' })
  h.click({ action: 'revoke-device' })
  assert.match(h.rendered, /Existing tasks are not automatically stopped/)
  h.click({ action: 'confirm-revoke' })
  h.flushToasts()
  assert.match(h.rendered, /Access revoked/)
  h.click({ state: 'offline' })
  assert.match(h.rendered, /reconnecting does not restore control/)
  h.click({ screen: 'terminal' })
  assert.match(h.rendered, /data-action="terminal-send" disabled/)
})

test('compose escapes input and preserves the pending message', () => {
  const h = harness()
  h.click({ screen: 'session' })
  h.input('draft', '<img src=x onerror=alert(1)>')
  h.click({ action: 'send' })
  h.flushToasts()
  assert.match(h.rendered, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(h.rendered, /<img src=x/)
  assert.match(h.rendered, /delivery pending/)
})

test('new-task validation and notification toggle are not no-op buttons', () => {
  const h = harness()
  h.click({ action: 'new-task' })
  h.click({ action: 'new-task-submit' })
  assert.match(h.rendered, /Describe a task/)
  h.input('new-task-draft', 'Add loading state')
  h.click({ action: 'new-task-submit' })
  assert.match(h.rendered, /awaiting host receipt/)
  h.click({ screen: 'settings' })
  h.click({ action: 'toggle-notifications' })
  assert.match(h.rendered, /aria-label="Off"/)
  h.click({ screen: 'tasks' })
  h.click({ screen: 'settings' })
  assert.match(h.rendered, /aria-label="Off"/)
})
