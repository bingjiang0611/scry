import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

// State/markup checks only. These do not prove browser layout, focus or real Agent execution.
const source = (await Promise.all(['prototype-copy.js', 'prototype.js'].map(name =>
  readFile(new URL(name, import.meta.url), 'utf8')))).join('\n')
function preview(scene = 'live') {
  const target = { focus() {}, getBoundingClientRect() { return { bottom: 140, right: 600 } } }
  const element = () => ({ innerHTML: '', style: {}, addEventListener() {}, setAttribute() {},
    querySelector() { return target }, showModal() {}, close() {}, open: false,
    matches() { return this.open }, showPopover() { this.open = true }, hidePopover() { this.open = false } })
  const app = element()
  const dialog = element()
  const history = element()
  const context = vm.createContext({ document: {
    title: '', body: { classList: { toggle() {} } },
    querySelector(selector) { return ({ '#app': app, '#snapshot': dialog, '#history-menu': history })[selector] ?? target }
  } })
  vm.runInContext(source, context)
  if (scene) vm.runInContext(`act('mode:${scene}')`, context)
  return { app, dialog, history, run: expression => vm.runInContext(expression, context) }
}

test('closing and reopening retains the same conversation and draft', () => {
  const p = preview()
  p.run("entry().draft = 'keep this draft'; act('close:a')")
  assert.equal(p.run('current().active'), 'b')
  assert.equal(p.run('current().entries.length'), 2)
  p.run("act('history')")
  assert.match(p.history.innerHTML, /data-action="restore:a"/)
  p.run("act('restore:a')")
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

test('creating is distinct from sending and opens a new empty preview', () => {
  const p = preview()
  p.run("act('new')")
  assert.equal(p.run('current().entries.length'), 3)
  assert.equal(p.run('current().active'), 'new1')
  assert.equal(p.run('entry().mode'), 'empty')
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
  assert.match(p.app.innerHTML, /浏览、阅读并引用工作区文件/)
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
  assert.equal(p.run('state.dark'), false)
  assert.match(p.app.innerHTML, /window narrow show-main/)
})

test('the default entry is the seven-item Surface chooser, not a new conversation', () => {
  const p = preview(null)
  assert.equal(p.run('current().picker'), true)
  assert.equal(p.run('current().open.length'), 0)
  assert.equal(p.run('current().entries.length'), 2)
  assert.match(p.app.innerHTML, /打开一个 Surface/)
  assert.match(p.app.innerHTML, /data-action="new"/)
  assert.equal((p.app.innerHTML.match(/data-action="tool:/g) ?? []).length, 6)
  p.run("act('new')")
  assert.equal(p.run('current().picker'), false)
  assert.equal(p.run('current().active'), 'new1')
  assert.equal(p.run('state.notice'), '')
})

test('plus opens the existing-style tool menu without creating or changing either draft', () => {
  const p = preview()
  p.run("entry().draft = 'side draft'; current().mainDraft = 'main draft'; act('menu')")
  assert.equal(p.run('current().entries.length'), 2)
  assert.equal(p.run('current().active'), 'a')
  assert.equal(p.run('current().picker'), false)
  assert.match(p.history.innerHTML, /data-action="new"/)
  assert.equal((p.history.innerHTML.match(/data-action="tool:/g) ?? []).length, 6)
  assert.equal(p.run('entry().draft'), 'side draft')
  assert.equal(p.run('current().mainDraft'), 'main draft')
})

test('tool entries reuse a single tab; repeated side creation yields independent drafts', () => {
  const p = preview(null)
  for (const id of p.run('COPY.surfaces.map(item => item.id)')) {
    p.run(`act('tool:${id}'); act('picker'); act('tool:${id}')`)
    assert.equal(p.run(`current().open.filter(id => id === '${id}').length`), 1)
  }
  p.run("act('picker'); act('new'); entry().draft = 'first'; act('picker'); act('new')")
  assert.equal(p.run('current().active'), 'new2')
  assert.equal(p.run('entry().draft'), '')
  p.run("act('tab:new1')")
  assert.equal(p.run('entry().draft'), 'first')
  p.run("act('menu'); act('tool:files')")
  assert.equal(p.history.open, false)
})

test('closing the last tab returns to Surface chooser without deleting the side chat', () => {
  const p = preview(null)
  p.run("act('new'); act('close:new1')")
  assert.equal(p.run('current().picker'), true)
  assert.equal(p.run('current().open.length'), 0)
  assert.equal(p.run('current().entries.length'), 3)
  assert.match(p.app.innerHTML, /打开一个 Surface/)
})
