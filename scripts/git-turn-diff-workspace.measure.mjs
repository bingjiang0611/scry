#!/usr/bin/env node
/**
 * Measure one whole recorder turn over a real workspace layout: every discovered repository is
 * baselined at the turn start and diffed at the turn end, exactly as the hook does.
 *
 * This is an informational probe, not a gate: it always exits 0 once the bundles exist. Numbers move
 * with machine, disk cache and other load, so pass two builds and let the script interleave them:
 * both see the same load, and the printed delta is the part worth reading.
 *
 * The layout is read-only: copy it first, never measure the live workspace.
 *
 *   rsync -a --exclude='.scry' ~/src/rate-native/ /tmp/rate-native-layout/
 *   npm run build:cli
 *   node scripts/git-turn-diff-workspace.measure.mjs --layout /tmp/rate-native-layout --rounds 5 \
 *     --bundles <before>/packages/turn-recorder-cli/dist/core/turn-recorder,<after>/...
 *
 * Modes:
 *   (default)     every repository of a turn is captured in parallel; reports the wall time
 *   --sequential  one repository at a time, which is the cost of a turn that does not overlap them
 *   --paired      implies --sequential and alternates the builds per repository, so a load spike
 *                 cannot land on one build only; reports the sum of per-repository medians
 *
 * Options: --layout <dir> (required), --rounds <n> (default 5), --bundle <dir|git.js> (repeatable),
 *          --per-repository, --json <file>
 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const values = (name) => args.flatMap((arg, index) => arg === `--${name}` && args[index + 1] && !args[index + 1].startsWith('--') ? [args[index + 1]] : [])
const option = (name, fallback) => values(name).at(-1) ?? fallback
const layout = option('layout')
if (!layout || !existsSync(layout)) {
  process.stderr.write('usage: --layout <workspace directory with scry.config.json>\n')
  process.exit(2)
}
const rounds = Number(option('rounds', '5'))
const perRepository = args.includes('--per-repository')
const paired = args.includes('--paired')
const sequential = paired || args.includes('--sequential')
const jsonOut = option('json')
const bundleArgs = [...values('bundle'), ...values('bundles').flatMap((value) => value.split(','))]
const moduleRoots = bundleArgs.length ? bundleArgs : [join(repoRoot, 'packages', 'turn-recorder-cli', 'dist', 'core', 'turn-recorder')]
const gitModules = moduleRoots.map((root) => (root.endsWith('.js') ? root : join(root, 'git.js')))

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const round = (value) => Math.round(value * 10) / 10
const summary = (values) => ({ p50: round(median(values)), min: round(Math.min(...values)), max: round(Math.max(...values)) })

const builds = []
for (const gitModule of gitModules) {
  const configModule = join(dirname(gitModule), 'config.js')
  if (!existsSync(gitModule) || !existsSync(configModule)) {
    process.stderr.write(`missing recorder bundle: ${gitModule}\nrun: npm run build:cli\n`)
    process.exit(2)
  }
  const git = await import(pathToFileURL(gitModule).href)
  const config = await import(pathToFileURL(configModule).href)
  const enablement = await config.resolveRecorderEnablement(layout)
  if (!enablement.enabled) {
    process.stderr.write(`recorder is disabled for ${layout}: ${enablement.reason ?? 'unknown'}\n`)
    process.exit(2)
  }
  builds.push({ label: dirname(dirname(gitModule)), git, config, enablement, samples: [], repositories: [] })
}

async function captureOne(build, repository, captureRoot) {
  const beginStarted = process.hrtime.bigint()
  const capture = await build.git.beginGitTurnDiff(repository, 5_000, captureRoot, [build.enablement.dataRoot])
  const beginMs = Number(process.hrtime.bigint() - beginStarted) / 1e6
  const finishStarted = process.hrtime.bigint()
  const snapshot = await build.git.finishGitTurnDiff(capture)
  const finishMs = Number(process.hrtime.bigint() - finishStarted) / 1e6
  return {
    repository,
    beginMs,
    finishMs,
    strategy: snapshot.collection?.strategy ?? '-',
    files: snapshot.files.length
  }
}

async function cleanup(records) {
  await Promise.all(records.map(async (record) => {
    if (record.capture?.tempDir) await rm(record.capture.tempDir, { recursive: true, force: true })
  }))
}

async function measureTurn(build, order) {
  const discoveryStarted = process.hrtime.bigint()
  const discovery = await build.config.discoverRepositories(layout, build.enablement.config)
  const discoveryMs = Number(process.hrtime.bigint() - discoveryStarted) / 1e6
  const repositories = order?.length ? order : discovery.repositories
  const captureRoot = await mkdtemp(join(tmpdir(), 'scry-workspace-measure-'))
  try {
    const begin = (repository) => build.git.beginGitTurnDiff(repository, 5_000, captureRoot, [build.enablement.dataRoot])
    const finish = async ({ repository, capture }) => {
      const started = process.hrtime.bigint()
      const snapshot = await build.git.finishGitTurnDiff(capture)
      return { repository, capture, snapshot, elapsed: Number(process.hrtime.bigint() - started) / 1e6 }
    }
    const beginStarted = process.hrtime.bigint()
    const captures = sequential
      ? await repositories.reduce(async (previous, repository) => [...await previous, { repository, capture: await begin(repository) }], Promise.resolve([]))
      : await Promise.all(repositories.map(async (repository) => ({ repository, capture: await begin(repository) })))
    const beginMs = Number(process.hrtime.bigint() - beginStarted) / 1e6
    const finishStarted = process.hrtime.bigint()
    const snapshots = sequential
      ? await captures.reduce(async (previous, entry) => [...await previous, await finish(entry)], Promise.resolve([]))
      : await Promise.all(captures.map(finish))
    const finishMs = Number(process.hrtime.bigint() - finishStarted) / 1e6
    for (const entry of snapshots) {
      build.repositories.push({
        repository: entry.repository.slice(layout.length + 1) || '.',
        finishMs: entry.elapsed,
        strategy: entry.snapshot.collection?.strategy ?? '-',
        files: entry.snapshot.files.length
      })
    }
    const sample = {
      discoveryMs,
      beginMs,
      finishMs,
      totalMs: discoveryMs + beginMs + finishMs,
      files: snapshots.reduce((count, entry) => count + entry.snapshot.files.length, 0),
      changedRepositories: snapshots.filter((entry) => entry.snapshot.files.length > 0).length
    }
    await cleanup(snapshots)
    return sample
  } finally {
    await rm(captureRoot, { recursive: true, force: true })
  }
}

/** Per-repository medians, summed: the cost of a turn that captures one repository at a time. */
function sequentialCost(build) {
  const byRepository = new Map()
  for (const entry of build.repositories) {
    const current = byRepository.get(entry.repository) ?? { finishes: [], strategy: entry.strategy }
    current.finishes.push(entry.finishMs)
    current.strategy = entry.strategy
    byRepository.set(entry.repository, current)
  }
  const finishes = [...byRepository.values()].map((entry) => median(entry.finishes))
  return {
    repositories: byRepository.size,
    finishMs: round(finishes.reduce((total, value) => total + value, 0)),
    slowest: [...byRepository.entries()].sort((left, right) => median(right[1].finishes) - median(left[1].finishes)).slice(0, 10)
      .map(([repository, entry]) => `${repository} ${round(median(entry.finishes))}ms/${entry.strategy}`)
  }
}

