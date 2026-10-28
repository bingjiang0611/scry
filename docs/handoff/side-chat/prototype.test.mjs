import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

// State/markup checks only. These do not prove browser layout, focus or real Agent execution.
const source = await readFile(new URL('./prototype.js', import.meta.url), 'utf8')
function preview() {
  const element = () => ({ innerHTML: '', addEventListener() {}, setAttribute() {}, focus() {}, querySelector() { return null }, showModal() {}, close() {} })
  const app = element()
  const dialog = element()
  const context = vm.createContext({ document: {
    title: '', body: { classList: { toggle() {} } },
    querySelector(selector) { return selector === '#app' ? app : selector === '#snapshot' ? dialog : null }
  } })
  vm.runInContext(source, context)
  return { app, dialog, run: expression => vm.runInContext(expression, context) }
}

test('closing and reopening retains the same conversation and draft', () => {
  const p = preview()
  p.run("entry().draft = 'keep this draft'; act('close:a')")
  assert.equal(p.run('current().active'), 'b')
  assert.equal(p.run('current().entries.length'), 2)
  p.run("act('history')")
  assert.equal(p.run('current().active'), 'a')
  assert.equal(p.run('entry().draft'), 'keep this draft')
})

test('parent scopes retain their own active side chat and drafts', () => {
  const p = preview()
  p.run("act('tab:b'); entry().draft = 'parent A'; act('parent:1')")
  assert.equal(p.run('current().active'), 'c')
  p.run("entry().draft = 'parent B'; act('parent:0')")
  assert.equal(p.run('current().active'), 'b')
  assert.equal(p.run('entry().draft'), 'parent A')
})

test('creating is distinct from sending and focuses a new empty preview', () => {
  const p = preview()
  p.run("act('new')")
  assert.equal(p.run('current().entries.length'), 3)
  assert.equal(p.run('current().active'), 'new1')
  assert.equal(p.run('state.mode'), 'empty')
  assert.equal(p.run('state.notice'), '')
  assert.match(p.app.innerHTML, /换个角度，继续探索/)
})

test('send is explicitly a simulation and keeps the draft', () => {
  const p = preview()
  p.run("entry().draft = 'do not actually send'; act('send')")
  assert.equal(p.run('entry().draft'), 'do not actually send')
  assert.match(p.app.innerHTML, /未发送消息，也未启动 Agent/)
})

test('file tab preserves the chat draft; empty and error states are distinct', () => {
  const p = preview()
  p.run("entry().draft = 'saved'; act('tab:files')")
  assert.match(p.app.innerHTML, /工作区文件/)
  p.run("act('tab:a'); act('mode:empty')")
  assert.match(p.app.innerHTML, /换个角度，继续探索/)
  p.run("act('mode:error')")
  assert.match(p.app.innerHTML, /尚未发送/)
  assert.equal(p.run('entry().draft'), 'saved')
})

test('snapshot scope changes with parent without claiming native fork', () => {
  const p = preview()
  p.run('showSnapshot()')
  assert.match(p.dialog.innerHTML, /第 8 轮 · 已完成/)
  assert.match(p.dialog.innerHTML, /不是原生会话 fork/)
  p.run("act('parent:1'); showSnapshot()")
  assert.match(p.dialog.innerHTML, /第 3 轮 · 已完成/)
})

test('draft text cannot inject markup on rerender', () => {
  const p = preview()
  p.run("entry().draft = '</textarea><script>bad()</script>'; render()")
  assert.doesNotMatch(p.app.innerHTML, /<script>/)
  assert.match(p.app.innerHTML, /&lt;\/textarea&gt;/)
})

test('narrow presentation and theme do not change conversation identity', () => {
  const p = preview()
  p.run("act('narrow'); act('main'); act('theme')")
  assert.equal(p.run('current().active'), 'a')
  assert.equal(p.run('state.dark'), true)
  assert.match(p.app.innerHTML, /window narrow show-main/)
})
