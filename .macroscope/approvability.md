Use Macroscope's default approvability criteria and Scry's CLAUDE.md contracts.

Require human review for changes to product defaults, permission/trust policy, renderer isolation,
IPC authorization, evidence availability/provenance semantics, Provider capability/approval semantics,
persistence formats/migrations/deletion/recovery, or Recorder Core independence.

Changes to CI permissions, review/triage policy, exemptions, release/signing/distribution,
performance limits/metrics, or directives suppressing static diagnostics also require human review.
Weakening tests or acceptance checks is not auto-approvable.

An AI approval never authorizes merging, an external operation, paid Provider probes, or a release.
Check claimed verification against docs/agent/verification.md; unavailable evidence is not a pass.
