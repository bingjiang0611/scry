// 原型入口：state 全部集中在 App，子组件只收 props（避免跨 Babel script 共享 state）。
const { useEffect, useState } = React;

const VARIANTS = [
  { id: 'current', label: '现状', hint: 'ChatView.tsx 现有 zero-turn 分支' },
  { id: 'a', label: 'A · 就绪台', hint: 'welcome 垂直居中 + Provider 展开成 2×2 卡片矩阵' },
  { id: 'b', label: 'B · 就绪条', hint: 'welcome 垂直居中 + Provider 折叠成一条横向就绪仪表' }
];

// 初始状态可从 query 进入，方便直接链到某个组合做对比与截图：
// ?v=current|a|b & bound=1 & theme=light & w=1280 & menu=1（直接展开工作目录菜单）
const query = new URLSearchParams(location.search);
const initial = {
  variant: ['current', 'a', 'b'].includes(query.get('v')) ? query.get('v') : 'a',
  bound: query.get('bound') === '1' || query.get('menu') === '1',
  theme: query.get('theme') === 'light' ? 'light' : 'dark',
  width: query.get('w') === '1280' ? '1280' : '1000',
  menu: query.get('menu') === '1'
};

function App() {
  const [variant, setVariant] = useState(initial.variant);
  const [bound, setBound] = useState(initial.bound);
  const [theme, setTheme] = useState(initial.theme);
  const [width, setWidth] = useState(initial.width);
  const [selectedId, setSelectedId] = useState('claude');
  const [input, setInput] = useState('');
  const [hint, setHint] = useState('');
  const [scanning, setScanning] = useState(false);
  const [project, setProject] = useState(PROJECTS[0]);
  const [switchedTo, setSwitchedTo] = useState(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : '';
  }, [theme]);

  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(''), 2600);
    return () => clearTimeout(timer);
  }, [hint]);

  useEffect(() => {
    if (!scanning) return;
    const timer = setTimeout(() => setScanning(false), 1200);
    return () => clearTimeout(timer);
  }, [scanning]);

  // switchedTo 不自动消失：它陈述的是当前绑定的来历（只换绑定、未打开旧对话），
  // 在零轮次空态里一直成立；做成 2 秒就消失的 toast 反而看不到。

  const cwd = bound ? project.path : null;
  const provider = PROVIDERS.find((item) => item.id === selectedId) ?? PROVIDERS[0];
  const welcomeProps = {
    cwd,
    providers: PROVIDERS,
    selectedId,
    onSelect: setSelectedId,
    readiness: scanning ? READINESS_SCANNING : READINESS,
    scanning,
    onRescan: () => setScanning(true),
    project,
    projects: PROJECTS,
    // 切项目只重新绑定：不清空输入、不换视图、不打开历史会话。
    onPickProject: (item) => {
      setProject(item);
      setSwitchedTo(item.name);
    },
    switchedTo,
    projectMenuOpen: initial.menu
  };
  const activeVariant = VARIANTS.find((item) => item.id === variant);

  return (
    <div className="stage">
      <div className="stage-bar">
        <div className="stage-bar-title">
          <b>Scry Welcome</b>
          <span>0.2.44 · ZERO-TURN</span>
        </div>
        <div className="seg" role="group" aria-label="方案">
          {VARIANTS.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-pressed={variant === item.id}
              title={item.hint}
              onClick={() => setVariant(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="工作目录状态">
          <button type="button" aria-pressed={!bound} onClick={() => setBound(false)}>
            未绑定
          </button>
          <button type="button" aria-pressed={bound} onClick={() => setBound(true)}>
            已绑定 {project.name}
          </button>
        </div>
        <div className="stage-spacer" />
        <div className="seg" role="group" aria-label="窗口宽度">
          <button type="button" aria-pressed={width === '1000'} onClick={() => setWidth('1000')}>
            1000px
          </button>
          <button type="button" aria-pressed={width === '1280'} onClick={() => setWidth('1280')}>
            1280px
          </button>
        </div>
        <div className="seg" role="group" aria-label="主题">
          <button type="button" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>
            深色
          </button>
          <button type="button" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>
            浅色
          </button>
        </div>
      </div>

      <div className="app-window" data-width={width}>
        <div className="win-chrome" aria-hidden="true">
          <i />
          <i />
          <i />
          <span>Scry</span>
        </div>
        <div className="app-shell">
          <AppTopbar cwd={cwd} provider={provider} />
          <div className="body chat-body">
            <div className="chat chat-transcript" aria-label="执行时间线">
              {variant === 'current' && <WelcomeCurrent {...welcomeProps} />}
              {variant === 'a' && <WelcomeA {...welcomeProps} />}
              {variant === 'b' && <WelcomeB {...welcomeProps} />}
            </div>
          </div>
          <AppComposer
            cwd={cwd}
            project={project}
            provider={provider}
            value={input}
            onChange={setInput}
            showHeading={variant === 'current'}
            hint={hint}
            onSend={() => {
              setInput('');
              setHint('原型不会调用 Provider，也不会写入本机证据。');
            }}
          />
        </div>
      </div>

      <p className="stage-note">{activeVariant.hint}</p>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
