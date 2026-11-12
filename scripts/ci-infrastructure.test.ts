import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { classifyFailure, failedStepLog, observeInfrastructure } from './ci-infrastructure.mjs'

const failedStep = { started_at: '2026-01-01T00:01:00Z', completed_at: '2026-01-01T00:01:10Z', conclusion: 'failure' }
const setup = { runner_id: 42, steps: [{ ...failedStep, name: 'Install archive tools' }] }
describe('CI failure classification', () => {
  it.each(['Temporary failure resolving archive.ubuntu.com', 'EAI_AGAIN', 'ENOTFOUND registry.npmjs.org',
    'E: Failed to fetch https://mirror/ubuntu.deb', 'npm error code ECONNRESET'])(
    'recognizes dependency infrastructure: %s', log => {
      expect(classifyFailure(setup, log).category).toBe('infrastructure')
    })
  it('recognizes an unstarted runner only with explicit annotation evidence', () => {
    expect(classifyFailure({ runner_id: 0, steps: [] }, '', [{ message: 'The job was not acquired by runner' }]).category).toBe('infrastructure')
    expect(classifyFailure({ runner_id: 0, steps: [] }, '', [{ message: 'Failed to start a hosted runner. Please try re-running the job.' }]).category).toBe('infrastructure')
    expect(classifyFailure({ runner_id: 0, steps: [] }).category).toBe('unknown')
  })
  it('does not retry assertions, negative-control DNS messages, or ordinary failures', () => {
    expect(classifyFailure(setup, 'ENOTFOUND\nAssertionError: expected false to be true').category).toBe('assertion')
    expect(classifyFailure({ ...setup, steps: [{ name: 'Unit, contract tests and coverage shard', conclusion: 'failure' }] }, 'ENOTFOUND').category).toBe('unknown')
    expect(classifyFailure(setup, 'package not found').category).toBe('unknown')
    expect(classifyFailure(setup, 'npm error code EUSAGE').category).toBe('unknown')
  })
})

function fixture(attempt = 1) {
  const jobs = [
    { ...setup, id: 1, name: 'packaged-linux', run_attempt: 1, conclusion: 'failure' },
    { id: 2, name: 'unit', runner_id: 43, run_attempt: 1, conclusion: 'failure', steps: [{ ...failedStep, name: 'Unit tests' }] }
  ]
  const github = {
    paginate: vi.fn(async () => jobs),
    rest: {
      actions: {
        getWorkflowRun: vi.fn(async () => ({ data: { status: 'completed', run_attempt: attempt } })),
        listJobsForWorkflowRun: vi.fn(),
        downloadJobLogsForWorkflowRun: vi.fn(async ({ job_id }: { job_id: number }) => ({ data: `2026-01-01T00:01:05.1234567Z ${job_id === 2 ? 'AssertionError' : 'Temporary failure resolving archive.ubuntu.com'}` })),
        reRunJobForWorkflowRun: vi.fn(async () => ({}))
      },
      checks: { listAnnotations: vi.fn() }
    }
  }
  const summary = { addHeading: vi.fn().mockReturnThis(), addLink: vi.fn().mockReturnThis(), addTable: vi.fn().mockReturnThis(), write: vi.fn() }
  const core = { notice: vi.fn(), summary }
  const context = { repo: { owner: 'example', repo: 'test' }, payload: { workflow_run: { id: 99, run_attempt: attempt, html_url: 'https://example.invalid/run' } } }
  return { github, context, core, jobs }
}

it('reruns only the infrastructure job once, never the failed test job', async () => {
  const options = fixture()
  await observeInfrastructure(options)
  expect(options.github.rest.actions.reRunJobForWorkflowRun.mock.calls).toEqual([[{ owner: 'example', repo: 'test', job_id: 1 }]])
  expect(options.core.notice).toHaveBeenCalledWith(expect.stringContaining('Infrastructure retry (1/1)'))
  expect(options.core.summary.addTable).toHaveBeenCalledWith(expect.arrayContaining([
    expect.arrayContaining(['assertion', 'no retry'])
  ]))
})

it('classifies a second attempt but does not retry it', async () => {
  const options = fixture(2)
  options.jobs.push({ ...options.jobs[0], id: 3, run_attempt: 2 })
  await observeInfrastructure(options)
  expect(options.github.rest.actions.reRunJobForWorkflowRun).not.toHaveBeenCalled()
  expect(options.core.summary.write).toHaveBeenCalledOnce()
})

