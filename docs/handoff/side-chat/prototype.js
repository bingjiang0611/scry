// Standalone design preview. No Provider, preload API, network calls or persistence.
// All visible prototype copy is kept together here; production copy belongs in renderer constants.
const COPY = {
  title: 'Scry · 侧边会话设计稿', brand: 'Scry / 侧边会话', demo: '交互设计稿 · 示例数据，不连接 Provider',
  modes: { live: '进行中', empty: '空侧聊', error: '发送失败' }, narrow: '窄窗口', theme: '切换深浅主题',
  project: 'scry', projects: '项目', newSession: '新会话', local: '本机工作区',
  parentTitles: ['梳理会话恢复流程', '优化工具调用展示'], parentMeta: '主会话正在运行',
  sideCount: n => `${n} 个侧聊`, attention: '1 个需处理',
  mainTab: '主会话', sideTab: '侧聊', running: '运行中', mainTurn: '第 9 轮', latest: '最新',
  openSide: '打开侧聊', createSide: '新建侧聊', history: '恢复已关闭的侧聊', files: '文件',
  sideTitles: ['检查边界情况', '补一组回归测试'], secondParentSide: '讨论信息层级', untitled: '新侧聊',
  closeTab: title => `关闭 ${title}（保留会话）`,
  origin: '来自主会话 · 截至第 8 轮', originOther: '来自主会话 · 截至第 3 轮',
  shared: '共用工作区 · 文件改动立即互相可见',
  mainUser: '梳理会话恢复链路，先确认运行状态和历史记录的来源，再调整恢复逻辑。',
  mainBody: '<p>恢复流程可以拆成两层：先确认会话身份，再恢复当前可验证的运行状态。</p><h3>先固定会话，再读取历史</h3><p>主进程负责核对原生会话标识。界面只使用已确认的会话引用，不从当前选中的 Provider 推断恢复目标。</p>',
  file: 'src/main/bootstrap/run-admission.ts', toolMain: '读取恢复边界', mainProgress: '继续检查轮次完成后的证据保存路径…',
  assistant: 'Codex', mainPlaceholder: '向主会话补充说明…', sidePlaceholder: '在侧聊中继续，不打断主会话…',
  model: 'GPT-5.4', permission: '默认审批', attach: '附件', stop: '停止当前运行（示意）', send: '发送（仅示意）',
  mainHint: '主会话', saved: '长期保存', sideHint: '独立对话 · 相同文件',
  sideUser: '如果恢复时切换了 Provider，会不会把消息发到旧会话？只检查这个边界。',
  sideBody: '<p>关键不在界面选中了谁，而在发送请求是否仍绑定原来的会话。</p><p>我会重点核对三处：</p><p>① 发送前的会话身份校验<br>② Provider 切换后的续接标识<br>③ 超时后是否会重复投递</p>',
  toolSide: '检查发送前的身份校验', sideProgress: '正在对照相邻路径…',
  overlap: '并行运行期间的工作区变化，可能包含其他会话的改动。',
  emptyTitle: '换个角度，继续探索', emptyBody: '已带入主会话的消息快照。这里的讨论独立保存，不会自动写回主会话。', emptyPill: '快照已保存 · 不含正在生成的内容',
  errorTitle: '尚未发送', errorBody: 'Provider 启动前连接失败。问题已保留，你可以检查连接后重试。', retry: '重试（示意）',
  awaitingTitle: '需要你确认', awaitingBody: '侧聊正在等待一项工具操作审批。处理它不会批准主会话的操作。', approval: '查看审批（示意）',
  awaitingUser: '针对会话恢复的边界情况，补一组回归测试。',
  unknownTitle: '发送结果待核对', unknownBody: '回执未返回。先核对原请求，不重新发送。', readback: '核对原请求（示意）',
  sentPreview: '这是交互设计稿，未发送消息，也未启动 Agent。',
  stoppedPreview: '停止按钮只展示当前会话的控制位置，设计稿没有真实运行。',
  filesTitle: '工作区文件', filesBody: '工具页签与侧聊平级。切回侧聊，草稿仍保留。',
  snapshotTitle: '消息快照', close: '关闭', source: '来源', boundary: '截止轮次', captured: '冻结时间', included: '已保存内容', excluded: '未包含',
  snapshotBoundary: '第 8 轮 · 已完成', snapshotBoundaryOther: '第 3 轮 · 已完成', snapshotTime: '14:32 · 创建侧聊时',
  snapshotIncluded: '16 条用户消息 / 助手正文', snapshotIncludedOther: '6 条用户消息 / 助手正文',
  snapshotExcluded: '正在生成的第 9 轮、历史附件、隐藏推理与原生工具状态', snapshotExcludedOther: '历史附件、隐藏推理与原生工具状态',
  snapshotNote: '快照不会随主会话更新。工作区文件仍是实时共享的；这不是代码版本快照，也不是原生会话 fork。',
  footer: '01 / 桌面工作台 · 关闭页签不停止运行，也不删除会话',
  designLink: '设计说明', techLink: '技术方案', separator: ' / ',
  noTabsTitle: '侧聊已收起', noTabsBody: '历史会话仍保留。点击右上角历史按钮恢复，或新建一个侧聊。',
  otherUser: '先梳理工具调用信息的优先级，再考虑视觉细节。',
  otherBody: '<p>先把结果、当前状态与需要你处理的事项分开。</p><h3>减少同时竞争注意力的信息</h3><p>主视图保留当前任务，细节放进可展开的工具证据。侧聊可以单独讨论另一种方案。</p>'
}

