// Skills 只读清单：改前对照 + 三种改后方案，用 data-variant 切换。
const { useState } = React;

function Ico({ name }) {
  return (
    <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
      <path d={SKILL_ICONS[name]} />
    </svg>
  );
}

const VARIANTS = [
  { id: 'before', label: '改前现状', hint: 'A0' },
  { id: 'plain', label: '精简对齐', hint: 'A' },
  { id: 'compact', label: '紧凑清单', hint: 'B' },
  { id: 'cards', label: '双列卡片', hint: 'C' }
];

const VARIANT_NOTES = {
  before: '对照用：保留 Provider account 区块与右侧「配置状态」列，和现在线上的 Skills 面板一致。',
  plain: 'A · 精简对齐：只删掉账号区块和状态列，行结构、字号、间距全部保持原样。改动面最小，行高从 82 降到 74。',
  compact: 'B · 紧凑清单：来源路径收到名称同一行右侧，行高压到 58，一屏可见条目数从 4 条提升到约 7 条。',
  cards: 'C · 双列卡片：面板加宽到 1040，两列并排，描述允许折到两行，适合 Provider Skill 这种条目多、描述长的场景。'
};

const SCOPES = [
  { id: 'project', label: '项目 Skill' },
  { id: 'user', label: '用户 Skill' },
  { id: 'provider', label: 'Provider Skill' }
];

function matchesScope(skill, scope) {
  if (scope === 'project') return skill.scope === 'project';
  if (scope === 'user') return skill.scope === 'user';
  return skill.scope !== 'project' && skill.scope !== 'user';
}

function scopeShortLabel(scope) {
  return scope === 'project' ? '项目' : scope === 'user' ? '用户' : scope || '未知';
}

function scopeClass(scope) {
  return scope === 'project' ? 'project' : scope === 'user' ? 'user' : 'unknown';
}

function SkillRow({ skill, variant }) {
  return (
    <article className="skill-ledger__row">
      <div className="skill-ledger__main">
        <div className="skill-ledger__name-line">
          <strong>{skill.name}</strong>
          <span className={'inventory-scope inventory-scope--' + scopeClass(skill.scope)}>{scopeShortLabel(skill.scope)}</span>
          {variant === 'compact' && (
            <div className="skill-ledger__source">
              <span>来源</span>
              <code title={skill.dir}>{skill.dir}</code>
            </div>
          )}
        </div>
        <p title={skill.description}>{skill.description}</p>
        {variant !== 'compact' && (
          <div className="skill-ledger__source">
            <span>来源</span>
            <code title={skill.dir}>{skill.dir}</code>
          </div>
        )}
      </div>
      {variant === 'before' && (
        <div className="skill-ledger__status">
          <span>配置状态</span>
          <div className="skill-ledger__status-line">
            <span className={'inventory-state inventory-state--' + (skill.enabled ? 'enabled' : 'disabled')}>
              <i aria-hidden="true" />
              <span>{skill.enabled ? '已启用' : '已关闭'}</span>
            </span>
            <label className="inventory-switch">
              <input type="checkbox" defaultChecked={skill.enabled} aria-label={(skill.enabled ? '关闭' : '启用') + ' Skill ' + skill.name} />
              <span className="inventory-switch__track" aria-hidden="true"><span /></span>
            </label>
          </div>
          <small>可管理</small>
        </div>
      )}
    </article>
  );
}

function Tweaks({ variant, setVariant, theme, setTheme }) {
  const [open, setOpen] = useState(true);
  return (
    <React.Fragment>
      <button type="button" className="tweaks-toggle" onClick={() => setOpen(!open)}>
        {open ? 'Hide tweaks' : 'Tweaks'}
      </button>
      {open && (
        <div className="tweaks">
          <fieldset>
            <legend>方案</legend>
            {VARIANTS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={variant === option.id ? 'active' : ''}
                onClick={() => setVariant(option.id)}
              >
                <span>{option.label}</span>
                <small>{option.hint}</small>
              </button>
            ))}
          </fieldset>
          <fieldset>
            <legend>主题</legend>
            <div className="tweaks__row">
              <button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>浅色</button>
              <button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>深色</button>
            </div>
          </fieldset>
        </div>
      )}
    </React.Fragment>
  );
}

