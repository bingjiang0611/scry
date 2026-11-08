import type { WorkspaceEntry } from '@shared/workspace'

// Pierre's tree model takes a flat path list. These projections are the only work
// Scry does per render on top of the model, so they are what the workspace.tree
// counters measure; mounting and row virtualization stay inside @pierre/trees.

/** Loaded entries keyed by model path: directories carry a trailing slash. */
export function workspaceTreeEntries(children: Record<string, WorkspaceEntry[]>): Map<string, WorkspaceEntry> {
  const result = new Map<string, WorkspaceEntry>()
  const visit = (path: string): void => {
    for (const entry of children[path] ?? []) {
      result.set(entry.kind === 'directory' ? `${entry.path}/` : entry.path, entry)
      // A directory without a loaded page contributes only itself.
      if (entry.kind === 'directory') visit(entry.path)
    }
  }
  visit('')
  return result
}

export function normalizeWorkspaceTreeQuery(query: string): string {
  return query.trim().toLowerCase()
}

/** Model paths for the current filter. A blank query keeps every loaded entry. */
export function filterWorkspaceTreePaths(entries: ReadonlyMap<string, WorkspaceEntry>, query: string): string[] {
  const normalized = normalizeWorkspaceTreeQuery(query)
  return [...entries]
    .filter(([, entry]) => !normalized || entry.name.toLowerCase().includes(normalized))
    .map(([path]) => path)
}

/**
 * Already-loaded parents revealed for a filtered path list. Pierre dedupes them;
 * the count stays one entry per path so a regression that reveals every ancestor
 * directory of every match remains visible.
 */
export function workspaceTreeAncestors(paths: readonly string[]): string[] {
  return paths.flatMap(path => {
    const parts = path.replace(/\/$/, '').split('/').slice(0, -1)
    return parts.map((_, index) => `${parts.slice(0, index + 1).join('/')}/`)
  })
}
