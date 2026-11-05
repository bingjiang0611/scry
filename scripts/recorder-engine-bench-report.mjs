#!/usr/bin/env node
/**
 * Aggregation and human-readable output for `scripts/recorder-engine-bench.mjs`.
 * Kept in its own file so neither script grows past the repository's staged-file size budget.
 */
import { median } from './recorder-engine-bench-fixtures.mjs'

/**
 * The tracked artifact is the per-scenario aggregate: rounds repeat the same deterministic Git
 * counts, so keeping every round would only inflate the file past the repository size budget.
 */
export function summarize(input) {
  return {
    schema: 1,
    generatedAt: input.generatedAt,
    environment: input.environment,
    rounds: input.rounds,
    notes: input.notes,
    scenarios: input.results.map((result) => {
      const groups = new Map()
      for (const entry of result.stages ?? []) {
        const key = `${entry.name}:${entry.history ?? ''}`
        const group = groups.get(key) ?? {
          name: entry.name, history: entry.history, ms: [], git: entry.git, parse: 0, anchor: 0, rss: 0, records: 0
        }
        if (typeof entry.ms === 'number') group.ms.push(entry.ms)
        if (entry.git && (!group.git || entry.git.total > group.git.total)) group.git = entry.git
        group.parse = Math.max(group.parse, entry.transcript?.bytesRead ?? 0)
        group.anchor = Math.max(group.anchor, entry.transcript?.anchorBytesScanned ?? 0)
        group.rss = Math.max(group.rss, entry.rssGrowthBytes ?? 0)
        group.records = Math.max(group.records, entry.records ?? 0)
        groups.set(key, group)
      }
      return {
        id: result.id,
        title: result.title,
        ...(result.error ? { error: result.error } : {}),
        wallMs: result.wallMs,
        gitPerScenario: result.git ?? null,
        stages: [...groups.values()].map((group) => ({
          name: group.name,
          ...(group.history === undefined ? {} : { history: group.history }),
          msP50: median(group.ms),
          rounds: group.ms.length,
          git: group.git ?? null,
          parseBytes: group.parse,
          anchorBytes: group.anchor,
          rssGrowthBytes: group.rss,
          ...(group.records ? { records: group.records } : {})
        }))
      }
    })
  }
}

function formatCounts(gitCount) {
  const entries = Object.entries(gitCount.byCommand ?? {}).sort((left, right) => right[1] - left[1])
  return entries.map(([command, count]) => `${command}:${count}`).join(' ') || '-'
}

export function printTable(results, { rounds, notes, platformLabel }) {
  process.stdout.write(`recorder engine L1 bench, ${rounds} rounds/scenario, ${platformLabel}\n\n`)
  for (const result of results) {
    if (result.error) {
      process.stdout.write(`${result.id}  ${result.title}\n  FAILED: ${result.error}\n\n`)
      continue
    }
    process.stdout.write(`${result.id}  ${result.title}\n`)
    for (const entry of result.stages) {
      if (entry.name === 'record-visible') continue
      const extra = entry.history === undefined ? '' : ` history=${entry.history}`
      const transcriptBytes = entry.transcript
        ? ` parse=${entry.transcript.bytesRead}B anchor=${entry.transcript.anchorBytesScanned}B`
        : ''
      const visible = entry.recordVisibleMs === undefined || entry.recordVisibleMs === null
        ? '' : ` recordVisible=${Math.round(entry.recordVisibleMs)}ms`
      process.stdout.write(
        `  ${entry.name.padEnd(11)} ms=${String(Math.round(entry.ms)).padStart(6)}${extra}` +
        ` git=${String(entry.git?.total ?? 0).padStart(3)} [${formatCounts(entry.git ?? {})}]` +
        `${entry.git?.indexBytes ? ` idx≈${entry.git.indexBytes}B` : ''}${transcriptBytes}${visible}` +
        `${entry.rssGrowthBytes !== undefined ? ` rss+${Math.round(entry.rssGrowthBytes / 1024 / 1024)}MB` : ''}\n`
      )
    }
    process.stdout.write(`  total git=${result.git?.total ?? '-'}  wall=${Math.round(result.wallMs / 1000)}s\n\n`)
  }
  if (notes.length > 0) process.stdout.write(`notes:\n${notes.map((note) => `  ${note}`).join('\n')}\n`)
}
