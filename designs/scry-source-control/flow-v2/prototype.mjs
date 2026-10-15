import { files, initialState, commitScope, primaryAction, transition } from './model.mjs'

const $ = id => document.getElementById(id)
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
let state = initialState()
let selectedFile = 'cache'
let tab = 'changes'
let dialogAction = null
let busy = false
let returnFocus = null
const dialog = $('dialog')
const fileById = id => files.find(file => file.id === id)
const visibleFiles = () => files.filter(file => state.remaining.includes(file.id) || state.staged.includes(file.id))
const isStaged = id => state.staged.includes(id)
const isSelected = id => isStaged(id) || state.selected.includes(id)

const patches = {
  cache: [
    ['context', 19, 'export async function readHistory(session) {'],
    ['remove', 20, '  return parse(await readFile(session.path))'],
    ['add', 20, '  const revision = await stat(session.path)'],
    ['add', 21, '  const key = cacheKey(session.id, revision)'],
    ['add', 22, '  const cached = historyCache.get(key)'],
    ['add', 23, '  if (cached) return cached'],
    ['context', 24, ''],
    ['add', 25, '  const history = parse(await readFile(session.path))'],
    ['add', 26, '  historyCache.set(key, history)'],
    ['add', 27, '  return history'],
    ['context', 28, '}']
  ],
  test: [
    ['context', 12, "describe('history cache', () => {"],
    ['add', 13, "  it('reuses the same file revision', async () => {"],
    ['add', 14, '    await readHistory(session)'],
    ['add', 15, '    await readHistory(session)'],
    ['add', 16, '    expect(parseHistory).toHaveBeenCalledTimes(1)'],
    ['add', 17, '  })'],
    ['context', 18, '})']
  ],
  notes: [
    ['add', 1, '# 本地笔记'], ['add', 2, ''],
    ['add', 3, '- 下周整理远程连接问题'], ['add', 4, '- 这份笔记不属于本次任务']
  ]
}

function checkbox(file, prefix = 'file') {
  return `<input id="${prefix}-${file.id}" type="checkbox" data-select="${file.id}" aria-label="纳入本次提交 ${escape(file.name)}" ${isSelected(file.id) ? 'checked' : ''} ${isStaged(file.id) ? 'disabled' : ''}>`
}

function renderFiles() {
  const list = visibleFiles()
  $('file-list').innerHTML = list.length ? list.map(file => `
    <div class="file-row ${selectedFile === file.id ? 'active' : ''} ${isStaged(file.id) ? 'staged' : ''}">
      ${checkbox(file)}
      <button class="file-name" id="inspect-${file.id}" data-inspect="${file.id}" aria-pressed="${selectedFile === file.id}" title="${escape(file.path)}"><span>${escape(file.name)}</span><small>${isStaged(file.id) ? state.partial.includes(file.id) ? '部分已暂存 · 保留原有选择' : '已暂存 · 将纳入提交' : escape(file.path.slice(0, file.path.lastIndexOf('/')))}</small></button>
      <span class="file-kind" title="${file.kind === '?' ? '未跟踪文件' : '已修改文件'}">${file.kind === '?' ? 'U' : file.kind}</span>
    </div>`).join('') : '<div class="empty"><h3>没有未提交的改动</h3>本地工作区已干净。</div>'
  $('selection-count').textContent = `已选 ${commitScope(state).length} / ${list.length}`
  $('scope-note').innerHTML = state.staged.length
    ? '已有暂存内容始终纳入提交。<br><strong>部分暂存的文件不会重新整文件暂存。</strong>'
    : '勾选只确定提交范围。<br>确认提交时才暂存所选文件，其他文件保持不变。'
}

