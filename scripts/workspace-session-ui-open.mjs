// A managed worktree cwd is deliberately not a sidebar project: src/main/bootstrap/workspace-runtime.ts
// rememberProject() skips managed worktree paths so opening a worktree session never adds an empty
// project, and the fixture asserts that storage id has no project group. The real workspace entry for
// such a cwd is the session that ran inside it, nested under its source project: selecting that row
// sets the renderer and diff inspector to the worktree without starting a Provider run.
export async function openWorktreeSession({ cwd, evaluate, click, wait }) {
  let catalog = []
  // Failure-only evidence: the cwd every catalog session binds, so a missing session is diagnosable.
  const describe = () => JSON.stringify(catalog.map(project => ({
    project: project.cwd, sessions: (project.sessions ?? []).map(session => session.cwd ?? project.cwd) })))
  const sessionId = await wait(async () => {
    catalog = await evaluate('window.scry.listProjects()')
    return catalog.flatMap(project => project.sessions ?? []).find(session => session.cwd === cwd)?.sessionId ?? null
  }, `worktree session for ${cwd}`).catch(error => {
    throw new Error(`${error.message}; catalog=${describe()}`, { cause: error })
  })
  await click(`.sb-sess-row[data-motion-key$=":${sessionId}"] .sb-sess`)
}
