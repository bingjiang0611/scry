// What the archive replay needs on disk before the App starts.
//
// Moved out of the smoke module so both stay readable; the seeding itself is production
// layout, not a bespoke one (see archived-turn-smoke.mjs).
import { readFileSync } from 'node:fs'
import { seedArchivedTurn, seedNativeTranscript } from './archived-turn-smoke.mjs'

// Second launch of the same temporary userData/HOME: nothing is seeded again, so a session
// that appears proves the App read it back from disk after a real quit and restart.
export const workflowArchiveReuse = process.argv[5] === '--reuse'

/** Preview text of the second replayed session: same archive, no workflow rows. */
export const PLAIN_SESSION_PREVIEW = 'Plain replay'

/** Seed the archived turn and its Provider transcript for the first launch of the replay. */
export function prepareWorkflowArchive({ userDataDir, home, source, nativePath }) {
  seedArchivedTurn({ userDataDir, source, preview: 'Archived workflow replay', rewrite: !workflowArchiveReuse })
  // A second session without workflow rows: switching to it must not keep showing the first
  // session's run, and switching back must restore it.
  seedArchivedTurn({
    userDataDir,
    source: {
      ...source,
      sessionId: 'plain-replay',
      externalSessionId: 'plain-replay',
      turns: [{
        ...source.turns[0],
        runId: 'plain-replay',
        items: source.turns[0].items.filter((item) => item.stage !== 'workflow_activity')
      }]
    },
    preview: PLAIN_SESSION_PREVIEW,
    rewrite: !workflowArchiveReuse
  })
  // On a relaunch the transcript must already be on disk from the previous process.
  if (workflowArchiveReuse) return
  const rows = readFileSync(nativePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  seedNativeTranscript({ home, cwd: source.cwd, sessionId: 'workflow-archive-replay', messages: rows })
}

