// Executes the actual prototype script with minimal UI doubles.
// These checks do not provide browser, layout, screenshot or iPhone evidence.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const html = fs.readFileSync(path.join(__dirname, 'Scry iOS Remote v2.html'), 'utf8')
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1])
function harness(hash = '') {
  const app = { innerHTML: '' }
  const listeners = new Map()
  const timers = new Map()
  let nextId = 0
  const document = {
    querySelector: selector => selector === '#app' ? app : null,
    getElementById: () => null,
    addEventListener: (type, callback) => listeners.set(type, callback)
  }
  const context = vm.createContext({ document, window: {
    location: { hash },
    clearTimeout: id => timers.delete(id),
    setTimeout: callback => { const id = ++nextId; timers.set(id, callback); return id }
  } })
  scripts.forEach(script => new vm.Script(script).runInContext(context))
  return {
    get rendered() { return app.innerHTML },
    click(action, data = {}, { disabled = false, scrim = false, nested = false } = {}) {
      const target = { dataset: { action, ...data }, disabled, classList: { contains: name => scrim && name === 'scrim' } }
      target.closest = () => target
      const origin = nested ? { closest: () => target } : target
      listeners.get('click')({ target: origin })
    },
    page(page) { this.click(undefined, { page }) },
    input(id, value) { listeners.get('input')({ target: { id, value, selectionStart: value.length } }) },
    scenario(value) { listeners.get('change')({ target: { id: 'scenario', value } }) },
    escape() { listeners.get('keydown')({ key: 'Escape' }) },
    flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()) }
  }
}

