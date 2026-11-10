#!/usr/bin/env node
// Compare one provider event-log thread against the workflow projection it feeds.
//
// Input: a `<userData>/provider-event-log/<thread>/` directory written by
// `SCRY_PROVIDER_EVENT_LOG=1`. The log holds the native Provider messages and the
// canonical trace events Scry derived from them, in one sequence.
//
// The check is line-by-line, not by eye:
//   1. replay the native messages through the production normalizer and require that the
//      replayed `harness/workflow_activity` events equal the canonical ones in the log;
//   2. fold both into the renderer projection and require that the final provider snapshot
//      and the projection agree row by row (phase titles, agent indexes, labels, states);
//   3. when `--panel <json>` is given, require that the DOM state read from the real App
//      matches the projection.
//
// Exits 1 on any mismatch and prints a JSON report either way.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadWorkflowModules } from './workflow-wire-modules.mjs'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const target = args.find((value, index) => !value.startsWith('--') && args[index - 1] !== '--panel')

function readRecords(path) {
  const stat = statSync(path)
  const files = stat.isDirectory()
    ? readdirSync(path).filter((name) => /^events-\d{3}\.ndjson$/.test(name)).sort().map((name) => join(path, name))
    : [path]
  const records = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim()) records.push(JSON.parse(line))
    }
  }
  return records.sort((left, right) => left.seq - right.seq)
}

const workflowToolUses = (records) => {
  const found = []
  for (const record of records) {
    if (record.stream !== 'native' || record.payload?.type !== 'assistant') continue
    for (const block of record.payload.message?.content ?? []) {
      if (block?.type === 'tool_use' && block.name === 'Workflow') found.push({ id: block.id, input: block.input })
    }
  }
  return found
}

const workflowToolResults = (records, ids) => records
  .filter((record) => record.stream === 'native' && record.payload?.type === 'user')
  .flatMap((record) => (record.payload.message?.content ?? [])
    .filter((block) => block?.type === 'tool_result' && ids.has(block.tool_use_id))
    .map((block) => ({
      toolUseId: block.tool_use_id,
      isError: block.is_error === true,
      content: typeof block.content === 'string' ? block.content.slice(0, 2_000) : block.content,
      toolUseResult: record.payload.tool_use_result ?? record.payload.toolUseResult
    })))

const TASK_SUBTYPES = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification'])
const taskEvents = (records) => records
  .filter((record) => record.stream === 'native' && record.payload?.type === 'system' && TASK_SUBTYPES.has(record.payload.subtype))
  .map((record) => ({ seq: record.seq, payload: record.payload }))

function wireRowState(row) {
  return row && typeof row === 'object' ? { type: row.type, index: row.index, state: row.state, label: row.label, title: row.title } : undefined
}

/** Final provider snapshot of one task: the last event that carried workflow_progress. */
function finalSnapshot(events, taskId) {
  let snapshot
  let rowTotal
  for (const event of events) {
    const payload = event.payload
    if (payload.task_id !== taskId && payload.taskId !== taskId) continue
    if (Array.isArray(payload.workflow_progress)) {
      snapshot = payload.workflow_progress
      rowTotal = snapshot.length
    }
  }
  return { snapshot, rowTotal }
}

function projectPhases(run) {
  return run.phases.map((phase) => ({
    title: phase.title,
    declared: phase.declared,
    status: phase.status,
    settled: phase.settled,
    agents: phase.agents.map((agent) => ({
      index: agent.row.index,
      label: agent.row.label ?? null,
      wireState: agent.row.state,
      status: agent.status
    }))
  }))
}

