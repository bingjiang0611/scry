import { useState } from 'react'
import type { Turn } from '../format'

/**
 * Fork state for one turn, split out of the chat turn component so the turn's rendering
 * code stays readable. A provider turn needs an authoritative boundary before it can be
 * forked: a failed turn that never reported one would fork from the wrong place.
 */
export function useTurnFork({ turn, onForkTurn }: {
  turn: Turn
  onForkTurn?: (turn: Turn) => Promise<void>
}) {
  const [forking, setForking] = useState(false)
  const [forkError, setForkError] = useState<string | null>(null)
  const canFork = Boolean(
    onForkTurn && turn.done && turn.providerTurnId && (turn.forkTurnId ?? turn.providerTurnId)
  )
  const forkLabel = turn.error ? '从失败处恢复' : '在新会话中分支'
  const forkTitle = turn.error ? '从失败轮次创建恢复分支' : '从此轮创建分支会话'
  const forkAtTurn = async (): Promise<void> => {
    if (!onForkTurn || forking) return
    setForking(true)
    setForkError(null)
    try {
      await onForkTurn(turn)
    } catch (error) {
      setForkError(error instanceof Error ? error.message : String(error))
    } finally {
      setForking(false)
    }
  }
  return { canFork, forkLabel, forkTitle, forkAtTurn, forking, forkError }
}