function renderDiff() {
  const file = fileById(selectedFile)
  if (!file || !visibleFiles().some(item => item.id === file.id)) {
    $('diff-title').textContent = '选择文件查看差异'
    $('diff-stat').textContent = ''
    $('diff-content').innerHTML = '<div class="empty">点击左侧文件名，检查本次改动。</div>'
    return
  }
  $('diff-title').innerHTML = `<strong>${escape(file.name)}</strong><small>${isStaged(file.id) ? '当前暂存内容 · 提交时保留' : '工作区与 HEAD 的差异'}</small>`
  $('diff-stat').innerHTML = `<span class="added">+${file.added}</span> <span class="removed">−${file.removed}</span>`
  $('diff-content').innerHTML = `<div class="diff-block"><div class="diff-line hunk">@@ ${file.id === 'notes' ? '新文件' : '示意片段'} @@</div>${patches[file.id].map(([kind, line, text]) => `<div class="diff-line ${kind}"><span class="line-number">${line}</span><span class="line-prefix">${kind === 'add' ? '+' : kind === 'remove' ? '−' : ' '}</span><code>${escape(text)}</code></div>`).join('')}</div><p class="diff-caption">演示差异片段，不是当前仓库的真实内容。文件旁的勾选决定提交范围，不代表 Agent 拥有该文件。</p>`
}

function renderSecondary() {
  if (tab === 'history') {
    $('secondary').innerHTML = '<h2>操作记录</h2><p class="muted">仅本次演示；不持久化。</p>' + (state.log.length ? state.log.map((entry, index) => `<div class="history-entry">${index + 1}. ${escape(entry)}<small>演示结果 · 未执行真实 Git / GitHub 操作</small></div>`).join('') : '<div class="empty">尚未执行操作。</div>')
    return
  }
  if (!state.hasPR) {
    $('secondary').innerHTML = `<div class="pr-heading"><span class="muted">当前分支 / ${escape(state.branch)}</span></div><h2>此分支尚无 Pull Request</h2><p class="muted">目标仓库已从 origin 识别：demo/scry</p><div class="pr-section"><p>${state.branch === 'main' ? '当前为 main。创建 PR 需要功能分支；本稿不演示新建分支。' : state.published && !state.ahead ? '分支已推送，可以创建 PR。' : '先提交并推送当前分支，再创建 PR。'}</p></div><button class="primary" id="pr-create" ${!state.published || state.ahead || state.unknown || state.branch === 'main' ? 'disabled' : ''}>创建 Pull Request…</button><p class="pr-edit">多 remote 或 fork 无法唯一判断时，正式实现应要求选择目标，不能猜测。</p>`
    $('pr-create').addEventListener('click', () => openAction('createPr'))
    return
  }
  $('secondary').innerHTML = `<div class="pr-heading"><span class="pr-badge">Open</span><span class="muted">demo/scry #184 · 演示</span></div><h2>${escape(state.prTitle)}</h2><p class="muted">当前分支关联的 Pull Request</p><div class="pr-branches">main ← ${escape(state.branch)}</div><section class="pr-section"><h3>说明</h3><p>${escape(state.prBody || '未填写说明')}</p></section><section class="pr-section"><h3>检查与审查</h3><div class="check-row"><span>持续集成（CI）</span><span>等待运行</span></div><div class="check-row"><span>代码审查</span><span>尚未提交审查</span></div></section><section class="pr-section"><p>本稿聚焦提交 → 推送 → PR。完整 Review / Merge 沿用上一版设计，不在这里伪装成可用操作。</p></section>`
}