const ICONS = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8L21 21l-5.7-.9a8.5 8.5 0 1 1 5.7-8.6Z"/><path d="M8 11h6m-3-3v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>',
  folder: '<path d="M3 7V5h6l2 2h10v13H3Z"/>', history: '<path d="M3 11a9 9 0 1 1 2.5 7M3 4v7h7m2-4v5l3 2"/>',
  arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m2-4c7 0 10-2 10-5"/>',
  file: '<path d="M14 2H5v20h14V7Zm0 0v5h5M8 12h8M8 16h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>', shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>'
}
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
const button = (action, label, image, className = '', extra = '') => `<button class="${className}" data-action="${action}" aria-label="${escape(label)}" title="${escape(label)}" ${extra}>${image ? icon(image) : escape(label)}</button>`
const state = { mode: 'live', parent: 0, dark: false, narrow: false, showMain: false, parents: [
  { active: 'a', open: ['a', 'b'], entries: [{ id: 'a', title: COPY.sideTitles[0], draft: '' }, { id: 'b', title: COPY.sideTitles[1], draft: '' }] },
  { active: 'c', open: ['c'], entries: [{ id: 'c', title: COPY.secondParentSide, draft: '' }] }
], notice: '' }
const app = document.querySelector('#app')
const dialog = document.querySelector('#snapshot')
let serial = 0
const current = () => state.parents[state.parent]
const entry = () => current().entries.find(item => item.id === current().active)

