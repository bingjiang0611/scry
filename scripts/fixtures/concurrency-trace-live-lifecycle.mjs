// Ownership of a spawned measurement process (R6.3).
//
// A child is owned from the moment it is spawned, not from the moment its startup succeeds:
// the launcher stores the handle first and awaits `ready()` afterwards, so a failed startup
// still has an owner that stops it.
//
// Shutdown has one owner and one order:
//   1. optional peer/CDP cleanup — never a process exit,
//   2. the real stopOwnedApp while the root is still alive, which captures the identity of
//      the tree and signals it until convergence,
//   3. the close the child really produced, then a read-only inspection.
// A root that already exited reports `descendants: 'unknown'`, and that is reported as an
// unproven cleanup instead of being counted as a clean shutdown.
import { inspectOwnedApp, stopOwnedApp } from '../owned-app-processes.mjs'

const describe = (error) => (error instanceof Error ? error.message : String(error))

/**
 * @param {object} input
 * @param {string} input.name process label used in the report
 * @param {object} input.child spawned child (must exist before this is called)
 * @param {object} input.childClose watchChildClose() handle
 * @param {object} input.snapshots openSnapshotChannel() handle
 * @param {(child: object) => object} [input.inspect] defaults to inspectOwnedApp(child)
 * @param {(child: object) => Promise<object>} [input.stopProcess] defaults to stopOwnedApp(child)
 * @param {() => Promise<any>} [input.requestClose] peer/transport cleanup only
 */
export function ownedChild({ name, child, childClose, snapshots, inspect, stopProcess, requestClose }) {
  // The real helpers need the child handle: calling inspectOwnedApp() without it returns
  // `not-started` forever, which would hide a live process tree. Both defaults therefore
  // receive the child explicitly.
  const inspectChild = inspect ?? ((target) => inspectOwnedApp(target))
  const stopChild = stopProcess ?? ((target) => stopOwnedApp(target))
  const record = {
    name,
    pid: child?.pid ?? null,
    phase: 'spawned',
    ready: null,
    startupError: null,
    identity: null,
    stop: null,
    close: null,
    owned: null,
    inspection: null,
    faults: []
  }

  return {
    record,
    child,
    childClose,
    snapshots,

    /** Runs the process's readiness checks. A failure leaves the handle owned and stoppable. */
    async ready(run) {
      record.identity = inspectChild(child)
      try {
        const value = await run()
        record.phase = 'ready'
        record.ready = value ?? null
        return value
      } catch (error) {
        record.phase = 'startup-failed'
        record.startupError = describe(error)
        throw error
      }
    },

    /** Called when the launcher observed a fault for this process (never swallows it). */
    fault(phase, error) {
      record.faults.push({ phase, error: describe(error) })
    },

    /** Stops the process exactly once, in the order documented at the top of this file. */
    async shutdown(reason = 'launcher') {
      if (record.stop) return record
      record.stop = { reason, atMs: Date.now() }
      if (requestClose) {
        record.stop.closeRequest = await requestClose().then(
          (value) => ({ requested: true, value }),
          (error) => ({ requested: false, error: describe(error) })
        )
      }
      try { snapshots?.close() } catch (error) { record.faults.push({ phase: 'snapshot-close', error: describe(error) }) }
      // Ownership capture and signalling must happen while the root is alive; the helper
      // refuses to pretend otherwise and that refusal is reported, not swallowed.
      record.stop.identityBefore = inspectChild(child)
      record.owned = await stopChild(child).then(
        (value) => ({ status: 'stopped', ...value }),
        (error) => ({ status: 'failed', error: describe(error) })
      )
      record.close = await childClose.wait()
      record.inspection = inspectChild(child)
      record.phase = record.phase === 'ready' ? 'stopped' : record.phase
      return record
    }
  }
}

/**
 * Turns ownership records into report issues. Any startup failure, missing stop, failed
 * convergence, unobserved close or surviving process makes the run not-completed.
 *
 * `inspection.state === 'exited'` is expected after a successful stop (the root has exited);
 * it proves nothing on its own, so the verdict depends on `owned.status === 'stopped'`.
 */
export function lifecycleVerdict(records) {
  const issues = []
  for (const record of records) {
    if (!record) continue
    if (record.phase === 'startup-failed') issues.push(`${record.name}: startup failed (${record.startupError ?? 'unknown error'}) and the handle was stopped by its owner`)
    else if (record.phase !== 'stopped') issues.push(`${record.name}: phase ${record.phase} was not stopped`)
    if (!record.stop) issues.push(`${record.name}: stop was never requested`)
    else if (record.stop.closeRequest && record.stop.closeRequest.requested === false) issues.push(`${record.name}: peer/transport cleanup failed (${record.stop.closeRequest.error})`)
    if (!record.owned) issues.push(`${record.name}: descendant cleanup was never confirmed`)
    else if (record.owned.status === 'failed') issues.push(`${record.name}: owned cleanup failed (${record.owned.error})`)
    if (!record.close) issues.push(`${record.name}: close state was never observed`)
    else if (record.close.state !== 'closed') issues.push(`${record.name}: close ${record.close.state}${record.close.reason ? ` (${record.close.reason})` : ''}`)
    if (record.inspection) {
      if (record.inspection.state === 'observed') issues.push(`${record.name}: process tree still observed running after cleanup`)
      else if (record.inspection.state !== 'exited') issues.push(`${record.name}: final inspection is ${record.inspection.state}, so cleanup is unproven`)
    }
    for (const fault of record.faults) issues.push(`${record.name}: ${fault.phase} fault (${fault.error})`)
  }
  return { ok: issues.length === 0, issues }
}
