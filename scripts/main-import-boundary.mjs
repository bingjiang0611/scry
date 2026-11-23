#!/usr/bin/env node
/**
 * S3 static import boundary check for Electron main (`src/main/index.ts`). S3 removed the
 * in-process runtime from main; CI runs `--strict` (0 violations, node job).
 *
 * Scans the esbuild metafile reachability graph + dynamic `require()`/`import()` calls:
 *   1. `orchestrationImporters` — HARD FAIL (zero tolerance, Layer 3 single-writer boundary).
 *   2. `forbiddenPackages` — Provider SDKs, `node-pty`, `better-sqlite3`.
 *   3. `forbiddenModules` — In-process runtime modules (run pipeline, remote host, ledgers, terminals, SQLite, Providers).
 *   4. `nonWhitelistedChildProcess` — Reachable `child_process` importers outside the post-S3 allowlist.
 *   5. `testOnlySymbols` — HARD FAIL: a reachable module other than its own uses a test-only export.
 *
 * `--strict` requires 0 violations across all categories. The ratchet mode (`--baseline <json>`,
 * default scripts/main-import-boundary-baseline.json, now empty) only allows listed violations.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const FORBIDDEN_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk',
  '@opencode-ai/sdk',
  '@opencode-ai/sdk/v2',
  '@qoder-ai/qoder-agent-sdk',
  'node-pty',
  'better-sqlite3'
]

export const FORBIDDEN_MODULES = [
  'src/host-runtime/create-run-pipeline.ts',
  'src/host-runtime/host-runtime.ts',
  'src/main/terminal-manager.ts',
  'src/main/remote/remote-host-service.ts',
  'src/main/remote/session-ledger.ts',
  'src/main/source-control/service.ts',
  'src/main/db.ts',
  'src/main/agent-runner.ts',
  'src/main/providers/claude.ts',
  'src/main/providers/codex-app-server.ts',
  'src/main/providers/opencode-server.ts',
  'src/main/providers/qoder-launch.ts',
  'src/main/providers/pi-rpc.ts',
  'src/main/providers/antigravity-launch.ts',
  // S3: the assembly that built those runtimes in main, and their writers.
  'src/main/providers/registry.ts',
  'src/main/bootstrap/provider-runtime.ts',
  'src/main/bootstrap/terminal-runtime.ts',
  'src/main/bootstrap/run-execution.ts',
  'src/main/bootstrap/session-catalog.ts',
  'src/main/conversation-store.ts',
  'src/main/db-connection.ts',
  'src/main/source-control/process.ts',
  'src/main/recorder-cli-runtime.ts'
]

export const CHILD_PROCESS_ALLOWLIST = new Set([
  'src/main/bootstrap/daemon-launch.ts',
  'src/daemon/supervisor.ts',
  'src/daemon/login-start/exec.ts',
  'src/main/process-diagnostics.ts',
  'src/main/remote/desktop-transport.ts',
  'src/main/llm-network-configuration.ts'
])

// Exports that exist for tests only. The App reaches their defining module (it uses other
// exports of it) but no other App module may call them: registerTrustCheckedListener is the
// trust check without the daemon gate, which the App must only reach through
// registerTrustedIpcHandler.
export const TEST_ONLY_SYMBOLS = [
  { symbol: 'registerTrustCheckedListener', definedIn: 'src/main/ipc-trust.ts' }
]

const DYNAMIC_SPECIFIER_RE = /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function normalizePath(p) {
  return p.replace(/\\/g, '/')
}

export async function scanMainImportBoundary(entryPath = resolve(repoRoot, 'src/main/index.ts')) {
  const absEntry = resolve(repoRoot, entryPath)
  const result = await build({
    entryPoints: [absEntry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    metafile: true
  })

  const inputs = Object.keys(result.metafile.inputs).map((f) => normalizePath(f))
  const forbiddenPackageHits = new Set()
  const forbiddenModuleHits = new Set()
  const nonWhitelistedChildProcess = new Set()
  const orchestrationImporters = new Set()
  const testOnlySymbols = new Set()
  const forbiddenPkgSet = new Set(FORBIDDEN_PACKAGES)
  const forbiddenModSet = new Set(FORBIDDEN_MODULES)

  for (const [rawFile, info] of Object.entries(result.metafile.inputs)) {
    const file = normalizePath(rawFile)
    if (forbiddenModSet.has(file)) forbiddenModuleHits.add(file)
    if (file.startsWith('src/host-runtime/orchestration/')) orchestrationImporters.add(file)

    for (const imp of info.imports) {
      if (forbiddenPkgSet.has(imp.path)) forbiddenPackageHits.add(`${file} -> ${imp.path}`)
      if (imp.path === 'child_process' || imp.path === 'node:child_process') {
        if (!CHILD_PROCESS_ALLOWLIST.has(file)) nonWhitelistedChildProcess.add(file)
      }
      if (imp.path.includes('host-runtime/orchestration')) {
        orchestrationImporters.add(`${file} -> ${imp.path}`)
      }
    }

    // Also inspect dynamic require(...) / import(...) in reachable source files (e.g. node-pty, better-sqlite3)
    const diskPath = resolve(repoRoot, rawFile)
    let source = ''
    try {
      source = stripComments(readFileSync(diskPath, 'utf8'))
    } catch {
      continue
    }
    for (const { symbol, definedIn } of TEST_ONLY_SYMBOLS) {
      if (file !== definedIn && new RegExp(`\\b${symbol}\\b`).test(source)) testOnlySymbols.add(`${file} -> ${symbol}`)
    }
    for (const match of source.matchAll(DYNAMIC_SPECIFIER_RE)) {
      const spec = match[1]
      if (forbiddenPkgSet.has(spec)) forbiddenPackageHits.add(`${file} -> ${spec}`)
      if (spec === 'child_process' || spec === 'node:child_process') {
        if (!CHILD_PROCESS_ALLOWLIST.has(file)) nonWhitelistedChildProcess.add(file)
      }
      if (spec.includes('host-runtime/orchestration')) {
        orchestrationImporters.add(`${file} -> ${spec}`)
      }
    }
  }

  return {
    entry: normalizePath(relative(repoRoot, absEntry)),
    totalReachableModules: inputs.length,
    orchestrationImporters: [...orchestrationImporters].sort(),
    forbiddenPackages: [...forbiddenPackageHits].sort(),
    forbiddenModules: [...forbiddenModuleHits].sort(),
    nonWhitelistedChildProcess: [...nonWhitelistedChildProcess].sort(),
    testOnlySymbols: [...testOnlySymbols].sort()
  }
}

export function evaluateBoundaryReport(report, baseline) {
  const newViolations = {
    orchestrationImporters: [...report.orchestrationImporters],
    forbiddenPackages: [],
    forbiddenModules: [],
    nonWhitelistedChildProcess: [],
    // Like orchestration: no baseline can allow it.
    testOnlySymbols: [...(report.testOnlySymbols ?? [])]
  }
  const categories = ['forbiddenPackages', 'forbiddenModules', 'nonWhitelistedChildProcess']
  for (const key of categories) {
    const allowed = new Set(baseline?.[key] ?? [])
    for (const item of report[key]) {
      if (!allowed.has(item)) newViolations[key].push(item)
    }
  }
  const ok =
    newViolations.orchestrationImporters.length === 0 &&
    newViolations.forbiddenPackages.length === 0 &&
    newViolations.forbiddenModules.length === 0 &&
    newViolations.nonWhitelistedChildProcess.length === 0 &&
    newViolations.testOnlySymbols.length === 0
  return { ok, newViolations }
}

async function main() {
  const args = process.argv.slice(2)
  const getArg = (flag) => {
    const idx = args.indexOf(flag)
    return idx >= 0 ? args[idx + 1] : undefined
  }
  const entry = getArg('--entry') ?? 'src/main/index.ts'
  const strict = args.includes('--strict')
  const jsonOut = args.includes('--json')
  const writeBaseline = getArg('--write-baseline')
  const baselinePath = strict ? undefined : (getArg('--baseline') ?? 'scripts/main-import-boundary-baseline.json')

  const report = await scanMainImportBoundary(entry)

  if (writeBaseline) {
    if (report.orchestrationImporters.length > 0) {
      throw new Error(`Refusing to write baseline with orchestrationImporters: ${report.orchestrationImporters.join(', ')}`)
    }
    const payload = {
      schema: 1,
      entry: report.entry,
      totalReachableModules: report.totalReachableModules,
      forbiddenPackages: report.forbiddenPackages,
      forbiddenModules: report.forbiddenModules,
      nonWhitelistedChildProcess: report.nonWhitelistedChildProcess
    }
    writeFileSync(resolve(repoRoot, writeBaseline), `${JSON.stringify(payload, null, 2)}\n`)
    process.stdout.write(`Wrote baseline to ${writeBaseline}\n`)
    return
  }

  const baseline = baselinePath ? JSON.parse(readFileSync(resolve(repoRoot, baselinePath), 'utf8')) : null
  const evaluation = evaluateBoundaryReport(report, baseline)

  if (jsonOut) {
    process.stdout.write(`${JSON.stringify({ report, evaluation }, null, 2)}\n`)
  } else if (!evaluation.ok) {
    console.error('Main import boundary check FAILED:')
    console.error(JSON.stringify(evaluation.newViolations, null, 2))
  } else {
    console.log(
      `Main import boundary OK (reachable=${report.totalReachableModules}, orchestration=0, packages=${report.forbiddenPackages.length}, modules=${report.forbiddenModules.length}, child_process=${report.nonWhitelistedChildProcess.length})`
    )
  }

  if (!evaluation.ok) process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
