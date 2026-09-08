const { useEffect, useState } = React

const SKILLS = [
  { name: 'agent-reach', scope: 'project', description: '在用户需要联网调研、搜索或查找资料时启动多来源检索。', source: '.agents/skills/agent-reach/SKILL.md' },
  { name: 'english-daily-coach', scope: 'project', description: '为 Obsidian Alpha 计划提供每日英语学习陪练。', source: '.agents/skills/english-daily-coach/SKILL.md' },
  { name: 'humanize-writing', scope: 'project', description: '润色中英文内容，去除模板化表达并保留作者原有语气。', source: '.agents/skills/humanize-writing/SKILL.md' },
  { name: 'list-refresh', scope: 'project', description: '扫描推荐清单、补充近期更新并校验每个来源。', source: '.agents/skills/list-refresh/SKILL.md' },
  { name: 'markdown-to-html', scope: 'project', description: '把 Markdown 转为高品质单文件 HTML，并按内容匹配版式。', source: '.agents/skills/markdown-to-html/SKILL.md' },
  { name: 'markitdown-convert', scope: 'project', description: '把 URL、PDF、Office、图片和音频转换为干净 Markdown。', source: '.agents/skills/markitdown-convert/SKILL.md' },
  { name: 'skill-creator', scope: 'user', description: '创建或更新可复用的 Agent Skill。', source: '~/.qoder/skills/skill-creator/SKILL.md' }
]

const MCPS = [
  {
    name: 'arthas',
    transport: 'HTTP',
    scope: 'project',
    url: 'https://mcp.alibaba-inc.com/arthas/mcp',
    runtime: { kind: 'ok', text: '已连接', detail: '来自当前 Provider 原生运行时' },
    toolNames: ['arthas_dashboard', 'arthas_thread', 'arthas_jvm', 'arthas_sc', 'arthas_sm', 'arthas_jad', 'arthas_watch', 'arthas_trace', 'arthas_stack', 'arthas_tt', 'arthas_monitor', 'arthas_profiler', 'arthas_heapdump', 'arthas_ognl', 'arthas_vmtool']
  },
  { name: 'arthas-attach', transport: 'HTTP', scope: 'project', url: 'https://mcp.alibaba-inc.com/arthas-attach/mcp', runtime: { kind: 'ok', text: '已连接', detail: '来自当前 Provider 原生运行时' } },
  { name: 'upp-hub', transport: 'HTTP', scope: 'project', url: 'https://mcp.alibaba-inc.com/upp-hub/mcp', runtime: { kind: 'ok', text: '已连接', detail: '来自当前 Provider 原生运行时' } },
  { name: '3eye-device-control', transport: 'HTTP', scope: 'project', url: 'https://3eye.alibaba-inc.com/mcp/device', runtime: { kind: 'ok', text: '已连接', detail: '来自当前 Provider 原生运行时' } },
  { name: 'ai_native_trace_report', transport: 'HTTP', scope: 'project', url: 'https://ai-native-trace-report.sh-mw-mcp.alibaba-inc.com/mcp', runtime: { kind: 'ok', text: '已连接', detail: '来自当前 Provider 原生运行时' } },
  { name: 'chrome-devtools', transport: 'HTTP', scope: 'project', url: 'https://devtools.alibaba-inc.com/mcp', runtime: { kind: 'warn', text: '需要认证', detail: 'Provider 已加载配置，但尚未建立连接' }, action: 'authenticate' },
  { name: 'legacy-files', transport: 'STDIO', scope: 'user', url: 'npx -y @modelcontextprotocol/server-filesystem', runtime: { kind: 'disabled', text: '已关闭', detail: '配置文件中的当前值' } }
]

const SCOPES = [
  { id: 'project', label: '项目' },
  { id: 'user', label: '用户' }
]

function State({ value }) {
  return <span className={'state ' + value.kind} title={value.detail}>{value.text}</span>
}

function initialView() {
  return new URLSearchParams(window.location.search).get('view') === 'mcp' ? 'mcp' : 'skills'
}

function initialScope() {
  return new URLSearchParams(window.location.search).get('scope') === 'user' ? 'user' : 'project'
}

function initialExpanded() {
  const target = new URLSearchParams(window.location.search).get('expand')
  return target ? `mcp:${target}` : null
}

