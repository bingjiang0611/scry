---
name: delete-comment
description: Audit Scry source comments, delete redundant or stale prose, file issues for workarounds, and move durable rationale into ADRs. Use for /delete-comment or a comment-ratchet cleanup, not for bulk stripping files.
---

# Delete comments

1. Take a directory or file scope; default to `src/cli/`. Inventory actual JS/TS comments with `npm run --silent check:source-comments -- --inventory <path>` (JSONL on stdout, line counts on stderr). For other languages, use a language-aware parser. Do not treat strings, fixtures containing source text, generated output, or vendored code as first-party prose.
2. Read each comment alongside its code and tests. Group adjacent lines that make one claim. Keep legal notices and tool directives intact; removing them is not a prose cleanup. Classify the rest:
   - **Tautology:** The code or test already says it. Delete.
   - **Stale:** The current implementation contradicts it or the referenced behavior is gone. Verify, then delete.
   - **Excuse:** A comment justifies a fixable workaround. Deduplicate and file an issue with the affected code, impact, and acceptance criteria. Delete the comment after the issue exists; if issue filing is unavailable, leave it and report why.
   - **Decision Record:** The comment explains an important decision someone could accidentally undo. Move the rationale, alternatives, and consequences into an existing canonical ADR or a short new one under `docs/adr/`. Verify the decision still holds. Preserve external contracts and link to the owning code and tests.
3. Make a bounded pass; defer uncertain cases rather than auto-delete. Do not change runtime behavior or silently weaken the lint rule. When deleting a block, preserve token boundaries, line terminators that affect parsing, and JSX behavior. Run the ratchet and focused tests; check the diff.
4. Report scope, counts by category, issue/ADR links, and what remains. For LOC estimates, count physical comment-only lines separately from inline comments. State which languages and exclusions the estimate covers. No new prose is allowed within the ratchet scope; existing prose can be removed incrementally.
