// 顶层 error boundary：把渲染期/effect 抛错降级成可恢复的提示，而不是整屏黑屏。
// dev 迭代中 renderer 与 preload/main 容易短暂不同步（preload 没重建→调到 undefined 方法），不该把整个 app 干掉。
import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    // 留个 console 方便 dev 排查（read_console_messages 能捞）
    console.error('[scry] 渲染异常被 ErrorBoundary 捕获：', error)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="err-boundary">
        <div className="err-card">
          <h2>界面渲染出错了</h2>
          <p className="dim">
            app 还活着，只是这层 UI 崩了。常见原因：dev 改动后 preload/main 没重建（重启 <code>npm run dev</code>），或某个组件抛错。
          </p>
          <pre>{error.message}</pre>
          <div className="err-actions">
            <button onClick={() => this.setState({ error: null })}>重试</button>
            <button onClick={() => location.reload()}>刷新页面</button>
          </div>
        </div>
      </div>
    )
  }
}
