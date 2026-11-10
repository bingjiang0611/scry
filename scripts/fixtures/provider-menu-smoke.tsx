import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import type { DetectedAgent } from '../../src/renderer/env'
import { CliPicker } from '../../src/renderer/components/CliPicker'
import { ProviderFilterMenu } from '../../src/renderer/components/ProviderFilterMenu'
import '../../src/renderer/styles.css'
import '../../src/renderer/codex-alignment.css'
import '../../src/renderer/components/archived-sessions.css'

// 合成 Provider 列表：不连接任何本机 CLI，只验证菜单的图标与单选语义。
const agents: DetectedAgent[] = [
  { id: 'claude', name: 'Claude', bin: 'claude', path: '/synthetic/claude', version: '2.0.0' },
  { id: 'codex', name: 'Codex', bin: 'codex', path: '/synthetic/codex', version: '0.51.0' },
  { id: 'qoder', name: 'Qoder', bin: 'qoder', path: '/synthetic/qoder', version: '1.0.0' },
  { id: 'opencode', name: 'OpenCode', bin: 'opencode', path: '/synthetic/opencode', version: '0.9.0' },
  { id: 'pi:default', name: 'Pi', bin: 'pi', path: '/synthetic/pi', version: '0.52.0' },
  { id: 'pi:rotom', name: 'Pi · Rotom', bin: 'rotom', path: '/synthetic/rotom', version: '0.1.27' }
]

// 与生产一致：打开状态由拥有者控制，菜单只能请求关闭。
function PickerHost() {
  const [open, setOpen] = useState(true)
  const [selected, setSelected] = useState('pi:rotom')
  return (
    <CliPicker
      agents={agents}
      selectedId={selected}
      onSelect={setSelected}
      open={open}
      onOpenChange={setOpen}
    />
  )
}

// 两个菜单不同时打开：同一时刻只有一个下拉是生产形态，也避免共享的 document 监听互相干扰。
function FilterHost() {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('claude')
  return <ProviderFilterMenu providers={['claude', 'codex', 'pi']} value={value} onChange={setValue} open={open} onOpenChange={setOpen} />
}

createRoot(document.querySelector('#root')!).render(
  <main style={{ padding: 24, display: 'grid', gap: 32, justifyItems: 'start' }}>
    {/* 菜单向上展开：给触发器留出上方空间，截图里才看得到整块菜单。 */}
    <section id="picker-fixture" style={{ position: 'relative', marginTop: 430 }}>
      <PickerHost />
    </section>
    <section id="filter-fixture" style={{ position: 'relative', marginTop: 24 }}>
      <FilterHost />
    </section>
  </main>
)
