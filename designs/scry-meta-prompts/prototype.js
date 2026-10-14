// Isolated, in-memory design prototype. Reload restores the sample library.
const icons = {
  plus: '<path d="M9 3v12M3 9h12"/>',
  search: '<circle cx="7.5" cy="7.5" r="4.5"/><path d="m11 11 4 4"/>',
  chart: '<path d="M2 2v13h14M5 11l3-4 3 2 4-5"/>',
  hex: '<path d="m9 2 7 4v7l-7 4-7-4V6Z"/>',
  cube: '<path d="m9 2 7 4v7l-7 4-7-4V6Zm0 8 7-4M9 10 2 6m7 4v7"/>',
  prompt: '<rect x="2.5" y="2.5" width="13" height="13" rx="3"/><path d="m6 6 3 3-3 3m5 0h2"/>',
  folder: '<path d="M2 5V3h5l2 2h7v10H2Z"/>',
  settings: '<path d="m7 2 4 0 1 3 3 1 1 4-3 2-1 3H6l-1-3-3-2 1-4 3-1Z"/><circle cx="9" cy="9" r="2.5"/>',
  star: '<path d="m9 2 2.2 4.5 5 .7-3.6 3.5.8 5L9 13.4l-4.4 2.3.8-5L1.8 7.2l5-.7Z"/>',
  copy: '<rect x="6" y="6" width="9" height="10" rx="1.5"/><path d="M11 3H3v9"/>',
  edit: '<path d="m11 3 4 4M3 15l1-4L12 3a2 2 0 0 1 3 3l-8 8Zm0 0 4-1"/>',
  trash: '<path d="M2 5h14M6 5V2h6v3M4 5l1 11h8l1-11M7 8v5m4-5v5"/>',
  x: '<path d="m4 4 10 10M14 4 4 14"/>',
  arrow: '<path d="M9 14V3m-5 5 5-5 5 5"/>',
  'arrow-right': '<path d="M3 9h12m-5-5 5 5-5 5"/>'
}
const icon = name => `<svg viewBox="0 0 18 18" aria-hidden="true">${icons[name]}</svg>`
const escapeHtml = text => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const samples = [
  {
    id: 'plan', title: '先写方案，再开始实现', starred: true,
    body: '先不要修改代码。请先理解需求与现有实现，写出一份可执行的技术方案。\n\n1. 确认问题\n说明用户目标、当前行为与预期行为。区分已验证事实和待确认假设。\n\n2. 检查调用链\n找到相关入口、共享实现与相邻路径。优先复用已有组件、类型和约定，不为未来需求预留能力。\n\n3. 给出最小方案\n列出改动位置、关键决策与取舍。不要只修表面症状，也不要顺手重构无关代码。\n\n4. 明确验证方式\n给出能证明关键行为的检查，列出回归风险、未验证项和需要我决定的问题。\n\n写完方案后停下，等我确认再开始实现。'
  },
  {
    id: 'review', title: '带着证据做代码审查', starred: true,
    body: '请审查本次改动，重点找出会影响真实用户的错误与回归。\n\n先读完整 diff，再检查调用方、共享实现和测试。不要仅凭代码风格给出结论。\n\n每个问题都写清：\n- 具体文件和位置\n- 触发条件\n- 用户影响\n- 支持判断的证据\n- 最小修复建议\n\n按风险高低排序。区分确定问题与推测。没有发现问题就明确说明，不要凑数量。\n\n暂时不要修改代码。'
  },
  {
    id: 'root', title: '先查根因，不要加兜底', starred: true,
    body: '先调查失败原因，不要直接增加重试、延迟或备用路径。\n\n从首次失败的日志开始，沿真实调用链检查状态变化、数据来源和权限边界。\n\n说明：\n1. 哪个事实已经被日志或可运行检查证明？\n2. 哪些结论仍是推测？\n3. 哪个最小实验可以区分这些假设？\n4. 应该在哪个共享层修复根因？\n\n无法证明成功的结果应标记为未知，不要静默吞错。'
  },
  {
    id: 'simplify', title: '最小实现与自审', starred: false,
    body: '理解需求后，选择满足完整需求的最简单实现。\n\n先复用仓库已有能力，再考虑标准库与已安装依赖。不要引入单一实现的接口、工厂或配置。\n\n完成后审查最终 diff：需求遗漏、死代码、重复校验、临时占位和无关改动。\n\n验证必须能区分真实实现与表面正确。只对已验证的行为宣称成功。'
  },
  {
    id: 'explain', title: '把复杂问题讲清楚', starred: false,
    body: '请用清晰、简洁的中文解释这个问题。\n\n先给结论，再解释依据。每句话尽量只表达一个要点。对术语给出必要解释，避免堆叠抽象名词。\n\n复杂结构或流程可以用简短 ASCII 图或 Mermaid 辅助说明。图中要区分已验证事实和假设。\n\n保留重要细节和限制，不要为了简短而隐藏未知结果。'
  },
  {
    id: 'handoff', title: '结束前给出交接记录', starred: false,
    body: '结束前，请给出可继续工作的交接记录。\n\n- 已完成什么，改动在哪些文件\n- 实际运行了哪些检查，结果是什么\n- 哪些路径尚未验证，原因是什么\n- 当前分支、提交和推送状态\n- 是否留下运行中的进程或临时资源\n- 下一步最具体的动作\n\n不要把工具调用成功当作业务完成，也不要把旧版本测试当作本次证据。'
  }
]
let prompts = structuredClone(samples)
let selectedId = prompts[0].id
let mode = 'library'
let filter = 'all'
let editingId = null
let initialEdit = ''
let deleteId = null
let toastTimer
const $ = selector => document.querySelector(selector)
const selected = () => prompts.find(prompt => prompt.id === selectedId)
const hydrateIcons = root => root.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon) })
const notify = message => {
  clearTimeout(toastTimer)
  $('#toast').textContent = message
  $('#toast').classList.add('visible')
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 2400)
}
const matches = (prompt, query) => `${prompt.title}\n${prompt.body}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
const visiblePrompts = () => prompts.filter(prompt => matches(prompt, $('#search').value) && (filter !== 'starred' || prompt.starred))
const row = (prompt, quick = false) => `<div class="prompt-row ${prompt.id === selectedId ? 'selected' : ''}"><button class="row-select" data-select="${prompt.id}" aria-pressed="${prompt.id === selectedId}"><span class="row-title"><strong>${escapeHtml(prompt.title)}</strong>${prompt.starred ? `<span class="star-mark">${icon('star')}</span>` : ''}</span>${quick ? '' : `<p>${escapeHtml(prompt.body.split('\n')[0])}</p>`}</button>${quick ? '' : `<button class="row-copy" data-copy="${prompt.id}" aria-label="复制：${escapeHtml(prompt.title)}" title="复制提示词">${icon('copy')}</button>`}</div>`
const emptyList = () => prompts.length === 0
  ? `<div class="empty">${icon('prompt')}<strong>还没有提示词</strong><span>把第一条常用指令保存下来。</span><button class="button new-prompt">新建提示词</button></div>`
  : '<div class="empty"><strong>没有匹配的提示词</strong><span>试试正文中的关键词，或切换筛选。</span></div>'
const actions = prompt => `<div class="detail-actions"><button class="button" data-insert="${prompt.id}">放入当前会话</button><button class="button primary" data-copy="${prompt.id}">${icon('copy')}复制提示词</button></div>`
function render() {
  const visible = visiblePrompts()
  if (!visible.some(prompt => prompt.id === selectedId)) selectedId = visible[0]?.id ?? null
  $('#all-count').textContent = prompts.length
  $('#star-count').textContent = prompts.filter(prompt => prompt.starred).length
  $('#list').innerHTML = visible.length ? visible.map(prompt => row(prompt)).join('') : emptyList()
  const prompt = selected()
  $('#detail').innerHTML = prompt ? `<header class="detail-header"><div><h2>${escapeHtml(prompt.title)}</h2></div><div class="detail-tools"><button class="icon-button" data-star="${prompt.id}" aria-label="${prompt.starred ? '取消收藏' : '收藏'}" aria-pressed="${prompt.starred}" title="${prompt.starred ? '取消收藏' : '收藏'}">${icon('star')}</button><button class="icon-button" data-edit="${prompt.id}" aria-label="编辑提示词" title="编辑">${icon('edit')}</button><button class="icon-button" data-delete="${prompt.id}" aria-label="删除提示词" title="删除">${icon('trash')}</button></div></header><div class="detail-body"><pre class="prompt-text">${escapeHtml(prompt.body)}</pre></div><footer class="detail-footer"><span class="text-meta">${Array.from(prompt.body).length} 字 · 纯文本</span>${actions(prompt)}</footer>` : '<div class="empty"><strong>没有可预览的提示词</strong><span>新建一条，或调整搜索与筛选。</span></div>'
  renderQuick()
}
function renderQuick() {
  const visible = prompts.filter(prompt => matches(prompt, $('#quick-search').value))
  const prompt = visible.find(prompt => prompt.id === selectedId) ?? visible[0]
  if (mode === 'quick' && prompt) selectedId = prompt.id
  $('#quick-list').innerHTML = visible.length ? visible.map(item => row(item, true)).join('') : emptyList()
  $('#quick-detail').innerHTML = prompt ? `<h3>${escapeHtml(prompt.title)}</h3><pre class="prompt-text">${escapeHtml(prompt.body)}</pre>${actions(prompt)}` : '<div class="empty"><strong>没有可预览的提示词</strong></div>'
}
function setMode(nextMode) {
  mode = nextMode
  $('#quick-dialog').close()
  document.querySelectorAll('.direction').forEach(button => {
    const active = button.dataset.mode === mode
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', active)
  })
  $('#library').classList.toggle('hidden', mode === 'quick')
  $('#chat').classList.toggle('hidden', mode === 'library')
  $('#open-prompts').classList.add('active')
  if (mode === 'quick') {
    $('#quick-search').value = ''
    renderQuick()
    $('#quick-dialog').showModal()
    $('#quick-search').focus()
  } else render()
}
async function copyPrompt(id) {
  const prompt = prompts.find(item => item.id === id)
  try {
    await navigator.clipboard.writeText(prompt.body)
    notify('已复制提示词')
  } catch (error) {
    notify(`复制失败，请手动选择正文复制：${error.name}`)
  }
}
function insertPrompt(id) {
  const prompt = prompts.find(item => item.id === id)
  const composer = $('#composer')
  composer.value = composer.value ? `${composer.value}\n\n${prompt.body}` : prompt.body
  $('#quick-dialog').close()
  $('#library').classList.add('hidden')
  $('#chat').classList.remove('hidden')
  $('#open-prompts').classList.remove('active')
  composer.focus()
  notify('已放入输入框，尚未发送')
}
const editValue = () => JSON.stringify([$('#edit-title').value, $('#edit-body').value])
function openEditor(id = null) {
  editingId = id
  const prompt = id ? prompts.find(item => item.id === id) : null
  $('#editor-title').textContent = prompt ? '编辑提示词' : '新建提示词'
  $('#edit-title').value = prompt?.title ?? ''
  $('#edit-body').value = prompt?.body ?? ''
  $('#edit-title').setCustomValidity('')
  $('#edit-body').setCustomValidity('')
  $('#edit-count').textContent = `${Array.from($('#edit-body').value).length} 字`
  initialEdit = editValue()
  $('#editor').showModal()
  $('#edit-title').focus()
}
function cancelEditor() {
  if (editValue() !== initialEdit) $('#discard-dialog').showModal()
  else $('#editor').close()
}
document.addEventListener('click', event => {
  const button = event.target.closest('button')
  if (!button) return
  if (button.dataset.mode) setMode(button.dataset.mode)
  if (button.dataset.select) {
    selectedId = button.dataset.select
    mode === 'quick' ? renderQuick() : render()
  }
  if (button.dataset.copy) copyPrompt(button.dataset.copy)
  if (button.dataset.insert) insertPrompt(button.dataset.insert)
  if (button.dataset.star) {
    const prompt = prompts.find(item => item.id === button.dataset.star)
    prompt.starred = !prompt.starred
    render()
  }
  if (button.dataset.edit) openEditor(button.dataset.edit)
  if (button.classList.contains('new-prompt')) openEditor()
  if (button.dataset.delete) {
    deleteId = button.dataset.delete
    $('#delete-name').textContent = `“${prompts.find(item => item.id === deleteId).title}”将从提示词库移除。`
    $('#delete-dialog').showModal()
  }
  if (button.hasAttribute('data-chat')) {
    $('#quick-dialog').close()
    $('#library').classList.add('hidden')
    $('#chat').classList.remove('hidden')
    $('#open-prompts').classList.remove('active')
  }
})
$('#search').addEventListener('input', render)
$('#quick-search').addEventListener('input', renderQuick)
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.filter
  document.querySelectorAll('[data-filter]').forEach(item => {
    const active = item.dataset.filter === filter
    item.classList.toggle('active', active)
    item.setAttribute('aria-pressed', active)
  })
  render()
}))
$('#open-prompts').addEventListener('click', () => setMode(mode))
$('#manage').addEventListener('click', () => setMode('library'))
$('#close-quick').addEventListener('click', () => $('#quick-dialog').close())
$('#cancel-editor').addEventListener('click', cancelEditor)
$('#cancel-editor-x').addEventListener('click', cancelEditor)
$('#editor').addEventListener('cancel', event => { event.preventDefault(); cancelEditor() })
$('#keep-editing').addEventListener('click', () => $('#discard-dialog').close())
$('#discard').addEventListener('click', () => { $('#discard-dialog').close(); $('#editor').close() })
$('#cancel-delete').addEventListener('click', () => $('#delete-dialog').close())
$('#confirm-delete').addEventListener('click', () => {
  prompts = prompts.filter(prompt => prompt.id !== deleteId)
  $('#delete-dialog').close()
  render()
  notify('已删除提示词')
})
$('#edit-title').addEventListener('input', () => $('#edit-title').setCustomValidity(''))
$('#edit-body').addEventListener('input', () => {
  $('#edit-body').setCustomValidity('')
  $('#edit-count').textContent = `${Array.from($('#edit-body').value).length} 字`
})
$('#editor-form').addEventListener('submit', event => {
  event.preventDefault()
  const title = $('#edit-title').value.trim()
  const body = $('#edit-body').value
  if (!title || !body.trim()) {
    if (!title) $('#edit-title').setCustomValidity('请输入标题')
    if (!body.trim()) $('#edit-body').setCustomValidity('请输入提示词正文')
    $('#editor-form').reportValidity()
    return
  }
  if (editingId) Object.assign(prompts.find(prompt => prompt.id === editingId), { title, body })
  else {
    const prompt = { id: crypto.randomUUID(), title, body, starred: false }
    prompts.unshift(prompt)
    selectedId = prompt.id
    $('#search').value = ''
    filter = 'all'
    document.querySelectorAll('[data-filter]').forEach(button => {
      const active = button.dataset.filter === filter
      button.classList.toggle('active', active)
      button.setAttribute('aria-pressed', active)
    })
  }
  $('#editor').close()
  render()
  notify('已保存到设计稿，刷新后恢复示例')
})
$('#theme').addEventListener('click', () => {
  const light = document.documentElement.dataset.theme !== 'light'
  document.documentElement.dataset.theme = light ? 'light' : 'dark'
  $('#theme').textContent = light ? '深色' : '浅色'
  $('#theme').setAttribute('aria-label', light ? '切换深色主题' : '切换浅色主题')
  document.querySelector('meta[name="theme-color"]').content = light ? '#f7f7f5' : '#181818'
})
hydrateIcons(document)
render()
