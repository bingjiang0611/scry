import assert from 'node:assert/strict'
import {aggregateRunning, prototypeRuns} from './aggregate.mjs'

const snapshot = aggregateRunning(prototypeRuns())
assert.equal(snapshot.running, 5)
assert.equal(snapshot.outputting, 3)
assert.deepEqual(snapshot.current, {value:84, measured:3}) // Not first run (92) or sum (252).
assert.ok(Math.abs(snapshot.wait.value - 1.4) < 1e-9)
assert.equal(snapshot.wait.measured, 5)
assert.deepEqual(snapshot.sessionAverage, {value:78, measured:5})

const unequal = [
  {running:true, phase:'output', currentRate:20, firstWait:2, averageRate:20},
  {running:true, phase:'output', currentRate:100, firstWait:4, averageRate:100},
  {running:false, phase:'output', currentRate:1000, firstWait:99, averageRate:1000},
  {running:true, phase:'tool', currentRate:1000, firstWait:null, averageRate:null}
]
assert.deepEqual(aggregateRunning(unequal).current, {value:60, measured:2})
assert.deepEqual(aggregateRunning(unequal.slice(1)).current, {value:100, measured:1}) // Ended run leaves cohort.
assert.deepEqual(aggregateRunning(unequal.map(run => ({...run, running:false}))).current, {value:null, measured:0})
assert.deepEqual(aggregateRunning(prototypeRuns('tool')).current, {value:null, measured:0})
assert.deepEqual(aggregateRunning(prototypeRuns('partial')).current, {value:92, measured:1}) // Missing four are not zero.
assert.deepEqual(aggregateRunning([{...unequal[0], currentRate:0}]).current, {value:0, measured:1}) // Observed zero is valid.
assert.deepEqual(aggregateRunning(prototypeRuns('unavailable')).wait, {value:null, measured:0})
console.log('PASS: equal-session mean, active-only ownership, coverage, tool exclusion, unknown vs measured zero')
