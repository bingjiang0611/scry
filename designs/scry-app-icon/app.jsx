const { useState } = React;

function Score({ value }) {
  return (
    <div className="score-row" aria-label={`${value} out of 5`}>
      <span className={`score-dot ${value >= 1 ? "on" : ""}`}></span>
      <span className={`score-dot ${value >= 2 ? "on" : ""}`}></span>
      <span className={`score-dot ${value >= 3 ? "on" : ""}`}></span>
      <span className={`score-dot ${value >= 4 ? "on" : ""}`}></span>
      <span className={`score-dot ${value >= 5 ? "on" : ""}`}></span>
    </div>
  );
}

function ScaleStrip({ src, title }) {
  return (
    <div className="scale-strip" aria-label={`${title} small size previews`}>
      <div className="scale-sample"><img src={src} alt="" width="64" height="64" /><span>64</span></div>
      <div className="scale-sample"><img src={src} alt="" width="32" height="32" /><span>32</span></div>
      <div className="scale-sample"><img src={src} alt="" width="20" height="20" /><span>20</span></div>
      <div className="scale-sample"><img src={src} alt="" width="16" height="16" /><span>16</span></div>
    </div>
  );
}

function DirectionBoard({ code, title, subtitle, src, meaning, tradeoff, score, recommended, mode, mainSize }) {
  return (
    <article className="direction-board" data-screen-label={`${code} · ${title}`}>
      <header className="direction-head">
        <div className="direction-title-wrap">
          <div className="eyebrow">Direction {code}</div>
          <h2 className="direction-title">{title}</h2>
          <p className="direction-subtitle">{subtitle}</p>
        </div>
        {recommended ? <span className="recommended">推荐定稿</span> : null}
      </header>

      <div className="icon-stage" data-mode={mode}>
        <img
          className="hero-icon"
          src={src}
          alt={`${title} icon concept`}
          style={{ width: `${mainSize}px`, height: `${mainSize}px` }}
        />
      </div>

      <ScaleStrip src={src} title={title} />

      <div className="direction-copy">
        <div className="copy-block">
          <h3>核心隐喻</h3>
          <p>{meaning}</p>
        </div>
        <div className="copy-block">
          <h3>取舍</h3>
          <p>{tradeoff}</p>
          <Score value={score} />
        </div>
      </div>
    </article>
  );
}

function StressBoard() {
  return (
    <section className="stress-board" data-screen-label="Small-size and Dock stress test">
      <div className="compare-panel">
        <div className="eyebrow">Recognition test</div>
        <h2>从蓝色球体，变成可识别的观察工具</h2>
        <p className="lede">同样承载 trace 分叉，新方案把语义放进单一光学主物体，并用暖色底板在开发者工具 Dock 中建立独立记忆点。</p>
        <div className="before-after">
          <figure>
            <img src="reference-current.png" alt="Current Scry app icon" />
            <figcaption>现有 · 球体主导，细线在小尺寸衰减</figcaption>
          </figure>
          <figure>
            <img src="previews/icon-a-aperture.png" alt="Recommended Scry app icon" />
            <figcaption>定稿 · 暖色底板 + 深色镜头 + 粗 trace</figcaption>
          </figure>
        </div>
      </div>

      <div className="dock-stage" aria-label="Mock macOS Dock context">
        <div className="dock-window"></div>
        <div className="dock">
          <span className="dock-generic one"></span>
          <span className="dock-generic two"></span>
          <img className="dock-icon" src="previews/icon-a-aperture.png" alt="Scry in Dock" />
          <span className="dock-generic three"></span>
          <span className="dock-generic four"></span>
        </div>
      </div>
    </section>
  );
}

function DecisionBoard() {
  return (
    <section className="decision-board" data-screen-label="Final recommendation">
      <div className="decision-copy">
        <div className="kicker">Ship A · Aperture Trace</div>
        <h2>“看见 trace” 是最短、最强的品牌句子。</h2>
        <p>方案 A 同时满足产品语义、Apple 式单主物体层级与 16 px 可读性。橙色不是装饰性换肤：它主动避开开发工具常见的蓝紫色海洋，让 Scry 在 Dock、Spotlight 与安装器里都更快被找到。</p>
        <div className="reason-list">
          <div className="reason"><strong>一眼理解</strong><span>镜头负责观察，分叉负责 agent trace。</span></div>
          <div className="reason"><strong>小尺寸稳定</strong><span>粗线、三节点与深色圆形保持清晰。</span></div>
          <div className="reason"><strong>品牌可延展</strong><span>暖橙 + 薄荷可用于状态动效与品牌页。</span></div>
        </div>
      </div>
      <div className="final-icon-stage">
        <img src="previews/icon-a-aperture.png" alt="Final Scry Aperture Trace icon" />
        <code>icons/icon-a-aperture.svg<br />1024 PNG · macOS ICNS</code>
      </div>
    </section>
  );
}