function App() {
  const [view, setView] = useState(initialView)
  const [scope, setScope] = useState(initialScope)
  const [expanded, setExpanded] = useState(initialExpanded)
  const [refreshing, setRefreshing] = useState(false)
  const [toast, setToast] = useState('')

  useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(''), 1800)
    return () => window.clearTimeout(timer)
  }, [toast])

  const filteredSkills = SKILLS.filter((skill) => skill.scope === scope)
  const filteredMcps = MCPS.filter((mcp) => mcp.scope === scope)

  function selectView(nextView) {
    setView(nextView)
    setScope('project')
    setExpanded(null)
  }

  function refresh() {
    if (refreshing) return
    setRefreshing(true)
    window.setTimeout(() => {
      setRefreshing(false)
      setToast(view === 'skills' ? 'Skill 清单已刷新' : 'MCP 运行态已刷新')
    }, 700)
  }

  function toggleDetails(id) {
    setExpanded((current) => current === id ? null : id)
  }

  return (
    <div className="stage">
      <section className={'window ' + (view === 'skills' ? 'skills-view' : 'mcp-view')} role="dialog" aria-modal="true" aria-label="Scry Capabilities" data-screen-label={view === 'skills' ? 'Skills 简化方案' : 'MCP 简化方案'}>
        <header className="app-head">
          <nav className="view-tabs" aria-label="能力类型">
            <button type="button" className={view === 'skills' ? 'active' : ''} onClick={() => selectView('skills')}>Skills</button>
            <button type="button" className={view === 'mcp' ? 'active' : ''} onClick={() => selectView('mcp')}>MCP</button>
          </nav>
          <span className="head-spacer"></span>
          <div className="head-actions">
            {view === 'mcp' && (
              <button type="button" className={'icon-button refresh' + (refreshing ? ' is-loading' : '')} onClick={refresh} aria-label="刷新 MCP 运行态">
                <span className="refresh-mark" aria-hidden="true">↻</span>
                <span>{refreshing ? '检测中' : '刷新'}</span>
              </button>
            )}
            <button type="button" className="icon-button" aria-label="关闭" onClick={() => setToast('原型中保留关闭入口')}>×</button>
          </div>
        </header>

        <div className="toolbar">
          <div className="scope-tabs" role="tablist" aria-label={view === 'skills' ? 'Skill 来源' : 'MCP 来源'}>
            {SCOPES.map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={scope === item.id} className={scope === item.id ? 'active' : ''} onClick={() => { setScope(item.id); setExpanded(null) }}>
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {view === 'skills' ? (
          <section className="list skill-list" role="tabpanel">
            {filteredSkills.map((skill) => (
              <article className="row" key={`${skill.scope}:${skill.name}`}>
                <div className="skill-row">
                  <div className="skill-main">
                    <div className="name-line">
                      <strong>{skill.name}</strong>
                    </div>
                    <p className="description" title={skill.description}>{skill.description}</p>
                  </div>
                </div>
              </article>
            ))}
            {filteredSkills.length === 0 && <div className="empty"><div><strong>当前来源没有 Skill</strong><p>切换其他来源查看。</p></div></div>}
          </section>
        ) : (
          <section className="list">
            {filteredMcps.map((mcp) => {
              const open = expanded === `mcp:${mcp.name}`
              const expandable = mcp.runtime.kind === 'ok'
              return (
                <article className="row" key={mcp.name}>
                  <div className="mcp-row">
                    <div className="server-main">
                      <div className="name-line">
                        {expandable ? (
                          <button type="button" className="server-toggle" aria-expanded={open} onClick={() => toggleDetails(`mcp:${mcp.name}`)}>
                            <span aria-hidden="true">{open ? '⌄' : '›'}</span>
                            <strong>{mcp.name}</strong>
                          </button>
                        ) : (
                          <strong className="server-name-static">{mcp.name}</strong>
                        )}
                        <span className="transport">{mcp.transport}</span>
                      </div>
                      <code className="server-url" title={mcp.url}>{mcp.url}</code>
                    </div>
                    <div className="evidence runtime">
                      {mcp.action ? (
                        <button type="button" className="auth-state" title={mcp.runtime.detail} onClick={() => setToast(`${mcp.name}：已打开 Provider 原生认证`)}>需要认证</button>
                      ) : (
                        <State value={mcp.runtime} />
                      )}
                    </div>
                  </div>
                  {expandable && (
                    <div className={'details tools-details ' + (open ? 'open' : '')}>
                      <div className="details-inner">
                        {mcp.toolNames?.length ? (
                          <div className="tool-list">{mcp.toolNames.map((tool) => <code key={tool}>{tool}</code>)}</div>
                        ) : (
                          <p className="tools-unavailable">Provider 未返回工具名称明细</p>
                        )}
                      </div>
                    </div>
                  )}
                </article>
              )
            })}
            {filteredMcps.length === 0 && <div className="empty"><div><strong>当前来源没有 MCP</strong><p>切换其他来源查看。</p></div></div>}
          </section>
        )}

      </section>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
