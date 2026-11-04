import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { lostSendReplyPath, writeIpcCountEntry, sideChatRequestsPath } from './smoke-app-entries.mjs'
import { rendererEvaluator } from './electron-security-cdp.mjs'
import { exerciseSideChatExecution, verifySideChatRestart } from './side-chat-execution-checks.mjs'
import { exerciseSideChatRuntime } from './side-chat-runtime-checks.mjs'
import { exerciseSideChatHistory } from './side-chat-history-checks.mjs'
import { exerciseSideChatLayout } from './side-chat-layout-checks.mjs'
import { exerciseSideChatScroll } from './side-chat-scroll-checks.mjs'
import { exerciseSideChatOrphan } from './side-chat-orphan-checks.mjs'
import { exerciseSideChatOrphanReader } from './side-chat-orphan-reader-checks.mjs'
import { exerciseSideChatOrphanPaging } from './side-chat-orphan-paging-checks.mjs'
import { exerciseSideChatRestore } from './side-chat-restore-checks.mjs'
import { prepareSideChatDrafts, verifySideChatDrafts } from './side-chat-draft-restart-checks.mjs'
import { verifySideChatWorkbenchAfterRestart } from './side-chat-workbench-checks.mjs'
import { exerciseSideChatAdoption } from './side-chat-adoption-checks.mjs'
import { exerciseSideChatLargeHistory, exerciseSideChatLargeHistoryRefusal } from './side-chat-large-history-checks.mjs'

/**
 * Everything the isolated App needs for one side-chat acceptance pass.
 *
 * The entry file, the counted IPC path and the fixture-only window control are wired here
 * so the general smoke script only has to launch the App and hand over its connection.
 */
export async function prepareSideChatMode({ temp, entryPath, workspace, userDataDir, inputsPath, callsPath, identity, largeHistory = false }) {
  const ipcCountsPath = join(temp, 'side-chat-ipc-counts.json')
  const windowControlPath = join(temp, 'side-chat-window-control.json')
  // The isolated main entry imports the shipped main unchanged; it only counts IPC and, in
  // this mode, lets the run apply real native window sizes.
  writeIpcCountEntry(entryPath, ipcCountsPath, windowControlPath, sideChatRequestsPath(ipcCountsPath))
  const readsPath = join(temp, 'side-chat-reader-reads.jsonl')
  const seedPath = await prepareLargeHistorySeed({ temp, userDataDir, workspace })
  return {
    env: { SCRY_ELECTRON_SMOKE_SIDE_CHAT: '1', SCRY_ELECTRON_SMOKE_INPUTS: inputsPath,
      SCRY_ELECTRON_SMOKE_CALLS: callsPath, SCRY_ELECTRON_SMOKE_IDENTITY: identity,
      // The large-history pass needs a Provider that really owns and uses the reader.
      ...(largeHistory ? { SCRY_ELECTRON_SMOKE_READER: '1', SCRY_ELECTRON_SMOKE_READS: readsPath } : {}) },
    run: ({ cdp, evaluate, check, lifecycle }) => largeHistory
      ? exerciseLargeHistoryMode({ cdp, evaluate, check,
        options: { ipcCountsPath, inputsPath, callsPath, readsPath, seedPath, workspace, userDataDir, temp, windowControlPath } })
      : exerciseSideChatMode({
        cdp, evaluate, check, lifecycle,
        options: { ipcCountsPath, inputsPath, callsPath, seedPath, workspace, userDataDir, temp, windowControlPath },
        rendererFailures: []
      })
  }
}

/**
 * Writes the large-history parent before the App exists.
 *
 * Thousands of real Provider runs would be fixture cost, not acceptance value: the App
 * still reads this parent through its own store and archive, and the preview, creation,
 * first send and reader reads under test are the shipped ones. The seed script imports
 * the production store and archive modules, so the on-disk contract is not re-implemented
 * here, and it refuses to continue unless the parent really exceeds every removed ceiling.
 */