function render() {
  const focusId = document.activeElement?.id
  $('branch').textContent = state.branch
  $('repo-summary').textContent = `上游 origin　·　待推送 ${state.ahead} 个提交`
  $('file-count').textContent = visibleFiles().length
  $('pr-count').textContent = state.hasPR ? '#184' : ''
  for (const [id, name] of [['changes-tab', 'changes'], ['pr-tab', 'pr'], ['history-tab', 'history']]) $(id).setAttribute('aria-pressed', String(tab === name))
  $('workspace').hidden = tab !== 'changes'
  $('secondary').hidden = tab === 'changes'
  if (tab === 'changes') { renderFiles(); renderDiff() } else renderSecondary()
  $('notice').innerHTML = state.unknown
    ? '<div class="notice warning"><span>上次推送结果未知。先核查，不重复推送。</span></div>'
    : state.hookBlocked ? '<div class="notice warning"><span>pre-push 未授权：仅推送受限，本地提交仍可进行。</span><button id="hook-details">查看原因</button></div>'
      : state.staged.length ? '<div class="notice"><span>检测到已有暂存内容，提交时将保留原有选择。</span></div>' : ''
  $('hook-details')?.addEventListener('click', () => openAction('push'))
  const action = primaryAction(state)
  $('primary').textContent = action.label
  $('primary').disabled = action.disabled || busy
  const step = state.unknown ? 2 : state.next === 'pr' ? 3 : state.next === 'push' ? 2 : 1
  $('step-label').textContent = `0${step} / 03`
  $('next-summary').textContent = step === 1 ? (commitScope(state).length ? `本次提交 ${commitScope(state).length} 个文件` : '先确认这次要提交哪些文件') : step === 2 ? state.unknown ? '推送未确认，其他未提交改动仍保留' : '本地提交已就绪，下一步推送分支' : state.hasPR ? 'PR 已创建，等待检查与审查' : '分支已推送，下一步创建 PR'
  $('next-detail').textContent = step === 1 ? '未勾选的工作区文件不会被自动加入提交。' : step === 2 ? `${state.remaining.length} 个文件仍留在工作区，不会随推送提交。` : '仓库与分支已带入，无需重新填写。'
  $('live-status').textContent = state.log.length ? `演示 · ${state.log.at(-1)}` : '演示数据 · 尚未执行操作'
  if (focusId && !dialog.open) $(focusId)?.focus()
}

function closeDialog() {
  if (busy) return
  dialog.close()
  returnFocus?.focus()
}

function updateCommitButton() {
  $('confirm-dialog').disabled = busy || !commitScope(state).length || !$('commit-message').value.trim() || state.unknown
  $('confirm-dialog').textContent = `确认提交 ${commitScope(state).length} 个文件`
}

