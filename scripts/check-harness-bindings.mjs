import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { HARNESS_FILES } from './session-concurrency-evidence.mjs'

// node --check cannot detect a deleted helper. Keep the former Vitest compiler
// contracts, including their DOM libraries, source graphs and negative controls,
// in a required static-check step rather than a five-second unit-test case.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const unresolvedName = new Set([2304, 2552, 18004])
const groups = [
  {
    name: 'session-concurrency', files: HARNESS_FILES, types: ['node'],
    missing: 'deletedHelper'
  },
  {
    name: 'concurrency-trace-launcher',
    files: ['scripts/concurrency-trace-bench.mjs', 'scripts/fixtures/concurrency-trace-electron.ts'],
    missing: 'deletedLauncherHelper'
  }
]
const directory = mkdtempSync(join(tmpdir(), 'scry-harness-bindings-'))
try {
  for (const group of groups) {
    const control = join(directory, `${group.name}.mjs`)
    writeFileSync(control, `export function runIt() { return ${group.missing}(1) }\n`)
    const program = ts.createProgram([...group.files.map(file => join(root, file)), control], {
      allowJs: true, checkJs: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true, ...(group.types ? { types: group.types } : {})
    })
    const diagnostics = [...program.getSemanticDiagnostics(), ...program.getSyntacticDiagnostics()]
      .filter(diagnostic => unresolvedName.has(diagnostic.code))
    const message = diagnostic => `${diagnostic.file?.fileName ?? '<global>'}:${diagnostic.code}: `
      + ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    assert.deepEqual(diagnostics.filter(diagnostic => diagnostic.file?.fileName !== control).map(message), [],
      `${group.name}: unresolved source bindings`)
    assert.ok(diagnostics.some(diagnostic => diagnostic.file?.fileName === control
      && diagnostic.code === 2304 && message(diagnostic).includes(group.missing)),
      `${group.name}: negative control did not detect ${group.missing}`)
    const sources = program.getSourceFiles().filter(file => !file.isDeclarationFile && file.fileName !== control)
    console.log(`${group.name}: ${sources.length} source files checked; missing-binding control detected`)
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
