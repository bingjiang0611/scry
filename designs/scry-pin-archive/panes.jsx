// 展示层：侧边栏会话行 + 已存档会话页。全部 props in / callbacks out，状态由 app.jsx 持有。
const { Icon, relTime, absTime } = window

// 生产里 .sb-sess 本身是 <button>，行内再放按钮会嵌套 button（非法 HTML）。
// 所以这里把行拆成 .sb-sess-row 包裹层 + 内部 button + 绝对定位的操作区。
function SessionRow({ session, active, showProject, onPick, onTogglePin, onArchive }) {
  const pinned = Boolean(session.pinnedAt)
  return (
    <div className="sb-sess-row">
      <button
        type="button"
        className={['sb-sess', active && 'active'].filter(Boolean).join(' ')}
        data-provider={session.providerId}
        aria-current={active ? 'true' : undefined}
        onClick={() => onPick(session)}
      >
        <span className="sb-session-main">
          <span className="sb-provider">{session.providerId}</span>
          <span className="sb-sesstext">{session.preview || '(无预览)'}</span>
        </span>
        <span className="sb-session-meta">
          {session.count > 1 && <span className="sb-count">{session.count} 轮</span>}
          <span className="sb-sesstime">{relTime(session.mtime)}</span>
          {showProject && <span className="sb-sess-proj">{session.name || '未关联目录'}</span>}
        </span>
        {session.runId && <span className="sb-running" role="status" aria-label="正在运行" />}
      </button>
      <span className="sb-sess-acts">
        <button
          type="button"
          className={['sb-act', pinned && 'on'].filter(Boolean).join(' ')}
          title={pinned ? '取消置顶' : '置顶会话'}
          aria-label={pinned ? '取消置顶' : '置顶会话'}
          aria-pressed={pinned}
          onClick={() => onTogglePin(session)}
        >
          <Icon name="pin" />
        </button>
        <button
          type="button"
          className="sb-act"
          title="存档会话"
          aria-label="存档会话"
          onClick={() => onArchive(session)}
        >
          <Icon name="archive" />
        </button>
      </span>
    </div>
  )
}

function ArchivedChats({
  groups,
  total,
  matched,
  query,
  provider,
  project,
  projects,
  confirming,
  onQuery,
  onProvider,
  onProject,
  onUnarchive,
  onDelete,
  onAskDeleteAll,
  onCancelDeleteAll,
  onDeleteAll
}) {
  return (
    <>
      <div className="arch-head">
        <div className="settings-copy">
          <b>已存档会话</b>
          <span>存档后会话从左侧列表移出，历史记录、用量与 trace 都保留。在这里可以取消存档放回原项目，或永久删除。</span>
        </div>
        <button type="button" className="arch-danger" disabled={total === 0} onClick={onAskDeleteAll}>
          <Icon name="trash" /> 全部删除
        </button>
      </div>

      {confirming && (
        <div className="arch-confirm" role="alert">
          <span>永久删除全部 {total} 个已存档会话？会话记录、用量与 trace 一并移除，不可恢复。</span>
          <button type="button" className="cancel" onClick={onCancelDeleteAll}>取消</button>
          <button type="button" className="go" onClick={onDeleteAll}>确认删除</button>
        </div>
      )}

      <div className="arch-tools">
        <label className="arch-search">
          <Icon name="search" />
          <input placeholder="搜索已存档会话…" value={query} onChange={(e) => onQuery(e.target.value)} />
        </label>
        <label className="arch-filter">
          <Icon name="filter" />
          <select value={provider} onChange={(e) => onProvider(e.target.value)} aria-label="按 Provider 筛选">
            <option value="all">全部 Provider</option>
            <option value="claude">claude</option>
            <option value="codex">codex</option>
            <option value="qoder">qoder</option>
            <option value="opencode">opencode</option>
          </select>
        </label>
        <label className="arch-filter">
          <Icon name="folder" />
          <select value={project} onChange={(e) => onProject(e.target.value)} aria-label="按项目筛选">
            <option value="all">全部项目</option>
            {projects.map((p) => (
              <option key={p.cwd || 'none'} value={p.cwd || 'none'}>{p.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="arch-list">
        {total === 0 && (
          <div className="arch-empty">
            <b>没有已存档会话</b>
            <span>在左侧列表把鼠标移到会话上，点存档图标即可把它收进这里。</span>
          </div>
        )}
        {total > 0 && matched === 0 && (
          <div className="arch-empty">
            <b>没有匹配的会话</b>
            <span>当前筛选条件下没有结果；换个关键词或把筛选改回“全部”。</span>
          </div>
        )}
        {groups.map((g) => (
          <section className="arch-group" key={g.cwd || 'none'}>
            <header className="arch-group-head">
              <Icon name="folder" />
              <b>{g.name}</b>
              <span className="cnt">{g.sessions.length} 个会话</span>
            </header>
            <div className="arch-group-body">
              {g.sessions.map((s) => (
                <div className="arch-row" key={s.sessionId}>
                  <div className="arch-row-copy">
                    <div className="arch-row-title">
                      <b>{s.preview || '(无预览)'}</b>
                    </div>
                    <div className="arch-row-meta">
                      <span>{s.providerId}</span>
                      <span>{s.count} 轮</span>
                      <span>存档于 {absTime(s.archivedAt)}</span>
                    </div>
                  </div>
                  <div className="arch-row-acts">
                    <button
                      type="button"
                      className="arch-del"
                      title="永久删除"
                      aria-label={`永久删除 ${s.preview}`}
                      onClick={() => onDelete(s)}
                    >
                      <Icon name="trash" />
                    </button>
                    <button type="button" className="arch-unarch" onClick={() => onUnarchive(s)}>
                      取消存档
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  )
}

Object.assign(window, { SessionRow, ArchivedChats })