test('standalone script renders; no network, OS keyboard or voice implementation is fabricated', () => {
  assert.equal(scripts.length, 1)
  assert.doesNotMatch(html, /<(?:script|link)[^>]*(?:src|href)="https?:/)
  assert.doesNotMatch(scripts[0], /\bfetch\s*\(|new (?:WebSocket|XMLHttpRequest)|navigator\.(?:clipboard|mediaDevices)/)
  assert.match(html, /viewport-fit=cover/)
  assert.match(html, /height: 100dvh/)
  const h = harness()
  assert.match(h.rendered, /已置顶/)
  assert.match(h.rendered, /class="project-threads"/)
  assert.match(h.rendered, /搜索聊天/)
  assert.doesNotMatch(h.rendered, /bottom-nav|tab-bar/)
})

test('the three comparison screens have direct, allowlisted hash entries', () => {
  assert.match(harness('#new').rendered, /class="context-list"/)
  assert.match(harness('#chat').rendered, /这次改动的重点/)
  assert.match(harness('#unknown').rendered, /搜索聊天/)
})

test('home search and both independent group disclosures work', () => {
  const h = harness()
  h.input('search', '购物车')
  assert.match(h.rendered, /调整空购物车文案/)
  assert.doesNotMatch(h.rendered, /优化结算页加载状态/)
  h.input('search', '')
  h.click('toggle-pinned')
  assert.equal((h.rendered.match(/data-id="checkout"/g) || []).length, 1)
  h.click('toggle-project')
  assert.equal((h.rendered.match(/data-id="checkout"/g) || []).length, 0)
  h.scenario('empty')
  assert.match(h.rendered, /还没有会话/)
})

test('new-thread context is selectable without executing workspace operations', () => {
  const h = harness()
  h.click('new')
  assert.match(h.rendered, /class="context-list"/)
  assert.match(h.rendered, /在本地工作/)
  assert.match(h.rendered, /data-action="send-new"[^>]*disabled/)
  h.click('projects')
  h.click('choose-project', { project: 'docs-site' })
  h.click('branches')
  h.click('choose-branch', { branch: 'feature/loading-state' })
  assert.match(h.rendered, /docs-site/)
  assert.match(h.rendered, /feature\/loading-state/)
  h.input('composer', '整理公开文档导航')
  h.click('send-new')
  assert.match(h.rendered, /任务已提交，等待主机回执/)
  assert.match(h.rendered, /docs-site · Studio Mac/)
  h.click('home')
  assert.match(h.rendered, /整理公开文档导航/)
  assert.doesNotMatch(h.rendered, /优化结算页加载状态/)
})

test('thread and file identities follow selected task, not previous task data', () => {
  const h = harness()
  h.click('thread', { id: 'copy' })
  assert.match(h.rendered, /调整空购物车文案/)
  assert.match(h.rendered, /1 个文件/)
  h.click('agents')
  assert.match(h.rendered, /Codex/)
  h.escape()
  h.click('files')
  assert.match(h.rendered, /src\/cart\/EmptyCart.tsx/)
  assert.doesNotMatch(h.rendered, /checkout.tsx/)
  h.click('thread', { id: 'checkout' })
  h.click('files')
  h.click('select-file', { index: '1' })
  assert.match(h.rendered, /class="diff-title">src\/checkout\/loading-state.test.tsx/)
  h.click('thread', { id: 'review' })
  h.click('files')
  assert.match(h.rendered, /文件证据未缓存，不能视为没有改动/)
})

test('offline sends and approvals are disabled and rejected by handlers', () => {
  const h = harness()
  h.scenario('offline')
  assert.match(h.rendered, /dot offline/)
  assert.match(h.rendered, /新建会话" disabled/)
  h.page('new')
  h.input('composer', 'Do not send')
  h.click('send-new')
  assert.match(h.rendered, /class="new-header|new-header/)
  h.click('thread', { id: 'approval' })
  h.click('approval')
  assert.match(h.rendered, /data-action="approve" disabled/)
  h.click('approve')
  h.click('reject')
  assert.doesNotMatch(h.rendered, /审批回复已提交/)
})

test('changed approval fingerprint survives disconnect and requires a fresh review', () => {
  const h = harness()
  h.scenario('stale')
  h.scenario('offline')
  assert.match(h.rendered, /--updateSnapshot/)
  h.scenario('online')
  assert.match(h.rendered, /sample-b72e/)
  h.click('approve')
  assert.match(h.rendered, />批准一次</)
  assert.doesNotMatch(h.rendered, /审批回复已提交/)
  h.click('approve')
  assert.match(h.rendered, /审批回复已提交 · 等待主机确认/)
  h.click('approval')
  assert.match(h.rendered, /data-action="approve" disabled/)
  h.click('reject')
  assert.match(h.rendered, /等待主机确认/)
})

test('stop request stays pending and is scoped to one task', () => {
  const h = harness()
  h.click('thread', { id: 'checkout' })
  h.click('stop')
  h.click('confirm-stop')
  h.flush()
  assert.match(h.rendered, /停止已请求 · 等待主机确认/)
  h.click('thread', { id: 'copy' })
  assert.doesNotMatch(h.rendered, /停止已请求/)
  h.click('thread-menu')
  assert.match(h.rendered, /data-action="stop" disabled/)
  h.click('thread', { id: 'checkout' })
  assert.match(h.rendered, /停止已请求/)
})

test('terminal input requires exclusive control and never blindly replays', () => {
  const h = harness()
  h.click('terminal')
  assert.match(h.rendered, /桌面正在控制/)
  h.input('terminal-input', 'echo demo')
  h.click('terminal-send')
  assert.doesNotMatch(h.rendered, /输入已提交/)
  h.click('take-control')
  h.click('confirm-control')
  assert.match(h.rendered, /桌面输入已禁用/)
  h.click('terminal-send')
  assert.match(h.rendered, /输入已提交，执行结果未确认/)
  assert.match(h.rendered, /发送终端输入" disabled/)
  h.scenario('offline')
  assert.match(h.rendered, /控制权未知/)
})

test('revoke is persistent; demo pairing does not restore control', () => {
  const h = harness()
  h.click('machines')
  h.click('revoke')
  assert.match(h.rendered, /不会自动停止已经运行的任务/)
  h.click('confirm-revoke')
  h.scenario('online')
  assert.match(h.rendered, /设备授权已撤销/)
  h.click('pair')
  h.click('pair-confirm')
  assert.match(h.rendered, /未创建连接或授予访问权/)
  h.click('close-modal')
  h.click('home')
  assert.match(h.rendered, /新建会话" disabled/)
})

test('messages are escaped, pending and isolated by task', () => {
  const h = harness()
  h.page('chat')
  h.input('composer', '<img src=x onerror=alert(1)>')
  h.click('send')
  h.flush()
  assert.match(h.rendered, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(h.rendered, /<img src=x/)
  assert.match(h.rendered, /已提交 · 等待主机确认/)
  h.input('composer', 'duplicate')
  h.click('send')
  assert.doesNotMatch(h.rendered, /class="user-message">duplicate/)
  h.click('thread', { id: 'copy' })
  assert.doesNotMatch(h.rendered, /onerror/)
})

test('provider choices configure only the next run; evidence is not relabelled', () => {
  const h = harness()
  h.page('chat')
  h.click('controls')
  h.click('choose-provider', { provider: 'Codex' })
  assert.match(h.rendered, /当前会话：Claude Code/)
  assert.match(h.rendered, /Mac 上配置的模型/)
  h.click('permissions')
  assert.match(h.rendered, /不是 root/)
  h.click('new')
  h.input('composer', '新任务模型示例')
  h.click('send-new')
  h.click('agents')
  assert.match(h.rendered, /Codex/)
  assert.match(h.rendered, /用量证据未提供，不显示为 0/)
  assert.match(h.rendered, /任务已提交 · 等待主机确认/)
  assert.doesNotMatch(h.rendered, /运行中 · 示例主机状态/)
})

test('sheet blank area does not dismiss; Escape closes; notifications persist', () => {
  const h = harness()
  h.click('home-menu')
  h.click('close-modal', {}, { scrim: true, nested: true })
  assert.match(h.rendered, /role="dialog"/)
  h.escape()
  assert.doesNotMatch(h.rendered, /role="dialog"/)
  h.click('settings')
  h.click('notifications')
  assert.match(h.rendered, /class="detail">关闭/)
  h.click('home')
  h.click('settings')
  assert.match(h.rendered, /class="detail">关闭/)
})

test('switching to the offline host does not reuse another host task list', () => {
  const h = harness()
  h.click('hosts')
  h.click('choose-host', { host: 'Travel MacBook' })
  assert.match(h.rendered, /Travel MacBook/)
  assert.match(h.rendered, /这台电脑的会话未缓存/)
  assert.doesNotMatch(h.rendered, /优化结算页加载状态/)
  h.click('terminal')
  assert.match(h.rendered, /终端证据未缓存/)
})
