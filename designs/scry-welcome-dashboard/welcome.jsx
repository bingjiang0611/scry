// 两个 welcome 方案。共用 Scry 现有 token 与信息事实，只重排结构与节奏。
//
// A · 就绪台：welcome 区垂直居中，Provider 由满宽表格行改成 2×2 紧凑卡片矩阵。
// B · 就绪条：同样垂直居中，Provider 折叠成一条横向仪表，把纵向空间还给任务起点。

function ReadyMeter({ total, available, showCount }) {
  return (
    <span className="wd-meter" aria-hidden="true">
      <span className="wd-meter-track">
        {Array.from({ length: total }).map((_, index) => (
          <i key={index} data-on={String(index < available)} />
        ))}
      </span>
      {showCount && (
        <b>
          {available}/{total}
        </b>
      )}
    </span>
  );
}

// 项目上下文条：切项目就在这里完成，并且只重新绑定、停在新会话。
// 现有实现的 pickRecent() 会在该目录有历史会话时直接 pickSession(firstSession)，
// 把人扭进一个旧对话，具体路径根本没机会看到——这里改成只换绑定。
function ProjectContext({ project, projects, onPick, switchedTo, initialOpen }) {
  const [open, setOpen] = React.useState(Boolean(initialOpen));
  return (
    <div className="wd-context-wrap">
      <button
        type="button"
        className="wd-context"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
        title={project.path}
      >
        <Icon name="folder" />
        <b>{project.name}</b>
        <code>{project.path}</code>
        <Icon name="chevronDown" className="chev" />
      </button>
      {open && (
        <div className="menu wd-context-menu" role="menu" onMouseLeave={() => setOpen(false)}>
          <div className="mhdr">工作目录</div>
          {projects.map((item) => (
            <button
              type="button"
              key={item.path}
              className={`mitem wd-context-item ${item.path === project.path ? 'on' : ''}`}
              title={item.path}
              onClick={() => {
                setOpen(false);
                onPick(item);
              }}
            >
              <Icon name="folder" />
              <span>
                <b>{item.name}</b>
                <code>{item.path}</code>
              </span>
              {item.path === project.path && (
                <span className="ck">
                  <Icon name="check" /> 当前
                </span>
              )}
            </button>
          ))}
          <div className="mdiv" />
          <button type="button" className="mitem" onClick={() => setOpen(false)}>
            <Icon name="folder" /> 选择其他文件夹…
          </button>
          <button type="button" className="mitem" onClick={() => setOpen(false)}>
            <Icon name="message" /> 不绑定项目
          </button>
        </div>
      )}
      {switchedTo && (
        <div className="wd-context-note" role="status">
          已绑定到 {switchedTo}；未打开任何历史会话。
        </div>
      )}
    </div>
  );
}

function WelcomeHead({ cwd }) {
  return (
    <header className="wd-head">
      <div className="wd-kicker">
        <span className="wd-ready-dot" />
        新会话 · 本机证据
      </div>
      <h1>开始一次可追溯执行。</h1>
      <p>{cwd ? WELCOME_COPY.bound : WELCOME_COPY.unbound}</p>
    </header>
  );
}

function RescanButton({ scanning, onRescan, className }) {
  return (
    <button
      type="button"
      className={className}
      data-busy={String(Boolean(scanning))}
      disabled={scanning}
      onClick={onRescan}
      aria-label="重新扫描 PATH"
      title="重新扫描 PATH，重新探测本机 agent CLI"
    >
      <Icon name="refresh" />
      <span>{scanning ? '探测中…' : '重新扫描'}</span>
    </button>
  );
}

function WelcomeA({
  cwd,
  providers,
  selectedId,
  onSelect,
  readiness,
  scanning,
  onRescan,
  project,
  projects,
  onPickProject,
  switchedTo,
  projectMenuOpen
}) {
  const available = providers.filter((provider) => provider.state === 'available').length;
  return (
    <div className="wd wd-a" data-screen-label="方案 A · 就绪台">
      <WelcomeHead cwd={cwd} />
      {cwd && (
        <ProjectContext
          project={project}
          projects={projects}
          onPick={onPickProject}
          switchedTo={switchedTo}
          initialOpen={projectMenuOpen}
        />
      )}
      <section className="wd-a-field" aria-label="Provider">
        <div className="wd-a-fieldhead">
          <div role="status">
            <span className="wd-a-fieldtitle">
              <b>{readiness.summary}</b>
              <ReadyMeter total={providers.length} available={available} />
            </span>
            <small>{readiness.detail}</small>
          </div>
          <RescanButton className="wd-rescan" scanning={scanning} onRescan={onRescan} />
        </div>
        <div className="wd-a-grid" aria-label="Provider 探测结果">
          {providers.map((provider) => (
            <button
              type="button"
              key={provider.id}
              className={`wd-card ${provider.id === selectedId ? 'is-selected' : ''}`}
              data-provider={provider.id}
              data-health={provider.state}
              aria-pressed={provider.id === selectedId}
              onClick={() => onSelect(provider.id)}
            >
              <span className="wd-card-top">
                <i aria-hidden="true" />
                <b>{provider.name}</b>
                <em>{provider.state === 'available' ? '可用' : '不可用'}</em>
                <Icon name="check" className="wd-card-check" />
              </span>
              <small>
                {provider.version} · {provider.transport}
              </small>
              <code title={provider.path}>{provider.short}</code>
            </button>
          ))}
        </div>
      </section>
      <div className="wd-source">
        <Icon name="info" />
        路径与版本＝本机 PATH 探测结果；未探测到的字段保持「未知」
      </div>
    </div>
  );
}

