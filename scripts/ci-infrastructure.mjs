// Runs only from the default branch in a workflow_run observer. Never import or
// execute code from the observed PR with the observer's actions:write token.
export function classifyFailure(job, log = '', annotations = []) {
  const failed = (job.steps ?? []).filter(step => step.conclusion === 'failure')
  const messages = annotations.map(item => item.message).join('\n')
  if (failed.length === 0 && !job.runner_id &&
    /runner.*(never (acquired|started)|not (acquired|started)|failed to (acquire|start))|failed to (?:start|acquire) (?:a |the )?(?:hosted )?runner|job was not acquired by runner|runner.*did not pick up/i.test(messages)) {
    return { category: 'infrastructure', reason: 'runner did not start' }
  }
  // Download errors printed by tests may be expected negative controls. Only a
  // failed dependency/provisioning step is eligible; assertions never retry.
  if (/AssertionError|FAIL\s+.*(?:test|spec)|tests? failed|expected .+ to (?:be|equal)/i.test(log)) {
    return { category: 'assertion', reason: 'assertion evidence; no automatic retry' }
  }
  const setup = /^(Run npm ci(?: |$)|Install (?:archive tools|dependencies)$|Set up job$|Set up Node|Run actions\/(?:checkout|setup-node)@|Prepare Electron executable$)/i
  if (failed.length === 0 || failed.some(step => !setup.test(step.name))) {
    return { category: 'unknown', reason: 'not a proven provisioning failure; inspect the original failure' }
  }
  if (/EAI_AGAIN|ENOTFOUND|Could not resolve host|Temporary failure resolving|Could not resolve ['"]|unable to resolve host/i.test(log)) {
    return { category: 'infrastructure', reason: 'dependency host DNS failure' }
  }
  if (/ECONNRESET|ETIMEDOUT|ERR_SOCKET_TIMEOUT|E: Failed to fetch https?:\/\/|npm (?:ERR!|error) (?:code )?(?:E503|E502)|The remote server returned an error: \((?:502|503|504)\)/i.test(log)) {
    return { category: 'infrastructure', reason: 'dependency download failure' }
  }
  return { category: 'unknown', reason: 'no recognized infrastructure evidence; no automatic retry' }
}

export async function observeInfrastructure({ github, context, core }) {
  const run = context.payload.workflow_run
  const repo = context.repo
  // Duplicate/late completion events must not start another retry while a new
  // attempt is running. The observer itself is serialized per workflow run.
  const current = await github.rest.actions.getWorkflowRun({ ...repo, run_id: run.id })
  if (current.data.status !== 'completed' || current.data.run_attempt !== run.run_attempt) {
    core.notice('Stale CI completion event; no retry requested')
    return
  }
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repo, run_id: run.id, filter: 'all', per_page: 100
  })
  // CI uses unique job names, including matrix coordinates. Keep all attempts so
  // a manual retry consumes the same one-retry budget. Ambiguous names fail closed.
  const histories = new Map()
  for (const job of jobs) {
    const history = histories.get(job.name) ?? []
    history.push(job)
    histories.set(job.name, history)
  }
  const rows = []
  let retryJob
  for (const history of histories.values()) {
    history.sort((left, right) => right.run_attempt - left.run_attempt || right.id - left.id)
    const job = history[0]
    if (job.conclusion !== 'failure' && job.conclusion !== 'startup_failure') continue
    let annotations = []
    if (job.check_run_url) {
      const checkRunId = Number(job.check_run_url.split('/').at(-1))
      annotations = await github.paginate(github.rest.checks.listAnnotations, { ...repo, check_run_id: checkRunId, per_page: 100 })
    }
    let log = ''
    // An unstarted runner has no logs; annotations are its authoritative evidence.
    if (job.runner_id) {
      const response = await github.rest.actions.downloadJobLogsForWorkflowRun({ ...repo, job_id: job.id })
      log = typeof response.data === 'string' ? response.data : Buffer.from(response.data).toString('utf8')
    }
    const result = classifyFailure(job, log, annotations)
    const eligible = result.category === 'infrastructure' && history.length === 1 && job.run_attempt === 1
    let action = 'no retry'
    if (eligible) {
      action = retryJob ? 'queued until the next completion' : 'selected for retry (1/1)'
      retryJob ??= job
    }
    rows.push([job.name, result.category, result.reason, action])
  }
  // Write classification before a mutation; API failure must not hide the evidence.
  await core.summary.addHeading('CI failure classification')
    .addLink(`Observed run ${run.id}, attempt ${run.run_attempt}`, run.html_url)
    .addTable([
      [{ data: 'Job', header: true }, { data: 'Category', header: true }, { data: 'Evidence', header: true }, { data: 'Action', header: true }],
      ...rows
    ]).write()
  if (retryJob) {
    // One request per completion avoids racing multiple reruns. The next completed
    // attempt drains another eligible job, never an unrelated failed assertion.
    await github.rest.actions.reRunJobForWorkflowRun({ ...repo, job_id: retryJob.id })
    core.notice(`Infrastructure retry (1/1): ${retryJob.name}`)
  }
}
