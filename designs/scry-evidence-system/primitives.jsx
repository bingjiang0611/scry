function cx(...values) {
  return values.filter(Boolean).join(' ')
}

function StatusMark({ status, state, label, compact = false }) {
  status = status || state || 'unknown'
  const labels = {
    ready: '就绪', complete: '完成', exact: '完整', classified: '已分类', passed: '通过', verified: '已认证', connected: '已连接', trueZero: '真实 0', zero: '真实 0',
    running: '执行中', loading: '读取中', pending: '提交中', scanning: '扫描中',
    partial: '部分覆盖', degraded: '降级', warning: '需注意', warn: '需注意', unknown: '未知',
    unsupported: '未支持', error: '错误', failed: '失败', danger: '危险', blocked: '阻塞', cancelled: '已取消', disabled: '已禁用', none: '无需认证'
  }
  return <span className={cx('status-mark', `status-${status}`, compact && 'is-compact')}><i></i>{label || labels[status] || status}</span>
}

function KnownValue({ value, status, state, suffix = '', className = '' }) {
  status = status || state || 'exact'
  const display = status === 'unknown' ? '—' : status === 'unsupported' ? '未支持' : status === 'loading' ? '···' : status === 'trueZero' || status === 'zero' ? '0' : `${status === 'partial' && value && !String(value).startsWith('≥') ? '≥ ' : ''}${value}`
  return <span className={cx('known-value', `known-${status}`, className)}><b>{display}</b>{suffix && <small>{suffix}</small>}</span>
}

function EvidenceRow({ label, value, status, state, detail, note, action, onAction, selected = false, icon }) {
  status = status || state || 'exact'
  detail = detail || note
  return (
    <div className={cx('evidence-row', selected && 'selected')}>
      <span className="evidence-label">{icon && <ScryIcon name={icon} size={14} />}{label}</span>
      <i className="evidence-leader"></i>
      <span className="evidence-value">{detail && <small>{detail}</small>}{React.isValidElement(value) ? value : <KnownValue value={value} status={status} />}{action && <button type="button" className="text-action" onClick={onAction}>{action}</button>}</span>
    </div>
  )
}

function ViewHeader({ eyebrow, title, description, detail, summary, scope, actions, trailing, status, compact = false }) {
  description = description || detail || summary
  return (
    <header className={cx('view-header', compact && 'is-compact')}>
      <div className="view-heading">
        {eyebrow && <span className="view-eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      <div className="view-meta">
        {scope && <span className="scope-chip"><i></i>{scope}</span>}
        {status}
        {trailing}
        {actions}
      </div>
    </header>
  )
}

function SectionTitle({ id, index, title, note, meta, action }) {
  note = note || meta
  return (
    <div className="section-title">
      <span>{index}</span>
      <h2 id={id}>{title}</h2>
      <i></i>
      {note && <small>{note}</small>}
      {action}
    </div>
  )
}

function SourceLine({ children }) {
  return <div className="source-line"><span>SOURCE</span><i></i><b>{children}</b></div>
}

function MetricStrip({ metrics, compact = false }) {
  return <div className={cx('metric-strip', compact && 'is-compact')}>{metrics.map((metric) => <div className="metric-cell" key={metric.label}><span>{metric.label}</span><KnownValue value={metric.value} status={metric.status} /><small>{metric.note}</small></div>)}</div>
}

function VerdictBand({ tone = 'neutral', label = 'VERDICT', title, detail, action }) {
  return <section className={cx('verdict-band', `tone-${tone}`)}><div><span>{label}</span><h2>{title}</h2>{detail && <p>{detail}</p>}</div>{action}</section>
}

function Toggle({ checked, pending = false, disabled = false, onChange, label }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled || pending} className={cx('switch', checked && 'on', pending && 'pending')} onClick={() => onChange?.(!checked)}><i></i></button>
}

function ModalFrame({ title, subtitle, children, onClose, width = 'wide' }) {
  const panelRef = React.useRef(null)
  React.useEffect(() => {
    const previous = document.activeElement
    panelRef.current?.focus()
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab' || !panelRef.current) return
      const items = [...panelRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')]
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown); previous?.focus?.() }
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={cx('modal-panel', `modal-${width}`)} role="dialog" aria-modal="true" aria-label={title} ref={panelRef} tabIndex="-1">
        <header className="modal-header"><div><span>GLOBAL INVENTORY</span><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><ScryIcon name="x" /></button></header>
        {children}
      </section>
    </div>
  )
}

Object.assign(window, { cx, StatusMark, KnownValue, EvidenceRow, ViewHeader, SectionTitle, SourceLine, MetricStrip, VerdictBand, Toggle, ModalFrame })
