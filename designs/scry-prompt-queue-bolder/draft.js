// Scry · 等待队列 · Bolder 设计稿
// 全部数据为模拟：文本来自截图与自拟示例，Steer 回执不是真实 Provider 证据。

const MESSAGES = [
  { id: 'm1', text: '都覆盖了哪些交互场景', attachments: 0 },
  { id: 'm2', text: '顺便把队列在 720px 下的换行也过一遍，别让 Steer 按钮压住正文。', attachments: 0 },
  { id: 'm3', text: '再补一张截图：附件只保留文件名，不要读图内容。', attachments: 1 }
]

const SCENARIOS = {
  normal: { label: '正常', states: {}, capability: null },
  pending: { label: '提交中', states: { m1: { status: 'pending' } }, capability: null },
  unknown: {
    label: '结果未知',
    states: { m2: { status: 'unknown', message: '结果未知：Provider 未回执；不重发、不移除、不自动出队' } },
    capability: null
  },
  rejected: {
    label: '已拒绝',
    states: { m1: { status: 'rejected', message: 'Provider 明确拒绝：当前运行不在可补充状态' } },
    capability: null
  },
  unavailable: { label: '能力不可用', states: {}, capability: '当前运行不支持运行中补充消息' }
}

const VARIANTS = [
  {
    id: 'a',
    name: 'A · 现状',
    subtitle: '当前产品实现，作为对照',
    notes: [
      '三行等高、同字重：序号 10px、正文 12.5px、按钮 10.5px，「下一个」和「第 3 条」之间没有层级差。',
      '12px 圆角加 <code>--shadow-pop</code>：一个内联块读成浮层，边界比内容更响。'
    ]
  },
  {
    id: 'b',
    name: 'B · 阶梯',
    subtitle: '序号成为竖轨刻度，只有「下一个」抬高',
    notes: [
      '序号并进 1px 竖轨：11.5px 灰 → 15px 琥珀，琥珀段只给第一条，队列头一眼可读。',
      '第一条铺 <code>--surface-hover</code> 加内描边；其余退成 1px 发丝行，不再每行一个盒子。',
      '去掉 <code>--shadow-pop</code>，改成 <code>--surface-inset-soft</code> 内嵌面；Steer 在次要行降到 dim2，悬停才变蓝。'
    ]
  },
  {
    id: 'c',
    name: 'C · 状态列',
    subtitle: '每行固定说明自己在等什么',
    notes: [
      '保留逐行卡片，右侧加 62px 状态列：下一个 / 等待 / 提交中 / 结果未知 / 已拒绝。',
      '状态词右对齐成一条可扫的竖列，未决状态带色点，不再只靠禁用按钮暗示。',
      '代价：正文可用宽度少 62px，窄窗口更早截断。'
    ]
  },
  {
    id: 'd',
    name: 'D · 单峰',
    subtitle: '只展开下一条，其余收成一行',
    notes: [
      '当前任务结束后真正会先跑的只有一条，其余折叠成 <code>展开后面 2 条</code>。',
      '收起的行里只要有未决状态，尾行就用 warn 徽标写出来——不能让折叠把「结果未知」藏掉。',
      '代价：给第 3 条 Steer 要多一次点击。'
    ]
  }
]

const state = {
  variant: 'b',
  scenario: 'normal',
  theme: 'dark',
  width: 960,
  compare: false,
  removed: new Set(),
  overrides: {},
  receipts: [],
  open: false
}

// 深链接：index.html#s=unknown&theme=light&compare=1&v=c&w=720
{
  const params = new URLSearchParams(location.hash.slice(1))
  if (VARIANTS.some((v) => v.id === params.get('v'))) state.variant = params.get('v')
  if (SCENARIOS[params.get('s')]) state.scenario = params.get('s')
  if (params.get('theme') === 'light' || params.get('theme') === 'dark') state.theme = params.get('theme')
  if (params.get('w') === '720') state.width = 720
  if (params.get('compare') === '1') state.compare = true
}

const $ = (sel, root = document) => root.querySelector(sel)
const numeric = 'numeric'

