# Scry relay on Cloudflare Workers + Durable Objects

Deployable outer relay for the Scry iOS remote feature. It is an **untrusted byte
rendezvous only** — it never sees inner keys and is never the security root. The
inner TLS 1.3 mTLS (device ↔ Mac host) runs end-to-end over the raw bytes it
shuttles; a compromised relay can at most drop or delay bytes, never read or
forge them.

## Topology

Cloudflare Workers cannot accept arbitrary inbound TCP, so **both** sides connect
over WebSocket:

- The NAT-bound Mac host opens a warm pool of legs to
  `/host?host=<hostId>&mode=<run|pair>` and authenticates with a first-frame JSON
  `{ "token": "..." }` (per-deploy bearer secret; never in the URL, never logged).
- The iOS device opens `/?host=<hostId>&mode=<run|pair>`.

A Durable Object keyed by `hostId` keeps a **separate warm pool per mode** and
glues one device to one host leg, raw-shuttling binary frames both ways. A
pairing device (`mode=pair`, self-signed prove) can never land on the strict-mTLS
`run` pool and vice versa. Unknown host id / bad mode → close 1008; no warm leg →
close 1013.

The relay **stores nothing** and only ever sees encrypted inner-TLS bytes. It
uses the **WebSocket Hibernation API** (`state.acceptWebSocket` + `webSocket*`
handlers), so idle warm legs incur no compute-duration charges.

## Cost: runs on the Workers **Free** plan

SQLite-backed Durable Objects are available on the Workers Free plan (per
Cloudflare's pricing docs), and hibernation keeps idle connections free. A
personal always-on relay fits comfortably inside the free daily allowances
(100,000 requests/day; 13,000 GB-s/day compute duration — hibernating warm legs
consume duration only while actually forwarding frames). No paid plan required.
Protocol pings and outgoing WebSocket messages are not billed; incoming
WebSocket messages bill at a 20:1 ratio.

## Local verification (no account, no deploy, no spend)

```
npm --prefix experiments/remote-g0 run smoke:cf        # relay under local workerd
npm --prefix experiments/remote-g0 run smoke:cf-host   # production host leg vs the Worker
```

Both boot the real Worker with `wrangler dev` (workerd) and drive it exactly as
the device + Mac host would. `smoke:cf` covers the byte shuttle both ways,
first-frame token auth (1008), pool separation, and no-leg rejection (1013).
`smoke:cf-host` wires the production `createRelayConnectWS` →
`ReverseTunnelTransport` → `RelayClient` and round-trips bytes through the Worker.

## Deploy (needs the maintainer's Cloudflare account; free plan is enough)

Nothing here creates paid resources. To deploy once credentials are provided:

```
cd experiments/remote-g0/cf-relay
wrangler login                       # or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
wrangler secret put RELAY_TOKEN      # same value provisioned to the Mac host
wrangler deploy                      # publishes to <name>.<subdomain>.workers.dev
```

Then point the Mac host at it:

```
SCRY_REMOTE_HOST=1 \
SCRY_REMOTE_RELAY_WS='{"url":"wss://scry-relay.<subdomain>.workers.dev","token":"<RELAY_TOKEN>"}' \
  <launch Scry>
```

`SCRY_REMOTE_RELAY_WS` takes precedence over the raw-TCP `SCRY_REMOTE_RELAY`. The
free `workers.dev` subdomain works out of the box; a custom domain additionally
needs the zone in the same account plus a Workers route. No Workers Paid plan is
required for SQLite-backed Durable Objects.
