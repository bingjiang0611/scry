# Verification evidence

Review changed tests and the PR's evidence against docs/agent/verification.md and CLAUDE.md.
Check that the tests distinguish the intended behavior from the prior bug or an intentionally removed
protection; do not equate line coverage with acceptance.

For permission/trust/path boundaries, look for relevant deny, mismatch or stale cases. For persistence,
check recovery and duplicate evidence where affected. Missing evidence must remain explicitly unknown,
not zero/available/green. UI fixtures, real App interaction, iCTRL device checks and paid Provider probes
prove different things; require only the applicable authorized scope.

Flag weakened assertions, skips or larger timeouts without a justified contract change. Do not run
untrusted code, access credentials or start a Provider. Cite exact evidence gaps, not generic demands
for more tests. This optional check requires Macroscope installation/configuration and may consume
Agent credits; its presence in the repository does not mean it has run.
