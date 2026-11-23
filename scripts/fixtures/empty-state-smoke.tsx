import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EmptyState, EmptyStateSlot } from '../../src/renderer/components/primitives/EmptyState'
import { EmptyStateArtwork } from '../../src/renderer/components/primitives/EmptyStateArtwork'
import { DelayedSkeletonRows } from '../../src/renderer/components/primitives/Skeleton'
import { Button } from '../../src/renderer/components/primitives/Button'
import '../../src/renderer/styles-theme-shell.css'
import '../../src/renderer/codex-alignment-shell.css'
import '../../src/renderer/styles-buttons.css'
import '../../src/renderer/motion.css'

// Local verification only: no product data or bridge. Exercise the production primitive.
const params = new URLSearchParams(location.search)
function Fixture() {
  const [query, setQuery] = useState(params.get('query') ?? '')
  const [dark, setDark] = useState(params.has('dark'))
  const [narrow, setNarrow] = useState(params.has('narrow'))
  const [stage, setStage] = useState<'first' | 'loading' | 'failed' | 'retry' | 'ready'>(params.has('failed') ? 'failed' : 'first')
  const startRead = () => {
    setStage('loading')
    window.setTimeout(() => setStage('failed'), 1500)
  }
  const retry = () => {
    setStage('retry')
    window.setTimeout(() => setStage('ready'), 850)
  }
  return <main data-theme={dark ? 'dark' : 'light'} style={{ color: 'var(--fg)', background: 'var(--panel)', padding: 'var(--space-3)', maxWidth: narrow ? 320 : 740 }}>
    <header style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      <label>搜索 <input aria-label="搜索" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <Button onClick={() => setDark(!dark)}>{dark ? '切换浅色' : '切换深色'}</Button>
      <Button onClick={() => setNarrow(!narrow)}>{narrow ? '恢复宽度' : '切换窄屏'}</Button>
      <Button onClick={startRead}>模拟慢速读取</Button>
    </header>
    <div style={{ display: 'grid', minHeight: 310 }}>
      <EmptyStateSlot empty={query ? <EmptyState size="page" announcement="polite" title={`没有与「${query}」匹配的结果`}
        actions={[{ label: '清除搜索', intent: 'secondary', onClick: () => setQuery('') }]} />
        : stage === 'first' ? <EmptyState size="page" title="新会话" description="发出第一条消息后，回复和执行记录会出现在这里。"
          picture={<EmptyStateArtwork scene="conversation" />} actions={[{ label: '新建会话', onClick: () => setStage('ready') }]} />
          : stage === 'failed' || stage === 'retry' ? <EmptyState size="page" picture="alert" announcement="alert" title="没能读取会话历史"
            description="这次读取失败不会更改归档。" actions={[{ label: '重新读取', intent: 'secondary', icon: 'refresh', busy: stage === 'retry', onClick: retry }]} /> : null}>
        {stage === 'loading' ? <DelayedSkeletonRows loading rows={4} label="正在读取会话" /> : <p>会话内容已显示</p>}
      </EmptyStateSlot>
    </div>
    <footer>固定页脚</footer>
  </main>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
