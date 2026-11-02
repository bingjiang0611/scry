import { page } from './session-cache-smoke'
import type { ProviderContext } from '../../src/shared/provider'
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { summarizeRunningLlmSessions } from '../../src/shared/llm-performance'
import { ModalFrame, requestModalClose } from '../../src/renderer/components/Modals'
import { ModalCloseButton } from '../../src/renderer/components/primitives/ModalCloseButton'
import { MODAL_COPY } from '../../src/renderer/constants/copy'
import { SessionRenameMenu, type SessionMenuTarget } from '../../src/renderer/components/SessionRename'
import { SidebarProjectMenu } from '../../src/renderer/components/SidebarProjectMenu'

// Same full App/memory bridge as the session fixture; no Provider or real data.
document.documentElement.dataset.platform = 'macos'
document.getElementById('cache-state')!.parentElement!.hidden = true
Object.assign(window.scry, {
  loadSession: async (context: ProviderContext) => page(context.externalSessionId!),
  listArchivedSessions: async () => [],
  llmPerformanceSummary: async () => summarizeRunningLlmSessions([]),
  llmPerformanceHistory: async () => ({ rows: [], invalidLines: 0, truncated: false })
})
const copy = {
  openBoth: 'Open placement probes', openModal: 'Open modal probe',
  title: 'Overlay placement', nestedTitle: 'Nested overlay', nested: 'Open nested',
  busy: 'Toggle pending', input: 'Nested input',
  projectMenu: 'Open long project menu', projectName: 'scry-main-diff-integration-超长项目名称-'.repeat(6)
}
function Probes() {
  const [menu, setMenu] = useState<SessionMenuTarget | null>(null)
  const [projectMenu, setProjectMenu] = useState(false)
  const [modal, setModal] = useState(false)
  const [nested, setNested] = useState(false)
  const [busy, setBusy] = useState(false)
  const nestedInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    Object.assign(window, { overlayFixture: { busy, setBusy, hide: () => { setModal(false); setNested(false); setMenu(null) } } })
  }, [busy])
  const recordPageTime = (): void => {
    const animation = document.getAnimations().find(animation => animation.id === 'scry-structure')
    document.getElementById('overlay-probe-host')!.dataset.openTime = String(animation?.currentTime ?? -1)
  }
  return <>
    <div className="overlay-probe-actions" style={{ position: 'absolute', top: 90, left: 24, zIndex: 20, display: 'flex', gap: 4 }}>
      <button className="btn" id="probe-both" onClick={event => {
        recordPageTime()
        setMenu({ cwd: '/fixture/cache', session: { sessionId: 'placement', providerId: 'claude', preview: copy.title, mtime: 1, count: 1 },
          trigger: event.currentTarget, left: 440, top: 120 })
        setModal(true)
      }}>{copy.openBoth}</button>
      <button className="btn" id="probe-modal" onClick={() => { recordPageTime(); setModal(true) }}>{copy.openModal}</button>
      <button className="btn" id="probe-project-menu" onClick={() => setProjectMenu(true)}>{copy.projectMenu}</button>
    </div>
    {projectMenu && <SidebarProjectMenu menu={{ project: { cwd: '/fixture/long-project', name: copy.projectName, mtime: 1, sessions: [] }, left: 450, top: 160 }}
      onClose={() => setProjectMenu(false)} onNewProjectChat={cwd => { document.getElementById('overlay-probe-host')!.dataset.newChatCwd = cwd }} />}
    {menu && <SessionRenameMenu target={menu} onRename={async () => {}} onClose={() => setMenu(null)} />}
    {modal && <ModalFrame labelledBy="probe-title" className="probe-modal" closeDisabled={busy} onClose={() => setModal(false)}>
      <div className="modal-head"><h2 id="probe-title">{copy.title}</h2><ModalCloseButton aria-label={MODAL_COPY.close} onClick={() => requestModalClose()} /></div>
      <div className="modal-body">
        <button className="btn" id="probe-nested" onClick={() => setNested(true)}>{copy.nested}</button>
        <button className="btn" id="probe-busy" onClick={() => setBusy(value => !value)}>{copy.busy}</button>
      </div>
      {nested && <ModalFrame labelledBy="probe-nested-title" className="probe-nested-modal" initialFocusRef={nestedInput} onClose={() => setNested(false)}>
        <div className="modal-head"><h2 id="probe-nested-title">{copy.nestedTitle}</h2><ModalCloseButton aria-label={MODAL_COPY.close} onClick={() => requestModalClose()} /></div>
        <input ref={nestedInput} aria-label={copy.input} />
      </ModalFrame>}
    </ModalFrame>}
  </>
}
// Put production menu/ModalFrame consumers beneath the actual animated page.
// This host is fixture-only and doesn't participate in App layout or authority.
const host = document.createElement('div')
host.id = 'overlay-probe-host'
const probeRoot = createRoot(host)
probeRoot.render(<Probes />)
const attach = (): void => {
  const page = document.querySelector('.main-content')
  if (page && host.parentElement !== page) page.append(host)
}
const observer = new MutationObserver(attach)
observer.observe(document.getElementById('root')!, { subtree: true, childList: true })
attach()
window.addEventListener('pagehide', () => { observer.disconnect(); probeRoot.unmount() }, { once: true })