const repositoryOrder = (await builds[0].config.discoverRepositories(layout, builds[0].enablement.config)).repositories
if (paired) {
  // One repository at a time, both builds back to back: the tightest pairing of the two numbers.
  for (let index = 0; index <= rounds; index += 1) {
    for (const repository of repositoryOrder) {
      const order = builds.map((_, offset) => (index + offset) % builds.length)
      for (const position of order) {
        const build = builds[position]
        const captureRoot = await mkdtemp(join(tmpdir(), 'scry-workspace-measure-'))
        try {
          const record = await captureOne(build, repository, captureRoot)
          if (index > 0) build.repositories.push({ repository: record.repository.slice(layout.length + 1) || '.', finishMs: record.finishMs, strategy: record.strategy, files: record.files })
        } finally {
          await rm(captureRoot, { recursive: true, force: true })
        }
      }
    }
  }
  for (const build of builds) build.samples.push({ ...sequentialCost(build), discoveryMs: 0 })
} else {
  for (let index = 0; index <= rounds; index += 1) {
    const order = builds.map((_, offset) => (index + offset) % builds.length)
    for (const position of order) {
      const build = builds[position]
      const sample = await measureTurn(build)
      // Round 0 is a warm-up per build and stays out of the numbers.
      if (index > 0) build.samples.push(sample)
    }
  }
}