function compareRows(snapshot, run) {
  const mismatches = []
  const wirePhases = snapshot.filter((row) => row.type === 'workflow_phase')
    .map((row) => ({ index: row.index, title: row.title }))
  const projectionPhases = run.phases.map((phase) => ({ index: phase.index, title: phase.title }))
  for (const wire of wirePhases) {
    const match = projectionPhases.find((phase) => phase.title === wire.title)
    if (!match) mismatches.push({ kind: 'phase-missing', wire })
  }
  if (projectionPhases.length !== wirePhases.length) {
    mismatches.push({ kind: 'phase-count', wire: wirePhases.length, projection: projectionPhases.length })
  }
  const wireAgents = snapshot.filter((row) => row.type === 'workflow_agent')
  const projected = run.phases.flatMap((phase) => phase.agents.map((agent) => ({ phase: phase.title, row: agent.row, status: agent.status })))
  for (const wire of wireAgents) {
    const match = projected.find((agent) => agent.row.index === wire.index)
    if (!match) { mismatches.push({ kind: 'agent-missing', wire: wireRowState(wire) }); continue }
    if (match.row.state !== wire.state) mismatches.push({ kind: 'agent-state', wire: wireRowState(wire), projection: wireRowState(match.row) })
    if ((wire.label ?? null) !== (match.row.label ?? null)) mismatches.push({ kind: 'agent-label', wire: wire.label ?? null, projection: match.row.label ?? null })
    if (wire.phaseTitle && match.phase !== wire.phaseTitle) mismatches.push({ kind: 'agent-phase', wire: wire.phaseTitle, projection: match.phase })
  }
  if (wireAgents.length !== projected.length) {
    mismatches.push({ kind: 'agent-count', wire: wireAgents.length, projection: projected.length })
  }
  return mismatches
}

function comparePanel(panel, run) {
  const mismatches = []
  if (panel.status && panel.status !== run.status) mismatches.push({ kind: 'panel-status', panel: panel.status, projection: run.status })
  if (typeof panel.agentCount === 'number' && panel.agentCount !== run.agentCount) {
    mismatches.push({ kind: 'panel-agent-count', panel: panel.agentCount, projection: run.agentCount })
  }
  const projected = run.phases.map((phase) => ({ title: phase.title, total: phase.agents.length, settled: phase.settled }))
  if (Array.isArray(panel.phases)) {
    if (panel.phases.length !== projected.length) {
      mismatches.push({ kind: 'panel-phase-count', panel: panel.phases.length, projection: projected.length })
    }
    for (const phase of panel.phases) {
      const match = projected.find((candidate) => candidate.title === phase.title)
      if (!match) { mismatches.push({ kind: 'panel-phase-missing', panel: phase.title }); continue }
      if (match.total !== phase.total) mismatches.push({ kind: 'panel-phase-total', title: phase.title, panel: phase.total, projection: match.total })
      if (match.settled !== phase.settled) mismatches.push({ kind: 'panel-phase-settled', title: phase.title, panel: phase.settled, projection: match.settled })
      for (const agent of phase.agents ?? []) {
        const expected = run.phases.flatMap((candidate) => candidate.agents).find((candidate) => (candidate.row.label ?? null) === agent.label)
        if (!expected) mismatches.push({ kind: 'panel-agent-missing', label: agent.label })
        else if (agent.status && agent.status !== expected.status) {
          mismatches.push({ kind: 'panel-agent-status', label: agent.label, panel: agent.status, projection: expected.status })
        }
      }
    }
  }
  return mismatches
}

const records = readRecords(target)
const { normalizeSdkMessage, deriveWorkflowRuns } = await loadWorkflowModules()
const toolUses = workflowToolUses(records)
const useIds = new Set(toolUses.map((use) => use.id))
const toolResults = workflowToolResults(records, useIds)
const tasks = taskEvents(records)

const workflowTaskIds = [...new Set(tasks
  .filter((event) => event.payload.task_type === 'local_workflow' || Array.isArray(event.payload.workflow_progress) || useIds.has(event.payload.tool_use_id))
  .map((event) => event.payload.task_id ?? event.payload.taskId)
  .filter(Boolean))]

// Replay: the same native messages through the same normalizer, in log order.
let counter = 0
const ctx = { runId: 'replay', newId: () => `ev-${counter++}`, now: () => '2026-11-10T00:00:00.000Z' }
const replayed = []
for (const record of records) {
  if (record.stream !== 'native') continue
  if (!['system', 'assistant', 'user', 'attachment'].includes(record.payload?.type)) continue
  replayed.push(...normalizeSdkMessage(record.payload, ctx))
}
const canonical = records
  .filter((record) => record.stream === 'canonical' && record.type === 'harness/workflow_activity')
  .map((record) => record.payload)
const replayedWorkflow = replayed.filter((event) => event.stage === 'workflow_activity')