function openAction(action) {
  if (action === 'viewPr') { tab = 'pr'; render(); return }
  dialogAction = action
  returnFocus = document.activeElement
  $('dialog-eyebrow').textContent = '仅交互演示 · 不执行真实操作'
  $('cancel-dialog').textContent = '取消'
  $('confirm-dialog').hidden = false
  $('confirm-dialog').disabled = false
  if (action === 'commit') {
    $('dialog-title').textContent = '确认本次提交'
    $('dialog-content').innerHTML = `<p>选择提交范围。确认后暂存所选工作区文件，再提交完整暂存区；不自动推送。</p><div class="dialog-files">${visibleFiles().map(file => `<label class="dialog-file">${checkbox(file, 'dialog-file')}<span><strong>${escape(file.name)}</strong><small>${isStaged(file.id) ? state.partial.includes(file.id) ? '仅现有暂存部分；未暂存部分保留' : '已有暂存内容，必须纳入本次提交' : '未勾选则留在工作区'}</small></span></label>`).join('')}</div><label class="field">提交说明<textarea id="commit-message" placeholder="这次改了什么，为什么改？" maxlength="20000"></textarea></label>${state.unknown ? '<p class="dialog-note warning">存在未确认的推送，先核查后再继续写操作。</p>' : ''}<p class="dialog-note">目的地：本地 ${escape(state.branch)} · 不包含其他未选工作区文件。</p>`
    $('commit-message').value = state.message
    $('commit-message').addEventListener('input', updateCommitButton)
    updateCommitButton()
  } else if (action === 'push') {
    $('dialog-title').textContent = state.hookBlocked ? '推送前需要处理 hook 授权' : '确认推送'
    $('dialog-content').innerHTML = `<p>将本地已存在的提交推送到远端。不会提交工作区文件，不会强制推送。</p><div class="target-summary"><div><span>仓库</span><strong>demo/scry</strong></div><div><span>远端</span><strong>https://github.com/demo/scry.git</strong></div><div><span>目标分支</span><strong>${escape(state.branch)}</strong></div><div><span>待推送</span><strong>${state.ahead} 个提交</strong></div></div>${state.branch === 'main' ? '<p class="dialog-note warning">这是直接更新 main，不会自动创建功能分支或 PR。请确认目标。</p>' : ''}${state.hookBlocked ? '<div class="readback">仓库配置了 pre-push，但尚未获独立执行授权。Scry 不会跳过 hook，也不继承 recorder 的自动授权。</div><p class="dialog-note">本稿不新增授权能力。正式实现需设计独立授权流程；当前版本可在终端按 Git 原生流程处理。暂存与本地提交不应因此禁用。</p>' : ''}`
    $('confirm-dialog').textContent = state.hookBlocked ? '推送受限' : `确认推送到 ${state.branch}`
    $('confirm-dialog').disabled = state.hookBlocked || state.unknown || !state.ahead
  } else if (action === 'createPr') {
    $('dialog-title').textContent = '创建 Pull Request'
    $('dialog-content').innerHTML = `<p>已识别当前仓库与分支。确认后才执行远端创建操作。</p><div class="target-summary"><div><span>目标仓库</span><strong>demo/scry</strong></div><div><span>分支</span><strong>main ← ${escape(state.branch)}</strong></div><div><span>GitHub 账户</span><strong>demo-owner（演示）</strong></div></div><label class="field">标题<input type="text" id="pr-title" required maxlength="256"></label><label class="field">说明<textarea id="pr-body" placeholder="概述改动与验证方式"></textarea></label><p class="dialog-note">GitHub 账户与 Git 推送身份独立；此处仅展示已识别的演示账户。</p>`
    $('pr-title').value = state.message || '缓存会话历史，减少重复解析'
    $('confirm-dialog').textContent = '确认创建 PR'
    const update = () => { $('confirm-dialog').disabled = !$('pr-title').value.trim() || !state.published || state.ahead > 0 || state.hasPR || state.unknown || state.branch === 'main' }
    $('pr-title').addEventListener('input', update)
    update()
  } else if (action === 'reconcile') {
    $('dialog-title').textContent = '核查推送结果'
    $('dialog-content').innerHTML = '<p>只读取远端分支，不重试推送。读取到最新状态，也不一定能证明上次推送是否成功。</p><div class="readback">本演示设定：远端已继续变化，无法确认原操作的结果。</div><p class="dialog-note">核查后仍标记“结果未知”，不改成成功，也不自动重放。</p>'
    $('confirm-dialog').textContent = '只读核查'
  } else if (action === 'details') {
    $('dialog-title').textContent = '仓库详情'
    $('dialog-content').innerHTML = `<div class="target-summary"><div><span>目录</span><strong>~/Projects/scry（演示）</strong></div><div><span>分支</span><strong>${escape(state.branch)}</strong></div><div><span>上游</span><strong>origin/${escape(state.branch)}</strong></div><div><span>HEAD</span><strong>${state.head}（示意）</strong></div></div><p class="dialog-note">真实 Git 状态与 Agent 文件证据不同。完整路径、SHA、传输配置放在这里，不占用主操作区。</p>`
    $('confirm-dialog').hidden = true
    $('cancel-dialog').textContent = '关闭'
  } else if (action === 'other') {
    $('dialog-title').textContent = '其他 Git 操作'
    $('dialog-content').innerHTML = `<p>主按钮推荐下一步，你也可以单独选择操作。每次写入仍需确认。</p><button type="button" class="dialog-action" data-action="commit" ${!visibleFiles().length || state.unknown ? 'disabled' : ''}>提交改动…<span>只在本地提交所选范围</span></button><button type="button" class="dialog-action" data-action="push" ${!state.ahead || state.unknown ? 'disabled' : ''}>推送 ${state.ahead} 个提交…<span>${state.hookBlocked ? 'pre-push 授权受限，点击查看原因' : '不包含未提交的工作区改动'}</span></button><button type="button" class="dialog-action" data-action="${state.hasPR ? 'viewPr' : 'createPr'}" ${!state.hasPR && (!state.published || state.ahead > 0 || state.unknown || state.branch === 'main') ? 'disabled' : ''}>${state.hasPR ? '查看 PR #184' : '创建 Pull Request…'}<span>${state.hasPR ? '查看当前分支关联的 PR' : '先推送分支，再创建 PR'}</span></button>`
    $('confirm-dialog').hidden = true
    $('cancel-dialog').textContent = '关闭'
    $('dialog-content').querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
      const targetAction = button.dataset.action
      closeDialog()
      openAction(targetAction)
    }))
  }
  if (!dialog.open) dialog.showModal()
}

