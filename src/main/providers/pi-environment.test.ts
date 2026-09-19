import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { piRpcEnvironment } from './pi'

async function withNodes(run: (cwd: string, path: string) => Promise<void>) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'scry-pi-env-')))
  try {
    const directories = ['23.6.0', '24.18.0'].map((version, index) => {
      const directory = join(cwd, String(index))
      mkdirSync(directory)
      const node = join(directory, 'node')
      writeFileSync(node, `#!/bin/sh\nprintf '${version}\\n'\n`)
      chmodSync(node, 0o755)
      return directory
    })
    await run(cwd, directories.join(delimiter))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe('Pi launcher environment', () => {
  it('keeps the Pi and Rotom Node requirements and overrides distinct', async () => {
    await withNodes(async (cwd, path) => {
      const pi = { id: 'pi:default', label: 'Pi', executable: join(cwd, 'pi') }
      const rotom = { id: 'pi:rotom', label: 'Rotom', executable: join(cwd, 'rotom') }
      const base = { PATH: path, HOME: cwd }
      expect((await piRpcEnvironment(pi, base)).PI_AGENT_NODE).toBe(join(cwd, '0/node'))
      expect((await piRpcEnvironment(rotom, base)).ROTOM_NODE).toBe(join(cwd, '1/node'))
      expect(await piRpcEnvironment(rotom, { ...base, PI_AGENT_NODE: '/legacy/node' })).toMatchObject({
        PI_AGENT_NODE: '/legacy/node', ROTOM_NODE: join(cwd, '1/node')
      })
      expect(await piRpcEnvironment(rotom, { ...base, ROTOM_NODE: '/explicit/node' })).toMatchObject({
        ROTOM_NODE: '/explicit/node'
      })
      expect((await piRpcEnvironment(pi, { ...base, PI_AGENT_NODE: '/explicit/pi-node' })).PI_AGENT_NODE)
        .toBe('/explicit/pi-node')
    })
  })

  it('enables Node env-proxy support only for Rotom when a proxy is configured', async () => {
    await withNodes(async (cwd, path) => {
      const pi = { id: 'pi:default', label: 'Pi', executable: join(cwd, 'pi') }
      const rotom = { id: 'pi:rotom', label: 'Rotom', executable: join(cwd, 'rotom') }
      const base = { PATH: path, HOME: cwd }

      expect(await piRpcEnvironment(rotom, { ...base, HTTPS_PROXY: 'http://127.0.0.1:10808' }))
        .toMatchObject({ HTTPS_PROXY: 'http://127.0.0.1:10808', NODE_USE_ENV_PROXY: '1' })
      expect(await piRpcEnvironment(rotom, { ...base, http_proxy: 'http://127.0.0.1:10808' }))
        .toMatchObject({ http_proxy: 'http://127.0.0.1:10808', NODE_USE_ENV_PROXY: '1' })
      expect(await piRpcEnvironment(rotom, { ...base, HTTPS_PROXY: 'http://127.0.0.1:10808', NODE_USE_ENV_PROXY: '0' }))
        .toMatchObject({ NODE_USE_ENV_PROXY: '0' })
      expect(await piRpcEnvironment(rotom, base)).not.toHaveProperty('NODE_USE_ENV_PROXY')
      expect(await piRpcEnvironment(pi, { ...base, HTTPS_PROXY: 'http://127.0.0.1:10808' }))
        .not.toHaveProperty('NODE_USE_ENV_PROXY')
    })
  })

  it('yields the main event loop and gives the Node probe only the sanitized environment', async () => {
    await withNodes(async (cwd, path) => {
      const output = join(cwd, 'probe-env.json')
      const node = join(cwd, '0/node')
      writeFileSync(node, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({
  admin: 'OPENAI_ADMIN_API_KEY' in process.env,
  nested: 'CLAUDECODE' in process.env,
  home: process.env.HOME
}))
process.stdout.write('24.18.0')
`)
      vi.stubEnv('OPENAI_ADMIN_API_KEY', 'inherited-admin-sentinel')
      try {
        let yielded = false
        setImmediate(() => { yielded = true })
        await piRpcEnvironment({ id: 'pi:default', label: 'Pi', executable: join(cwd, 'pi') }, {
          PATH: path, HOME: cwd, OPENAI_ADMIN_API_KEY: 'input-admin-sentinel', CLAUDECODE: '1'
        })
        expect(yielded).toBe(true)
        expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ admin: false, nested: false, home: cwd })
      } finally {
        vi.unstubAllEnvs()
      }
    })
  })
})
