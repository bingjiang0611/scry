import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Plugin as VitePlugin } from 'vite'
import type { Plugin as EsbuildPlugin } from 'esbuild'

export type Paths = { repository: string; generated: string; runtime: string; worker: string }
function mapped(source: string, importer: string | undefined, paths: Paths): string | undefined {
  if (!importer || !source.startsWith('.')) return undefined
  const target = resolve(dirname(importer.split('?')[0]), source).replace(/\.(ts|js)$/, '')
  if (target === resolve(paths.repository, 'src/main/workflow-store')) return paths.generated
  if (target === resolve(paths.repository, 'src/main/workflow-storage-probe.fixture')) return resolve(paths.repository, 'experiments/workflow-checkpoint/storage-test-probe.ts')
  if (importer.split('?')[0] === paths.generated) return resolve(paths.repository, 'src/main', source)
  return undefined
}
function cleanup(code: string, id: string, paths: Paths): string {
  if (id === resolve(paths.repository, 'scripts/fixtures/workflow-recovery-process.ts')) {
    const anchor = 'finally { if (process.connected) process.disconnect() }'
    if (code.split(anchor).length !== 2) throw new Error('controller lifecycle anchor changed')
    return `import { closeAll as closePrototypeStorage, storageReport as prototypeStorageReport } from '${paths.runtime}'\n` + code.replace(anchor,
      `finally { await closePrototypeStorage(); process.stderr.write(JSON.stringify({ event: 'prototype_storage_closed', ...prototypeStorageReport() }) + '\\n'); if (process.connected) process.disconnect() }`)
  }
  if (!id.startsWith(resolve(paths.repository, 'src/main/workflow-'))) return code
  let changed = false
  const transformed = code.replace(/import \{([^}]+)\} from 'node:fs\/promises'/g, (original, names: string) => {
    const parts = names.split(',').map(name => name.trim())
    if (!parts.includes('rm')) return original
    changed = true
    const remaining = parts.filter(name => name !== 'rm')
    return remaining.length ? `import { ${remaining.join(', ')} } from 'node:fs/promises'` : ''
  })
  return changed ? `import { prototypeRm as rm } from '${paths.runtime}'\n` + transformed : code
}
export function viteAdapter(paths: Paths): VitePlugin {
  return { name: 'isolated-checkpoint-prototype', enforce: 'pre',
    async resolveId(source, importer) {
      const path = mapped(source, importer, paths)
      if (path) return this.resolve(path, importer, { skipSelf: true })
    },
    transform(code, id) {
      const transformed = cleanup(code, id, paths)
      if (transformed !== code) return { code: transformed, map: null }
    }
  }
}
export function esbuildAdapter(paths: Paths): EsbuildPlugin {
  return { name: 'isolated-checkpoint-prototype', setup(build) {
    build.onResolve({ filter: /./ }, async args => {
      const path = mapped(args.path, args.importer, paths)
      if (path) return build.resolve(path, { kind: args.kind, resolveDir: paths.repository })
    })
    build.onLoad({ filter: /workflow-.*\.ts$/ }, async args => {
      const source = await readFile(args.path, 'utf8'), transformed = cleanup(source, args.path, paths)
      if (transformed !== source) return { contents: transformed, loader: 'ts', resolveDir: dirname(args.path) }
    })
  } }
}