function WelcomeB({
  cwd,
  providers,
  selectedId,
  onSelect,
  readiness,
  scanning,
  onRescan,
  project,
  projects,
  onPickProject,
  switchedTo,
  projectMenuOpen
}) {
  const available = providers.filter((provider) => provider.state === 'available').length;
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];
  return (
    <div className="wd wd-b" data-screen-label="方案 B · 就绪条">
      <WelcomeHead cwd={cwd} />
      {cwd && (
        <ProjectContext
          project={project}
          projects={projects}
          onPick={onPickProject}
          switchedTo={switchedTo}
          initialOpen={projectMenuOpen}
        />
      )}
      <section className="wd-b-field" aria-label="Provider">
        <div className="wd-b-bar">
          <div className="wd-b-score" role="status" title={readiness.summary}>
            <b>
              {available}/{providers.length}
            </b>
            <small>PROVIDER</small>
          </div>
          <div className="wd-b-chips" aria-label="Provider 探测结果">
            {providers.map((provider) => (
              <button
                type="button"
                key={provider.id}
                className={`wd-b-chip ${provider.id === selectedId ? 'is-selected' : ''}`}
                data-provider={provider.id}
                aria-pressed={provider.id === selectedId}
                title={`${provider.name} · ${provider.path}`}
                onClick={() => onSelect(provider.id)}
              >
                <span>
                  <i aria-hidden="true" />
                  <b>{provider.name}</b>
                </span>
                <small>{provider.version}</small>
              </button>
            ))}
          </div>
          <RescanButton className="wd-b-rescan" scanning={scanning} onRescan={onRescan} />
        </div>
        <div className="wd-b-fact">
          <b>{selected.name}</b>
          <hr />
          <span>{selected.transport}</span>
          <hr />
          <code title={selected.path}>{selected.path}</code>
        </div>
      </section>
      <div className="wd-source">
        <Icon name="info" />
        {readiness.detail}
      </div>
    </div>
  );
}

// 现状对照：markup 与文案照抄 ChatView.tsx 的 zero-turn 分支，不做任何修饰。
function WelcomeCurrent({ cwd, providers, selectedId, onSelect }) {
  return (
    <div className={`unbound-empty welcome-field ${cwd ? 'bound' : ''}`} data-screen-label="现状 · 0.2.44">
      <header className="welcome-heading">
        <div className="welcome-kicker">
          <span className="welcome-ready-dot" />
          NEW SESSION · LOCAL EVIDENCE
        </div>
        <h1>开始一次可追溯执行。</h1>
        <p>{cwd ? WELCOME_COPY.bound : WELCOME_COPY.unbound}</p>
      </header>

      <section className="welcome-provider-field" aria-label="Provider">
        <div className="welcome-ready-line" data-tone={READINESS.tone} role="status">
          <span className="welcome-runtime-pulse" aria-hidden="true" />
          <span>
            <b>{READINESS.summary}</b>
            <small>{READINESS.detail}</small>
          </span>
        </div>
        <div className="welcome-provider-list" aria-label="Provider 探测结果">
          {providers.map((provider) => (
            <button
              type="button"
              className={`welcome-provider ${provider.id === selectedId ? 'is-selected' : ''}`}
              data-provider={provider.id}
              data-health={provider.state}
              key={provider.id}
              aria-pressed={provider.id === selectedId}
              onClick={() => onSelect(provider.id)}
            >
              <i aria-hidden="true" />
              <span>
                <span>
                  <b>{provider.name}</b>
                  <em>{provider.state === 'available' ? '可用' : '不可用'}</em>
                </span>
                <code title={provider.path}>{provider.path}</code>
                <small>
                  {provider.version} · {provider.transport}
                </small>
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

Object.assign(window, { WelcomeA, WelcomeB, WelcomeCurrent });
