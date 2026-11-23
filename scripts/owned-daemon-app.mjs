import { stopOwnedApp } from './owned-app-processes.mjs'
import { daemonTree, stopBenchDaemon } from './session-open-bench-daemon.mjs'

export async function stopOwnedDaemonApp(child, userData, {
  scan = daemonTree, closeApp = stopOwnedApp, closeDaemon = stopBenchDaemon
} = {}) {
  const errors = []
  let tree = []
  let app
  let daemon
  try { tree = scan(userData) } catch (error) { errors.push(error) }
  // Leave the verified daemon tree to its supervisor. Try both cleanups
  // even if one identity scan or stop fails, and retain all the failures.
  try { app = await closeApp(child, { exclude: tree.map(row => row.pid) }) } catch (error) { errors.push(error) }
  try { daemon = await closeDaemon(userData, tree) } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Isolated App and daemon cleanup incomplete')
  return { ...app, daemon }
}