function composer(side) {
  const busy = !side || (state.mode === 'live' && current().active === 'a')
  return `<div class="composer-wrap"><div class="composer"><textarea ${side ? 'id="side-input"' : 'readonly'} aria-label="${side ? COPY.sideHint : COPY.mainHint}" placeholder="${side ? COPY.sidePlaceholder : COPY.mainPlaceholder}">${side ? escape(entry()?.draft ?? '') : ''}</textarea><div class="composer-footer"><div class="composer-options">${icon('plus')}${icon('shield')}<span>${COPY.permission}</span></div><div class="composer-options"><span>${COPY.model}</span>${button(busy ? 'stop' : 'send', busy ? COPY.stop : COPY.send, busy ? 'stop' : 'arrow', 'send')}</div></div></div><div class="caption"><span>${side ? COPY.sideHint : COPY.mainHint}</span><span>${COPY.saved}</span></div></div>`
}
function sideBody() {
  if (!entry()) return `<div class="empty">${icon('chat')}<h3>${COPY.noTabsTitle}</h3><p>${COPY.noTabsBody}</p></div>`
  if (state.mode === 'empty' || current().active.startsWith('new')) return `<div class="empty">${icon('chat')}<h3>${COPY.emptyTitle}</h3><p>${COPY.emptyBody}</p><span class="pill">${COPY.emptyPill}</span></div>`
  if (state.mode === 'error') return `<div class="user">${COPY.sideUser}</div><div class="error"><strong>${COPY.errorTitle}</strong><p>${COPY.errorBody}</p>${button('retry', COPY.retry)}</div>`
  if (current().active === 'b') return `<div class="user">${COPY.awaitingUser}</div><div class="error"><strong>${COPY.awaitingTitle}</strong><p>${COPY.awaitingBody}</p>${button('approval', COPY.approval)}</div>`
  return `<div class="user">${COPY.sideUser}</div><div class="assistant-label">${icon('chat')}${COPY.assistant}<span class="dot"></span>${COPY.running}</div><div class="message">${COPY.sideBody}</div><div class="tool-row">${icon('file')}<span>${COPY.toolSide}</span></div><div class="tool-row">${icon('chevron')}<span>${COPY.sideProgress}</span></div><div class="note">${COPY.overlap}</div>`
}
function render() {
  document.title = COPY.title
  document.body.classList.toggle('dark', state.dark)
  const parent = current()
  const side = entry()
  app.innerHTML = `<header class="designbar"><div><span class="brand">${COPY.brand}</span><span class="designnote">${COPY.demo}</span></div><nav class="controls">${Object.entries(COPY.modes).map(([key, label]) => button(`mode:${key}`, label, null, '', `aria-pressed="${state.mode === key}"`)).join('')}<span class="divider"></span>${button('narrow', COPY.narrow, null, '', `aria-pressed="${state.narrow}"`)}${button('theme', COPY.theme, 'sun')}</nav></header>
  <main class="stage"><div class="window ${state.narrow ? 'narrow' : ''} ${state.showMain ? 'show-main' : ''}"><aside class="sidebar"><div class="traffic" aria-hidden="true"><i></i><i></i><i></i></div><div class="side-new">${icon('plus')} ${COPY.newSession}</div><div class="section-label">${COPY.projects}</div><div class="project">${icon('folder')}${COPY.project}</div>${COPY.parentTitles.map((title, index) => `<button class="session" data-action="parent:${index}" aria-pressed="${state.parent === index}"><span class="session-name">${title}</span><span class="session-meta"><span class="dot"></span>${COPY.sideCount(state.parents[index].entries.length)}${index === 0 ? `<span class="attention">· ${COPY.attention}</span>` : ''}</span></button>`).join('')}<div class="sidebar-bottom">${icon('folder')}${COPY.local}</div></aside>
  <div class="workspace"><div class="mobile-switch">${button('main', COPY.mainTab, null, '', `aria-pressed="${state.showMain}"`)}${button('side', COPY.sideTab, null, '', `aria-pressed="${!state.showMain}"`)}</div><section class="chat main"><div class="head"><strong>${COPY.parentTitles[state.parent]}</strong><div class="tools"><span class="status"><span class="dot"></span>${COPY.running}</span>${button('open', COPY.openSide, 'chat')}</div></div><div class="scroll"><div class="turn-marker"><span>${COPY.mainTurn}</span><span>${COPY.latest}</span></div><div class="user">${state.parent ? COPY.otherUser : COPY.mainUser}</div><div class="assistant-label">${icon('chat')}${COPY.assistant}</div><div class="message">${state.parent ? COPY.otherBody : COPY.mainBody}</div><div class="file-line">${icon('file')}<code>${COPY.file}</code></div><div class="tool-row">${icon('check')}${COPY.toolMain}</div><div class="tool-row">${icon('chevron')}${COPY.mainProgress}</div></div>${composer(false)}</section>
  <section class="chat side"><div class="tabs" role="tablist" aria-label="${COPY.sideTab}"><div class="tab ${parent.active === 'files' ? 'active' : ''}">${button('tab:files', COPY.files, null, '', `role="tab" aria-selected="${parent.active === 'files'}" tabindex="${parent.active === 'files' ? 0 : -1}"`)}</div>${parent.open.map(id => { const item = parent.entries.find(item => item.id === id); return `<div class="tab ${parent.active === id ? 'active' : ''}"><button data-action="tab:${id}" role="tab" aria-selected="${parent.active === id}" tabindex="${parent.active === id ? 0 : -1}">${icon('chat')}<span>${escape(item.title)}</span>${id === 'b' ? '<span class="attention">!</span>' : ''}</button>${button(`close:${id}`, COPY.closeTab(item.title), 'close')}</div>` }).join('')}${button('new', COPY.createSide, 'plus')}${button('history', COPY.history, 'history', 'history')}</div>
  ${parent.active === 'files' ? `<div class="scroll"><div class="empty">${icon('folder')}<h3>${COPY.filesTitle}</h3><p>${COPY.filesBody}</p></div></div>` : `<div class="side-title"><h2>${escape(side?.title ?? COPY.sideTab)}</h2>${side ? `<button class="origin" data-action="snapshot">${icon('branch')}${state.parent ? COPY.originOther : COPY.origin}${icon('chevron')}</button>` : ''}</div><div class="shared">${icon('folder')}${COPY.shared}</div><div class="scroll">${sideBody()}${state.notice ? `<div class="note" role="status">${COPY[state.notice]}</div>` : ''}</div>${side ? composer(true) : ''}`}</section></div></div>
  <footer class="footer"><span>${COPY.footer}</span><span><a href="README.md">${COPY.designLink}</a>${COPY.separator}<a href="technical-plan.md">${COPY.techLink}</a></span></footer></main>`
}
function showSnapshot() {
  dialog.innerHTML = `<div class="dialog-title"><h2 id="snapshot-title">${COPY.snapshotTitle}</h2>${button('dialog-close', COPY.close, 'close')}</div><dl><dt>${COPY.source}</dt><dd>${COPY.parentTitles[state.parent]}</dd><dt>${COPY.boundary}</dt><dd>${state.parent ? COPY.snapshotBoundaryOther : COPY.snapshotBoundary}</dd><dt>${COPY.captured}</dt><dd>${COPY.snapshotTime}</dd><dt>${COPY.included}</dt><dd>${state.parent ? COPY.snapshotIncludedOther : COPY.snapshotIncluded}</dd><dt>${COPY.excluded}</dt><dd>${state.parent ? COPY.snapshotExcludedOther : COPY.snapshotExcluded}</dd></dl><p>${COPY.snapshotNote}</p>`
  dialog.setAttribute('aria-labelledby', 'snapshot-title')
  dialog.showModal()
}
function act(action) {
  const [kind, value] = action.split(':')
  state.notice = ''
  let focus = action
  if (kind === 'snapshot') return showSnapshot()
  if (kind === 'dialog-close') return dialog.close()
  if (kind === 'mode') state.mode = value
  if (kind === 'narrow') state.narrow = !state.narrow
  if (kind === 'theme') state.dark = !state.dark
  if (kind === 'parent') state.parent = Number(value)
  if (kind === 'main' || kind === 'side') state.showMain = kind === 'main'
  if (kind === 'tab') current().active = value
  if (kind === 'close') {
    const parent = current()
    const index = parent.open.indexOf(value)
    parent.open = parent.open.filter(id => id !== value)
    if (parent.active === value) parent.active = parent.open[index] ?? parent.open[index - 1] ?? 'files'
    focus = `tab:${parent.active}`
  }
  if (kind === 'history' || kind === 'open') {
    const parent = current()
    const closed = parent.entries.find(item => !parent.open.includes(item.id))
    if (closed) parent.open.push(closed.id)
    parent.active = closed?.id ?? parent.open[0] ?? 'files'
    state.showMain = false
    focus = `tab:${parent.active}`
  }
  if (kind === 'new') {
    const id = `new${++serial}`
    current().entries.push({ id, title: COPY.untitled, draft: '' })
    current().open.push(id)
    current().active = id
    state.mode = 'empty'
  }
  if (kind === 'send' || kind === 'retry' || kind === 'approval') state.notice = 'sentPreview'
  if (kind === 'stop') state.notice = 'stoppedPreview'
  render()
  if (kind === 'new') document.querySelector('#side-input')?.focus()
  else app.querySelector(`[data-action="${focus}"]`)?.focus()
}
app.addEventListener('click', event => {
  const target = event.target.closest('[data-action]')
  if (target) act(target.dataset.action)
})
dialog.addEventListener('click', event => {
  if (event.target.closest('[data-action="dialog-close"]')) dialog.close()
})
app.addEventListener('input', event => {
  if (event.target.id === 'side-input' && entry()) entry().draft = event.target.value
})
app.addEventListener('keydown', event => {
  if (event.target.getAttribute('role') !== 'tab') return
  const tabs = [...app.querySelectorAll('[role="tab"]')]
  const index = tabs.indexOf(event.target)
  let next
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
  if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
  if (event.key === 'Home') next = 0
  if (event.key === 'End') next = tabs.length - 1
  if (next === undefined) return
  event.preventDefault()
  act(tabs[next].dataset.action)
})
render()
