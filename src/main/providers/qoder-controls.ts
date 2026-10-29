import { query, type Query } from '@qoder-ai/qoder-agent-sdk'
import type { ProviderContext } from '../../shared/provider'
import { sanitizeMcpAuthError } from './mcp-auth-security'
import { heldPrompt, qoderOptions } from './qoder-launch'

type QoderInitialization = Awaited<ReturnType<Query['initializationResult']>>

interface QoderInitializationEvidence {
  value: QoderInitialization
  observedAt: number
}

interface QoderControlRead<T> {
  value: T
  session: QoderControlSession
  initializedAt: number
}

interface QoderControlSession {
  key: string
  query: Query
  releasePrompt: () => void
  ready: Promise<QoderInitializationEvidence>
  active: number
  retired: boolean
  quiesced: Promise<void>
  resolveQuiesced: () => void
  closePromise?: Promise<void>
  startClose?: () => void
  closeStarted: boolean
  idleTimer?: NodeJS.Timeout
}

interface QoderControlRefresh {
  session: QoderControlSession
  promise: Promise<void>
  invalidated: boolean
}

const PROBE_TTL_MS = 30_000
const CONTROL_READY_TIMEOUT_MS = 20_000
const CONTROL_READY_TIMEOUT_REASON = `Qoder 控制会话 ${CONTROL_READY_TIMEOUT_MS / 1000} 秒内未完成初始化`
const CONTROL_CONTEXT_INVALIDATED_REASON = 'Qoder control context invalidated'

/**
 * Qoder 的 cwd 级控制会话池：只服务 skills / commands / runControls 读取，
 * 不承载模型执行。执行 run 每轮自建 transport 与 query。
 */
export interface QoderControlPool {
  withControl<T>(
    context: ProviderContext,
    read: (q: Query, initialized: QoderInitialization) => Promise<T>,
    options?: { requireFreshInitialization?: boolean }
  ): Promise<QoderControlRead<T>>
  current(key: string): QoderControlSession | undefined
  generation(key: string): number
  /** Last control-close failure, kept for `describe()` health without rethrowing into reads. */
  closeError(): string | undefined
  invalidate(context: ProviderContext): Promise<void>
  dispose(): Promise<void>
}

