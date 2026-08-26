/* Evidence derivation copied from scry/src/renderer/components/Modals.tsx:575-912 so the
   mockup reproduces real labels/details rather than invented copy. */

const MCP_SCOPE_LABEL = {
  '.mcp.json': '项目 MCP（.mcp.json）',
  project: '项目 MCP（~/.claude.json）',
  user: '用户 MCP（~/.claude.json）',
  effective: 'Pi 有效配置（合并后）'
}

const LIVE_STATE = {
  connected: 'connected',
  cached: 'unknown',
  disconnected: 'unknown',
  failed: 'failed',
  'needs-auth': 'needs-auth',
  'needs-client-registration': 'required',
  pending: 'pending',
  disabled: 'disabled'
}

const LIVE_TEXT = {
  connected: 'connected',
  cached: '仅缓存元数据',
  disconnected: '尚未连接',
  failed: 'failed',
  'needs-auth': '需认证',
  'needs-client-registration': '需配置 OAuth Client',
  pending: 'pending',
  disabled: 'disabled'
}

function scopeClass(scope) {
  if (scope === '.mcp.json' || scope === 'project') return 'project'
  if (scope === 'user') return 'user'
  return 'unknown'
}

function scopeShortLabel(scope) {
  if (scope === '.mcp.json' || scope === 'project') return '项目'
  if (scope === 'user') return '用户'
  if (scope === 'effective') return '有效'
  return scope
}

function evidenceForRuntime(value, capability) {
  if (!value) {
    if (capability?.state === 'unsupported' || capability?.mode === 'none') {
      return { state: 'unsupported', label: '不支持', detail: capability.reason ?? 'Provider 不提供 MCP 运行态' }
    }
    return { state: 'unknown', label: '未知', detail: 'Provider 未返回此 Server 的运行态' }
  }
  const state = LIVE_STATE[value.status]
  if (!state) return { state: 'unknown', label: 'disconnected', detail: 'Provider 返回了未识别的运行态' }
  return {
    state,
    label: LIVE_TEXT[value.status] + (value.tools != null && (value.status === 'connected' || value.status === 'cached') ? ' · ' + value.tools + ' tools' : ''),
    detail: value.status === 'cached'
      ? 'Provider 仅返回缓存中的工具元数据；这不是实时连接证据'
      : value.status === 'disconnected'
        ? 'Provider 已加载配置，但 lazy server 尚未建立连接'
        : '来自当前 Provider 原生运行时'
  }
}

function deriveTest(currentStatus, canManage, readsRuntime, authLimited) {
  if (currentStatus?.testing) return { state: 'pending', label: '测试中', detail: '正在执行 initialize / tools/list…' }
  if (currentStatus?.ok === true) {
    return { state: 'passed', label: '通过', detail: '本次测试成功' + (currentStatus.tools != null ? ' · ' + currentStatus.tools + ' tools' : '') }
  }
  if (currentStatus?.ok === false) {
    return authLimited
      ? { state: 'needs-auth', label: '需认证（测试无 token）', detail: '测试握手没带 OAuth token；真实连接以当前 Provider 原生运行时为准' }
      : { state: 'failed', label: '失败', detail: '本次测试失败' + (currentStatus.error ? ' · ' + currentStatus.error : '') }
  }
  if (canManage) return { state: 'unknown', label: '未测试', detail: '尚未执行单项 initialize / tools/list' }
  if (readsRuntime) return { state: 'unsupported', label: '不支持单项直测', detail: '使用 Provider 原生运行态；Scry 不伪造测试结果' }
  return { state: 'unknown', label: '未知', detail: '测试能力尚未确认' }
}

function deriveAuth(currentStatus, capability, targetId, needsAuth, needsClientRegistration, canAuthenticate) {
  if (currentStatus?.authenticating) return { state: 'pending', label: '认证中', detail: '等待浏览器完成授权…' }
  if (currentStatus?.authOk === true) {
    return currentStatus.authError
      ? { state: 'pending', label: '已授权 · 待确认', detail: '授权流程已完成；运行状态未确认 · ' + currentStatus.authError }
      : { state: 'passed', label: '认证成功', detail: '认证成功，运行状态已刷新' }
  }
  if (currentStatus?.authOk === false || currentStatus?.authError) {
    return { state: 'failed', label: '认证失败', detail: '认证失败' + (currentStatus.authError ? ' · ' + currentStatus.authError : '') }
  }
  if (needsClientRegistration) return { state: 'required', label: '需配置 OAuth Client', detail: '需在 Provider 中配置 OAuth Client ID' }
  if (needsAuth) {
    return { state: 'required', label: '需要认证', detail: canAuthenticate ? '可由 Scry 启动 Provider 原生 OAuth' : '请在 Provider 客户端完成认证' }
  }
  if (capability?.data?.operations) {
    return capability.data.operations.authenticate.includes(targetId)
      ? { state: 'unknown', label: '未执行', detail: '当前没有认证流程结果' }
      : { state: 'unsupported', label: 'Scry 不支持', detail: 'Provider 未声明此目标可由 Scry 发起认证' }
  }
  return { state: 'unknown', label: '未知', detail: 'Provider 未返回认证能力证据' }
}

