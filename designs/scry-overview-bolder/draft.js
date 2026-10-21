// Scry · 总览证据块（右栏 dossier 顶部）动效稿数据与渲染。
// 所有数值是设计示例，取自用户截图：26% · 70.5k / 272.0k · 263 calls · 875.8k · 100.0% · $31.81。

const COPY = {
  title: 'Scry · 总览证据块',
  subtitle: 'Bolder 设计稿 · 示例数据来自你的截图，不是真实会话',
  panelTitle: '总览',
  annotation: '本机真实数据',
  state: '运行中',
  calls: '263 calls',
  contextLabel: '上下文占用',
  tokenLabel: '输入（含缓存）+输出',
  cacheLabel: '缓存命中率',
  costLabel: '成本',
  sessionLabel: '会话',
  compactLabel: 'Compact',
  idLabel: 'ID',
  tabs: ['轮次数据', '会话数据'],
  turnsHeading: '每轮调用',
  turnsMeta: '263 turns'
}

const DATA = {
  used: '70.5k',
  window: '272.0k',
  pct: 26,
  pctText: '26%',
  calls: '263 calls',
  tokens: '875.8k',
  cache: '100.0%',
  cost: '$31.81',
  compactions: '1',
  shortId: '01a15e55…0fcd9afc'
}

const VARIANTS = [
  {
    id: 'a',
    key: 'A',
    name: '现状 · 环 + 通栏主指标',
    peak: '上下文占用环',
    container: '卡片（发丝线）',
    meter: '圆环',
    note: '已提交的版本：环 66px、已用量 21px，主证据通栏、命中率与成本并排。层级靠字号，容器保持三格。',
    cost: '代价：仍是三块卡片，信息密度最低。'
  },
  {
    id: 'b',
    key: 'B',
    name: '台账 · 去卡片',
    peak: 'Token 总量（右对齐）',
    container: '发丝线行',
    meter: '小圆环（行首）',
    note: '全部改成一列右对齐数字，只在行间留 1px 发丝线；环缩到 40px 退成行首标记。密度最高，最像观察台账。',
    cost: '代价：数字靠右，扫读时要横向移动视线。'
  },
  {
    id: 'c',
    key: 'C',
    name: '刻度 · 横向占用条',
    peak: 'Token 总量',
    container: '无容器（发丝线分段）',
    meter: '横向刻度条',
    note: '把「用了多少 / 还剩多少」画成长度而不是圆环：26% 的横向条占据通栏，token 总量紧随其后，命中率与成本用竖线分隔。',
    cost: '代价：放弃圆环这个既有原语，竖排信息更高。'
  },
  {
    id: 'd',
    key: 'D',
    name: '单峰 · 环是唯一图形',
    peak: '上下文占用环（96px）',
    container: '图例网格（无卡片）',
    meter: '大圆环',
    note: '整块只留一个图形：96px 的环、22px 的百分比；其余三项压成一行图例。视觉最集中，其余证据明显降级。',
    cost: '代价：成本与命中率被排到最低优先级。'
  }
]

const query = new URLSearchParams(location.search)
const state = {
  variant: query.get('variant') ?? 'a',
  theme: query.get('theme') === 'light' ? 'light' : 'dark',
  width: Number(query.get('width')) === 340 ? 340 : 380,
  compare: query.get('compare') === '1'
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]))
}

// label 为空时环只是刻度标记，百分比由旁的文字承担，避免同一数字出现两次。
function ring(size, inner, label = DATA.pctText) {
  return `<span class="ring" style="--size:${size}px;--inner:${inner}px;--p:${DATA.pct}" role="img" aria-label="上下文占用 ${DATA.pctText}">${label ? `<b>${label}</b>` : ''}</span>`
}

function verdict() {
  return `<div class="verdict">
    <span class="verdict-state"><i class="dot" aria-hidden="true"></i><strong>${COPY.state}</strong></span>
    <em>${COPY.calls}</em>
  </div>`
}

function sessionRows() {
  return `<div class="session">
    <div class="session-head"><span>${COPY.sessionLabel}</span><span class="session-compact">${COPY.compactLabel}<span class="info" aria-hidden="true">i</span><b>${DATA.compactions}</b></span></div>
    <div class="session-id"><span class="label">${COPY.idLabel}</span><code>${DATA.shortId}</code><span class="copy" aria-hidden="true">⧉</span></div>
  </div>`
}

function tabs() {
  return `<div class="tabs" role="tablist">
    <button role="tab" class="active" aria-selected="true">${COPY.tabs[0]}</button>
    <button role="tab" aria-selected="false">${COPY.tabs[1]}</button>
  </div>`
}

function turnSample() {
  return `<div class="turns">
    <div class="turns-head"><span>${COPY.turnsHeading}</span><em>${COPY.turnsMeta}</em></div>
    <div class="turn-row"><span class="tid">T01</span><span class="turn-preview">/rate-native-hsf-invoke 查询接口</span></div>
  </div>`
}

// A · 现状：环 66 + 通栏主指标卡片 + 并排两格
function variantA() {
  return `
  <div class="a-gauge">
    ${ring(66, 5)}
    <div class="a-value"><b>${DATA.used}</b><span> / ${DATA.window}</span></div>
  </div>
  ${verdict()}
  <div class="a-metrics">
    <div class="a-metric lead"><span>${COPY.tokenLabel}</span><strong>${DATA.tokens}</strong></div>
    <div class="a-metric"><span>${COPY.cacheLabel}</span><strong>${DATA.cache}</strong></div>
    <div class="a-metric"><span>${COPY.costLabel}</span><strong>${DATA.cost}</strong></div>
  </div>
  ${sessionRows()}`
}

