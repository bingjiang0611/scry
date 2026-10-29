import { FileWorkflowStore } from '../../src/main/workflow-store'
import { closeAll } from './runtime'

const [root, value] = process.argv.slice(2)
try {
  const store = new FileWorkflowStore(root)
  await store.saveFrameWithValue({ schemaVersion: 1, workflowId: 'prototype-flow', programRevision: 'revision',
    frameId: 'node', nodeId: 'node', scopePath: [], inputKey: '0'.repeat(64), phase: 'completed' }, 1,
  { field: 'resultRef', key: value, evaluation: { state: 'known', value, derivedFrom: [] } })
  console.log(JSON.stringify({ status: 'committed' }))
} catch (error) {
  console.log(JSON.stringify({ status: 'refused', error: String(error) }))
} finally { await closeAll() }
