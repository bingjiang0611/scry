import { join } from 'node:path'

export function fixtureImports(root) {
  return `
import { createRoot } from 'react-dom/client'
import { useRef, useState } from 'react'
import { RemoteHostPanel } from ${JSON.stringify(join(root, 'src/renderer/components/DesktopRemote.tsx'))}
import { RemotePairing } from ${JSON.stringify(join(root, 'src/renderer/components/RemotePairing.tsx'))}
import { RemoteChat, remoteDraftKey } from ${JSON.stringify(join(root, 'src/renderer/components/RemoteChat.tsx'))}
import { App } from ${JSON.stringify(join(root, 'src/renderer/App.tsx'))}
import { refreshRemoteCatalog, useConnectedCatalogLoader } from ${JSON.stringify(join(root, 'src/renderer/hooks/useRemoteCatalogs.ts'))}
import { SidebarRemoteProjects, useRemoteProjectGroups } from ${JSON.stringify(join(root, 'src/renderer/components/SidebarRemoteProjects.tsx'))}
import { refreshDesktopConnections } from ${JSON.stringify(join(root, 'src/renderer/hooks/useDesktopConnections.ts'))}
import { createComposerDraftStore } from ${JSON.stringify(join(root, 'src/renderer/composer-drafts.ts'))}
import { RemotePromptQueueStore } from ${JSON.stringify(join(root, 'src/renderer/remote-prompt-queue.ts'))}
import { createRightSurfaceState } from ${JSON.stringify(join(root, 'src/renderer/right-surface.ts'))}
import ${JSON.stringify(join(root, 'src/renderer/styles.css'))}
import ${JSON.stringify(join(root, 'src/renderer/motion.css'))}
import ${JSON.stringify(join(root, 'src/renderer/codex-alignment.css'))}

const firstLedger = '11111111-1111-4111-8111-111111111111'
const secondLedger = '22222222-2222-4222-8222-222222222222'
const firstScryRun = 'remote-run-fixture-1'
const secondScryRun = 'remote-run-fixture-2'
`
}