it('serializes multiple infrastructure retries across completion events without rerunning assertions', async () => {
  const options = fixture()
  options.jobs.push({ ...options.jobs[0], id: 3, name: 'cli-compat (20)' })
  await observeInfrastructure(options)
  expect(options.github.rest.actions.reRunJobForWorkflowRun).toHaveBeenCalledExactlyOnceWith({ owner: 'example', repo: 'test', job_id: 1 })
  options.github.rest.actions.reRunJobForWorkflowRun.mockClear()
  options.context.payload.workflow_run.run_attempt = 2
  options.github.rest.actions.getWorkflowRun.mockResolvedValue({ data: { status: 'completed', run_attempt: 2 } })
  options.jobs.push({ ...options.jobs[0], id: 4, run_attempt: 2, conclusion: 'success' })
  await observeInfrastructure(options)
  expect(options.github.rest.actions.reRunJobForWorkflowRun).toHaveBeenCalledExactlyOnceWith({ owner: 'example', repo: 'test', job_id: 3 })
  options.github.rest.actions.reRunJobForWorkflowRun.mockClear()
  options.context.payload.workflow_run.run_attempt = 3
  options.github.rest.actions.getWorkflowRun.mockResolvedValue({ data: { status: 'completed', run_attempt: 3 } })
  options.jobs.push({ ...options.jobs[2], id: 5, run_attempt: 3 }) // the one retry still fails
  await observeInfrastructure(options)
  expect(options.github.rest.actions.reRunJobForWorkflowRun).not.toHaveBeenCalled()
})

it('ignores stale completion events rather than racing an active attempt', async () => {
  const options = fixture()
  options.github.rest.actions.getWorkflowRun.mockResolvedValue({ data: { status: 'in_progress', run_attempt: 2 } })
  await observeInfrastructure(options)
  expect(options.github.paginate).not.toHaveBeenCalled()
  expect(options.github.rest.actions.reRunJobForWorkflowRun).not.toHaveBeenCalled()
})

it('does not use successful-step DNS logs to retry an unrelated failed install contract', async () => {
  const options = fixture()
  options.jobs[0].steps = [
    { name: 'Prepare cache', conclusion: 'success', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:01:00Z' },
    { ...failedStep, name: 'Run npm ci' }
  ]
  options.github.rest.actions.downloadJobLogsForWorkflowRun.mockImplementation(async ({ job_id }: { job_id: number }) => ({ data: job_id === 2
    ? '2026-01-01T00:01:05Z AssertionError'
    : '2026-01-01T00:00:30Z ENOTFOUND\n2026-01-01T00:01:05Z npm error code EUSAGE' }))
  await observeInfrastructure(options)
  expect(options.github.rest.actions.reRunJobForWorkflowRun).not.toHaveBeenCalled()
  expect(options.core.summary.addTable).toHaveBeenCalledWith(expect.arrayContaining([
    expect.arrayContaining(['unknown', 'no retry'])
  ]))
})

it('rejects unscoped or ambiguous boundary logs instead of guessing their step', () => {
  const job = { steps: [
    { name: 'Prepare cache', conclusion: 'success', started_at: '2026-01-01T00:00:00Z', completed_at: failedStep.started_at },
    { ...failedStep, name: 'Run npm ci' }
  ] }
  expect(failedStepLog(job, '2026-01-01T00:01:00.123Z ENOTFOUND')).toBe('')
  expect(failedStepLog(job, 'ENOTFOUND')).toBe('')
  expect(failedStepLog({ steps: [{ name: 'Run npm ci', conclusion: 'failure' }] }, '2026-01-01T00:01:05Z ENOTFOUND')).toBe('')
  expect(failedStepLog(job, '2026-01-01T00:01:05.1234567Z ENOTFOUND')).toContain('ENOTFOUND')
})

it('never executes the observed PR revision in the privileged observer', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci-infrastructure.yml', import.meta.url), 'utf8')
  expect(workflow).toContain('workflow_run:')
  expect(workflow).toContain('ref: ${{ github.event.repository.default_branch }}')
  expect(workflow).toContain('persist-credentials: false')
  expect(workflow).not.toMatch(/ref:.*head_sha|pull_request_target|download-artifact/)
})
