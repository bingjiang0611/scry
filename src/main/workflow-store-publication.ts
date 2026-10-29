import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** Prepare bytes independently; a dependency must finish its file flush and rename before publication. */
export async function publishWorkflowText(directory: string, name: string, text: string,
  options?: { deferDirectorySync?: boolean; beforePublish?: Promise<void> }): Promise<void> {
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.workflow-${randomUUID()}.tmp`)
  let renamed = false
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flush: true })
    await options?.beforePublish
    await rename(temporary, join(directory, name))
    renamed = true
    if (!options?.deferDirectorySync) {
      const handle = await open(directory, 'r')
      try { await handle.sync() } finally { await handle.close() }
    }
  } finally {
    // Rename consumes this name even when the subsequent directory barrier fails.
    if (!renamed) await rm(temporary, { force: true })
  }
}
