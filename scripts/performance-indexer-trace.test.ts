import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countIndexerEvents, finalizeIndexerTrace } from './performance-indexer-trace.mjs'

describe('read-only indexer attribution', () => {
  it('keeps only path-matched counts and never exposes raw paths', async () => {
    const counts = await countIndexerEvents([
      'header',
      '04:00:00.123456 open /fixture work/candidate/node_modules/secret-name 0.001 mdworker_shared',
      '04:00:00.123456 open /fixture work/native.noindex/candidate/node_modules/secret-name 0.001 mdworker_shared',
      '04:00:00.123456 open /fixture work/baseline/source.ts 0.001 mdworker_shared',
      '04:00:00.123456 read F=3 0.001 mdworker_shared',
      '04:00:00.123456 open /private/unrelated/secret-name 0.001 mdworker_shared'
    ], '/fixture work')
    expect(counts).toEqual({ eventLines: 5, workspaceNodeModules: 2, workspaceOther: 1, withoutWorkspacePath: 2 })
    expect(JSON.stringify(finalizeIndexerTrace(counts, 0))).not.toContain('secret-name')
    expect(finalizeIndexerTrace(counts, 1)).toMatchObject({ status: 'unavailable', collectorExit: 1 })
    expect(finalizeIndexerTrace(counts, 1)).not.toHaveProperty('counts')
    expect(finalizeIndexerTrace({ ...counts, eventLines: 0 }, 0)).toMatchObject({ status: 'unavailable' })
  })

  it.each([[0, 0], [1, 0], [0, 7]])('preserves trace exit %s and benchmark exit %s with exact argv', (traceExit, benchExit) => {
    const directory = mkdtempSync(join(tmpdir(), 'scry-indexer-test-'))
    try {
      const workspace = join(directory, 'work space')
      const scripts = join(workspace, 'candidate', 'scripts')
      const output = join(workspace, 'native-results')
      const bin = join(directory, 'bin')
      for (const path of [scripts, output, bin]) mkdirSync(path, { recursive: true })
      for (const file of ['performance-indexer-profile.sh', 'performance-indexer-trace.mjs']) copyFileSync(join('scripts', file), join(scripts, file))
      writeFileSync(join(bin, 'sudo'), '#!/bin/bash\nprintf \'%s\\0\' "$@" > "$ARGV_LOG"\nprintf \'%s\\n\' "$TRACE_LINE"\nexit "$TRACE_EXIT"\n', { mode: 0o755 })
      writeFileSync(join(bin, 'node'), '#!/bin/bash\nif [[ "$1" == *timing-run.mjs ]]; then\n printf \'%s\\0\' "$@" > "$PROFILE_ARGV"\n exit "$BENCH_EXIT"\nfi\nexec "$REAL_NODE" "$@"\n', { mode: 0o755 })
      const args = join(directory, 'trace.argv'), profileArgs = join(directory, 'profile.argv')
      const result = spawnSync('bash', [join(scripts, 'performance-indexer-profile.sh')], { encoding: 'utf8', env: {
        ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, REAL_NODE: process.execPath,
        GITHUB_WORKSPACE: workspace, ARGV_LOG: args, PROFILE_ARGV: profileArgs,
        TRACE_EXIT: String(traceExit), BENCH_EXIT: String(benchExit),
        TRACE_LINE: `04:00:00.123456 open ${workspace}/candidate/node_modules/test.js 0.001 mdworker_shared`
      } })
      expect(result.status, result.stderr).toBe(benchExit)
      expect(readFileSync(args, 'utf8').split('\0').slice(0, -1)).toEqual([
        '-n', '/usr/bin/fs_usage', '-w', '-f', 'filesys', '-t', '15', 'mdworker', 'mdworker_shared', 'mds', 'mds_stores'
      ])
      expect(readFileSync(profileArgs, 'utf8').split('\0').slice(0, -1)).toEqual([
        '.agents/skills/scry-performance-climb/scripts/timing-run.mjs', 'native-process-profile', '--',
        'node', 'scripts/performance-native-run.mjs', 'bench', '../native-results/runner-profile.json'
      ])
      const report = JSON.parse(readFileSync(join(output, 'indexer-trace.json'), 'utf8'))
      expect(report).toMatchObject({ status: traceExit === 0 ? 'available' : 'unavailable', collectorExit: traceExit })
      if (traceExit === 0) expect(report.counts.workspaceNodeModules).toBe(1)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
