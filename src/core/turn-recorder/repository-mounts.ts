import { lstat, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { gitCommand } from './git-command.js'

function withinRoot(path: string, root: string): boolean {
  const rel = relative(root, path)
  return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** Only the immediate links collected from an explicit capture's physical repos/ directory. */
export async function discoverRepositoryMounts(args: {
  links: string[]
  workspaceRoot: string
  excluded: Set<string>
  known: ReadonlyMap<string, string>
  slots: number
  concurrency: number
  deadline: number
}): Promise<string[]> {
  const { links, workspaceRoot, excluded, known, slots, concurrency, deadline } = args
  if (!links.length || slots <= 0 || Date.now() >= deadline) return []
  const accepted: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        // macOS also has a shared /tmp even when TMPDIR is a per-user directory. Ownership
        // is checked on the repository itself; neither temporary root is traversed.
        const roots = [workspaceRoot, ...(await Promise.all([homedir(), tmpdir(), '/tmp'].map(path =>
          realpath(path).catch(() => undefined)
        ))).filter((path): path is string => !!path)]
        const candidates = new Set<string>()
        for (let offset = 0; offset < links.length && Date.now() < deadline; offset += concurrency) {
          const batch = await Promise.all(links.slice(offset, offset + concurrency).map(async link => {
            // realpath rejects broken links and cycles. Never descend into the target.
            const canonical = await realpath(link).catch(() => undefined)
            if (!canonical || known.has(canonical) || !roots.some(root => withinRoot(canonical, root)) ||
              canonical.split(sep).some(name => excluded.has(name)) || Date.now() >= deadline) return undefined
            const repo = await lstat(canonical).catch(() => undefined)
            const uid = process.getuid?.()
            if (!repo?.isDirectory() || (uid != null && repo.uid !== uid)) return undefined
            const marker = await lstat(join(canonical, '.git')).catch(() => undefined)
            return marker?.isDirectory() || marker?.isFile() ? canonical : undefined
          }))
          for (const path of batch) if (path) candidates.add(path)
        }
        const probed = [...candidates].slice(0, slots)
        for (let offset = 0; offset < probed.length && Date.now() < deadline; offset += concurrency) {
          const batch = await Promise.all(probed.slice(offset, offset + concurrency).map(async path => {
            const output = await gitCommand(['--no-optional-locks', 'rev-parse', '--is-inside-work-tree', '--show-toplevel'], {
              cwd: path, deadline: Math.min(deadline, Date.now() + 1_000)
            }).catch(() => '')
            const [inside, root] = output.trimEnd().split('\n')
            // A marker alone does not prove this directory is the Git root.
            if (inside === 'true' && root === path) return path
            return undefined
          }))
          for (const path of batch) if (path && Date.now() < deadline) accepted.push(path)
        }
      })(),
      new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())) })
    ])
  } finally {
    clearTimeout(timer)
  }
  return [...accepted]
}
