#!/usr/bin/env node
/**
 * Measure `beginGitTurnDiff`, which runs inside the Provider's turn-start hook and is therefore
 * the one capture cost the user waits for directly.
 *
 * This is an informational probe, not a gate: it always exits 0 once the CLI bundle exists, and
 * nothing here asserts a threshold. Absolute numbers move with machine, disk and load, so compare
 * runs on the same machine rather than against the reference below.
 *
 * Reference (macOS, Apple silicon, CLI 0.2.31, git spawn ~75ms):
 *   clean worktree              311ms   (554ms before the layout calls were merged into one rev-parse)
 *   3 small untracked files     705ms
 *   one 50 MB untracked file    977ms
 *   300 small files             916ms
 *
 * Usage:
 *   npm run build:cli && npm run bench:git-diff
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = join(repoRoot, 'packages', 'turn-recorder-cli', 'dist', 'core', 'turn-recorder', 'git.js')
if (!existsSync(bundle)) {
  process.stderr.write(`missing CLI bundle: ${bundle}\nrun: npm run build:cli\n`)
  process.exit(2)
}
const { beginGitTurnDiff, cloneGitTurnDiffCapture } = await import(pathToFileURL(bundle).href)

const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 6)

async function repo(setup) {
  const root = await mkdtemp(join(tmpdir(), 'scry-git-bench-'))
  execFileSync('git', ['init', '-q', '.'], { cwd: root })
  execFileSync(
    'git',
    ['-c', 'user.email=bench@scry.local', '-c', 'user.name=bench', 'commit', '-q', '--allow-empty', '-m', 'baseline'],
    { cwd: root }
  )
  await setup(root)
  return root
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function cleanupCaptures(captures) {
  await Promise.all(captures.map((capture) =>
    capture.tempDir ? rm(capture.tempDir, { recursive: true, force: true }) : Promise.resolve()
  ))
}

async function scenario(label, setup) {
  const root = await repo(setup)
  const captureRoot = join(root, '.scry', 'diff')
  const samples = []
  try {
    // One warm-up round absorbs first-call filesystem and JIT effects.
    for (let round = 0; round <= ROUNDS; round += 1) {
      const startedAt = process.hrtime.bigint()
      const capture = await beginGitTurnDiff(root, 5_000, captureRoot, [join(root, '.scry')])
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      if (round > 0) samples.push(elapsedMs)
      await cleanupCaptures([capture])
      if (round === ROUNDS) {
        process.stdout.write(
          `${label.padEnd(30)} p50=${median(samples).toFixed(1).padStart(8)}ms  ` +
            `min=${Math.min(...samples).toFixed(1).padStart(8)}ms  ` +
            `max=${Math.max(...samples).toFixed(1).padStart(8)}ms  ` +
            `status=${capture.status}${capture.reason ? `/${capture.reason}` : ''}  ` +
            `baselineClean=${capture.baselineClean ?? '-'}\n`
        )
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

process.stdout.write(`beginGitTurnDiff, ${ROUNDS} timed rounds per scenario\n\n`)
await scenario('clean worktree', async () => {})
await scenario('3 small untracked files', async (root) => {
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeFile(join(root, name), 'x'.repeat(100))
})
await scenario('one 50 MB untracked file', async (root) => {
  await writeFile(join(root, 'big.jsonl'), 'y'.repeat(50 * 1024 * 1024))
})
await scenario('300 small files', async (root) => {
  for (let index = 0; index < 300; index += 1) {
    await writeFile(join(root, `f${index}.ts`), `export const x${index} = ${index}\n`)
  }
})

async function dualBaselineScenario(label, setup) {
  const root = await repo(setup)
  const captureRoot = join(root, '.scry', 'diff')
  const separate = []
  const reused = []
  const measureSeparate = async () => {
    const startedAt = process.hrtime.bigint()
    const captures = await Promise.all([
      beginGitTurnDiff(root, 5_000, captureRoot, [join(root, '.scry')]),
      beginGitTurnDiff(root, 5_000, captureRoot, [join(root, '.scry')])
    ])
    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6
    await cleanupCaptures(captures)
    return elapsed
  }
  const measureReused = async () => {
    const startedAt = process.hrtime.bigint()
    const baseline = await beginGitTurnDiff(root, 5_000, captureRoot, [join(root, '.scry')])
    const turn = await cloneGitTurnDiffCapture(baseline)
    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6
    await cleanupCaptures([baseline, turn])
    return elapsed
  }
  try {
    for (let round = 0; round <= ROUNDS; round += 1) {
      // 交替顺序，避免文件系统 cache 总是偏向第二种实现。
      let separateMs
      let reusedMs
      if (round % 2 === 0) {
        separateMs = await measureSeparate()
        reusedMs = await measureReused()
      } else {
        reusedMs = await measureReused()
        separateMs = await measureSeparate()
      }
      if (round > 0) {
        separate.push(separateMs)
        reused.push(reusedMs)
      }
    }
    const before = median(separate)
    const after = median(reused)
    process.stdout.write(
      `${label.padEnd(30)} separate=${before.toFixed(1).padStart(8)}ms  ` +
      `reuse=${after.toFixed(1).padStart(8)}ms  delta=${(((after - before) / before) * 100).toFixed(1)}%\n`
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

process.stdout.write('\nfirst-turn + session baseline wall time\n\n')
await dualBaselineScenario('clean dual baseline', async () => {})
await dualBaselineScenario('300-file dual baseline', async (root) => {
  for (let index = 0; index < 300; index += 1) {
    await writeFile(join(root, `f${index}.ts`), `export const x${index} = ${index}\n`)
  }
})
