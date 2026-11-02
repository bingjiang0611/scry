// Runtime protocol literals for the private client process (R6.3).
//
// Node runs the launcher modules directly, so the literals both sides share live in
// this plain module; scripts/fixtures/concurrency-trace-live-commands.ts declares the
// same values with literal types and a focused test asserts the two stay equal. The
// snapshot type is the fixed C1 request/reply name, reused unchanged.
export const CLIENT_MESSAGE_TYPE = 'concurrency-trace-live'
export const CLIENT_REPLY_TYPE = 'concurrency-trace-live:reply'
export const CLIENT_FAULT_TYPE = 'concurrency-trace-live:error'
export const SNAPSHOT_MESSAGE_TYPE = 'concurrency-snapshot'

export const CLIENT_COMMANDS = ['status', 'pair', 'finish', 'window', 'driver', 'counters', 'abandon', 'close']
export const DRIVER_METHODS = ['state', 'beginVisit', 'ready', 'round', 'endVisit', 'takeViews', 'releaseViews']
