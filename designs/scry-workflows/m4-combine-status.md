# M4 combine slice status

Implemented in the current WIP:

- `combine` is a typed Main SystemStep with a base replica expression and bounded candidate collection expression.
- Candidates carry durable Main-issued base ancestry. Main compares complete canonical manifests and current bytes in stable candidate/path order.
- Non-overlapping edits and identical same-path final entries combine into a new integration replica. Conflicting edits return durable path/candidate evidence.
- Integration replicas remain separate lease-protected copies. No source-workspace application authority is created.
- Existing `check` can consume a successful integration reference; failed, rejected, timed-out, or unknown checks do not become successful evidence.
- Ledger result references and opaque provenance validate combine lineage and result integrity on recovery.
- A canonical Service/Runner/Interpreter fixture maps two replicas, collects their durable references, combines them, runs the frozen native check in the integration replica and cold-reopens the exact result. Separate fixtures retain failed and unknown integration checks without upgrading either to applicability.

Verification: Node/web typechecks pass; the directly affected seven-file scope passes 58/58 tests; production build passes at 356 Main modules and 2817.32 kB. The broader eight-file run retained the existing `workflow-system-revision` 5000 ms timeout (67 passed / 1 timeout); no deadline or workload changed. Earlier pre-fix service fixtures failed first because collected candidates were still metadata rows and because the combine result incorrectly used replica evaluation metadata; those failures were fixed at the canonical runner/host boundary rather than weakened.

Not claimed by this slice: batch migration, Jev quality, real Provider quality, source application, real Provider/account acceptance, commit, push, install or a performance improvement. The mapped performance scenario remains unavailable because `providers.catalog` has no counter collector.
