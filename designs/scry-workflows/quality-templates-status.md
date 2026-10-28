# Quality templates status (M4, partial)

## Implemented

- Three builtin quality templates use the same definition validation, revision hashing and freeze path as other templates: independent candidate review; parallel counterexample/evidence review followed by adjudication; three-angle drafting followed by cross-review, arbitration and improvement. Their definitions and structural tests do not prove actual Provider reasoning quality.
- The template workbench now offers **检查并修复**. The user enters a literal JSON argv array, relative working directory, parser and timeout. This creates a **project draft**, not an execution or an automatic publication. The existing source/diff review and independent project disclosure are still required for publication. Preparation and execution approval remain separate.
- `src/shared/workflow-check-fix.ts` generates the ordinary template definition. It does not introduce a scheduler or execution engine:

```text
owned replica → firstCheck
  ├─ known failed → repair call in that same replica → secondCheck
  ├─ other known state → retain firstCheck
  └─ unknown → blocked / no repair
→ return selected check result (unwrap the branch's { arm, value })
```

The repair receives the goal and first-check diagnostics. A first-round pass costs no repair call. A second failure is returned as `passed: false`, even if the repair Agent claims success. No further repair is scheduled, and no change is applied to the source project.

Both check blocks use the same literal request; Main freezes authorization during preparation and revalidates execution through the existing system host. The template cannot ship its own authorization. Distinct check block ids preserve both observations rather than overwriting the first failure.

## Current-revision verification

| Check | Result | Scope / evidence |
| --- | --- | --- |
| Focused regression | 5 files, 19 tests passed | `workflow-check-fix.test.ts`, `workflow-template-check.test.ts`, both builtin suites, `workflow-template-review.test.ts` |
| First-round pass | 1 actual native check; 0 repair calls | canonical Service/Runner/Interpreter/SystemHost with a temporary project, published project template and isolated HOME |
| Repair then pass | native results `failed`, `passed`; exactly 1 repair call | offline repair executor writes a marker only to the real owned replica; source project marker remains absent |
| Repair ineffective | native results `failed`, `failed`; exactly 1 repair call | executor claims “all checks passed”; returned result remains `passed: false`, exit code 1 |
| Native timeout | result `timed_out`; 0 repair calls | actual process hits the frozen 100ms fixture deadline; no sleep/retry-to-green |
| Unknown host result | does not complete or dispatch repair; observation does not replay | injected host-boundary lost-result case, not a real Provider failure |
| Negative control | expected failure, then mutation restored | changing repair admission from `failed` to `passed` makes the first-round test fail with dispatchAttempts 1 instead of 0; `/tmp/scry-check-fix-negative.log` |
| Real isolated App UI | passed with trusted pointer/keyboard | `node scripts/electron-security-smoke.mjs --dev-workflow-template-editor-only`; rejects invalid JSON, creates exact project source without authorization, requires both review checkboxes, publishes exact bytes; 0 Provider invocations |
| Adjacent UI | passed | builtin readonly, Save As, invalid draft retention/reopen, narrow viewport, source/structure, instance preview, deletion/restoration, revision editor |
| Type/build | passed | `npm run typecheck`, `npm run build`; `git diff --check` passed |

App evidence: `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-workflow-template-editor-ui-JgKpXV`.

The first UI attempt failed because the new test searched for “浏览模板” instead of the existing button “模板库”. Corrected the selector, without changing the deadline or assertion. The first unknown-result test used a nonexistent `inspect` method; corrected to the production `snapshot` API. These failures are not hidden by the final passing runs.

The workbench was split along existing catalog, extraction-form and publication-review responsibilities to keep the changed file below the 20,000-byte authored limit (26,020 → 19,172 bytes). Main remains the authority for validation, trust and publication.

## Not verified / remaining M4

- Actual Provider repair, adversarial reasoning and feedback effectiveness are not proven by the offline repair executor. The checks are real native processes, but the Agent is a fixture.
- No proof yet of all-fail candidate selection, synthesis quality or batch-migration semantics. Jev and combined-patch regression/conflict/application gates remain unfinished.
- `completed` means the workflow returned its result, not that a failed check passed. The returned `state`, `passed` and exit code are authoritative for the check.
- The older full-regression timeout/cleanup failures remain open. A later status audit also found 2 native verification tests timing out at the original 5000ms deadline; the focused tests here do not resolve them.
- This is an increment, not M1–M6 completion. No commit, push, installation, version change or daily-App restart.
