import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function installHookTraps(workspace, temp) {
  const markers = ['post-checkout', 'post-index-change', 'reference-transaction'].map(name => ({
    hook: join(workspace, '.git', 'hooks', name), marker: join(temp, `${name}-ran`)
  }))
  for (const { hook, marker } of markers)
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  return markers
}

export function assertHooksIdle(markers) {
  for (const { marker } of markers)
    assert.equal(existsSync(marker), false, 'workspace preparation must not execute native Git hooks')
}
