// app chrome 复刻：顶栏与 composer 与现有实现保持一致（作为不变对照组）。
// 顶栏行为照 ViewChrome.tsx：无 cwd 且无会话时不出视图 tab、不出「纵览」按钮，只留
// agent pill + 「不绑定项目」；绑定后才出现「对话」tab、「文件」与「纵览」。

function AppTopbar({ cwd, provider }) {
  return (
    <header className="topbar compact">
      {cwd && (
        <nav className="vtabs" aria-label="会话视图">
          <button type="button" className="vtab active" aria-current="page">
            <Icon name="message" /> 对话
          </button>
        </nav>
      )}
      <div className="tb-spacer" />
      <div className="tb-statusbar" aria-label="会话工具">
        <div
          className="tb-agent-status agent-pill"
          role="status"
          title={`${provider.path} · ${provider.version}`}
        >
          <span className="dot" /> <span className="agent-name">{provider.name}</span>{' '}
          <b className="agent-version">{provider.version}</b>
        </div>
        {!cwd && (
          <span className="tb-context cwd-pill" title="当前运行未指定工作目录">
            <Icon name="folder" /> <b>不绑定项目</b>
          </span>
        )}
        {cwd && (
          <>
            <button type="button" className="tb-action panel-pill" title="工作区文件">
              <Icon name="folder" /> 文件
            </button>
            <button type="button" className="tb-action panel-pill" title="纵览面板">
              <Icon name="grid" /> 纵览
            </button>
          </>
        )}
      </div>
    </header>
  );
}

function AppComposer({ cwd, project, provider, value, onChange, onSend, hint, showHeading }) {
  const canSend = value.trim().length > 0;
  return (
    <div className="composer runtime-composer">
      <div className="composer-shell evidence-composer-shell">
        {showHeading && (
          <div className="welcome-composer-heading">
            <span>
              <small>任务</small>
              <b>告诉 Agent 要完成什么</b>
            </span>
            <em>本机证据已开启</em>
          </div>
        )}
        <div className="composer-top">
          <button type="button" className="wdbtn" title={cwd ?? '当前运行未指定工作目录'}>
            <Icon name="folder" /> {cwd ? project.name : '不绑定项目'}
            <Icon name="chevronDown" className="chev" />
          </button>
        </div>
        <textarea
          className="input"
          aria-label="描述任务"
          placeholder={`给 ${provider.name} 一个任务…（/ 唤起命令，Enter 发送，Shift+Enter 换行）`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (canSend) onSend();
            }
          }}
        />
        <div className="composer-bottom">
          <div className="composer-controls" aria-label="运行配置">
            <button type="button" className="clibtn">
              <span className="agicon">
                <Icon name="cube" />
              </span>
              <span>{provider.name}</span>
              <Icon name="chevronDown" className="chev" />
            </button>
            <span className="run-control-select">
              {RUN_CONTROLS.model}
              <Icon name="chevronDown" className="chev" />
            </span>
            <span className="run-control-select">
              {RUN_CONTROLS.permission}
              <Icon name="chevronDown" className="chev" />
            </span>
          </div>
          <div className="spacer" />
          <button
            type="button"
            className="send"
            disabled={!canSend}
            onClick={onSend}
            title={canSend ? '发送' : '先输入任务'}
          >
            <Icon name="send" />
          </button>
        </div>
        {hint && (
          <div className="composer-hint on" role="status">
            {hint}
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { AppTopbar, AppComposer });
