// Design-only state. No filesystem, provider or network operations.
export const files = [
  { id: 'cache', name: 'session-history-cache.ts', path: 'src/renderer/session-history-cache.ts', kind: 'M', added: 31, removed: 7 },
  { id: 'test', name: 'session-history-cache.test.ts', path: 'src/renderer/session-history-cache.test.ts', kind: 'M', added: 7, removed: 2 },
  { id: 'notes', name: 'local-notes.md', path: 'notes/local-notes.md', kind: '?', added: 4, removed: 0 }
]

export function initialState(scenario = 'ready') {
  return {
    scenario, tab: 'changes', prTab: 'overview', selected: 'cache', staged: [],
    remaining: files.map(file => file.id), ahead: 0, hasPR: scenario !== 'new',
    pushed: scenario !== 'new', checks: scenario === 'pending' ? 'pending' : 'passed',
    stale: scenario === 'stale', authenticated: scenario !== 'auth',
    unknown: scenario === 'unknown', busy: scenario === 'busy', merged: false,
    commitTitle: 'perf: cache session history by revision',
    prTitle: '缓存会话历史，减少重复解析', head: 'a81f3d2',
    prBody: '以文件版本为键缓存已解析的会话历史。\n文件内容变化时丢弃旧缓存，保留失败信息。',
    apiUser: 'reviewer-demo', prAuthor: 'author-demo', isDraftPR: false,
    approvalHead: scenario === 'new' ? null : 'a81f3d2', reviewDecision: 'approved',
    drafts: [], reviews: [], operation: scenario === 'unknown' ? '演示：推送已发出，响应中断，尚未确认结果' : '尚未执行操作'
  }
}

export function capabilities(state) {
  const localReady = !state.stale && !state.unknown && !state.busy && !state.merged
  const remoteReady = localReady && state.authenticated
  return {
    stage: localReady,
    commit: localReady && state.staged.length > 0 && Boolean(state.commitTitle.trim()),
    push: localReady && state.ahead > 0,
    createPR: remoteReady && !state.hasPR && state.pushed && state.ahead === 0,
    comment: remoteReady && state.hasPR,
    review: remoteReady && state.hasPR && state.drafts.every(draft => draft.head === state.head),
    canApprove: state.apiUser !== state.prAuthor,
    merge: remoteReady && state.hasPR && !state.isDraftPR && state.checks === 'passed' && state.reviewDecision === 'approved' && state.ahead === 0
  }
}

export function transition(state, action) {
  const allowed = capabilities(state)
  switch (action.type) {
    case 'stage':
      if (!allowed.stage || !state.remaining.includes(action.id)) return state
      return { ...state, staged: state.staged.includes(action.id) ? state.staged.filter(id => id !== action.id) : [...state.staged, action.id] }
    case 'commit':
      if (!allowed.commit) return state
      return { ...state, remaining: state.remaining.filter(id => !state.staged.includes(id)), staged: [], ahead: state.ahead + 1, operation: '演示：本地提交成功 · c93a71e；尚未推送' }
    case 'push':
      if (!allowed.push) return state
      return { ...state, ahead: 0, pushed: true, head: 'c93a71e', checks: 'pending', reviewDecision: 'required', operation: '演示：远端分支已确认 · c93a71e；CI 等待中' }
    case 'createPR':
      if (!allowed.createPR) return state
      return { ...state, hasPR: true, prTitle: action.title, prBody: action.body, prAuthor: state.apiUser, isDraftPR: Boolean(action.draft), approvalHead: null, reviewDecision: 'required', tab: 'pr', operation: '演示：已创建 PR #184（非真实 GitHub 写入）' }
    case 'addDraft':
      if (!allowed.comment || !action.body.trim()) return state
      return { ...state, drafts: [...state.drafts, { body: action.body.trim(), path: files[0].path, line: 26, head: state.head }], operation: '行评论保存在本页草稿，尚未提交' }
    case 'discardDrafts':
      return { ...state, drafts: [], operation: '已明确丢弃本地草稿；未执行外部写入' }
    case 'review':
      if (!allowed.review || (!action.body.trim() && !state.drafts.length && action.verdict !== 'APPROVE')) return state
      if (action.verdict !== 'COMMENT' && !allowed.canApprove) return state
      return { ...state, reviews: [...state.reviews, { body: action.body, verdict: action.verdict, head: state.head, comments: state.drafts }], drafts: [], reviewDecision: action.verdict === 'REQUEST_CHANGES' ? 'changes_requested' : action.verdict === 'APPROVE' ? 'approved' : state.reviewDecision, operation: '演示：已提交审查；不是 AI 建议或本地草稿' }
    case 'merge':
      if (!allowed.merge || action.head !== state.head) return state
      return { ...state, merged: true, operation: `演示：已合并 ${state.head} → main；未删除分支或工作目录` }
    case 'refresh':
      // Refresh must never turn an unknown write into success, authenticate, or finish CI.
      return { ...state, stale: false, operation: state.stale ? '演示：已重新读取仓库；请重新确认提交范围' : '演示：只读刷新完成，未重试任何写操作' }
    case 'reconcile':
      if (!state.unknown) return state
      return { ...state, operation: '演示：远端已继续变化，无法确认原推送结果；保持未知，不重试' }
    default:
      return state
  }
}