function currentScenario() {
  const base = SCENARIOS[state.scenario]
  return { capability: base.capability, states: { ...base.states, ...state.overrides } }
}

function rows() {
  const { states } = currentScenario()
  return MESSAGES.filter((m) => !state.removed.has(m.id)).map((message, index) => ({
    message,
    index,
    next: index === 0,
    status: states[message.id]?.status ?? 'idle',
    reason: states[message.id]?.message ?? null
  }))
}

function statusWord(row) {
  switch (row.status) {
    case 'pending': return '提交中'
    case 'unknown': return '结果未知'
    case 'rejected': return '已拒绝'
    case 'unavailable': return '不可用'
    default: return row.next ? '下一个' : '等待'
  }
}

const icon = (id, cls = '') => `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`
const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function steerDisabled(row, anyPending, capability) {
  return row.status === 'pending' || row.status === 'unknown' || row.status === 'unavailable' ||
    Boolean(capability) || (anyPending && !row.status.startsWith('pending'))
}

function steerLabel(row) {
  if (row.status === 'pending') return '提交中'
  if (row.status === 'rejected') return '重试'
  return 'Steer'
}

function steerTitle(row, capability) {
  if (row.status === 'pending') return 'Steer 正在提交；完成前不能重复提交或移除'
  if (row.status === 'unknown') return '结果未知；不能重发或移除'
  if (row.status === 'rejected') return 'Provider 明确拒绝；点击重试'
  if (capability) return capability
  return '不中断模型，将这条消息补充给当前任务'
}

function rowMarkup(row, anyPending, capability) {
  const disabled = steerDisabled(row, anyPending, capability)
  // 行内只写法这条消息自己的状态。能力原因属于整个 Composer，只在块底部说一次，
  // 不复制到每一行（那是噪音，不是证据）。
  const reason = row.reason
  const showReason = reason && row.status !== 'idle'
  return `
    <div class="qrow${row.next ? ' next' : ''}" role="listitem" data-state="${capability && row.status === 'idle' ? 'unavailable' : row.status}" data-id="${row.message.id}">
      <span class="qidx ${numeric}" aria-hidden="true">${row.index + 1}</span>
      <span class="qbody">
        <span class="qtext" title="${esc(row.message.text)}">${esc(row.message.text)}</span>
        ${showReason ? `<span class="qreason">${icon('alert')}${esc(reason)}</span>` : ''}
      </span>
      <span class="qstate">${statusWord(row)}</span>
      ${row.message.attachments > 0 ? `<span class="qattach" title="${row.message.attachments} 张附件（示例）">${icon('image')}${row.message.attachments}</span>` : '<span></span>'}
      <button type="button" class="qsteer" data-act="steer" data-id="${row.message.id}"
        ${disabled ? 'disabled aria-disabled="true"' : ''}
        aria-label="${steerLabel(row)}：队列第 ${row.index + 1} 条消息" title="${esc(steerTitle(row, capability))}">
        ${row.status === 'pending' ? '' : icon('steer')}${steerLabel(row)}
      </button>
      <button type="button" class="qremove" data-act="remove" data-id="${row.message.id}"
        ${row.status === 'pending' || row.status === 'unknown' ? 'disabled' : ''}
        aria-label="移除队列第 ${row.index + 1} 条消息"
        title="${row.status === 'pending' ? 'Steer 正在提交，不能移除' : row.status === 'unknown' ? '结果未知的 Steer 不能移除' : '移除排队消息'}">
        ${icon('x')}
      </button>
    </div>`
}

function tailMarkup(list) {
  const hidden = list.slice(1)
  const badges = []
  const unknown = hidden.filter((r) => r.status === 'unknown').length
  const rejected = hidden.filter((r) => r.status === 'rejected').length
  const pending = hidden.filter((r) => r.status === 'pending').length
  if (unknown) badges.push(`${unknown} 条结果未知`)
  if (pending) badges.push(`${pending} 条提交中`)
  if (rejected) badges.push(`${rejected} 条已拒绝`)
  const label = state.open ? '收起' : `展开后面 ${hidden.length} 条`
  return `
    <button type="button" class="qtail" data-act="tail" aria-expanded="${state.open}">
      ${icon('chevron')}
      <span>${label}</span>
      ${badges.length ? `<span class="qtail-badge">${icon('alert')}${badges.join(' · ')}</span>` : ''}
    </button>`
}

