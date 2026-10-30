import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as ts from 'typescript'

// Static and CLI-argument checks only — none of these prove the Electron cell runs. They cover the two
// things that fail silently instead: a helper that is called but no longer bound (node --check would pass
// it), and an argument path that starts a build, a temp tree or a process before it has to. Whether the
// measured cell works is answered by running it under the timing lock, not here.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const launcher = join(root, 'scripts/concurrency-trace-bench.mjs')
const entry = join(root, 'scripts/fixtures/concurrency-trace-electron.ts')
const UNRESOLVED_NAME = new Set([2304, 2552, 18004])

function unresolvedNames(files: string[]) {
  const program = ts.createProgram(files, { allowJs: true, checkJs: true, noEmit: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true })
  return [...program.getSemanticDiagnostics(), ...program.getSyntacticDiagnostics()]
    .filter(diagnostic => UNRESOLVED_NAME.has(diagnostic.code))
    .map(diagnostic => `${diagnostic.file?.fileName ?? '<global>'}:${diagnostic.code}: `
      + ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
}

// Counts real `new BrowserWindow(...)` expressions. Comments and strings cannot produce a NewExpression, so
// a comment that explains why no window is created stays free of charge.
function browserWindowConstructions(file: string): number {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true)
  let count = 0
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'BrowserWindow') count += 1
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

const runLauncher = (...args: string[]) =>
  spawnSync(process.execPath, [launcher, ...args], { encoding: 'utf8', timeout: 60_000 })

// Preloaded before the CLI is evaluated: any temp directory, mkdir, file write or child process makes the
// guarded run fail with this marker instead of silently creating state for --help or an invalid flag.
const GUARD_MARK = 'SCRY_TRACE_LAUNCHER_GUARD'
const guardSource = [
  "import fs from 'node:fs'",
  "import childProcess from 'node:child_process'",
  "import { syncBuiltinESMExports } from 'node:module'",
  '',
  `const blocked = name => () => { throw new Error('${GUARD_MARK} ' + name) }`,
  "for (const name of ['mkdtempSync', 'mkdirSync', 'writeFileSync', 'rmSync']) fs[name] = blocked('fs.' + name)",
  "for (const name of ['spawn', 'execFileSync', 'execSync', 'fork', 'spawnSync']) childProcess[name] = blocked('child_process.' + name)",
  'syncBuiltinESMExports()',
  ''
].join('\n')

