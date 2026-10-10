import assert from 'node:assert/strict'
import {aggregateRunning, prototypeRuns} from './aggregate.mjs'

const snapshot = aggregateRunning(prototypeRuns())
assert.equal(snapshot.running, 5)
assert.equal(snapshot.outputting, 3)
assert.deepEqual(snapshot.current, {value:32, measured:3}) // Mean of token rates 38/30/28, not converted character rates.
assert.ok(Math.abs(snapshot.wait.value - 1.4) < 1e-9)
assert.equal(snapshot.wait.measured, 5)
assert.deepEqual(snapshot.sessionAverage, {value:28, measured:5})

const unequal = [
  {running:true, phase:'output', tokenEvidence:'live-output', currentTokenRate:20, firstWait:2, averageTokenRate:20},
  {running:true, phase:'output', tokenEvidence:'live-output', currentTokenRate:100, firstWait:4, averageTokenRate:100},
  {running:false, phase:'output', tokenEvidence:'live-output', currentTokenRate:1000, firstWait:99, averageTokenRate:1000},
  {running:true, phase:'tool', tokenEvidence:'live-output', currentTokenRate:1000, firstWait:null, averageTokenRate:null},
  {running:true, phase:'output', tokenEvidence:'final-only', currentTokenRate:1000, firstWait:null, averageTokenRate:1000}
]
assert.deepEqual(aggregateRunning(unequal).current, {value:60, measured:2})
assert.deepEqual(aggregateRunning(unequal).sessionAverage, {value:60, measured:2}) // Final-only token usage cannot impersonate live evidence.
assert.deepEqual(aggregateRunning(unequal.slice(1)).current, {value:100, measured:1})
assert.deepEqual(aggregateRunning(unequal.map(run => ({...run, running:false}))).current, {value:null, measured:0})
assert.deepEqual(aggregateRunning(prototypeRuns('tool')).current, {value:null, measured:0})
assert.deepEqual(aggregateRunning(prototypeRuns('partial')).current, {value:38, measured:1})
assert.deepEqual(aggregateRunning([{...unequal[0], currentTokenRate:0}]).current, {value:0, measured:1})
assert.deepEqual(aggregateRunning(prototypeRuns('unavailable')).current, {value:null, measured:0})
assert.equal(aggregateRunning(prototypeRuns('unavailable')).wait.measured, 5) // First-text timing is independent of token-count availability.
console.log('PASS: token-only evidence, final-only excluded, equal-session mean, active ownership, unknown vs zero')
