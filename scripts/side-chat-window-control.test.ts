import { watch, readFileSync, writeFileSync, type FSWatcher } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createWindowResize } from './side-chat-window-control.mjs'

const fixtures: { root: string; watcher: FSWatcher }[] = []
afterEach(async () => {
  for (const { root, watcher } of fixtures.splice(0)) {
    watcher.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([true, false])('does not publish a resize before measured narrow=%s commits', async narrow => {
  const root = await mkdtemp(join(tmpdir(), 'scry-window-control-'))
  const path = join(root, 'control.json')
  // The native controller acknowledges dimensions independently of React's layout state.
  const watcher = watch(root, (_event, filename) => {
    if (filename?.toString() !== 'control.json') return
    const request = JSON.parse(readFileSync(path, 'utf8')) as { seq: number; width: number; height: number }
    writeFileSync(`${path}.receipt`, JSON.stringify({ seq: request.seq, visible: false,
      contentSize: [request.width, request.height] }))
  })
  fixtures.push({ root, watcher })
  let enterLayout!: () => void
  let releaseLayout!: () => void
  const entered = new Promise<void>(resolve => { enterLayout = resolve })
  const ready = new Promise<void>(resolve => { releaseLayout = resolve })
  const wait = vi.fn(async (expression: string) => {
    if (expression.includes('.app-shell.narrow-single-column')) {
      enterLayout()
      await ready
    }
  })
  const { resize, applied } = createWindowResize({ wait, idle: async () => {},
    check: (condition: boolean, message: string) => { if (!condition) throw new Error(message) },
    windowControlPath: path, json: JSON.stringify })
  const width = narrow ? 1100 : 1400
  const operation = resize(width, 900, narrow)
  try {
    expect(await Promise.race([entered.then(() => 'layout'), operation.then(() => 'returned')])).toBe('layout')
    expect(applied).toEqual([])
    expect(wait).toHaveBeenLastCalledWith(
      `(document.querySelector('.app-shell.narrow-single-column') != null) === ${narrow}`, 20000)
    releaseLayout()
    await operation
    expect(applied).toEqual([{ width, height: 900, contentSize: [width, 900] }])
  } finally {
    releaseLayout()
    await operation
  }
})