/* 操作列很窄，内联槽位用短文案，完整证据放 title */
function shortTestLabel(value) {
  if (value.state === 'passed') return '本次测试通过'
  if (value.state === 'pending') return '测试中…'
  if (value.state === 'needs-auth') return '测试无 OAuth token'
  return value.detail.replace('本次测试失败 · ', '测试失败 · ')
}

function RefreshIcon() {
  return (
    <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.96" strokeLinecap="round" />
      <path d="M13.4 2.2v2.9h-2.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  )
}

function EvidenceState({ value, quiet = false }) {
  return (
    <span className={'inventory-state inventory-state--' + value.state + (quiet ? ' inventory-state--quiet' : '')}>
      <i aria-hidden="true" />
      {value.label}
    </span>
  )
}

function InventorySwitch({ checked, disabled, label, title }) {
  return (
    <label className="inventory-switch" title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} readOnly aria-label={label} />
      <span className="inventory-switch__track"><span /></span>
    </label>
  )
}

function InventoryContext({ capability, summary }) {
  return (
    <div className="inventory-context">
      <div className="inventory-context__item">
        <span>Provider</span>
        <strong>{capability.providerId}</strong>
      </div>
      <div className="inventory-context__divider" />
      <div className="inventory-context__item inventory-context__cwd">
        <span>工作目录</span>
        <code title="/Users/baobingjiang/IdeaProjects/rate-native">/Users/baobingjiang/IdeaProjects/rate-native</code>
      </div>
      <div className="inventory-context__spacer" />
      <div className="inventory-context__summary">{summary}</div>
      <div className="inventory-context__time">15:00:34</div>
    </div>
  )
}

function McpEvidenceCell({ label, value }) {
  return (
    <div className="mcp-evidence-cell">
      <span className="mcp-evidence-cell__label">{label}</span>
      <EvidenceState value={value} />
      {value.detail && <small>{value.detail}</small>}
    </div>
  )
}