export function createQoderControls(): QoderControlPool {
  const controls = new Map<string, QoderControlSession>()
  const closingControls = new Map<string, Promise<void>>()
  const refreshingControls = new Map<string, QoderControlRefresh>()
  const ownedControls = new Set<QoderControlSession>()
  const contextGenerations = new Map<string, number>()
  let disposed = false
  let disposePromise: Promise<void> | undefined
  let lastControlCloseError: string | undefined

  const recordControlCloseFailure = (error: unknown): void => {
    lastControlCloseError = sanitizeMcpAuthError(error)
  }

  const closeControl = (key: string, session: QoderControlSession, mode: 'graceful' | 'cancel' = 'graceful'): Promise<void> => {
    if (session.closePromise) {
      if (mode === 'cancel') session.startClose?.()
      return session.closePromise
    }
    session.retired = true
    if (controls.get(key) === session) controls.delete(key)
    if (session.idleTimer) clearTimeout(session.idleTimer)
    if (session.active === 0) session.resolveQuiesced()
    let startClose!: () => void
    const closePromise = new Promise<void>((resolve, reject) => {
      startClose = () => {
        if (session.closeStarted) return
        session.closeStarted = true
        session.releasePrompt()
        void Promise.resolve().then(() => session.query.close()).then(
          () => {
            ownedControls.delete(session)
            if (closingControls.get(key) === closePromise) closingControls.delete(key)
            resolve()
          },
          (error) => {
            recordControlCloseFailure(error)
            reject(error)
          }
        )
      }
    })
    session.closePromise = closePromise
    session.startClose = startClose
    closingControls.set(key, closePromise)
    if (mode === 'cancel') startClose()
    else void session.quiesced.then(startClose)
    closePromise.then(() => {}, () => {})
    return closePromise
  }

  const waitForControlClose = async (key: string): Promise<void> => {
    const closing = closingControls.get(key)
    if (closing) await closing
  }

  const controlFor = (context: ProviderContext): QoderControlSession => {
    const key = context.cwd ?? ''
    const existing = controls.get(key)
    if (existing && !existing.retired) return existing
    if (disposed) throw new Error('Qoder adapter 已释放')
    const prompt = heldPrompt()
    const q = query({
      prompt: prompt.stream,
      options: { ...qoderOptions(context.cwd), persistSession: false } as never
    })
    let resolveQuiesced!: () => void
    const quiesced = new Promise<void>((resolve) => { resolveQuiesced = resolve })
    const ready = Promise.resolve(q.initializationResult()).then((value) => ({ value, observedAt: Date.now() }))
    const session: QoderControlSession = {
      key,
      query: q,
      releasePrompt: prompt.release,
      ready,
      active: 0,
      retired: false,
      quiesced,
      resolveQuiesced,
      closeStarted: false
    }
    controls.set(key, session)
    ownedControls.add(session)
    return session
  }

  const refreshControl = (context: ProviderContext, session: QoderControlSession): Promise<void> => {
    const key = context.cwd ?? ''
    const existing = refreshingControls.get(key)
    if (existing) return existing.promise
    const state = { session, invalidated: false } as QoderControlRefresh
    state.promise = (async () => {
      if (controls.get(key) === session) await closeControl(key, session)
      await waitForControlClose(key)
    })()
    refreshingControls.set(key, state)
    return state.promise
  }

  const acquireControl = async (context: ProviderContext, expectedGeneration: number): Promise<[string, QoderControlSession]> => {
    const key = context.cwd ?? ''
    while (true) {
      if ((contextGenerations.get(key) ?? 0) !== expectedGeneration) throw new Error(CONTROL_CONTEXT_INVALIDATED_REASON)
      const refresh = refreshingControls.get(key)
      if (refresh) {
        await refresh.promise
        if (refresh.invalidated || (contextGenerations.get(key) ?? 0) !== expectedGeneration) {
          if (refreshingControls.get(key) === refresh) refreshingControls.delete(key)
          throw new Error(CONTROL_CONTEXT_INVALIDATED_REASON)
        }
        if (refreshingControls.get(key) === refresh) refreshingControls.delete(key)
        const current = controls.get(key)
        if (current && !current.retired && !disposed) {
          if (current.idleTimer) clearTimeout(current.idleTimer)
          current.active++
          return [key, current]
        }
        const created = controlFor(context)
        created.active++
        return [key, created]
      }
      await waitForControlClose(key)
      // Expiry can establish a barrier while this acquisition yields, even when
      // its context generation is unchanged. Recheck before reserving a lease.
      if (refreshingControls.has(key) || closingControls.has(key)) continue
      if ((contextGenerations.get(key) ?? 0) !== expectedGeneration) throw new Error(CONTROL_CONTEXT_INVALIDATED_REASON)
      const current = controls.get(key)
      if (current && !current.retired && !disposed) {
        if (current.idleTimer) clearTimeout(current.idleTimer)
        current.active++
        return [key, current]
      }
      const created = controlFor(context)
      created.active++
      return [key, created]
    }
  }

  const awaitReady = async (session: QoderControlSession): Promise<QoderInitializationEvidence> =>
    Promise.race([
      session.ready,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(CONTROL_READY_TIMEOUT_REASON)), CONTROL_READY_TIMEOUT_MS)
        void session.ready.catch(() => {}).finally(() => clearTimeout(timer))
      })
    ])

  const withControl = async <T>(
    context: ProviderContext,
    read: (q: Query, initialized: QoderInitialization) => Promise<T>,
    options: { requireFreshInitialization?: boolean } = {}
  ): Promise<QoderControlRead<T>> => {
    const key = context.cwd ?? ''
    const expectedGeneration = contextGenerations.get(key) ?? 0
    const requireFreshInitialization = options.requireFreshInitialization !== false
    while (true) {
      const [currentKey, session] = await acquireControl(context, expectedGeneration)
      let refresh = false
      let result: T | undefined
      let initializedAt = 0
      try {
        const initialization = await awaitReady(session)
        initializedAt = initialization.observedAt
        refresh = session.retired || controls.get(currentKey) !== session || disposed ||
          (requireFreshInitialization && Date.now() - initialization.observedAt >= PROBE_TTL_MS)
        if (!refresh) result = await read(session.query, initialization.value)
      } catch (error) {
        const message = String((error as Error).message)
        if (message === CONTROL_READY_TIMEOUT_REASON || /transport|closed|process|broken pipe/i.test(message)) {
          void closeControl(currentKey, session, 'cancel').catch(recordControlCloseFailure)
        }
        throw error
      } finally {
        session.active--
        if (session.active === 0) {
          if (session.retired) session.resolveQuiesced()
          else if (controls.get(currentKey) === session) {
            session.idleTimer = setTimeout(() => { void closeControl(currentKey, session).catch(recordControlCloseFailure) }, 5_000)
          }
        }
      }
      if (refresh) {
        if (disposed) throw new Error('Qoder adapter 已释放')
        await refreshControl(context, session)
        continue
      }
      return { value: result as T, session, initializedAt }
    }
  }

  return {
    withControl,
    current: (key) => controls.get(key),
    generation: (key) => contextGenerations.get(key) ?? 0,
    closeError: () => lastControlCloseError,
    invalidate: async (context) => {
      const key = context.cwd ?? ''
      contextGenerations.set(key, (contextGenerations.get(key) ?? 0) + 1)
      const refresh = refreshingControls.get(key)
      if (refresh) {
        refresh.invalidated = true
        void closeControl(key, refresh.session, 'cancel').catch(recordControlCloseFailure)
        let failure: unknown
        try {
          await refresh.promise
        } catch (error) {
          failure = error
        }
        const replacement = controls.get(key)
        if (replacement) await closeControl(key, replacement, 'cancel')
        else await waitForControlClose(key)
        if (refreshingControls.get(key) === refresh) refreshingControls.delete(key)
        if (failure) throw failure
        return
      }
      const control = controls.get(key)
      if (control) await closeControl(key, control, 'cancel')
      else await waitForControlClose(key)
    },
    dispose: () => {
      if (disposePromise) return disposePromise
      disposed = true
      disposePromise = (async () => {
        const sessions = [...ownedControls]
        const closes = sessions.map((session) => closeControl(session.key, session, 'cancel'))
        const results = await Promise.allSettled(closes)
        contextGenerations.clear()
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failure) throw failure.reason
      })()
      return disposePromise
    }
  }
}