// B · 台账：发丝线行，数字右对齐
function variantB() {
  return `
  ${verdict()}
  <div class="b-ledger">
    <div class="b-row">
      <span class="b-head">${ring(40, 4, '')}<span class="b-label">${COPY.contextLabel}<b>${DATA.pctText}</b></span></span>
      <span class="b-value"><b>${DATA.used}</b> / ${DATA.window}</span>
    </div>
    <div class="b-row">
      <span class="b-label">${COPY.tokenLabel}</span>
      <strong class="b-value lead">${DATA.tokens}</strong>
    </div>
    <div class="b-row"><span class="b-label">${COPY.cacheLabel}</span><strong class="b-value">${DATA.cache}</strong></div>
    <div class="b-row"><span class="b-label">${COPY.costLabel}</span><strong class="b-value">${DATA.cost}</strong></div>
  </div>
  ${sessionRows()}`
}

// C · 刻度：横向占用条 + 无容器分段
function variantC() {
  return `
  ${verdict()}
  <div class="c-meter">
    <div class="c-meter-head"><span>${COPY.contextLabel}</span><b>${DATA.pctText}</b></div>
    <div class="c-track" role="img" aria-label="上下文占用 ${DATA.pctText}"><span style="width:${DATA.pct}%"></span></div>
    <div class="c-meter-foot"><span>${DATA.used}</span><span>${DATA.window}</span></div>
  </div>
  <div class="c-total">
    <span>${COPY.tokenLabel}</span>
    <strong>${DATA.tokens}</strong>
  </div>
  <div class="c-pair">
    <div><span>${COPY.cacheLabel}</span><strong>${DATA.cache}</strong></div>
    <div><span>${COPY.costLabel}</span><strong>${DATA.cost}</strong></div>
  </div>
  ${sessionRows()}`
}

// D · 单峰：96px 环 + 一行图例
function variantD() {
  return `
  ${verdict()}
  <div class="d-hero">
    ${ring(96, 7, '')}
    <div class="d-hero-copy"><span>${COPY.contextLabel}</span><b>${DATA.pctText}</b><span class="d-pair">${DATA.used} / ${DATA.window}</span></div>
  </div>
  <div class="d-legend">
    <div><span>${COPY.tokenLabel}</span><strong>${DATA.tokens}</strong></div>
    <div><span>${COPY.cacheLabel}</span><strong>${DATA.cache}</strong></div>
    <div><span>${COPY.costLabel}</span><strong>${DATA.cost}</strong></div>
  </div>
  ${sessionRows()}`
}

const BODY = { a: variantA, b: variantB, c: variantC, d: variantD }

function panel(variant) {
  return `<article class="panel v-${variant.id}" style="width:${state.width}px">
    <div class="panel-head"><strong>${COPY.panelTitle}</strong><em><i aria-hidden="true"></i>${COPY.annotation}</em></div>
    <div class="panel-body">${BODY[variant.id]()}</div>
    ${tabs()}
    ${turnSample()}
  </article>`
}

function render() {
  document.documentElement.dataset.theme = state.theme
  const stage = document.getElementById('stage')
  const current = VARIANTS.find((variant) => variant.id === state.variant)
  if (state.compare) {
    stage.className = 'stage compare'
    stage.innerHTML = VARIANTS.map((variant) => `<div class="compare-cell">
      <div class="compare-caption"><b>${variant.key}</b>${escapeHtml(variant.name)}</div>
      ${panel(variant)}
      <p class="compare-note">${escapeHtml(variant.note)}<br><span>${escapeHtml(variant.cost)}</span></p>
    </div>`).join('')
  } else {
    stage.className = 'stage single'
    stage.innerHTML = `<div class="compare-caption"><b>${current.key}</b>${escapeHtml(current.name)}</div>${panel(current)}`
  }
  document.getElementById('notes').innerHTML = `<dl>
    <div><dt>峰值</dt><dd>${escapeHtml(current.peak)}</dd></div>
    <div><dt>容器</dt><dd>${escapeHtml(current.container)}</dd></div>
    <div><dt>占用可视化</dt><dd>${escapeHtml(current.meter)}</dd></div>
    <div><dt>取舍</dt><dd>${escapeHtml(current.note)}${escapeHtml(current.cost)}</dd></div>
  </dl>`
  for (const button of document.querySelectorAll('[data-variant]')) {
    button.setAttribute('aria-selected', String(button.dataset.variant === state.variant))
  }
  for (const button of document.querySelectorAll('[data-theme]')) {
    button.setAttribute('aria-selected', String(button.dataset.theme === state.theme))
  }
  for (const button of document.querySelectorAll('[data-width]')) {
    button.setAttribute('aria-selected', String(Number(button.dataset.width) === state.width))
  }
  document.getElementById('compare').setAttribute('aria-pressed', String(state.compare))
  document.getElementById('compare').textContent = state.compare ? '单稿查看' : '同屏对比'
}

document.getElementById('variants').innerHTML = VARIANTS
  .map((variant) => `<button role="tab" data-variant="${variant.id}">${variant.key} · ${escapeHtml(variant.name)}</button>`)
  .join('')

document.getElementById('stage').addEventListener('click', (event) => {
  const button = event.target.closest('[data-variant], [data-theme], [data-width]')
  if (!button) return
  if (button.dataset.variant) state.variant = button.dataset.variant
  if (button.dataset.theme) state.theme = button.dataset.theme
  if (button.dataset.width) state.width = Number(button.dataset.width)
  render()
})
document.getElementById('compare').addEventListener('click', () => {
  state.compare = !state.compare
  render()
})

render()
