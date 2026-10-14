import { files, initialState, capabilities, transition } from './model.mjs'

const $ = selector => document.querySelector(selector)
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
let state = initialState()
let dialogAction = null
let dialogHead = null
let returnFocus = null
const patchLines = [
  ['', 20, 'export function loadSessionHistory(sessionId) {'],
  ['', 21, '  const revision = readRevision(sessionId)'],
  ['-', 22, '  return parseHistory(sessionId)'],
  ['+', 22, '  const cached = historyCache.get(sessionId)'],
  ['+', 23, '  if (cached?.revision === revision) {'],
  ['+', 24, '    return cached.turns'],
  ['+', 25, '  }'],
  ['+', 26, '  const turns = parseHistory(sessionId)'],
  ['+', 27, '  historyCache.set(sessionId, { revision, turns })'],
  ['+', 28, '  return turns'],
  ['', 29, '}']
]
function diff(id = 'cache') {
  const lines = id === 'cache' ? patchLines : id === 'test' ? [
    ['', 16, "test('invalidates a changed session', async () => {"],
    ['+', 17, "  await appendTurn(sessionId, 'second turn')"],
    ['+', 18, '  const turns = loadSessionHistory(sessionId)'],
    ['+', 19, '  assert.equal(turns.length, 2)'],
    ['', 20, '})']
  ] : [['+', 1, '# 我的本地笔记'], ['+', 2, '本文件不是 Agent 本轮产物。'], ['+', 3, '除非主动暂存，否则不会进入提交。']]
  return `<div class="diff" aria-label="${escape(id)} 演示差异"><div class="code-line hunk">@@ 文件级差异 · 演示片段 @@</div>${lines.map(([kind, line, text]) => `<div class="code-line ${kind === '+' ? 'plus' : kind === '-' ? 'minus' : ''}"><span class="line-num">${line}</span><span>${kind || ' '} ${escape(text)}</span></div>`).join('')}</div>`
}
function dispatch(action) { state = transition(state, action); render() }
function notice() {
  if (state.unknown) return '<p><strong>推送结果未知。</strong>连接中断不代表推送失败。请先核查远端，不重复发送。</p><button data-action="reconcile">核查远端</button>'
  if (state.stale) return '<p><strong>状态已过期。</strong>外部进程修改了仓库。重新读取后再确认范围。</p><button data-action="refresh">重新读取</button>'
  if (state.busy) return '<p><strong>Agent 正在此仓库运行。</strong>允许查看；暂存、提交与推送暂不可用。终端中的外部进程不在此检测保证内。</p>'
  if (!state.authenticated) return '<p><strong>GitHub 未登录。</strong>本地 Git 与既有 SSH 推送仍可使用。请在终端完成 <code>gh auth login --hostname github.com</code>，再检查连接。</p>'
  return ''
}
function fileGroup(label, list, allowed) {
  return `<div class="section-label"><span>${label}</span><span>${list.length}</span></div>${list.length ? list.map(file => `<div class="file-row ${state.selected === file.id ? 'active' : ''}"><span class="file-status ${file.kind === '?' ? 'new' : ''}">${file.kind}</span><button class="file-name" data-file="${file.id}" title="${file.path}">${file.name}</button><button class="stage" data-stage="${file.id}" aria-label="${state.staged.includes(file.id) ? '取消暂存' : '暂存'} ${file.name}" ${allowed.stage ? '' : 'disabled'}>${state.staged.includes(file.id) ? '−' : '+'}</button></div>`).join('') : '<div class="section-empty">没有文件</div>'}`
}
function changes(allowed) {
  const remaining = files.filter(file => state.remaining.includes(file.id))
  const selected = files.find(file => file.id === state.selected)
  return `<div class="workspace-grid"><aside class="filelist" aria-label="文件暂存列表">${fileGroup('已暂存 · 将进入提交', remaining.filter(file => state.staged.includes(file.id)), allowed)}${fileGroup('未暂存', remaining.filter(file => !state.staged.includes(file.id) && file.kind !== '?'), allowed)}${fileGroup('未跟踪', remaining.filter(file => !state.staged.includes(file.id) && file.kind === '?'), allowed)}<div class="file-legend">范围：整个工作区<br>不自动认定这些文件属于当前 Agent。<br>点击 + 暂存整个文件。</div></aside><section class="patch-column">${remaining.length ? `<header class="patch-header"><span title="${selected.path}">${selected.name}</span><span class="diff-stat"><span class="added">+${selected.added}</span> <span class="removed">−${selected.removed}</span></span></header>${diff(selected.id)}<div class="patch-scope">${state.staged.includes(selected.id) ? '暂存区 ↔ HEAD' : '工作目录 ↔ 暂存区'} · 本页展示演示片段，非完整源码</div>` : '<div class="empty"><div class="empty-icon">✓</div><h2>本地改动已提交</h2><p class="muted">提交只存在于本机。推送后才会更新远端分支。</p></div>'}<div class="commit-box"><label for="commit-title">提交信息</label><input id="commit-title" value="${escape(state.commitTitle)}" placeholder="描述这次提交" maxlength="200"><div class="commit-actions"><small>${state.staged.length} 个已暂存文件</small><button data-action="commit" class="primary" ${allowed.commit ? '' : 'disabled'}>提交到本地</button><button data-action="push" ${allowed.push ? '' : 'disabled'}>推送${state.ahead ? ` ↑${state.ahead}` : ''}</button></div></div></section></div>`
}
function checks() {
  return `<div class="checklist"><div class="checkrow"><span class="check-icon">✓</span>代码检查<span>通过</span></div><div class="checkrow"><span class="check-icon">✓</span>单元测试<span>通过</span></div><div class="checkrow"><span class="check-icon ${state.checks === 'pending' ? 'pending' : ''}">${state.checks === 'pending' ? '◷' : '✓'}</span>Electron UI 检查<span>${state.checks === 'pending' ? '运行中 · 尚不能合并' : '通过'}</span></div><div class="checkrow"><span class="check-icon ${state.reviewDecision !== 'approved' ? 'pending' : ''}">${state.reviewDecision === 'approved' ? '✓' : '◷'}</span>分支规则与审查<span>${state.isDraftPR ? '草稿 PR' : state.reviewDecision === 'approved' ? '已满足（演示）' : state.reviewDecision === 'changes_requested' ? '请求修改' : '等待当前版本审查'}</span></div></div>`
}
function pullRequest(allowed) {
  if (!state.authenticated) return '<div class="empty"><div class="empty-icon">⑂</div><h2>连接 GitHub 后查看拉取请求</h2><p class="muted">未读取不等于没有 PR。本地暂存和提交不依赖 GitHub 登录。</p><button data-action="refresh">检查连接（演示）</button></div>'
  if (!state.hasPR) return `<div class="empty"><div class="empty-icon">⑂</div><h2>当前分支还没有拉取请求</h2><p class="muted">先确认提交范围，再推送分支。创建时会明确显示仓库、源分支和目标分支，不会额外提交文件。</p><button class="primary" data-action="createPR" ${allowed.createPR ? '' : 'disabled'}>创建拉取请求</button>${!allowed.createPR ? '<p class="muted">完成暂存 → 本地提交 → 推送后可用</p>' : ''}</div>`
  return `<article class="pr"><div class="pr-title"><h2>${escape(state.prTitle)}</h2><span class="pill">${state.merged ? '已合并' : state.isDraftPR ? '草稿' : '开放'}</span></div><div class="pr-meta">#184 · octo-team/scry · <code>main ← feat/history-cache</code><br>远端 HEAD <code>${state.head}</code> · 当前登录 <strong>${state.apiUser}</strong> · 作者 ${state.prAuthor}</div><nav class="pr-nav" aria-label="拉取请求内容"><button data-pr-tab="overview" aria-pressed="${state.prTab === 'overview'}" class="${state.prTab === 'overview' ? 'active' : ''}">概览与检查</button><button data-pr-tab="files" aria-pressed="${state.prTab === 'files'}" class="${state.prTab === 'files' ? 'active' : ''}">文件与审查 <span class="count">2</span></button></nav>${state.prTab === 'overview' ? `<div class="pr-summary"><strong>变更摘要</strong><p class="pr-description">${escape(state.prBody)}</p><span class="muted">PR 描述 · 由作者提供，不是 Scry 验证结论。</span></div>${checks()}${state.approvalHead ? `<div class="review-entry"><strong>maintainer-demo</strong> <span class="muted">${state.approvalHead === state.head ? '已批准' : '此前批准 · 已过期'} · ${state.approvalHead}</span><p>缓存失效路径有测试覆盖。</p></div>` : '<p class="muted">尚无已提交审查。草稿 PR 的转为可审查流程未在本原型展开。</p>'}${state.reviews.map(review => `<div class="review-entry"><strong>reviewer-demo</strong> <span class="muted">${review.verdict === 'APPROVE' ? '批准' : review.verdict === 'REQUEST_CHANGES' ? '请求修改' : '评论'} · ${review.head}</span><p>${escape(review.body || '已审查这些改动。')}</p><span class="muted">已提交 ${review.comments.length} 条行评论（演示）</span></div>`).join('')}<div class="merge-row"><span class="muted">${state.merged ? '不会自动删除分支或 worktree' : state.isDraftPR ? '草稿 PR 不可合并' : state.checks === 'pending' ? '等待所有必需检查完成' : state.reviewDecision !== 'approved' ? '当前版本尚未满足审查要求' : '仅合并远端提交，不包含本地未提交文件'}</span><button data-action="merge" class="primary" ${allowed.merge ? '' : 'disabled'}>${state.merged ? '已合并' : '合并…'}</button></div>` : `<div class="review-tools"><span class="muted">审查基于 ${state.head} · 2 个文件</span><button data-action="review" class="primary" ${allowed.review ? '' : 'disabled'}>提交审查${state.drafts.length ? ` (${state.drafts.length})` : ''}</button></div><div class="review-file"><div class="patch-header"><span>src/renderer/session-history-cache.ts</span><span class="added">+31 −7</span></div>${diff('cache')}</div><button data-action="addDraft" ${allowed.comment ? '' : 'disabled'}>在第 26 行添加评论</button>${state.drafts.map(draft => `<div class="draft"><span class="badge">${draft.head === state.head ? '本地草稿 · 未发送' : '旧版本草稿 · 禁止提交'}</span><span class="muted"> 第 ${draft.line} 行 · ${draft.head}</span><p>${escape(draft.body)}</p></div>`).join('')}<div class="review-file"><div class="patch-header"><span>src/renderer/session-history-cache.test.ts</span><span class="added">+7 −2</span></div>${diff('test')}</div>${state.drafts.some(draft => draft.head !== state.head) ? '<button data-action="discardDrafts">丢弃过期草稿…</button>' : ''}<p class="muted">行评论在最终提交审查前保持私有。HEAD 变化后需重新定位；原型只演示明确丢弃后重新添加。</p>`}</article>`
}
function render() {
  const allowed = capabilities(state)
  if (!state.remaining.includes(state.selected) && state.remaining.length) state.selected = state.remaining[0]
  $('#sync').textContent = state.ahead ? `↑ ${state.ahead} 待推送` : state.unknown ? '远端结果未知' : state.pushed ? '本地与已读取远端一致' : '分支尚未发布'
  $('#upstream').textContent = state.pushed ? '↔ origin / feat/history-cache' : '目标 origin · 尚无上游'
  $('#freshness').textContent = state.stale ? '已过期' : '演示快照'
  $('#file-count').textContent = state.remaining.length
  $('#pr-number').textContent = state.hasPR ? '#184' : '—'
  document.querySelectorAll('[data-tab]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tab === state.tab)))
  const banner = notice()
  $('#notice').className = banner ? 'notice' : ''
  $('#notice').innerHTML = banner
  $('#content').innerHTML = state.tab === 'changes' ? changes(allowed) : pullRequest(allowed)
  $('#operation').textContent = state.operation
}
function openAction(action) {
  returnFocus = document.activeElement
  dialogAction = action
  dialogHead = state.head
  const selected = files.filter(file => state.staged.includes(file.id))
  const configs = {
    commit: ['确认本地提交', `<div class="confirm-summary"><strong>${escape(state.commitTitle)}</strong><br>分支 <code>feat/history-cache</code><br>只提交已暂存的 ${selected.length} 个文件：<ul>${selected.map(file => `<li>${escape(file.path)}</li>`).join('')}</ul></div><p class="muted">其他未暂存和未跟踪文件保留原样。不推送、不创建 PR。执行前会重验 HEAD 与暂存区。</p><p class="muted">正式版还需检查 Git hook / filter / 签名程序的执行授权；设计稿不会执行它们。</p>`, '确认提交到本地'],
    push: ['确认推送到远端', `<div class="confirm-summary">源：<code>feat/history-cache</code><br>实际推送端点：<code>git@github.com:octo-team/scry.git</code><br>配置已确认：单一 push URL · 无改写<br>Git SSH 身份：未由 GitHub API 身份推断<br>远端分支：<code>refs/heads/feat/history-cache</code><br>${state.ahead} 个本地提交 · 不强制推送</div><p>这是外部写入。远端若拒绝快进，本次操作停止，不自动 rebase 或覆盖。</p>`, '确认推送'],
    createPR: ['创建拉取请求', '<div class="confirm-summary">octo-team/scry<br><code>main ← feat/history-cache</code><br>使用已推送的提交，不额外修改文件。</div><label for="pr-title">标题</label><input id="pr-title" name="title" required value="缓存会话历史，减少重复解析"><label for="pr-body">说明</label><textarea id="pr-body" name="body" required>缓存已解析历史，并在文件版本变化后失效。\n验证：单元测试与 Electron UI 检查。</textarea><label class="checkbox-label"><input type="checkbox" name="draft">创建为草稿 PR</label><p class="muted">说明为演示文本；正式版可手写。AI 起草需要明确选择 Provider，不默认发送 diff。</p>', '创建 PR（演示）'],
    addDraft: ['添加行评论草稿', `<div class="confirm-summary">session-history-cache.ts · RIGHT / 26<br>绑定远端提交 <code>${state.head}</code></div><label for="draft-body">评论</label><textarea id="draft-body" name="body" required placeholder="例如：这里读取失败时是否会保留旧缓存？"></textarea><p class="muted">仅保存到本页草稿，尚未向 GitHub 提交。</p>`, '保存草稿'],
    review: ['提交 PR 审查', `<div class="confirm-summary">PR #184 · HEAD <code>${state.head}</code><br>登录身份：reviewer-demo · ${state.drafts.length} 条行评论草稿</div><label for="verdict">审查结论</label><select id="verdict" name="verdict"><option value="COMMENT">评论</option><option value="APPROVE" ${capabilities(state).canApprove ? '' : 'disabled'}>批准</option><option value="REQUEST_CHANGES" ${capabilities(state).canApprove ? '' : 'disabled'}>请求修改</option></select><label for="review-body">总体意见</label><textarea id="review-body" name="body" ${state.drafts.length ? '' : 'required'} placeholder="这是你的审查结论，不是 AI 自动批准。"></textarea>${!capabilities(state).canApprove ? '<p class="muted">当前账户是 PR 作者，不能批准或请求修改自己的 PR。</p>' : ''}`, '提交审查'],
    discardDrafts: ['丢弃过期草稿？', '<p>这些评论仍属于旧 HEAD。本原型不会自动映射旧行号；确认后删除本页草稿，你可以重新定位并添加。</p>', '确认丢弃草稿'],
    merge: ['确认合并拉取请求', `<div class="confirm-summary">octo-team/scry · PR #184<br><code>main ← feat/history-cache</code><br>你审查的 HEAD：<code>${state.head}</code></div><label for="merge-method">合并方式</label><select id="merge-method"><option>Squash and merge</option></select><p>执行前会重读权限、检查与 HEAD。若远端有新提交，必须重新审查；不会合并未看到的版本。</p><p class="muted">不绕过保护规则，不自动删除远端分支或本地工作目录。</p>`, '确认合并（演示）']
  }
  const config = configs[action]
  if (!config) return
  $('#dialog-title').textContent = config[0]
  $('#dialog-content').innerHTML = config[1]
  $('#confirm-dialog').textContent = config[2]
  $('#action-dialog').showModal()
}
function closeAction() { $('#action-dialog').close(); returnFocus?.focus() }
document.addEventListener('click', event => {
  const button = event.target.closest('button')
  if (!button || button.disabled) return
  if (button.dataset.tab) { state.tab = button.dataset.tab; render() }
  if (button.dataset.prTab) {
    const tab = button.dataset.prTab
    state.prTab = tab
    render()
    document.querySelector(`[data-pr-tab="${tab}"]`).focus()
  }
  if (button.dataset.file) {
    const id = button.dataset.file
    state.selected = id
    render()
    document.querySelector(`[data-file="${id}"]`).focus()
  }
  if (button.dataset.stage) {
    const id = button.dataset.stage
    dispatch({ type: 'stage', id })
    document.querySelector(`[data-stage="${id}"]`)?.focus()
  }
  if (button.dataset.action) {
    const type = button.dataset.action
    if (['refresh', 'reconcile'].includes(type)) dispatch({ type })
    else openAction(type)
  }
})
document.addEventListener('input', event => {
  if (event.target.id === 'commit-title') {
    state.commitTitle = event.target.value
    $('[data-action="commit"]').disabled = !capabilities(state).commit
  }
})
$('#action-form').addEventListener('change', event => {
  if (event.target.id === 'verdict') {
    $('#review-body').required = event.target.value === 'REQUEST_CHANGES' || (event.target.value === 'COMMENT' && state.drafts.length === 0)
  }
})
$('#action-form').addEventListener('submit', event => {
  event.preventDefault()
  const data = new FormData(event.target)
  dispatch({ type: dialogAction, body: String(data.get('body') || ''), title: String(data.get('title') || ''), verdict: String(data.get('verdict') || 'COMMENT'), head: dialogHead, draft: data.get('draft') === 'on' })
  closeAction()
  if (!returnFocus?.isConnected) $(`[data-tab="${state.tab}"]`).focus()
})
$('#close-dialog').onclick = closeAction
$('#cancel-dialog').onclick = closeAction
$('#scenario').onchange = event => { state = initialState(event.target.value); render() }
$('#refresh').onclick = () => dispatch({ type: 'refresh' })
$('#theme').onclick = () => { const dark = document.documentElement.dataset.theme !== 'dark'; document.documentElement.dataset.theme = dark ? 'dark' : 'light'; $('#theme').textContent = dark ? '浅色' : '深色' }
$('#maximize').onclick = () => { const expanded = $('#app').classList.toggle('focus'); $('#maximize').setAttribute('aria-label', expanded ? '恢复对话与工作台' : '放大源代码管理') }
$('#compare').onclick = () => $('#comparison').showModal()
$('#close-comparison').onclick = () => $('#comparison').close()
$('#choose-a').onclick = () => { $('#app').classList.remove('layout-b', 'focus'); $('.design-footer > span:last-child').textContent = 'A / 右侧工作台'; $('#comparison').close() }
$('#choose-b').onclick = () => { $('#app').classList.add('layout-b'); $('.design-footer > span:last-child').textContent = 'B / 独立仓库中心 · 结构预览'; $('#comparison').close() }
render()