function McpFleetModal({ slim, capabilityMode, showOffChip, showInlineTest, repeatReadOnlyNote }) {
  const capability = FLEET_CAPABILITY[capabilityMode]
  const canManage = capability.mode === 'manage'
  const readsRuntime = capability.mode === 'read'
  const status = canManage ? FLEET_TEST_STATUS : {}
  const live = FLEET_LIVE
  const mcps = FLEET_MCPS
  const [expanded, setExpanded] = React.useState(slim ? 'arthas' : null)

  React.useEffect(() => {
    setExpanded(canManage ? 'arthas' : null)
  }, [canManage])

  const liveByName = new Map(live.map((item) => [item.name, item]))
  const connectedCount = live.filter((item) => item.status === 'connected').length
  const testEvidenceCount = Object.values(status).filter((item) => item.ok != null || item.testing).length
  const colCount = slim ? 4 : 6

  return (
    <div className={'modal inventory-modal inventory-modal--mcp' + (slim ? ' inventory-modal--slim' : '')} data-screen-label={slim ? 'MCP Fleet 改版后' : 'MCP Fleet 原版'}>
      <div className="modal-head inventory-modal__head">
        <div className="inventory-modal__title">
          <span className="inventory-modal__eyebrow">Capability fleet</span>
          <div className="inventory-modal__title-line">
            <b>MCP</b>
            <span className="inventory-provider">{capability.providerId}</span>
          </div>
          {!slim && <p>配置、Provider 运行态、本次测试与认证是四份独立证据，不折叠成一个模糊的“健康”结论。</p>}
        </div>
        <div className="inventory-modal__head-actions">
          <button className={'modal-refresh' + (readsRuntime ? ' mcp-refresh-all' : '')} type="button" aria-label="检测全部 MCP 运行状态">
            <RefreshIcon />
            {readsRuntime && <span>检测全部</span>}
          </button>
          <button className="modal-x" type="button" aria-label="关闭 MCP"><CloseIcon /></button>
        </div>
      </div>

      <InventoryContext
        capability={capability}
        summary={`${mcps.length} 配置 · ${connectedCount} 已连接 / ${live.length} 运行态 · ${testEvidenceCount} 测试证据`}
      />

      <div className="inventory-state-legend" aria-label="状态语义说明">
        <span>状态语义</span>
        <EvidenceState value={{ state: 'unknown', label: '未知：还没有证据' }} quiet />
        <EvidenceState value={{ state: 'unsupported', label: '不支持：能力不存在' }} quiet />
      </div>

      <div className="modal-body inventory-modal__body inventory-modal__body--mcp">
        <div className="mcp-fleet-wrap">
          <table className={'mcp-fleet' + (slim ? ' mcp-fleet--slim' : '')}>
            <caption className="inventory-sr-only">
              {slim ? 'MCP Fleet：Provider 运行态与认证独立展示' : 'MCP Fleet：配置、运行态、本次测试和认证独立展示'}
            </caption>
            <thead>
              <tr>
                <th scope="col">Server / 来源</th>
                {!slim && <th scope="col">配置</th>}
                <th scope="col">Provider 运行态</th>
                {!slim && <th scope="col">本次测试</th>}
                <th scope="col">认证</th>
                <th scope="col"><span className="inventory-sr-only">操作</span></th>
              </tr>
            </thead>
            {mcps.map((mcp, index) => {
              const targetId = mcp.targetId
              const currentStatus = status[targetId]
              const runtime = liveByName.get(mcp.name)
              const runtimeValue = evidenceForRuntime(runtime, capability)
              const open = expanded === targetId
              const toolsId = 'mcp-tools-' + (slim ? 'slim-' : 'base-') + index
              const authLimited = currentStatus?.ok === false && /40[13]/.test(currentStatus.error ?? '')
              const canAuthenticate = capability.data.operations.authenticate.includes(targetId)
              const needsAuth = runtime?.status === 'needs-auth'
              const needsClientRegistration = runtime?.status === 'needs-client-registration'
              const testValue = deriveTest(currentStatus, canManage, readsRuntime, authLimited)
              const authValue = deriveAuth(currentStatus, capability, targetId, needsAuth, needsClientRegistration, canAuthenticate)
              const hasTestEvidence = Boolean(currentStatus?.testing || currentStatus?.ok != null)
              const configValue = {
                state: mcp.enabled ? 'enabled' : 'disabled',
                label: mcp.enabled ? '已启用' : '已关闭',
                detail: canManage ? '配置文件中的当前值 · Scry 可管理' : '配置文件中的当前值 · Scry 只读'
              }

              return (
                <tbody key={mcp.scope + ':' + targetId}>
                  <tr className={'mcp-fleet__row mcp-fleet__row--' + runtimeValue.state}>
                    <th scope="row">
                      <div className="mcp-server-cell">
                        <div className="mcp-server-cell__name">
                          <strong>{mcp.name}</strong>
                          <span>{mcp.transport}</span>
                          <span className={'inventory-scope inventory-scope--' + scopeClass(mcp.scope)} title={MCP_SCOPE_LABEL[mcp.scope] ?? mcp.scope}>
                            {scopeShortLabel(mcp.scope)}
                          </span>
                          {slim && showOffChip && !mcp.enabled && (
                            <span className="inventory-scope inventory-scope--off" title={configValue.detail}>已关闭</span>
                          )}
                        </div>
                        <code title={mcp.detail}>{mcp.detail}</code>
                        {currentStatus?.ok && currentStatus.toolNames && currentStatus.toolNames.length > 0 && (
                          <button
                            className="mcp-tools-toggle"
                            type="button"
                            aria-expanded={open}
                            aria-controls={toolsId}
                            onClick={() => setExpanded(open ? null : targetId)}
                          >
                            <span aria-hidden="true">{open ? '−' : '+'}</span>
                            {currentStatus.toolNames.length} tools
                          </button>
                        )}
                      </div>
                    </th>

                    {!slim && (
                      <td>
                        <div className="mcp-evidence-cell mcp-evidence-cell--config">
                          <span className="mcp-evidence-cell__label">配置</span>
                          <div className="mcp-config-toggle">
                            <InventorySwitch
                              checked={mcp.enabled}
                              disabled={!canManage}
                              label={(mcp.enabled ? '关闭' : '启用') + ' MCP ' + mcp.name}
                              title={configValue.detail}
                            />
                            <EvidenceState value={configValue} quiet />
                          </div>
                          <small>{configValue.detail}</small>
                        </div>
                      </td>
                    )}

                    <td><McpEvidenceCell label="运行态" value={runtimeValue} /></td>
                    {!slim && <td><McpEvidenceCell label="测试" value={testValue} /></td>}
                    <td><McpEvidenceCell label="认证" value={authValue} /></td>

                    <td className="mcp-fleet__actions">
                      {canManage && (
                        <button className="mcp-test" type="button" disabled={currentStatus?.testing}>
                          {currentStatus?.testing ? <><span className="spinner" /> 测试中…</> : '测试连接'}
                        </button>
                      )}
                      {needsAuth && canAuthenticate && (
                        <button className="mcp-test" type="button" aria-label={'重新认证 MCP ' + mcp.name}>重新认证</button>
                      )}
                      {slim && showInlineTest && hasTestEvidence && (
                        <div className={'mcp-test-inline mcp-test-inline--' + testValue.state} title={testValue.detail}>
                          <i aria-hidden="true" />
                          <span>{shortTestLabel(testValue)}</span>
                        </div>
                      )}
                      {needsAuth && !canAuthenticate ? (
                        <small>请在 Provider 客户端完成认证</small>
                      ) : !canManage && (!slim || repeatReadOnlyNote) ? (
                        <small>{readsRuntime ? '运行态只读' : '操作能力未知'}</small>
                      ) : null}
                    </td>
                  </tr>

                  {open && currentStatus?.toolNames && (
                    <tr className="mcp-tools-row">
                      <td colSpan={colCount}>
                        <div id={toolsId} className="mcp-tools-drawer">
                          <div><strong>本次测试返回的工具</strong><small>来自 initialize / tools/list</small></div>
                          <div className="mcp-tools-drawer__list">
                            {currentStatus.toolNames.map((tool) => <code key={tool}>{tool}</code>)}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              )
            })}
          </table>
        </div>
      </div>

      <div className="modal-foot inventory-footnote">
        <span>证据边界</span>
        <p>支持认证的远程 MCP 可直接在 Scry 完成 Provider 原生 OAuth；凭据由 Provider 保存在本机（OpenCode 使用 Scry 私有目录），不会上传。</p>
      </div>
    </div>
  )
}

function Toggle({ label, options, value, onChange }) {
  return (
    <div className="knob">
      <span>{label}</span>
      <div className="knob__seg">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={option.value === value ? 'active' : ''}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function App() {
  const [variant, setVariant] = React.useState('slim')
  const [capabilityMode, setCapabilityMode] = React.useState('read')
  const [theme, setTheme] = React.useState('light')
  const [showOffChip, setShowOffChip] = React.useState(true)
  const [showInlineTest, setShowInlineTest] = React.useState(true)
  const [repeatReadOnlyNote, setRepeatReadOnlyNote] = React.useState(false)
  const [tweaksOpen, setTweaksOpen] = React.useState(true)

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
  }, [theme])

  const slim = variant === 'slim'

  return (
    <div className="page">
      <div className="page__bar">
        <div className="page__id">
          <strong>Scry · MCP Fleet</strong>
          <span>{slim ? '改版后 · 4 列' : '原版 · 6 列'}</span>
        </div>
        <button className="tweaks-btn" type="button" onClick={() => setTweaksOpen(!tweaksOpen)}>
          {tweaksOpen ? '隐藏 Tweaks' : 'Tweaks'}
        </button>
      </div>

      {tweaksOpen && (
        <div className="knobs">
          <Toggle
            label="版本"
            value={variant}
            onChange={setVariant}
            options={[{ value: 'slim', label: '改版后' }, { value: 'base', label: '原版' }]}
          />
          <Toggle
            label="Provider 能力"
            value={capabilityMode}
            onChange={setCapabilityMode}
            options={[{ value: 'read', label: '只读 (qoder)' }, { value: 'manage', label: '可管理 (claude)' }]}
          />
          <Toggle
            label="主题"
            value={theme}
            onChange={setTheme}
            options={[{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]}
          />
          <Toggle
            label="已关闭标记"
            value={showOffChip ? 'on' : 'off'}
            onChange={(v) => setShowOffChip(v === 'on')}
            options={[{ value: 'on', label: '显示' }, { value: 'off', label: '不显示' }]}
          />
          <Toggle
            label="测试结果落点"
            value={showInlineTest ? 'on' : 'off'}
            onChange={(v) => setShowInlineTest(v === 'on')}
            options={[{ value: 'on', label: '操作列内联' }, { value: 'off', label: '仅工具抽屉' }]}
          />
          <Toggle
            label="只读标注"
            value={repeatReadOnlyNote ? 'row' : 'foot'}
            onChange={(v) => setRepeatReadOnlyNote(v === 'row')}
            options={[{ value: 'foot', label: '仅表尾' }, { value: 'row', label: '每行' }]}
          />
        </div>
      )}

      <div className="stage">
        <div className="modal-overlay">
          <McpFleetModal
            key={variant}
            slim={slim}
            capabilityMode={capabilityMode}
            showOffChip={showOffChip}
            showInlineTest={showInlineTest}
            repeatReadOnlyNote={repeatReadOnlyNote}
          />
        </div>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
