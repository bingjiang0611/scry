import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { piIntegrationTestRoots } from './pi-integration-test-fixture'
import { installPiIntegration, piIntegrationStatus } from './pi-integration'

const roots = piIntegrationTestRoots()

describe('Pi recorder integration installer', () => {
  it('原子安装受管 loader，重复安装保持幂等', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-integration-'))
    roots.push(root)
    const source = join(root, 'pi-recorder.mjs')
    await writeFile(source, 'export default function () {}\n')

    const first = await installPiIntegration({ home: root, source })
    const second = await installPiIntegration({ home: root, source })

    expect(second).toEqual(first)
    expect(await piIntegrationStatus({ home: root, source })).toMatchObject({ installed: true })
    expect(await readFile(first.target, 'utf8')).toContain(source)
    expect(JSON.parse(await readFile(join(root, '.pi', 'agent', 'settings.json'), 'utf8')).extensions).toEqual([first.target])
  })

  it('拒绝覆盖用户已有扩展', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-integration-'))
    roots.push(root)
    const source = join(root, 'pi-recorder.mjs')
    const target = join(root, '.pi', 'agent', 'extensions', 'scry-recorder.ts')
    await writeFile(source, 'export default function () {}\n')
    await mkdir(join(root, '.pi', 'agent', 'extensions'), { recursive: true })
    await writeFile(target, 'export default function userExtension() {}\n')

    await expect(installPiIntegration({ home: root, source })).rejects.toThrow('unmanaged Pi extension')
  })

  it('识别带 scope 的历史标记，升级后仍能覆盖旧 loader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-integration-'))
    roots.push(root)
    const source = join(root, 'pi-recorder.mjs')
    const target = join(root, '.pi', 'agent', 'extensions', 'scry-recorder.ts')
    await writeFile(source, 'export default function () {}\n')
    await mkdir(join(root, '.pi', 'agent', 'extensions'), { recursive: true })
    // 旧版本把发布方的 npm scope 写进标记；升级后必须仍被当成受管文件。
    await writeFile(target, `// managed-by: @example-scope/scry-turn-recorder pi integration\nexport { default } from ${JSON.stringify(source)}\n`)
    await writeFile(join(root, '.pi', 'agent', 'settings.json'), JSON.stringify({ extensions: [target] }))

    await expect(piIntegrationStatus({ home: root, source })).resolves.toMatchObject({ installed: true })
    const installed = await installPiIntegration({ home: root, source })
    expect(await readFile(installed.target, 'utf8')).toMatch(/^\/\/ managed-by: scry-turn-recorder pi integration\n/)
  })
})