describe('concurrency trace launcher contract', () => {
  it('resolves the launcher and the Electron entry without an unbound name', () => {
    expect(unresolvedNames([launcher, entry])).toEqual([])
  })

  // Negative control: the same program must report a name it cannot bind, otherwise a green case above
  // would only mean the filter never matches anything.
  it('reports a missing binding in a fixture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-trace-launcher-bindings-'))
    try {
      const fixture = join(dir, 'missing-binding.mjs')
      writeFileSync(fixture, 'export function runIt() { return deletedLauncherHelper(1) }\n')
      const found = unresolvedNames([fixture]).join('\n')
      expect(found).toContain('2304')
      expect(found).toContain('deletedLauncherHelper')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates no BrowserWindow in the launcher or the entry', () => {
    expect({ launcher: browserWindowConstructions(launcher), entry: browserWindowConstructions(entry) })
      .toEqual({ launcher: 0, entry: 0 })
  })

  // Negative control for the check above: a comment that mentions the constructor must not count, and a
  // real construction must be seen.
  it('sees BrowserWindow construction in code but not in a comment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-trace-launcher-window-'))
    try {
      const mentioned = join(dir, 'comment-only.mjs')
      const constructs = join(dir, 'constructs.mjs')
      writeFileSync(mentioned, '// this cell never does new BrowserWindow() and says so here\nexport const x = 1\n')
      writeFileSync(constructs, "import { BrowserWindow } from 'electron'\nexport const make = () => new BrowserWindow({ width: 1 })\n")
      expect({ mentioned: browserWindowConstructions(mentioned), constructs: browserWindowConstructions(constructs) })
        .toEqual({ mentioned: 0, constructs: 1 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prints usage for --help and exits before any build, temp tree or Electron start', () => {
    const result = runLauncher('--help')
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    expect(result.stdout).toContain('Usage: node scripts/concurrency-trace-bench.mjs')
    for (const flag of ['--limit', '--readers', '--items', '--help']) expect(result.stdout).toContain(flag)
    // No run started: the summary prefix cannot appear.
    expect(result.stdout).not.toContain('SCRY_CONCURRENCY_TRACE_BENCH')
  })

  it('rejects unknown flags, extra positionals and illegal values with exit code 2', () => {
    const cases: Array<{ args: string[], pattern: RegExp }> = [
      { args: ['--concurrency', '4'], pattern: /unknown option/i },
      { args: ['extra'], pattern: /positional/i },
      { args: ['--limit', '8'], pattern: /--limit must be one of 4, 16/ },
      { args: ['--readers', '2'], pattern: /--readers must be one of 0, 1, 4/ },
      { args: ['--items', '50000'], pattern: /--items must be one of 1000, 10000/ },
      // A missing value has to be reported as such; the usage text alone must not satisfy this.
      { args: ['--limit'], pattern: /argument missing/i }
    ]
    for (const { args, pattern } of cases) {
      const result = runLauncher(...args)
      expect({ args, status: result.status }).toEqual({ args, status: 2 })
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(pattern)
      expect(result.stderr).toContain('Usage: node scripts/concurrency-trace-bench.mjs')
    }
  })

  it('touches no filesystem entry and starts no process for --help or an invalid flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-trace-launcher-guard-'))
    try {
      const guardPath = join(dir, 'guard.mjs')
      writeFileSync(guardPath, guardSource)
      const cases: Array<{ args: string[], status: number, usage: 'stdout' | 'stderr', message: RegExp | null }> = [
        { args: ['--help'], status: 0, usage: 'stdout', message: null },
        { args: ['--limit', '8'], status: 2, usage: 'stderr', message: /--limit must be one of 4, 16/ }
      ]
      for (const { args, status, usage, message } of cases) {
        const result = spawnSync(process.execPath, ['--import', guardPath, launcher, ...args],
          { encoding: 'utf8', timeout: 60_000 })
        const stdout = result.stdout ?? ''
        const stderr = result.stderr ?? ''
        expect({ args, status: result.status, guardHit: stderr.includes(GUARD_MARK) })
          .toEqual({ args, status, guardHit: false })
        // The launcher's own streams: --help writes the usage to stdout and nothing to stderr, a rejected
        // argument writes the usage plus its specific message to stderr and leaves stdout empty.
        const withUsage = usage === 'stdout' ? stdout : stderr
        const silent = usage === 'stdout' ? stderr : stdout
        expect(withUsage).toContain('Usage: node scripts/concurrency-trace-bench.mjs')
        expect(silent).toBe('')
        if (message) {
          expect(stderr).toContain('[scry:concurrency-trace]')
          expect(stderr).toMatch(message)
        }
        // Neither case may print anything that looks like a measurement.
        expect(`${stdout}${stderr}`).not.toContain('SCRY_CONCURRENCY_TRACE_BENCH')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Source pins for guarantees a rewrite could drop silently. They are text checks on real code, not
  // evidence that the lifecycle behaves; only a run shows that.
  it('keeps the lifecycle and isolation contracts in the launcher source', () => {
    const source = readFileSync(launcher, 'utf8')
    expect(source).toContain('--user-data-dir=')
    expect(source).toContain('stopOwnedApp(')
    expect(source).toContain('inspectOwnedApp(')
    expect(source).toContain('createOutputCapture(')
    expect(source).toContain('watchChildClose(')
    // No bare signal in place of an identity check.
    expect(source).not.toMatch(/child\.kill\(/)
    // Env allowlist: the measured process must never inherit the launcher's environment.
    expect(source).not.toMatch(/env:\s*\{\s*\.\.\.process\.env/)
  })

  it('keeps the Electron entry main-only', () => {
    const source = readFileSync(entry, 'utf8')
    expect(source).toContain("app.on('browser-window-created'")
    expect(source).toContain('app.setActivationPolicy(')
    expect(source).toContain("process.on('SIGTERM'")
    // The single completion notification is the only thing this process sends to its parent.
    expect(source.match(/process\.send\(/g) ?? []).toHaveLength(1)
  })
})