process.stdout.write(`layout ${layout}  repositories ${repositoryOrder.length}  rounds ${rounds}` +
  `${paired ? '  (paired per repository)' : sequential ? '  (one repository at a time)' : '  (repositories in parallel)'}\n\n`)
const lines = []
for (const build of builds) {
  if (paired) {
    const cost = build.samples.at(-1)
    lines.push({ label: build.label, perTurnMs: cost.finishMs, repositories: cost.repositories, samples: build.samples, perRepository: build.repositories })
    process.stdout.write(`${build.label}\n  finish p50 per repository, summed over ${cost.repositories} repositories: ${cost.finishMs}ms\n`)
    if (perRepository) process.stdout.write(`  slowest: ${cost.slowest.join(', ')}\n`)
    continue
  }
  const report = Object.fromEntries(['discoveryMs', 'beginMs', 'finishMs', 'totalMs'].map((phase) => [phase, summary(build.samples.map((sample) => sample[phase]))]))
  lines.push({
    label: build.label,
    p50: { discovery: report.discoveryMs.p50, begin: report.beginMs.p50, finish: report.finishMs.p50, total: report.totalMs.p50 },
    ranges: report,
    samples: build.samples,
    perRepository: build.repositories
  })
  process.stdout.write(
    `${build.label}\n` +
    `  discovery p50=${String(report.discoveryMs.p50).padStart(8)}ms  begin p50=${String(report.beginMs.p50).padStart(8)}ms  ` +
    `finish p50=${String(report.finishMs.p50).padStart(8)}ms  per turn p50=${String(report.totalMs.p50).padStart(8)}ms (${report.totalMs.min}–${report.totalMs.max}ms)\n` +
    `  changed repositories ${summary(build.samples.map((sample) => sample.changedRepositories)).p50} of ${repositoryOrder.length}, files ${summary(build.samples.map((sample) => sample.files)).p50}\n`
  )
  if (perRepository) process.stdout.write(`  slowest finishes: ${sequentialCost(build).slowest.join(', ')}\n`)
}
if (lines.length > 1) {
  const before = lines[0]
  const after = lines[lines.length - 1]
  const delta = (from, to) => `${((1 - to / from) * 100).toFixed(1)}%`
  process.stdout.write(paired
    ? `\nfirst build → last build: ${before.perTurnMs}ms → ${after.perTurnMs}ms per turn (${delta(before.perTurnMs, after.perTurnMs)} less)\n`
    : `\nfirst build → last build: discovery ${before.p50.discovery}→${after.p50.discovery}ms, begin ${before.p50.begin}→${after.p50.begin}ms, ` +
      `finish ${before.p50.finish}→${after.p50.finish}ms, per turn ${before.p50.total}→${after.p50.total}ms (${delta(before.p50.total, after.p50.total)} less)\n`)
}
if (jsonOut) await writeFile(jsonOut, `${JSON.stringify({ layout, rounds, paired, sequential, builds: lines }, null, 2)}\n`)
