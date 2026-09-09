import { createRoot } from 'react-dom/client'
import { ComposerProjectFixture } from './composer-project-smoke'
import { UserMessage } from '../../src/renderer/components/ChatTurn'
import '../../src/renderer/styles.css'
import '../../src/renderer/codex-alignment.css'

// Synthetic images only; no Provider, preload, persisted session or private screenshot.
const image = (width: number, height: number) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')!
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#111'
  context.font = '40px sans-serif'
  context.fillText('Image preview regression', 24, 60)
  return { kind: 'image' as const, name: `${width}x${height}.png`, mimeType: 'image/png' as const, dataBase64: canvas.toDataURL().split(',')[1] }
}

createRoot(document.getElementById('root')!).render(
  <>
    <main style={{ width: '65vw', height: '60vh', overflow: 'auto', margin: '100px 0 0 20px' }}>
      <div className="transcript-turn">
        <UserMessage text="点击图片查看完整内容" attachments={[image(1600, 2400), image(2400, 900)]} />
      </div>
    </main>
    <ComposerProjectFixture />
    <aside id="summary" style={{ position: 'fixed', right: 0, top: 0, width: '25vw', height: '100vh', zIndex: 20 }}>Environment</aside>
  </>
)