function queueMarkup(variantId) {
  const { capability } = currentScenario()
  const list = rows()
  if (list.length === 0) {
    return `<div class="queue qempty" data-v="${variantId}" role="note">队列已清空（原型结束状态，点设计栏的「重置」继续）</div>`
  }
  const anyPending = list.some((r) => r.status === 'pending')
  const hiddenBadge = variantId === 'd' ? tailMarkup(list) : ''
  return `
  <section class="queue" data-v="${variantId}" data-open="${state.open}" aria-label="排队中的消息，共 ${list.length} 条">
    <div class="qhead">
      <span class="qhead-main">${icon('clock')}<span>等待运行</span><span class="qcount ${numeric}">${list.length}</span></span>
      <span class="qhint">当前任务结束后依次发送</span>
    </div>
    <div class="qlist" role="list">
      ${list.map((row) => rowMarkup(row, anyPending, capability)).join('')}
    </div>
    ${hiddenBadge}
    ${capability ? `<div class="qnote" role="note">${icon('alert')}Steer 不可用：${esc(capability)}</div>` : ''}
  </section>`
}

function frameMarkup(variant) {
  const receipts = state.receipts.map((receipt) => `
    <div class="msg-receipt">${icon('steer')}
      <div><b>Steer · Provider 已接收（模拟回执）</b><span>${esc(receipt.text)}</span></div>
    </div>`).join('')
  const label = `<div class="frame-label"><b>${variant.name}</b><span>${variant.subtitle}</span><em>${state.compare ? '分栏对比' : `${state.width}px`} · 模拟状态：${SCENARIOS[state.scenario].label}</em></div>`
  if (state.compare) {
    return `<div class="frame frame-compact">${label}<div class="queue-stage">${queueMarkup(variant.id)}</div></div>`
  }
  return `
  <div class="frame">
    ${label}
    <div class="screen">
      <div class="thread">
        <div class="msg-user">检查消息队列的实现，先给出修改方案。</div>
        <div class="msg-agent"><b>Codex</b><span>正在读取 ChatView.tsx…</span></div>
        ${receipts}
      </div>
      <div class="composer">
        ${queueMarkup(variant.id)}
        <div class="run-status" role="status">
          <span class="run-status-left">
            <i class="run-status-dot" aria-hidden="true"></i>
            <b>运行中</b>
            <span class="run-status-hint">可继续输入，新消息将加入队列</span>
          </span>
          <span class="run-status-meta">
            <span class="run-status-elapsed">00:45</span>
            <button type="button" class="stop">${icon('square')}停止本轮</button>
          </span>
        </div>
        <div class="composer-shell">
          <label class="sr-only" for="draft-${variant.id}">新消息</label>
          <textarea id="draft-${variant.id}" placeholder="补充要求，或添加下一条消息…"></textarea>
          <div class="composer-bar">
            <span class="chip">＋</span>
            <span class="chip">Codex</span>
            <span class="chip">gpt-5.4</span>
            <span class="chip">High</span>
            <span class="send" aria-hidden="true">↑</span>
          </div>
        </div>
      </div>
    </div>
  </div>`
}

function notesMarkup() {
  const variant = VARIANTS.find((v) => v.id === state.variant)
  const shown = state.compare ? VARIANTS : [variant]
  return `
    ${shown.map((v) => `<h2>${v.name} · ${v.subtitle}</h2><ul>${v.notes.map((n) => `<li>${n}</li>`).join('')}</ul>`).join('')}
    <h2>四稿共同约束</h2>
    <ul>
      <li>只动 <code>.prompt-queue</code> 块。运行状态条、输入区、会话区保持不变；顺序仍是队列 → 运行中 → 输入框。</li>
      <li>不新增颜色、字体、阴影或图标：只用 <code>styles.css</code> 现有 token；琥珀表示等待，蓝色表示动作，红色只给明确拒绝。</li>
      <li>证据语义不放松：提交中不可重复提交、结果未知不可重发也不可移除、明确拒绝可重试、能力不可用要写原因。</li>
      <li>序号与计数用等宽 + <code>tabular-nums</code>；<code>Steer</code> 与移除按钮始终可聚焦，焦点环 2px <code>--accent</code>。</li>
      <li>示例文本、运行时长与 Steer 回执都是模拟，不代表真实 Provider 行为或验收结果。</li>
    </ul>`
}

