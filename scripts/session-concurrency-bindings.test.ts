import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as ts from 'typescript'
import { HARNESS_FILES } from './session-concurrency-evidence.mjs'

// node --check parses without resolving identifiers, so a helper that is used but missing — or was deleted with
// the block that defined it — passes every syntax check and only fails inside the App. This resolves the real
// harness modules as JavaScript and rejects the compiler's unresolved-name diagnostics; the fixture below proves
// the check is sensitive rather than vacuously green.
const UNRESOLVED_NAME = new Set([2304, 2552, 18004])
const root = dirname(dirname(fileURLToPath(import.meta.url)))

function unresolvedNames(files: string[]) {
  const program = ts.createProgram(files, { allowJs: true, checkJs: true, noEmit: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, types: ['node'] })
  return [...program.getSemanticDiagnostics(), ...program.getSyntacticDiagnostics()]
    .filter(diagnostic => UNRESOLVED_NAME.has(diagnostic.code))
}

describe('harness modules have no unresolved identifiers', () => {
  // Check the full harness and the negative control in one program. This preserves both
  // verdicts without loading/checking TypeScript's library graph twice (or moving work into a hook).
  it('resolves every harness module and detects a missing fixture binding in the same program', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-bindings-'))
    try {
      const fixture = join(dir, 'missing-binding.mjs')
      writeFileSync(fixture, 'export function useIt() { return deletedHelper(1) }\n')
      const found = unresolvedNames([...HARNESS_FILES.map(file => join(root, file)), fixture])
      expect(found.filter(diagnostic => diagnostic.file?.fileName !== fixture)).toEqual([])
      const missing = found.filter(diagnostic => diagnostic.file?.fileName === fixture)
      expect(missing.some(diagnostic => diagnostic.code === 2304)).toBe(true)
      expect(missing.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')).join('\n'))
        .toContain('deletedHelper')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
