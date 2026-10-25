import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function readCssManifest(path: string): string {
  const directory = dirname(path)
  const source = readFileSync(path, 'utf8')
  return source.replace(/@import\s+['"](\.\/[^'"]+)['"]\s*;?/g, (_match, child: string) => readCssManifest(join(directory, child)))
}