function PreviewControls({ mode, setMode, mainSize, setMainSize }) {
  return (
    <aside className="preview-controls" aria-label="Preview controls">
      <span className="controls-label">背景</span>
      <div className="segmented">
        <button type="button" aria-pressed={mode === "light"} onClick={() => setMode("light")}>亮色</button>
        <button type="button" aria-pressed={mode === "dark"} onClick={() => setMode("dark")}>暗色</button>
      </div>
      <div className="size-control">
        <span className="controls-label">尺寸</span>
        <input
          type="range"
          min="168"
          max="286"
          value={mainSize}
          onChange={(event) => setMainSize(Number(event.target.value))}
          aria-label="Icon preview size"
        />
        <span className="size-value">{mainSize}px</span>
      </div>
    </aside>
  );
}

function App() {
  const [mode, setMode] = useState("dark");
  const [mainSize, setMainSize] = useState(252);

  return (
    <>
      <PreviewControls mode={mode} setMode={setMode} mainSize={mainSize} setMainSize={setMainSize} />
      <DesignCanvas minScale={0.28} maxScale={1.8}>
        <DCSection id="directions" title="Scry App Icon · 三个原创方向" subtitle="Apple 式层级与材质原则；不复刻任何现有图形。拖动画布，双击/右上角可聚焦单案。" gap={50}>
          <DCArtboard id="aperture" label="A · Aperture Trace" width={440} height={720}>
            <DirectionBoard
              code="A"
              title="Aperture Trace"
              subtitle="观察镜头 × 分叉执行轨迹"
              src="previews/icon-a-aperture.png"
              meaning="一枚光学镜头把 agent 的执行分叉放大到可检查状态。暖色瓷釉底板建立 Dock 识别。"
              tradeoff="语义最直接、最容易记住；保留 trace 语言，但不再依赖蓝色球体。"
              score={5}
              recommended={true}
              mode={mode}
              mainSize={mainSize}
            />
          </DCArtboard>
          <DCArtboard id="prism" label="B · Prism Relay" width={440} height={720}>
            <DirectionBoard
              code="B"
              title="Prism Relay"
              subtitle="多 Provider 信号 × 统一观察出口"
              src="previews/icon-b-prism.png"
              meaning="青、粉、金三路信号进入玻璃棱镜，汇聚为一个被检查的白色出口。"
              tradeoff="多 Provider 叙事最强、视觉最活跃；小尺寸下更接近抽象罗盘。"
              score={4}
              recommended={false}
              mode={mode}
              mainSize={mainSize}
            />
          </DCArtboard>
          <DCArtboard id="sentinel" label="C · Orbit Sentinel" width={440} height={720}>
            <DirectionBoard
              code="C"
              title="Orbit Sentinel"
              subtitle="三节点治理 × 常驻观测仪表"
              src="previews/icon-c-sentinel.png"
              meaning="三个受治理节点围绕观察核心运行，网格与金属环强调专业仪器感。"
              tradeoff="最接近 Pro 工具，暗色界面协调度高；品牌情绪略冷，也更像基础设施。"
              score={4}
              recommended={false}
              mode={mode}
              mainSize={mainSize}
            />
          </DCArtboard>
        </DCSection>

        <DCSection id="stress" title="识别压力测试" subtitle="与现有图标对照，并放入抽象 Dock 环境检查轮廓与颜色分离。">
          <DCArtboard id="dock-test" label="Dock · Before / After" width={1200} height={560}>
            <StressBoard />
          </DCArtboard>
        </DCSection>

        <DCSection id="decision" title="设计决策" subtitle="A 方案作为本轮定稿并进入应用资源。">
          <DCArtboard id="ship-a" label="Final · Ship A" width={1200} height={500}>
            <DecisionBoard />
          </DCArtboard>
        </DCSection>
      </DesignCanvas>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