function SkillsPanel({ variant }) {
  const [scope, setScope] = useState('user');
  const [query, setQuery] = useState('');
  const counts = {
    project: SKILLS.filter((skill) => matchesScope(skill, 'project')).length,
    user: SKILLS.filter((skill) => matchesScope(skill, 'user')).length,
    provider: SKILLS.filter((skill) => matchesScope(skill, 'provider')).length
  };
  const scopeSkills = SKILLS.filter((skill) => matchesScope(skill, scope));
  const needle = query.trim().toLowerCase();
  const filtered = scopeSkills.filter(
    (skill) => !needle || [skill.name, skill.description, skill.dir].some((value) => value.toLowerCase().includes(needle))
  );
  const scopeLabel = SCOPES.find((item) => item.id === scope).label;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Skills">
      <div className="modal-head">
        <div className="inventory-modal__title">
          <span className="inventory-modal__eyebrow">Capability inventory</span>
          <div className="inventory-modal__title-line">
            <b>Skills</b>
            <span className="inventory-provider">codex</span>
          </div>
          <p>
            {variant === 'before'
              ? '查看当前 Provider 在这个工作目录里实际发现了什么，以及 Scry 是否有权管理它。'
              : '查看当前 Provider 在这个工作目录里实际发现了哪些 Skill。'}
          </p>
        </div>
        <div className="inventory-modal__head-actions">
          <button className="modal-refresh" title="重新读取当前 Provider 的 Skill 清单" aria-label="刷新 Skills"><Ico name="refresh" /></button>
          <button className="modal-x" aria-label="关闭 Skills"><Ico name="x" /></button>
        </div>
      </div>

      <div className="inventory-context" aria-label="Skills 查询上下文">
        <div className="inventory-context__item">
          <span>Provider</span>
          <strong>codex</strong>
        </div>
        <i className="inventory-context__divider" aria-hidden="true" />
        <div className="inventory-context__item inventory-context__cwd">
          <span>工作目录</span>
          <code title="/Users/baobingjiang/.treehouse/rate-native-codex">/Users/baobingjiang/.treehouse/rate-native-…</code>
        </div>
        <span className="inventory-context__spacer" />
        <b className="inventory-context__summary">
          {filtered.length} 个结果{variant === 'before' ? ' · 可管理' : ''}
        </b>
        <time className="inventory-context__time">15:06:35</time>
      </div>

      <section className="inventory-account" aria-label="Provider 账号与额度证据">
        <div className="inventory-account__heading">
          <span>Provider account</span>
          <span className="inventory-state inventory-state--connected inventory-state--quiet">
            <i aria-hidden="true" />
            <span>已读取</span>
          </span>
        </div>
        <div className="inventory-account__facts">
          <div><span>账号</span><strong>baoobingjiang0611@gmail.com</strong></div>
          <div><span>计划</span><strong>pro</strong></div>
          <div><span>账户额度</span><strong>Provider 未上报</strong></div>
        </div>
      </section>

      <div className="skill-scope-tabs" role="tablist" aria-label="Skill 来源">
        {SCOPES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={scope === item.id}
            className={scope === item.id ? 'active' : ''}
            onClick={() => setScope(item.id)}
          >
            {item.label} <span>{counts[item.id]}</span>
          </button>
        ))}
      </div>

      <div className="inventory-toolbar">
        <label className="inventory-search">
          <span>搜索</span>
          <input
            type="search"
            placeholder={'搜索' + scopeLabel}
            aria-label="搜索 Skills"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && <button type="button" onClick={() => setQuery('')} aria-label="清空搜索">清除</button>}
        </label>
        <span className="inventory-toolbar__count" aria-live="polite">显示 {filtered.length} / {scopeSkills.length}</span>
      </div>

      <div className="modal-body" role="tabpanel">
        {filtered.length === 0 && (
          <div className="inventory-empty" role="status">
            <strong>{scopeSkills.length === 0 ? '未发现' + scopeLabel : scopeLabel + '中没有匹配结果'}</strong>
            <p>{scopeSkills.length === 0 ? '当前 Provider 没有返回' + scopeLabel + '。' : '换一个关键词，或清空搜索查看全部条目。'}</p>
            {query && <button type="button" onClick={() => setQuery('')}>清空搜索</button>}
          </div>
        )}
        {filtered.length > 0 && (
          <div className="skill-ledger">
            {filtered.map((skill) => (
              <SkillRow key={skill.scope + ':' + skill.name} skill={skill} variant={variant} />
            ))}
          </div>
        )}
      </div>

      <div className="modal-foot inventory-footnote">
        <span>{variant === 'before' ? '配置证据' : '发现证据'}</span>
        <p>
          {variant === 'before'
            ? '当前 Provider 支持由 Scry 管理 Skill 开关。'
            : '清单直接来自当前 Provider 在这个工作目录的发现结果，Scry 只读取、不改写 Skill 配置。'}
        </p>
      </div>
    </div>
  );
}

function initialVariant() {
  const requested = new URLSearchParams(window.location.search).get('v');
  return VARIANTS.some((option) => option.id === requested) ? requested : 'compact';
}

function App() {
  const [variant, setVariant] = useState(initialVariant);
  const [theme, setTheme] = useState('light');
  document.documentElement.dataset.theme = theme;
  return (
    <div className="stage" data-variant={variant} data-screen-label={'Skills · ' + variant}>
      <div>
        <SkillsPanel variant={variant} />
        <p className="variant-note">{VARIANT_NOTES[variant]}</p>
      </div>
      <Tweaks variant={variant} setVariant={setVariant} theme={theme} setTheme={setTheme} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