function render() {
  const target = $('#stage')
  target.classList.toggle('single', !state.compare)
  target.classList.toggle('compare', state.compare)
  const list = state.compare ? VARIANTS : VARIANTS.filter((v) => v.id === state.variant)
  target.innerHTML = list.map(frameMarkup).join('')
  $('#notes').innerHTML = notesMarkup()
  document.documentElement.dataset.theme = state.theme
  document.documentElement.style.setProperty('--w', `${state.width}px`)
  for (const button of document.querySelectorAll('#variants button')) {
    button.setAttribute('aria-selected', String(!state.compare && button.dataset.variant === state.variant))
  }
  for (const button of document.querySelectorAll('#scenarios button')) {
    button.setAttribute('aria-selected', String(button.dataset.scenario === state.scenario))
  }
  for (const button of document.querySelectorAll('[data-width]')) {
    button.setAttribute('aria-selected', String(Number(button.dataset.width) === state.width))
  }
  for (const button of document.querySelectorAll('[data-theme]')) {
    button.setAttribute('aria-selected', String(button.dataset.theme === state.theme))
  }
  $('#compare').setAttribute('aria-pressed', String(state.compare))
}

function mountControls() {
  $('#variants').innerHTML = VARIANTS.map((v) => `<button data-variant="${v.id}" role="tab" aria-selected="false">${v.name}</button>`).join('')
  $('#scenarios').innerHTML = Object.entries(SCENARIOS).map(([id, s]) => `<button data-scenario="${id}" aria-selected="false">${s.label}</button>`).join('')

  $('#variants').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-variant]')
    if (!button) return
    state.variant = button.dataset.variant
    state.compare = false
    render()
  })

  $('#scenarios').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-scenario]')
    if (!button) return
    state.scenario = button.dataset.scenario
    state.overrides = {}
    render()
  })

  for (const button of document.querySelectorAll('[data-width]')) {
    button.addEventListener('click', () => {
      state.width = Number(button.dataset.width)
      for (const other of document.querySelectorAll('[data-width]')) other.setAttribute('aria-selected', String(other === button))
      render()
    })
  }

  for (const button of document.querySelectorAll('[data-theme]')) {
    button.addEventListener('click', () => {
      state.theme = button.dataset.theme
      for (const other of document.querySelectorAll('[data-theme]')) other.setAttribute('aria-selected', String(other === button))
      render()
    })
  }

  $('#compare').addEventListener('click', () => {
    state.compare = !state.compare
    render()
  })

  $('#stage').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]')
    if (!button) return
    const { act, id } = button.dataset
    if (act === 'tail') {
      state.open = !state.open
      render()
      return
    }
    if (act === 'remove') {
      state.removed.add(id)
      render()
      return
    }
    if (act !== 'steer' || button.disabled) return
    const message = MESSAGES.find((m) => m.id === id)
    state.overrides[id] = { status: 'pending' }
    render()
    window.setTimeout(() => {
      state.removed.add(id)
      delete state.overrides[id]
      state.receipts.push({ text: message.text })
      render()
    }, 900)
  })

  const reset = document.createElement('button')
  reset.className = 'plain'
  reset.id = 'reset'
  reset.textContent = '重置'
  reset.addEventListener('click', () => {
    state.removed = new Set()
    state.overrides = {}
    state.receipts = []
    state.open = false
    state.scenario = 'normal'
    render()
  })
  $('.chrome-controls').append(reset)
}

mountControls()
render()
