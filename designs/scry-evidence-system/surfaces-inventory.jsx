;(() => {
  const { useEffect, useMemo, useRef, useState } = React

  const FALLBACK_INVENTORY = {
    context: {
      provider: 'Claude Code',
      cwd: '~/IdeaProjects/vibecoding/scry',
      capturedAt: '示例快照 · 10:42:18'
    },
    skills: [
      {
        id: 'scry-provider-regression',
        name: 'scry-provider-regression',
        description: '验证四个 Provider 的会话、用量、Skill、MCP 与恢复链路。',
        scope: 'project',
        source: '.claude/skills/scry-provider-regression/SKILL.md',
        enabled: true,
        state: 'ready'
      },
      {
        id: 'baoyu-design',
        name: 'baoyu-design',
        description: '创建高完成度 HTML 设计原型与可交互产品表面。',
        scope: 'project',
        source: '.claude/skills/baoyu-design/SKILL.md',
        enabled: true,
        state: 'pending'
      },
      {
        id: 'validate-scry-rate-workflow',
        name: 'validate-scry-rate-workflow',
        description: '对指定 Agent 执行两轮真实 rate workflow 验收。',
        scope: 'project',
        source: '.claude/skills/validate-scry-rate-workflow/SKILL.md',
        enabled: false,
        state: 'ready'
      },
      {
        id: 'emil-design-eng',
        name: 'emil-design-eng',
        description: '以克制的动效、排版和交互细节打磨界面。',
        scope: 'user',
        source: '~/.claude/skills/emil-design-eng/SKILL.md',
        enabled: true,
        state: 'ready'
      },
      {
        id: 'legacy-context-export',
        name: 'legacy-context-export',
        description: '旧版上下文导出 Skill；当前目录不可读。',
        scope: 'user',
        source: '~/.claude/skills/legacy-context-export/SKILL.md',
        enabled: false,
        state: 'error',
        reason: '目录不可读',
        demoFailure: true
      },
      {
        id: 'provider-command-index',
        name: 'provider-command-index',
        description: 'Provider 仅暴露命令索引，不提供持久化开关。',
        scope: 'user',
        source: 'Provider runtime',
        enabled: true,
        state: 'unsupported',
        reason: '当前 Provider 不支持管理此项',
        manageable: false
      }
    ],
    mcps: [
      {
        id: 'notion',
        name: 'notion',
        transport: 'HTTP',
        scope: 'project',
        source: '.mcp.json',
        config: { state: 'enabled', manageable: true },
        runtime: { state: 'connected', detail: 'notion-mcp · v1.8.2' },
        test: { state: 'passed', detail: 'initialize + tools/list · 184 ms' },
        auth: { state: 'ready', detail: 'OAuth token available' },
        tools: ['search', 'fetch', 'create-page', 'update-page']
      },
      {
        id: 'filesystem',
        name: 'filesystem',
        transport: 'stdio',
        scope: 'project',
        source: '.mcp.json',
        config: { state: 'enabled', manageable: true },
        runtime: { state: 'connected', detail: 'pid 48217' },
        test: { state: 'unsupported', detail: 'Provider 不暴露单项直测' },
        auth: { state: 'unsupported', detail: 'stdio server 无认证流程' },
        tools: ['read_file', 'list_directory', 'search_files']
      },
      {
        id: 'github',
        name: 'github',
        transport: 'HTTP',
        scope: 'user',
        source: '~/.claude.json',
        config: { state: 'enabled', manageable: true },
        runtime: { state: 'needs-auth', detail: 'Provider 请求重新认证' },
        test: { state: 'failed', detail: '401 · 测试未携带 Provider token' },
        auth: { state: 'required', detail: '在 Claude Code 中完成认证' },
        tools: []
      },
      {
        id: 'sentry',
        name: 'sentry',
        transport: 'SSE',
        scope: 'user',
        source: '~/.claude.json',
        config: { state: 'disabled', manageable: true },
        runtime: { state: 'disabled', detail: '配置关闭，未启动' },
        test: { state: 'unknown', detail: '尚未执行本次测试' },
        auth: { state: 'unknown', detail: '服务未启动，无法判断' },
        tools: []
      },
      {
        id: 'team-context',
        name: 'team-context',
        transport: 'HTTP',
        scope: 'project',
        source: 'Provider runtime',
        config: { state: 'unknown', manageable: false, detail: '未返回配置来源' },
        runtime: { state: 'pending', detail: 'Provider 尚未收敛运行状态' },
        test: { state: 'unknown', detail: '等待 runtime 初始化' },
        auth: { state: 'unknown', detail: '等待 runtime 初始化' },
        tools: []
      }
    ]
  }

  const STATE_LABELS = {
    ready: '就绪',
    enabled: '已启用',
    disabled: '已关闭',
    pending: '处理中',
    error: '错误',
    connected: '已连接',
    'needs-auth': '需认证',
    passed: '通过',
    failed: '失败',
    required: '需要认证',
    unknown: '未知',
    unsupported: '不支持'
  }

  function resolveInventoryData(data) {
    const shared = window.sampleData?.inventory ?? window.sampleData ?? {}
    return {
      context: data?.context ?? shared.context ?? FALLBACK_INVENTORY.context,
      skills: data?.skills ?? shared.skills ?? FALLBACK_INVENTORY.skills,
      mcps: data?.mcps ?? shared.mcps ?? FALLBACK_INVENTORY.mcps
    }
  }

  function SemanticState({ state, label, detail, quiet = false }) {
    const text = label ?? STATE_LABELS[state] ?? state
    return (
      <span
        className={`inventory-state inventory-state--${state}${quiet ? ' inventory-state--quiet' : ''}`}
        title={detail || text}
        data-semantic-state={state}
      >
        <i aria-hidden="true" />
        <span>{text}</span>
      </span>
    )
  }

  function SampleBadge() {
    return <span className="sample-badge">{window.sampleData?.meta?.live ? '本机真实证据 · 只读' : '交互原型 · 示例数据'}</span>
  }

  function ContextBar({ context, kind, resultSummary }) {
    return (
      <div className="inventory-context" aria-label={`${kind} 查询上下文`}>
        <div className="inventory-context__item">
          <span className="inventory-context__label">Provider</span>
          <strong>{context.provider}</strong>
        </div>
        <div className="inventory-context__divider" aria-hidden="true" />
        <div className="inventory-context__item inventory-context__cwd">
          <span className="inventory-context__label">工作目录</span>
          <code title={context.cwd}>{context.cwd}</code>
        </div>
        <div className="inventory-context__spacer" />
        <span className="inventory-context__summary">{resultSummary}</span>
        <span className="inventory-context__time">{context.capturedAt}</span>
      </div>
    )
  }

  function InventoryTitle({ id, eyebrow, title, description, actions }) {
    return (
      <header className="inventory-title">
        <div className="inventory-title__copy">
          <div className="inventory-title__eyebrow">
            <span>{eyebrow}</span>
            <SampleBadge />
          </div>
          <h1 id={id}>{title}</h1>
          <p>{description}</p>
        </div>
        {actions && <div className="inventory-title__actions">{actions}</div>}
      </header>
    )
  }

  function Toggle({ checked, disabled, pending, label, onChange }) {
    return (
      <label className={`inventory-switch${pending ? ' is-pending' : ''}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled || pending}
          aria-label={label}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="inventory-switch__track" aria-hidden="true">
          <span className="inventory-switch__thumb" />
        </span>
      </label>
    )
  }

  function ScopeMark({ scope }) {
    return (
      <span className={`scope-mark scope-mark--${scope}`}>
        {scope === 'project' ? '项目' : scope === 'user' ? '用户' : '观测'}
      </span>
    )
  }

  function SkillsModalContent({ data, onClose }) {
    const inventory = resolveInventoryData(data)
    const live = window.sampleData?.meta?.live
    const [query, setQuery] = useState('')
    const [rows, setRows] = useState(() => inventory.skills.map((skill) => ({ ...skill })))
    const timers = useRef(new Set())

    useEffect(() => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer))
    }, [])

    const normalizedQuery = query.trim().toLowerCase()
    const filtered = useMemo(() => {
      if (!normalizedQuery) return rows
      return rows.filter((skill) => [skill.name, skill.description, skill.source, skill.scope]
        .some((value) => String(value).toLowerCase().includes(normalizedQuery)))
    }, [normalizedQuery, rows])

    const groups = [
      { id: 'project', label: '项目 Skills', hint: '随当前仓库生效' },
      { id: 'user', label: '用户 Skills', hint: '来自用户目录，可跨项目复用' },
      { id: 'unknown', label: '观测到的 Skills', hint: '账本没有 scope 与配置状态' }
    ]

    function toggleSkill(skill, enabled) {
      if (skill.manageable === false) return
      const previous = skill.enabled
      setRows((current) => current.map((row) => row.id === skill.id
        ? { ...row, state: 'pending', reason: enabled ? '正在启用…' : '正在关闭…' }
        : row))

      const timer = window.setTimeout(() => {
        setRows((current) => current.map((row) => {
          if (row.id !== skill.id) return row
          if (row.demoFailure) {
            return { ...row, enabled: previous, state: 'error', reason: '目录不可读；示例操作未写入' }
          }
          return { ...row, enabled, state: 'ready', reason: '' }
        }))
        timers.current.delete(timer)
      }, 620)
      timers.current.add(timer)
    }

    const enabledCount = rows.filter((skill) => skill.enabled).length

    return (
      <section className="inventory-surface skills-surface" aria-labelledby="skills-surface-title" data-sample-data={!live}>
        <InventoryTitle
          id="skills-surface-title"
          eyebrow="Capability inventory"
          title="Skills"
          description={live ? '仅列出当前 trace archive 中真实观测到的 Skill 调用；SQLite 不保存配置开关，因此全部保持只读。' : '查看当前 Provider 在这个工作目录里实际发现了什么，以及 Scry 是否有权管理它。'}
          actions={onClose && (
            <button className="icon-button" type="button" onClick={onClose} aria-label="关闭 Skills">
              <span aria-hidden="true">×</span>
            </button>
          )}
        />

        <ContextBar
          context={inventory.context}
          kind="Skills"
          resultSummary={live
            ? `${rows.length} 个已观测 Skill · 配置状态未知`
            : `${enabledCount} 启用 · ${rows.length - enabledCount} 关闭/不可管理`}
        />

        <div className="inventory-toolbar">
          <label className="inventory-search">
            <span className="inventory-search__label">搜索</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="名称、描述、来源或 scope"
              aria-label="搜索 Skills"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="清空搜索">清除</button>
            )}
          </label>
          <div className="inventory-toolbar__count" aria-live="polite">
            显示 {filtered.length} / {rows.length}
          </div>
        </div>

        <div className="skill-groups">
          {groups.map((group) => {
            const skills = filtered.filter((skill) => skill.scope === group.id)
            if (skills.length === 0) return null
            return (
              <section className="skill-group" key={group.id} aria-labelledby={`skills-${group.id}`}>
                <div className="skill-group__header">
                  <div>
                    <h2 id={`skills-${group.id}`}>{group.label}</h2>
                    <p>{group.hint}</p>
                  </div>
                  <span>{skills.length}</span>
                </div>

                <div className="skill-ledger">
                  {skills.map((skill) => {
                    const pending = skill.state === 'pending'
                    const status = pending
                      ? { state: 'pending', label: skill.reason || '读取中' }
                      : skill.state === 'error'
                        ? { state: 'error', label: skill.reason || '读取失败' }
                        : skill.state === 'unsupported'
                          ? { state: 'unsupported', label: '不可管理' }
                          : { state: skill.enabled ? 'enabled' : 'disabled' }

                    return (
                      <article className={`skill-ledger__row skill-ledger__row--${skill.state}`} key={skill.id}>
                        <Toggle
                          checked={skill.enabled}
                          disabled={skill.manageable === false}
                          pending={pending}
                          label={`${skill.enabled ? '关闭' : '启用'} Skill ${skill.name}`}
                          onChange={(enabled) => toggleSkill(skill, enabled)}
                        />
                        <div className="skill-ledger__main">
                          <div className="skill-ledger__name-line">
                            <strong>{skill.name}</strong>
                            <ScopeMark scope={skill.scope} />
                          </div>
                          <p>{skill.description}</p>
                          <div className="skill-ledger__source">
                            <span>来源</span>
                            <code title={skill.source}>{skill.source}</code>
                          </div>
                        </div>
                        <div className="skill-ledger__status">
                          <span className="skill-ledger__status-label">当前状态</span>
                          <SemanticState {...status} />
                        </div>
                      </article>
                    )
                  })}
                </div>
              </section>
            )
          })}

          {filtered.length === 0 && (
            <div className="inventory-empty" role="status">
              <strong>没有匹配的 Skill</strong>
              <p>{live ? '当前会话没有观测到 Skill 调用。' : '换一个关键词，或清空搜索查看全部示例条目。'}</p>
              <button type="button" onClick={() => setQuery('')}>清空搜索</button>
            </div>
          )}
        </div>

        <footer className="inventory-footnote">
          <span>{live ? '真实调用证据' : '示例数据'}</span>
          <p>{live ? '“观测到调用”不等于“当前已启用”；配置与管理状态不在 SQLite / archive 中。' : '“启用”只表示配置开关；“处理中”与“错误”保留真实中间态，不会被折叠成已启用。'}</p>
        </footer>
      </section>
    )
  }

  function McpStateCell({ label, value }) {
    return (
      <div className="mcp-state-cell">
        <span className="mcp-state-cell__label">{label}</span>
        <SemanticState state={value.state} />
        {value.detail && <small>{value.detail}</small>}
      </div>
    )
  }

  function McpConfigCell({ server, onToggle }) {
    const canToggle = server.config.manageable !== false && server.config.state !== 'unknown'
    const enabled = server.config.state === 'enabled' || server.config.state === 'pending'

    if (server.config.state === 'unknown') {
      return <McpStateCell label="配置" value={server.config} />
    }

    return (
      <div className="mcp-state-cell mcp-state-cell--config">
        <span className="mcp-state-cell__label">配置</span>
        <div className="mcp-config-toggle">
          <Toggle
            checked={enabled}
            disabled={!canToggle}
            pending={server.config.state === 'pending'}
            label={`${enabled ? '关闭' : '启用'} MCP ${server.name}`}
            onChange={onToggle}
          />
          <SemanticState state={server.config.state} quiet />
        </div>
        {server.config.detail && <small>{server.config.detail}</small>}
      </div>
    )
  }

  function McpModalContent({ data, onClose }) {
    const inventory = resolveInventoryData(data)
    const live = window.sampleData?.meta?.live
    const [servers, setServers] = useState(() => inventory.mcps.map((server) => ({
      ...server,
      config: { ...server.config },
      runtime: { ...server.runtime },
      test: { ...server.test },
      auth: { ...server.auth },
      tools: [...(server.tools || [])]
    })))
    const [expanded, setExpanded] = useState(null)
    const [notice, setNotice] = useState('')
    const timers = useRef(new Set())

    useEffect(() => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer))
    }, [])

    function updateServer(id, updater) {
      setServers((current) => current.map((server) => server.id === id ? updater(server) : server))
    }

    function toggleServer(server, enabled) {
      if (server.config.manageable === false) return
      updateServer(server.id, (row) => ({
        ...row,
        config: { ...row.config, state: 'pending', detail: enabled ? '正在写入启用配置…' : '正在写入关闭配置…' }
      }))

      const timer = window.setTimeout(() => {
        updateServer(server.id, (row) => ({
          ...row,
          config: { ...row.config, state: enabled ? 'enabled' : 'disabled', detail: '' },
          runtime: enabled
            ? { state: 'pending', detail: '等待 Provider 刷新运行态' }
            : { state: 'disabled', detail: '配置关闭，未启动' },
          test: enabled ? row.test : { state: 'unknown', detail: '配置关闭，未执行测试' }
        }))
        timers.current.delete(timer)
      }, 620)
      timers.current.add(timer)
    }

    function testServer(server) {
      if (server.runtime.state === 'needs-auth') {
        setNotice(`${server.name} 的认证由 ${inventory.context.provider} 客户端完成；Scry 不伪造认证成功。`)
        return
      }

      updateServer(server.id, (row) => ({
        ...row,
        test: { state: 'pending', detail: '正在执行 initialize / tools/list…' }
      }))
      setNotice(`正在单项检测 ${server.name}（示例交互）`)

      const timer = window.setTimeout(() => {
        updateServer(server.id, (row) => ({
          ...row,
          test: row.runtime.state === 'connected'
            ? { state: 'passed', detail: `initialize + tools/list · ${126 + row.name.length * 7} ms` }
            : { state: 'failed', detail: 'runtime 未连接，未取得 tools/list' }
        }))
        setNotice(`${server.name} 的示例检测已完成。`)
        timers.current.delete(timer)
      }, 760)
      timers.current.add(timer)
    }

    function primaryAction(server) {
      if (server.auth.state === 'required' || server.runtime.state === 'needs-auth') {
        return { label: '查看认证路径', action: () => testServer(server) }
      }
      if (server.config.state === 'disabled') {
        return { label: '配置已关闭', disabled: true, action: () => {} }
      }
      if (server.test.state === 'unsupported') {
        return { label: '不支持单测', disabled: true, action: () => {} }
      }
      if (server.config.state === 'unknown' || server.runtime.state === 'pending') {
        return { label: '等待运行态', disabled: true, action: () => {} }
      }
      return {
        label: server.test.state === 'pending' ? '检测中…' : '测试连接',
        disabled: server.test.state === 'pending',
        action: () => testServer(server)
      }
    }

    const connectedCount = servers.filter((server) => server.runtime.state === 'connected').length
    const issueCount = servers.filter((server) => ['failed', 'needs-auth'].includes(server.runtime.state)).length

    return (
      <section className="inventory-surface mcp-surface" aria-labelledby="mcp-surface-title" data-sample-data={!live}>
        <InventoryTitle
          id="mcp-surface-title"
          eyebrow="Capability fleet"
          title="MCP"
          description={live ? 'Fleet 仅列出当前会话真实发生过的 MCP 调用；配置、当前运行态、测试和认证未落库，明确保持未知。' : '同一张 Fleet 表里对齐配置、运行态、本次测试和认证证据，但不把它们混成一个“健康”结论。'}
          actions={onClose && (
            <button className="icon-button" type="button" onClick={onClose} aria-label="关闭 MCP">
              <span aria-hidden="true">×</span>
            </button>
          )}
        />

        <ContextBar
          context={inventory.context}
          kind="MCP"
          resultSummary={live
            ? `${servers.length} 个已观测 Server · 当前运行态未知`
            : `${connectedCount} 已连接 · ${issueCount} 需处理 · ${servers.length} 配置项`}
        />

        <div className="mcp-legend" aria-label="状态语义说明">
          <span>状态语义</span>
          <SemanticState state="unknown" label="未知：还没有证据" quiet />
          <SemanticState state="unsupported" label="不支持：能力不存在" quiet />
        </div>

        {notice && (
          <div className="inventory-notice" role="status" aria-live="polite">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice('')}>收起</button>
          </div>
        )}

        <div className="mcp-fleet-wrap">
          <table className="mcp-fleet">
            <caption className="sr-only">MCP Fleet {live ? '真实调用证据' : '示例数据'}</caption>
            <thead>
              <tr>
                <th scope="col">Server / 来源</th>
                <th scope="col">配置</th>
                <th scope="col">Provider 运行态</th>
                <th scope="col">本次测试</th>
                <th scope="col">认证</th>
                <th scope="col"><span className="sr-only">单项动作</span></th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => {
                const open = expanded === server.id
                const action = primaryAction(server)
                const toolsId = `mcp-tools-${server.id}`
                return (
                  <React.Fragment key={server.id}>
                    <tr className={`mcp-fleet__row mcp-fleet__row--${server.runtime.state}`}>
                      <th scope="row">
                        <div className="mcp-server-cell">
                          <div className="mcp-server-cell__name">
                            <strong>{server.name}</strong>
                            <span>{server.transport}</span>
                            <ScopeMark scope={server.scope} />
                          </div>
                          <code title={server.source}>{server.source}</code>
                          {server.tools.length > 0 && (
                            <button
                              className="mcp-tools-toggle"
                              type="button"
                              aria-expanded={open}
                              aria-controls={toolsId}
                              onClick={() => setExpanded(open ? null : server.id)}
                            >
                              <span aria-hidden="true">{open ? '−' : '+'}</span>
                              {server.tools.length} tools
                            </button>
                          )}
                        </div>
                      </th>
                      <td>
                        <McpConfigCell server={server} onToggle={(enabled) => toggleServer(server, enabled)} />
                      </td>
                      <td><McpStateCell label="运行态" value={server.runtime} /></td>
                      <td><McpStateCell label="测试" value={server.test} /></td>
                      <td><McpStateCell label="认证" value={server.auth} /></td>
                      <td className="mcp-fleet__action">
                        <button
                          className="secondary-button secondary-button--compact"
                          type="button"
                          disabled={action.disabled}
                          onClick={action.action}
                        >
                          {action.label}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="mcp-tools-row">
                        <td colSpan="6">
                          <div id={toolsId} className="mcp-tools-drawer">
                            <div>
                              <span className="mcp-tools-drawer__label">Provider 返回的工具</span>
                              <small>{live ? '本会话实际调用名' : '示例 tools/list'}</small>
                            </div>
                            <div className="mcp-tools-drawer__list">
                              {server.tools.map((tool) => <code key={tool}>{tool}</code>)}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>

        {servers.length === 0 && <div className="inventory-empty"><strong>当前会话没有 MCP 调用证据</strong><p>这不是“未配置”；SQLite / archive 只能证明实际发生过的调用。</p></div>}
        <footer className="inventory-footnote">
          <span>{live ? '真实调用证据' : '示例数据'}</span>
          <p>{live ? '观测到历史调用不等于当前已连接；运行态、认证与 tools/list 必须由 Provider 客户端实时提供。' : '配置开关不等于已连接；测试失败也不覆盖 Provider 的原生运行态。重新认证与重连仍交给 Provider 客户端。'}</p>
        </footer>
      </section>
    )
  }

  Object.assign(window, {
    SkillsModalContent,
    McpModalContent
  })
})()
