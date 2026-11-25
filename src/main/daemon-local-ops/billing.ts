import type { DaemonLocalOpTable } from './types'

export const BILLING_LOCAL_OPS: DaemonLocalOpTable = {
  'agent:billingState': { op: 'billing', method: 'billingState', read: true },
  'agent:syncBillingAdmin': { op: 'billing', method: 'syncBillingAdmin', read: false },
  'agent:importBillingFixture': { op: 'billing', method: 'importBillingFixture', read: false }
}
