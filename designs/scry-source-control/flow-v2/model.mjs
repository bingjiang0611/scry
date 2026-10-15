// Design-only state; no Git, filesystem or network access.
import { files } from '../model.mjs'
export { files }

export function initialState(scenario = 'changes') {
  return {
    scenario,
    remaining: files.map(file => file.id),
    staged: scenario === 'partial' ? ['test'] : [],
    partial: scenario === 'partial' ? ['test'] : [],
    selected: [],
    branch: scenario === 'main' ? 'main' : 'feat/history-cache',
    ahead: scenario === 'main' ? 81 : 0,
    hookBlocked: scenario === 'hook',
    unknown: scenario === 'unknown',
    hasPR: scenario === 'pr',
    published: scenario === 'pr',
    next: scenario === 'unknown' || scenario === 'main' ? 'push' : 'commit',
    message: '',
    head: 'a81f3d2',
    log: [],
    prTitle: scenario === 'pr' ? '缓存会话历史，减少重复解析' : '',
    prBody: scenario === 'pr' ? '以文件版本缓存已读取的历史，文件变化时重新解析。' : ''
  }
}

export function commitScope(state) {
  return [...new Set([...state.staged, ...state.selected.filter(id => state.remaining.includes(id))])]
}

export function primaryAction(state) {
  if (state.unknown) return { action: 'reconcile', label: '核查推送结果', disabled: false }
  if (state.next === 'push' && state.ahead > 0) return { action: 'push', label: `推送 ${state.ahead} 个提交…`, disabled: false }
  if (state.next === 'pr') return { action: state.hasPR ? 'viewPr' : 'createPr', label: state.hasPR ? '查看 PR #184' : '创建 Pull Request…', disabled: false }
  return { action: 'commit', label: '提交改动…', disabled: state.remaining.length === 0 && state.staged.length === 0 }
}

export function transition(state, action) {
  switch (action.type) {
    case 'select':
      if (state.staged.includes(action.id) || !state.remaining.includes(action.id)) return state
      return { ...state, selected: state.selected.includes(action.id) ? state.selected.filter(id => id !== action.id) : [...state.selected, action.id] }
    case 'commit': {
      const scope = commitScope(state)
      if (state.unknown || scope.length === 0 || !action.message.trim()) return state
      // A partially staged file keeps its unstaged remainder. Never stage it again.
      return { ...state, remaining: state.remaining.filter(id => !scope.includes(id) || state.partial.includes(id)), staged: [], partial: [], selected: [], ahead: state.ahead + 1, head: 'c93a71e', message: action.message.trim(), next: 'push', log: [...state.log, `本地提交 c93a71e · ${scope.length} 个文件 · 尚未推送`] }
    }
    case 'push':
      if (state.hookBlocked || state.unknown || state.ahead === 0) return state
      return { ...state, ahead: 0, published: true, next: state.branch === 'main' ? 'commit' : 'pr', log: [...state.log, '远端分支已确认 · c93a71e'] }
    case 'reconcile':
      // Readback cannot prove this simulated interrupted write succeeded.
      return { ...state, log: [...state.log, '只读核查：仍无法确认原推送结果，未重新推送'] }
    case 'createPr':
      if (!state.published || state.ahead > 0 || state.hasPR || state.unknown || state.branch === 'main' || !action.title.trim()) return state
      return { ...state, hasPR: true, next: 'pr', prTitle: action.title.trim(), prBody: action.body, log: [...state.log, '已创建 PR #184 · 等待检查与审查'] }
    default:
      return state
  }
}