const mismatches = []
// Compare the whole derived payload, not just task/sequence: a changed row keeps its key.
const fingerprint = (event) => JSON.stringify({
  taskId: event.input?.taskId, seq: event.input?.seq, activity: event.input?.activity,
  rows: event.input?.rows ?? null, rowTotal: event.input?.rowTotal ?? null,
  rowsOmitted: event.input?.rowsOmitted ?? null, rowsUnrecognized: event.input?.rowsUnrecognized ?? null,
  status: event.input?.status ?? null, usage: event.input?.usage ?? null
})
const recordedKeys = canonical.map(fingerprint)
const replayedKeys = replayedWorkflow.map(fingerprint)
if (JSON.stringify(recordedKeys) !== JSON.stringify(replayedKeys)) {
  const firstDiff = recordedKeys.findIndex((value, index) => value !== replayedKeys[index])
  mismatches.push({
    kind: 'canonical-replay-mismatch', recorded: recordedKeys.length, replayed: replayedKeys.length,
    firstDiff: firstDiff === -1 ? null : {
      index: firstDiff,
      recorded: firstDiff < recordedKeys.length ? JSON.parse(recordedKeys[firstDiff]) : null,
      replayed: firstDiff < replayedKeys.length ? JSON.parse(replayedKeys[firstDiff]) : null
    }
  })
}

const turn = { runId: 'replay', userText: 'workflow run', items: replayed, done: true }
const runs = deriveWorkflowRuns([turn], { busy: false })
const run = runs.at(-1)

const perTask = workflowTaskIds.map((taskId) => {
  const events = tasks.filter((event) => (event.payload.task_id ?? event.payload.taskId) === taskId)
  const { snapshot, rowTotal } = finalSnapshot(events, taskId)
  const notification = events.filter((event) => event.payload.subtype === 'task_notification').map((event) => event.payload.status)
  const projected = run && run.taskId === taskId ? run : runs.find((candidate) => candidate.taskId === taskId)
  const rowMismatches = snapshot && projected ? compareRows(snapshot, projected) : []
  mismatches.push(...rowMismatches)
  const canonicalEvents = replayedWorkflow.filter((event) => event.input?.taskId === taskId)
  return {
    taskId,
    nativeEvents: events.length,
    nativeSubtypes: events.reduce((counts, event) => ({ ...counts, [event.payload.subtype]: (counts[event.payload.subtype] ?? 0) + 1 }), {}),
    workflowProgressObserved: events.some((event) => Array.isArray(event.payload.workflow_progress)),
    lastRowTotal: rowTotal,
    finalRowTypes: snapshot?.reduce((counts, row) => ({ ...counts, [`${row.type}:${row.state ?? 'phase'}`]: (counts[`${row.type}:${row.state ?? 'phase'}`] ?? 0) + 1 }), {}),
    notificationStatuses: notification,
    toolUseIdsOnTaskEvents: [...new Set(events.map((event) => event.payload.tool_use_id).filter(Boolean))],
    canonicalEvents: canonicalEvents.length,
    canonicalRows: canonicalEvents.reduce((total, event) => total + (event.input?.rows?.length ?? 0), 0),
    unrecognizedRows: canonicalEvents.reduce((total, event) => total + (event.input?.rowsUnrecognized ?? 0), 0),
    seqContinuous: canonicalEvents.every((event, index) => event.input.seq === index + 1),
    projection: projected ? projectPhases(projected) : null,
    projectionStatus: projected ? { status: projected.status, statusSource: projected.statusSource, progress: projected.progress } : null
  }
})

const panelPath = flag('--panel')
if (panelPath && run) mismatches.push(...comparePanel(JSON.parse(readFileSync(panelPath, 'utf8')), run))

const bytes = (() => {
  const stat = statSync(target)
  if (!stat.isFile()) return readdirSync(target).filter((name) => name.endsWith('.ndjson')).reduce((total, name) => total + statSync(join(target, name)).size, 0)
  return stat.size
})()

const report = {
  target,
  logBytes: bytes,
  records: records.length,
  toolUses: toolUses.map((use) => ({ id: use.id, inputKeys: Object.keys(use.input ?? {}) })),
  toolResults: toolResults.map((result) => ({
    toolUseId: result.toolUseId,
    isError: result.isError,
    toolUseResult: result.toolUseResult === undefined ? null : result.toolUseResult,
    content: result.content
  })),
  tasks: perTask,
  runs: runs.map((candidate) => ({ id: candidate.id, taskId: candidate.taskId, status: candidate.status, statusSource: candidate.statusSource })),
  mismatches
}

console.log(JSON.stringify(report, null, 2))
if (mismatches.length > 0) process.exitCode = 1
