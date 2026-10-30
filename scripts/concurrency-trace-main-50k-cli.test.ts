import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// Real subprocess regression for the launcher's CLI guard. The guard used to compare
// `resolve(process.argv[1])` with `import.meta.url` as strings, so invoking the launcher through a symlink or an
// aliased prefix (`/tmp` -> `/private/tmp`) skipped the CLI branch entirely: the process imported the module,
// printed nothing and exited 0 without ever starting Electron. These cases call the real file through a real
// alias and require the real argument rejection.

const launcher = fileURLToPath(new URL('./concurrency-trace-main-50k.mjs', import.meta.url))
const directories: string[] = []
afterAll(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }) })

const temporaryDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'scry-main50k-cli-'))
  directories.push(dir)
  return dir
}

/** A path to the launcher that resolves to it but is spelled through a directory symlink and a file symlink. */
const aliasedLauncher = (): string => {
  const dir = temporaryDir()
  const aliasDir = join(dir, 'aliasdir')
  symlinkSync(dir, aliasDir)
  const alias = join(aliasDir, 'launcher.mjs')
  symlinkSync(launcher, alias)
  return alias
}

describe('50k launcher CLI guard', () => {
  it('rejects an unknown flag when started through an aliased path', () => {
    const alias = aliasedLauncher()
    // The case proves nothing unless the invoked spelling really differs from the canonical file.
    expect(realpathSync(alias)).not.toBe(alias)
    const result = spawnSync(process.execPath, [alias, '--invalid', 'value'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unknown flag')
    // The broken guard produced exit 0 and empty output, which is exactly what a silent import looks like.
    expect(result.stdout).toBe('')
  })

  it('still rejects an unknown flag when started from the canonical path', () => {
    const result = spawnSync(process.execPath, [launcher, '--invalid', 'value'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unknown flag')
  })

  it('imports the module from stdin without starting the CLI', () => {
    // `node --input-type=module -` is the library-shaped start the guard must tolerate: stdin supplies the
    // module body, so the launcher is imported while argv[1] is `-` rather than a script path. cwd is a private
    // temp dir so no stray file named `-` can make existsSync succeed.
    const dir = temporaryDir()
    const source = [
      `import { runCell } from ${JSON.stringify(pathToFileURL(launcher).href)}`,
      'process.stdout.write(JSON.stringify({ argv1: process.argv[1] ?? null, runCell: typeof runCell }))',
      ''
    ].join('\n')
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], { cwd: dir, input: source, encoding: 'utf8' })
    expect(result.status).toBe(0)
    // No CLI side effect: neither the usage error nor the measured summary may appear.
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain('SCRY_CONCURRENCY_TRACE_MAIN_50K=')
    const report = JSON.parse(result.stdout) as { argv1: string | null, runCell: string }
    expect(report.runCell).toBe('function')
    // Node reports `-` for explicit stdin input; an absent argv[1] is the same "no entry point" shape.
    expect(['-', null]).toContain(report.argv1)
  })

  it('stays importable as a library instead of running the CLI', async () => {
    // In this process argv[1] is the test runner, so the guard must not treat the import as a CLI start.
    const module = await import(new URL('./concurrency-trace-main-50k.mjs', import.meta.url).href) as Record<string, unknown>
    expect(typeof module.runCell).toBe('function')
    expect(typeof module.identityIssues).toBe('function')
  })
})
