import type { DaemonLocalOpTable } from './types'

// Billing (B4-L4): the daemon owns scry.db, where the billing ledger lives. A sync calls
// the providers' admin APIs and writes rows, so it is never replayed and takes the long
// lane (paginated, 20 s per page); a fixture import writes rows too.
export const BILLING_LOCAL_OPS: DaemonLocalOpTable = {
  'agent:billingState': { op: 'billing', method: 'billingState', read: true },
  'agent:syncBillingAdmin': { op: 'billing', method: 'syncBillingAdmin', read: false },
  'agent:importBillingFixture': { op: 'billing', method: 'importBillingFixture', read: false }
}
