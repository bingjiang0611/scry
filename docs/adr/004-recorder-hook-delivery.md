# 004: Queue recorder hooks on unknown delivery

**Status:** Accepted (documents existing behavior)

Recorder hooks are observational. They must not fail the Provider's workflow or apply an event twice when a daemon accepted it but lost the response.

A successful daemon ACK ends delivery. A missing or refused connection proves the daemon did not receive the request. A replacement hint on an explicit pre-apply 404/409 permits replacing the owner and resending once. A server error or missing ACK can follow partial application; queue the event for replay rather than resending it or applying it locally. The shell passes its outcome to the CLI so a lost response does not become a fresh delivery attempt. The recorder uses the host's parent chain, passed through the hook process, to associate the event with the host.

See [recorder-command.ts](../../src/cli/recorder-command.ts), [hook-http-outcome.test.ts](../../src/cli/hook-http-outcome.test.ts), and [hook-fallback.test.ts](../../src/cli/hook-fallback.test.ts).
