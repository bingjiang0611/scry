import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const copy = readFileSync(new URL('./copy.js', import.meta.url), 'utf8')
const draft = readFileSync(new URL('./draft.js', import.meta.url), 'utf8')
const production = readFileSync(new URL('../../src/renderer/components/AnalyticsView.tsx', import.meta.url), 'utf8')
const productionSmooth = production.match(/function smoothPath\(points: ChartPoint\[\]\): string \{[\s\S]*?\n\}/)[0]
  .replace('points: ChartPoint[]', 'points').replace('): string', ')')

function setup() {
  const nodes = new Map()
  for (const selector of ['#app', '.chart-surface', '.chart-hover', '.chart-tooltip']) {
    nodes.set(selector, {
      innerHTML: '', hidden: true, style: {}, events: new Map(), attributes: new Map([['hidden', '']]),
      addEventListener(name, handler) { this.events.set(name, handler) },
      setAttribute(name, value) { this.attributes.set(name, value) },
      removeAttribute(name) { this.attributes.delete(name) },
      getBoundingClientRect() { return { left: 50, width: 900 } }
    })
  }
  const context = vm.createContext({
    document: { title: '', querySelector: selector => nodes.get(selector) },
    window: { addEventListener() {} }
  })
  vm.runInContext(copy, context)
  vm.runInContext(draft, context)
  const chart = nodes.get('.chart-surface')
  return {
    context,
    app: nodes.get('#app'),
    hover: nodes.get('.chart-hover'),
    tooltip: nodes.get('.chart-tooltip'),
    move(index) { chart.events.get('pointermove')({ clientX: 50 + index * 900 / 29 }) },
    emit(name) { chart.events.get(name)() },
    key(key) { chart.events.get('keydown')({ key, preventDefault() {} }) }
  }
}

test('smooth curves use the current App interpolation, not straight segments', () => {
  const { context } = setup()
  const reference = vm.createContext({})
  vm.runInContext(productionSmooth, reference)
  for (const points of [[], [{ x: 0, y: 300 }], [{ x: 0, y: 300 }, { x: 30, y: 50 }, { x: 60, y: 270 }]]) {
    context.points = points
    reference.points = points
    assert.equal(vm.runInContext('smoothPath(points)', context), vm.runInContext('smoothPath(points)', reference))
  }
  const curve = vm.runInContext('line(series.codex)', context)
  assert.equal((curve.match(/ C /g) || []).length, 29)
  assert.ok(!curve.includes(' L'))
})

test('hover shows the selected date and values, preserving zero versus no record', () => {
  const h = setup()
  assert.equal(h.tooltip.hidden, true)
  h.move(17)
  assert.equal(h.tooltip.hidden, false)
  for (const value of ['Oct 9', 'Codex', '$228.00', 'cc-switch', '—', '当日无记录', 'Qoder', '$0.00']) {
    assert.ok(h.tooltip.innerHTML.includes(value), value)
  }
  assert.equal((h.hover.innerHTML.match(/<circle /g) || []).length, 2)
  assert.ok(!h.hover.attributes.has('hidden'))
  h.emit('focus')
  assert.ok(h.tooltip.innerHTML.includes('Oct 9'), 'mouse focus must not replace the hovered day')
  h.emit('pointerleave')
  assert.equal(h.tooltip.hidden, true)
  assert.ok(h.hover.attributes.has('hidden'))
})

test('tooltip stays inside the plot at both edges and tracks different days', () => {
  const h = setup()
  for (const index of [0, 14, 29]) {
    h.move(index)
    const left = Number.parseFloat(h.tooltip.style.left)
    assert.ok(left >= 8 && left <= 900 - 232 - 8)
  }
  assert.ok(h.tooltip.innerHTML.includes('Oct 21'))
  h.move(0)
  assert.ok(h.tooltip.innerHTML.includes('Sep 22'))
})

test('keyboard can inspect days and dismiss the tooltip', () => {
  const h = setup()
  h.emit('focus')
  assert.ok(h.tooltip.innerHTML.includes('Oct 21'))
  h.key('ArrowLeft')
  assert.ok(h.tooltip.innerHTML.includes('Oct 20'))
  h.key('Home')
  h.key('ArrowLeft')
  assert.ok(h.tooltip.innerHTML.includes('Sep 22'))
  h.key('End')
  h.key('ArrowRight')
  assert.ok(h.tooltip.innerHTML.includes('Oct 21'))
  h.key('Escape')
  assert.equal(h.tooltip.hidden, true)
  h.emit('focus')
  h.emit('blur')
  assert.equal(h.tooltip.hidden, true)
})

test('the cleaned-up overview and model detail table remain intact', () => {
  const { app } = setup()
  const html = app.innerHTML
  assert.equal((html.match(/<article class="provider /g) || []).length, 3)
  assert.equal((html.match(/<div class="metric">/g) || []).length, 5)
  assert.equal((html.match(/<tbody>([\s\S]*?)<\/tbody>/)[1].match(/<tr>/g) || []).length, 5)
  const visible = html.replace(/<[^>]+>/g, '')
  for (const text of ['Credits', '已知下界', '数据说明', '非实际账单', 'unknown']) assert.ok(!visible.includes(text))
  assert.ok(!html.includes('undefined') && !html.includes('NaN'))
})
