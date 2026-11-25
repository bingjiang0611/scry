# 005: Deduplicate only comparable transcript usage

**Status:** Accepted (documents existing behavior)

A transcript can repeat usage without another model call. Summing every row can overcount, but merging unrelated calls with identical counts can undercount.

Claude Code repeats whole-message usage per content block. Identify those rows by message ID and request ID when present, keep the first, and share the dedupe set across files in one scan: resume, fork, and subagent transcripts can copy the same rows. Admit and count rows with no identity separately; their duplication is unknown.

For Codex, compare consecutive comparable `last_token_usage` signatures, not all signatures ever seen. Ignore field order. A frame with no comparable numeric delta is not grounds to suppress a row. Another comparable delta between two equal signatures lets the second one count. The rule is based on the rollout's repeated broadcasts and is not an identity for model calls.

See [usage-dedupe.ts](../../src/shared/usage-dedupe.ts) and [usage-dedupe.test.ts](../../src/shared/usage-dedupe.test.ts).