// Both lists edit the same prospective selection; checking never runs git add.
document.addEventListener('change', event => {
  const id = event.target.dataset.select
  if (!id) return
  state = transition(state, { type: 'select', id })
  render()
  if (dialog.open && dialogAction === 'commit') {
    $('dialog-content').querySelectorAll('[data-select]').forEach(input => { input.checked = isSelected(input.dataset.select) })
    updateCommitButton()
  }
})
$('file-list').addEventListener('click', event => {
  const button = event.target.closest('[data-inspect]')
  if (!button) return
  selectedFile = button.dataset.inspect
  $('workspace').classList.add('show-diff')
  render()
  // In a narrow panel the originating row is hidden; move focus into its detail.
  if (getComputedStyle($('back-files')).display !== 'none') $('back-files').focus()
})
$('back-files').addEventListener('click', () => {
  $('workspace').classList.remove('show-diff')
  $(`inspect-${selectedFile}`)?.focus()
})
for (const [id, value] of [['changes-tab', 'changes'], ['pr-tab', 'pr'], ['history-tab', 'history']]) $(id).addEventListener('click', () => { tab = value; render() })
$('primary').addEventListener('click', () => openAction(primaryAction(state).action))
$('other-actions').addEventListener('click', () => openAction('other'))
$('details').addEventListener('click', () => openAction('details'))
$('close-dialog').addEventListener('click', closeDialog)
$('cancel-dialog').addEventListener('click', closeDialog)
dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog() })
$('dialog-form').addEventListener('submit', async event => {
  event.preventDefault()
  if (busy || $('confirm-dialog').disabled || $('confirm-dialog').hidden) return
  const action = { type: dialogAction, message: $('commit-message')?.value || '', title: $('pr-title')?.value || '', body: $('pr-body')?.value || '' }
  busy = true
  $('confirm-dialog').disabled = true
  $('cancel-dialog').disabled = true
  $('close-dialog').disabled = true
  $('confirm-dialog').textContent = dialogAction === 'commit' ? '演示：确认暂存范围…' : dialogAction === 'push' ? '演示：正在推送…' : dialogAction === 'createPr' ? '演示：正在创建 PR…' : '演示：只读核查…'
  await new Promise(resolve => setTimeout(resolve, 350))
  if (dialogAction === 'commit') {
    $('confirm-dialog').textContent = '演示：创建本地提交…'
    await new Promise(resolve => setTimeout(resolve, 350))
  }
  state = transition(state, action)
  busy = false
  $('cancel-dialog').disabled = false
  $('close-dialog').disabled = false
  closeDialog()
  if (dialogAction === 'createPr') tab = 'pr'
  render()
})
function reset() {
  state = initialState($('scenario').value)
  tab = state.hasPR ? 'pr' : 'changes'
  selectedFile = 'cache'
  $('workspace').classList.remove('show-diff')
  render()
}
$('scenario').addEventListener('change', reset)
$('reset').addEventListener('click', reset)
$('width').addEventListener('click', () => {
  const narrow = $('shell').classList.toggle('compact')
  $('workspace').classList.remove('show-diff')
  $('width').textContent = narrow ? '宽面板' : '窄面板'
})
$('theme').addEventListener('click', () => {
  const light = document.documentElement.dataset.theme === 'dark'
  document.documentElement.dataset.theme = light ? 'light' : 'dark'
  $('theme').textContent = light ? '深色' : '浅色'
})
render()
