// Scry · 会话里的「已回答」问答块 · Bolder 设计稿。
// 示例数据取自用户截图：工具组 2 · ask_user_question · bash · 409.7s；
// 卡片 ask_user_question 409.0s；已回答 1 个问题 · 等待 409.0s；问题 = 是否继续修复 ACK 共存问题；答案 = 1。
// 其余状态（两个问题、取消、未完成、长答案、只有 output）是为覆盖边界构造的示例，不是真实会话。

const COPY = {
  title: 'Scry · 会话里的「已回答」问答块',
  stampAnswered: '已回答',
  stampCancelled: '用户取消',
  stampProviderCancelled: 'Provider 取消',
  stampIncomplete: '未完成',
  questions: (n) => `${n} 个问题`,
  wait: (value) => `等待 ${value}`,
  missingAnswer: '未获得答案',
  raw: '查看原始输入与输出',
  scopeNote: '卡片左侧虚线括号内是本次要改的块；外层工具组行、工具卡行与相邻 bash 都保持现状。'
}

const ICONS = {
  check: '<path d="m5 13 4 4L19 7"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>'
}

function ico(name, cls = 'ico') {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`
}

const RAW = {
  input: JSON.stringify({ source: 'claude', questions: [{ header: 'ACK', question: '是否继续修复 App 与独立 CLI 的 ACK 共存问题?', options: [{ label: '1' }, { label: '2' }] }] }, null, 2),
  output: JSON.stringify({ behavior: 'answered', answers: { '是否继续修复 App 与独立 CLI 的 ACK 共存问题?': '1' } }, null, 2)
}

const CASES = [
  {
    id: 'single',
    label: '截图数据 · 单问题 / 短答案',
    status: 'answered',
    count: 1,
    wait: '409.0s',
    pairs: [['是否继续修复 App 与独立 CLI 的 ACK 共存问题?', '1']],
    output: RAW.output,
    dur: '409.0s',
    bar: 78
  },
  {
    id: 'multi',
    label: '两个问题 · 一个长答案',
    status: 'answered',
    count: 2,
    wait: '86.2s',
    pairs: [
      ['App 与独立 CLI 谁先写 ACK?', 'App 先写，CLI 只读回执'],
      ['旧的 lastAck 字段是否保留?', '保留一个版本，下轮删除']
    ],
    output: RAW.output,
    dur: '86.3s',
    bar: 22
  },
  {
    id: 'cancelled',
    label: '用户取消',
    status: 'cancelled',
    count: 1,
    wait: '312.5s',
    pairs: [['是否把 recorder 的写盘间隔从 1000ms 调到 250ms?', null]],
    output: '{"behavior":"cancelled"}',
    dur: '312.6s',
    bar: 61
  },
  {
    id: 'incomplete',
    label: '未完成（error）',
    status: 'incomplete',
    count: 1,
    wait: null,
    pairs: [['是否在 turn record 里写入 provider 侧指纹?', null]],
    output: 'Tool ran without an answer: the provider closed the request.',
    dur: '1.2s',
    bar: 4
  },
  {
    id: 'long',
    label: '长答案（约 120 字）',
    status: 'answered',
    count: 1,
    wait: '74.0s',
    pairs: [['ACK 冲突时按哪个优先？', '按 canonical cwd 优先：同一个仓库只认 App 写入的那一份，CLI 只读取并在缺失时补写；跨仓库的临时目录不共享 ACK，避免 /tmp 下不同 repo 的锁互相覆盖。']],
    output: RAW.output,
    dur: '74.1s',
    bar: 18
  },
  {
    id: 'fallback',
    label: '没有结构化答案，只有 output',
    status: 'answered',
    count: 1,
    wait: '12.4s',
    pairs: [['是否保留当前的 question-raw 折叠?', null]],
    output: '{"behavior":"answered","answers":{"是否保留当前的 question-raw 折叠?":"保留"}}',
    dur: '12.5s',
    bar: 6
  }
]

const STATUS = {
  answered: { copy: COPY.stampAnswered, tone: 'ok', icon: 'check' },
  cancelled: { copy: COPY.stampCancelled, tone: 'bad', icon: 'alert' },
  providerCancelled: { copy: COPY.stampProviderCancelled, tone: 'bad', icon: 'alert' },
  incomplete: { copy: COPY.stampIncomplete, tone: 'bad', icon: 'alert' }
}

const VARIANTS = [
  {
    id: 'a',
    key: 'A',
    name: '现状 · 块内零样式',
    peak: '问题（14px 正文字号）',
    container: '无（沿用工具卡底色）',
    rhythm: '问题的字号与正文相同，答案缩进成默认 <dd>',
    note: '真实 App 现状：这个块的基础样式在 ab5601b 被删掉且没有补回，现在渲染的是浏览器默认的 <dl> / <dd> / <summary>。问题 14px、答案 40px 缩进、时长和状态挤在同一行。',
    cost: '代价：人工决定是这一轮唯一的人类动作，却是块里最不显眼的东西。'
  },
  {
    id: 'b',
    key: 'B',
    name: '倒置 · 决定为峰',
    peak: '答案（16px / 650，阅读声部）',
    container: '无，只有三条发丝线',
    rhythm: '一行等宽小字记录（状态 · 等待 · 问题数），下面一条更重的答案',
    note: '把块从「遥测声部」切回「阅读声部」：状态、等待、问题数压成一条 10.5px 等宽行，问题降为 12.5px 暗色，答案升到 16px/650——和待回答时问题本身的 16px/620 同一级别。块内只出现发丝线，没有新容器。',
    cost: '代价：答案变重之后，长答案会占掉 2–3 行，比现状高。'
  },
  {
    id: 'c',
    key: 'C',
    name: '台账 · 右轨对齐',
    peak: '问答对的结构',
    container: '无，行间发丝线',
    rhythm: '问题左、答案右，全部值对齐到同一条右轨（问题数 / 等待 / 答案）',
    note: '问答成行：问题左列可换行，答案右列 600 字重，行间发丝线；表头是 10px 等宽的状态与等待，天然对齐到答案的右边缘。密度最高，最像证据台账。',
    cost: '代价：短答案（如「1」）会被推到正文右侧，视线要跨过去；620px 下退化成上下两行。'
  },
  {
    id: 'd',
    key: 'D',
    name: '单行 · 时间线记录',
    peak: '没有峰值，整块压成一条记录',
    container: '无，两条发丝线',
    rhythm: '一行写完「✓ 已回答 · 1 个问题 · 等待 409.0s」，问题是单行截断、答案在一行的右侧',
    note: '承认它在会话里出现频率最高的不是阅读而是扫读：整块压成两行、约 70px 高，状态与等待一行，问题 → 答案一行（单行截断，title 与原始输入里可查全文）。',
    cost: '代价：长问题和长答案被截断，人工介入这件事在时间线上的存在感最弱。'
  }
]

const BODY = {
  a: (c) => `
    <div class="qblock v-a${toneClass(c)}">
      <div class="qb-head"><span>${STATUS[c.status].copy}</span><small>${COPY.questions(c.count)}${c.wait ? ` · ${COPY.wait(c.wait)}` : ''}</small></div>
      <dl class="qb-list">${c.pairs.map(([q, a]) => `<div><dt>${esc(q)}</dt><dd>${esc(a ?? COPY.missingAnswer)}</dd></div>`).join('')}</dl>
      ${c.pairs.some(([, a]) => !a) && c.output ? `<div class="qb-fallback">${esc(c.output)}</div>` : ''}
      ${raw(c)}
    </div>`,

  b: (c) => `
    <div class="qblock v-b${toneClass(c)}">
      <div class="qb-head">${stamp(c)}<span class="qb-meta">${COPY.questions(c.count)}${c.wait ? `<span class="sep" aria-hidden="true">·</span>${COPY.wait(c.wait)}` : ''}</span></div>
      ${c.pairs.map(([q, a]) => `<div class="qb-decision">
        <p class="qb-q">${esc(q)}</p>
        <p class="qb-a${a ? '' : ' missing'}">${esc(a ?? COPY.missingAnswer)}</p>
      </div>`).join('')}
      ${c.pairs.some(([, a]) => !a) && c.output ? `<div class="qb-fallback">${esc(c.output)}</div>` : ''}
      ${raw(c)}
    </div>`,

  c: (c) => `
    <div class="qblock v-c${toneClass(c)}">
      <div class="qb-head">${stamp(c)}<span class="qb-meta">${COPY.questions(c.count)}</span>${c.wait ? `<span class="qb-meta">${COPY.wait(c.wait)}</span>` : ''}</div>
      <div class="qb-rows">${c.pairs.map(([q, a]) => `<div class="qb-row">
        <p class="qb-q">${esc(q)}</p>
        <p class="qb-a${a ? '' : ' missing'}">${esc(a ?? COPY.missingAnswer)}</p>
      </div>`).join('')}</div>
      ${c.pairs.some(([, a]) => !a) && c.output ? `<div class="qb-fallback">${esc(c.output)}</div>` : ''}
      ${raw(c)}
    </div>`,

  d: (c) => `
    <div class="qblock v-d${toneClass(c)}">
      <div class="qb-line qb-head">
        ${stamp(c)}
        <span class="qb-meta">${COPY.questions(c.count)}</span>
        ${c.wait ? `<span class="qb-meta">${COPY.wait(c.wait)}</span>` : ''}
      </div>
      ${c.pairs.map(([q, a]) => `<div class="qb-line">
        <p class="qb-q" title="${esc(q)}">${esc(q)}</p>
        ${ico('chevronRight', 'ico')}
        <p class="qb-a${a ? '' : ' missing'}" title="${esc(a ?? COPY.missingAnswer)}">${esc(a ?? COPY.missingAnswer)}</p>
      </div>`).join('')}
      ${c.pairs.some(([, a]) => !a) && c.output ? `<div class="qb-fallback">${esc(c.output)}</div>` : ''}
      ${raw(c)}
    </div>`
}

function toneClass(c) {
  return c.status === 'answered' ? '' : ' error'
}

function stamp(c) {
  const status = STATUS[c.status]
  return `<span class="qb-stamp">${ico(status.icon)}${status.copy}</span>`
}

function raw(c) {
  return `<details class="qb-raw">
    <summary>${ico('chevronRight')}<span>${COPY.raw}</span></summary>
    <div class="lbl">input</div>
    <pre>${esc(RAW.input)}</pre>
    ${c.output ? `<div class="lbl">output</div><pre>${esc(c.output)}</pre>` : ''}
  </details>`
}

function esc(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]))
}

function askCard(variant, c, { framed = true } = {}) {
  const failed = c.status !== 'answered'
  return `<div class="tool-card">
    <div class="tool-row">
      <span class="st ${failed ? 'err' : 'ok'}">${ico(failed ? 'alert' : 'check')}</span>
      <span class="name">ask_user_question</span>
      <span class="arg">ask_user_question</span>
      <span class="meta"><span class="dur">${c.dur}</span><span class="bar${c.bar >= 70 ? ' slow' : ''}"><i style="width:${c.bar}%"></i></span></span>
      ${ico('chevronUp', 'ico chev')}
    </div>
    <div class="${framed ? 'target' : ''}">${BODY[variant](c)}</div>
  </div>`
}

function transcript(variant, c) {
  return `<div class="transcript">
    <div class="turn">
      <p class="model-text">ACK 归属还没定，先问你一句再改代码。</p>
      <div class="turn-flow">
        <div class="tool-group">
          <div class="tool-group-row">
            <span class="tg-pill">2</span>
            <span class="tg-label">ask_user_question · bash</span>
            <span class="tg-rule"></span>
            <span class="tg-dur">409.7s</span>
            ${ico('chevronUp', 'ico chev')}
          </div>
          <div class="tool-group-body">
            ${askCard(variant, c)}
            <div class="tool-card">
              <div class="tool-row">
                <span class="st ok">${ico('check')}</span>
                <span class="name">bash</span>
                <span class="arg">cd /tmp/scry-cli-multirepo.AVEdj0/source &amp;&amp; pwd -P &amp;&amp; git rev-parse --show-toplevel</span>
                <span class="meta"><span class="dur">691ms</span><span class="bar"><i style="width:3%"></i></span></span>
                ${ico('chevronDown', 'ico chev')}
              </div>
            </div>
          </div>
        </div>
      </div>
      <p class="model-text">已确认继续，先核对 App 与 CLI 的 ACK 写入路径。</p>
    </div>
  </div>`
}

function states(variant) {
  return `<section class="states">
    <div class="states-inner" style="width:${state.width}px;max-width:100%">
      <h2>边界与状态</h2>
      <p class="states-note">同一稿在其余数据下的样子。多问题、取消、未完成、长答案、只有 output：状态色、等待时长的缺失、以及原始输入折叠都必须照旧成立。</p>
      <div class="state-grid">
        ${CASES.map((c) => `<div class="state-case">
          <div class="state-label">${esc(c.label)}</div>
          <div class="state-frame">${askCard(variant, c, { framed: false })}</div>
        </div>`).join('')}
      </div>
    </div>
  </section>`
}

const query = new URLSearchParams(location.search)
const state = {
  variant: query.get('variant') ?? 'a',
  theme: query.get('theme') === 'light' ? 'light' : 'dark',
  width: Number(query.get('width')) === 620 ? 620 : 800,
  compare: query.get('compare') === '1'
}

function sheet(variant) {
  const main = CASES[0]
  return `<section class="sheet">
    <div class="sheet-caption"><b>${variant.key}</b>${esc(variant.name)}<small>${esc(variant.peak)}</small></div>
    <div class="width-${state.width}" style="width:${state.width}px;max-width:100%">${transcript(variant.id, main)}</div>
    <p class="sheet-note">${esc(variant.note)}<br><b>${esc(variant.cost)}</b></p>
  </section>`
}

function render() {
  document.documentElement.dataset.theme = state.theme
  const stage = document.getElementById('stage')
  const current = VARIANTS.find((variant) => variant.id === state.variant)

  if (state.compare) {
    stage.className = 'stage compare'
    stage.innerHTML = `<p class="states-note">${COPY.scopeNote}</p>` + VARIANTS.map(sheet).join('')
  } else {
    stage.className = 'stage single'
    stage.innerHTML = `<p class="states-note">${COPY.scopeNote}</p>` + sheet(current)
  }

  const currentStates = document.getElementById('states-slot')
  if (currentStates) currentStates.remove()
  if (!state.compare) {
    stage.insertAdjacentHTML('afterend', `<div id="states-slot">${states(current.id)}</div>`)
  }

  document.getElementById('notes').innerHTML = `<dl>
    <div><dt>峰值</dt><dd>${esc(current.peak)}</dd></div>
    <div><dt>容器</dt><dd>${esc(current.container)}</dd></div>
    <div><dt>节奏</dt><dd>${esc(current.rhythm)}</dd></div>
    <div><dt>取舍</dt><dd>${esc(current.note)}${esc(current.cost)}</dd></div>
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
  const compare = document.getElementById('compare')
  compare.setAttribute('aria-pressed', String(state.compare))
  compare.textContent = state.compare ? '单稿查看' : '同屏对比'
}

document.getElementById('variants').innerHTML = VARIANTS
  .map((variant) => `<button role="tab" data-variant="${variant.id}">${variant.key} · ${esc(variant.name)}</button>`)
  .join('')

document.addEventListener('click', (event) => {
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