async function prepareLargeHistorySeed({ temp, userDataDir, workspace }) {
  const seedPath = join(temp, 'side-chat-large-history-seed.json')
  const bundle = join(temp, 'side-chat-large-history-seed.mjs')
  const esbuild = await import('esbuild')
  await esbuild.build({ entryPoints: [resolve('scripts/side-chat-large-history-seed.ts')], bundle: true,
    platform: 'node', format: 'esm', external: ['electron'], outfile: bundle, logLevel: 'silent' })
  const run = spawnSync(process.execPath, [bundle, '--user-data', userDataDir,
    '--workspace', join(temp, 'large-history-workspace'), '--out', seedPath], { encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`could not seed the large-history parent: ${run.stderr || run.stdout}`)
  return seedPath
}

/**
 * The side-chat acceptance the isolated production App really runs.
 *
 * One window proves the sends, the runtime independence, the history bounds and the
 * layout; the same temporary userData is then restarted to prove what survives. The
 * acceptance lives here instead of inside the general smoke script so the two stay
 * readable, and the artifact hashes name the exact `out/` bundle this evidence belongs to.
 */
async function exerciseSideChatMode({ cdp, evaluate, check, lifecycle, options, rendererFailures }) {
  // A real click that silently does nothing is a finding, so renderer failures are evidence.
  const step = (name) => console.log(`[scry] side-chat step: ${name}`)
  step('execution')
  const first = await exerciseSideChatExecution({ cdp, evaluate, check, rendererFailures, ...options })
  step('runtime')
  const runtime = await exerciseSideChatRuntime({ cdp, evaluate, check, rendererFailures, childId: first.childId, ...options })
  step('history')
  const history = await exerciseSideChatHistory({ cdp, evaluate, check, rendererFailures, childId: first.childId, ...options })
  step('scroll')
  const scroll = await exerciseSideChatScroll({ cdp, evaluate, check, rendererFailures, childId: first.childId, ...options })
  step('orphan')
  const orphan = await exerciseSideChatOrphan({ cdp, evaluate, check, rendererFailures, childId: first.childId, ...options })
  step('orphan reader')
  // Still on the deleted source's child: its frozen body and its own controls are read from
  // the child record alone, so this stays a separate pass from the delete it depends on.
  const orphanReader = await exerciseSideChatOrphanReader({ cdp, evaluate, check, rendererFailures,
    orphanChild: orphan.childId, hostAgent: orphan.hostAgent, draft: orphan.draft,
    expectedMessages: orphan.seededMessages, ...options })
  step('orphan paging')
  // The bounds of the orphan list: one page of groups and one page of rows per group, both
  // reached by real next/previous clicks. The extra grouped sources are real records.
  const orphanPaging = await exerciseSideChatOrphanPaging({ cdp, evaluate, check, rendererFailures,
    workspace: options.workspace, existingGroups: 1, knownKeys: [`conversation:${orphan.parentId}`], ...options })
  // The orphan pass leaves the window on the deleted source's child; the restart below must
  // resume from the original parent with its own child tab open, as a user would. The
  // parent is found by the row that owns the side-chat count, never by a title alone.
  step('restore')
  const restore = await exerciseSideChatRestore({ cdp, evaluate, check, rendererFailures,
    childId: first.childId, ...options })
  // A parent whose own archive is past every removed budget: preview, creation, the
  // shipped viewer and one real first send, all on a separate conversation.
  // The capability boundary on a Provider that declares no verified reader.
  step('large history refusal')
  const largeRefusal = await exerciseSideChatLargeHistoryRefusal({ cdp, evaluate, check, ...options })
  step('layout')
  const layout = await exerciseSideChatLayout({ cdp, evaluate, check, rendererFailures, childId: first.childId, ...options })
  // Two unsent states before the quit: a draft the user typed but never sent, and a
  // receipt whose send reply was lost. Only the durable record can answer both after the
  // restart, so neither may be replayed.
  step('drafts')
  const drafts = await prepareSideChatDrafts({ cdp, evaluate, check, rendererFailures, childId: first.childId,
    source: first.source, lostSendReplyPath: lostSendReplyPath(options.ipcCountsPath), ...options })
  // The same temporary userData and workspace come back after a real quit: layout and
  // drafts must return and nothing may be replayed or re-sent.
  step('restart')
  const documentEpoch = await evaluate('performance.timeOrigin')
  cdp.close()
  await lifecycle.stop(lifecycle.child())
  lifecycle.launch()
  const restored = await lifecycle.waitTarget(lifecycle.port, () => lifecycle.child())
  const live = lifecycle.connect(restored.page.webSocketDebuggerUrl)
  // The restarted App is a different renderer behind a different socket, so every read
  // below goes through the evaluator bound to this connection, never the closed one.
  const liveEvaluate = rendererEvaluator(live)
  let workbench
  let adoption
  let second
  let draftsRestored
  try {
    await live.send('Runtime.enable')
    await live.send('Page.enable')
    // The restored workbench is read first: a tab that only comes back after someone
    // reopens the child is not a restored layout.
    workbench = await verifySideChatWorkbenchAfterRestart({ cdp: live, evaluate: liveEvaluate, check, documentEpoch,
      rendererFailures, prepared: drafts, ...options })
    second = await verifySideChatRestart({ cdp: live, evaluate: liveEvaluate, check, documentEpoch,
      rendererFailures, childId: first.childId, parentConversationId: first.parentConversationId,
      expectedComposerValue: drafts.draftText, ...options })
    step('drafts restored')
    draftsRestored = await verifySideChatDrafts({ cdp: live, evaluate: liveEvaluate, check, rendererFailures,
      childId: first.childId, prepared: drafts, ...options })
    // Last, because it changes what the parent is: an explicit user Provider switch must
    // keep the running child's own record, tabs and run, and keep it reachable.
    step('adoption')
    adoption = await exerciseSideChatAdoption({ cdp: live, evaluate: liveEvaluate, check, rendererFailures,
      runChildId: drafts.workbench.children.at(-1), ...options })
  } finally {
    live.close()
  }
  // The bundle this acceptance really ran, so a later review can tell whether the reported
  // evidence belongs to the current build.
  const artifactPaths = ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html',
    ...readdirSync(resolve('out/renderer/assets')).filter(name => /\.(js|css)$/.test(name)).map(name => `out/renderer/assets/${name}`)]
  const artifactHashes = Object.fromEntries(artifactPaths.map((path) =>
    [path, createHash('sha256').update(readFileSync(resolve(path))).digest('hex')]))
  const result = { test: 'side-chat execution', ...first, runtime, history, scroll, orphan, orphanReader,
    orphanPaging, restore, layout, largeRefusal, drafts: draftsRestored, workbench, adoption, restart: second, artifactHashes }
  // The smoke temp tree is removed on exit; the capture directory persists, so the evidence
  // lives next to the screenshots this run really produced.
  const verificationPath = join(first.captures, 'verification.json')
  writeFileSync(verificationPath, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ test: result.test, captures: first.captures, verification: verificationPath,
    childId: first.childId, receipts: first.receipts.length, providers: [...new Set(first.receipts.map(receipt => receipt.provider))],
    artifactHashes }))
  return result
}

/**
 * The large-history acceptance on its own App launch.
 *
 * Only a Provider that really owns a history reader may freeze a prefix whose handoff
 * cannot fit inline, so this pass launches the packaged App with the reader-enabled smoke
 * adapter and asserts the whole chain: freeze, create, first send with a reader call,
 * reading the earliest/middle/latest frozen body, and the same reads after the parent is
 * deleted.
 */
async function exerciseLargeHistoryMode({ cdp, evaluate, check, options }) {
  const result = await exerciseSideChatLargeHistory({ cdp, evaluate, check, ...options })
  cdp.close()
  console.log(JSON.stringify({ test: 'side-chat large history', ...result }))
  return result
}
