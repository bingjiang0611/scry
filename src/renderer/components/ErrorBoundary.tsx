// 顶层 error boundary：把渲染期/effect 抛错降级成可恢复的提示，而不是整屏黑屏。
// dev 迭代中 renderer 与 preload/main 容易短暂不同步（preload 没重建→调到 undefined 方法），不该把整个 app 干掉。
import { Component, type ReactNode } from 'react'
import { RENDERER_FAILURE_COPY as copy } from '../constants/copy'
import { EmptyState } from './primitives/EmptyState'

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
    console.error('[scry] 渲染异常被 ErrorBoundary 捕获：', error)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <EmptyState className="err-boundary" size="page" picture="alert" title={copy.title} description={copy.detail} announcement="alert"
        focusAction actions={[
          { label: copy.retry, intent: 'secondary', icon: 'refresh', onClick: () => this.setState({ error: null }) },
          { label: copy.reload, intent: 'quiet', onClick: () => location.reload() }
        ]} />
    )
  }
}
