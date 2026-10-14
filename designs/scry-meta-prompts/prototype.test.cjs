// Focused logic checks, not a browser or production App acceptance test.
const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, 'prototype.js'), 'utf8')
const helperSource = source.slice(0, source.indexOf('const samples ='))
const insertSource = source.slice(source.indexOf('function insertPrompt('), source.indexOf('const editValue ='))
const matchSource = source.slice(source.indexOf('const matches ='), source.indexOf('const visiblePrompts ='))

function fixture(draft = '') {
  const state = { value: draft, focused: false, notice: '', closed: false }
  const composer = { get value() { return state.value }, set value(value) { state.value = value }, focus() { state.focused = true } }
  const node = { classList: { add() {}, remove() {} }, close() { state.closed = true } }
  const context = vm.createContext({
    prompts: [{ id: 'sample', body: '第一段\n\n第二段' }],
    $: selector => selector === '#composer' ? composer : node,
    notify: message => { state.notice = message }
  })
  vm.runInContext(`${helperSource}\n${insertSource}\n${matchSource}`, context)
  return { state, context }
}

test('inserting a prompt preserves the existing draft and line breaks', () => {
  const { state, context } = fixture('原本的任务')
  vm.runInContext("insertPrompt('sample')", context)
  assert.equal(state.value, '原本的任务\n\n第一段\n\n第二段')
  assert.equal(state.notice, '已放入输入框，尚未发送')
  assert.equal(state.focused, true)
  assert.equal(state.closed, true)
})

test('inserting into an empty composer adds no extra separator', () => {
  const { state, context } = fixture()
  vm.runInContext("insertPrompt('sample')", context)
  assert.equal(state.value, '第一段\n\n第二段')
})

test('HTML and attribute delimiters remain literal prompt text', () => {
  const { context } = fixture()
  const escapeHtml = vm.runInContext('escapeHtml', context)
  assert.equal(escapeHtml('<script>&'), '&lt;script&gt;&amp;')
  assert.equal(escapeHtml('"\''), '&quot;&#39;')
})

test('search matches titles and bodies, case-insensitively, with whitespace trimmed', () => {
  const { context } = fixture()
  const matches = vm.runInContext('matches', context)
  const prompt = { title: '技术方案', body: 'Check Provider result' }
  assert.equal(matches(prompt, '方案'), true)
  assert.equal(matches(prompt, '  provider  '), true)
  assert.equal(matches(prompt, 'Recorder'), false)
})
