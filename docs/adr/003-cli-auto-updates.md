# 003: Bound automatic CLI updates without slowing hook delivery

**Status:** Accepted (documents existing behavior)

Opt-in updates miss machines whose operators never see the instructions. Staying inside a minor release similarly strands 0.x users. Checking from a hook would add a process launch to the hot path and could change the CLI between events in a turn.

Enable automatic updates unless explicitly disabled. Stay within the installed major, including for 0.x; use explicit npm range bounds because neither tilde nor caret expresses that policy for 0.x. Treat breaking CLI contract changes as major releases. Use the machine's npm registry configuration unless a registry override is provided.

The recorder daemon checks on idle shutdown, not on hook delivery; this reaches unattended installations without splitting an active turn. The install notice also tells operators how to turn updates off.

See [update.ts](../../src/cli/update.ts) and [update.test.ts](../../src/cli/update.test.ts).
