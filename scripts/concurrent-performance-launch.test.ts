import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { writeConcurrentAppEntry } from './concurrent-performance-launch.mjs'

it('announces the production build version from the temporary Electron entry', () => {
  const temp = mkdtempSync(join(tmpdir(), 'scry-concurrent-entry-'))
  try {
    const root = resolve('.')
    const app = join(temp, 'app')
    writeConcurrentAppEntry(app, root, join(root, 'scripts/concurrent-performance-probe.cjs'))
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'))).toMatchObject({
      main: 'main.cjs', version
    })
    expect(readFileSync(join(app, 'main.cjs'), 'utf8')).toContain(join(root, 'out/main/index.js'))
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
