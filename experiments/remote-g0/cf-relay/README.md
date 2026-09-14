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
  `/host?host=<hostId>&mode=<run|pair>` and authenticates with a first-frame JSON.
  Official clients send `{ "token": "<random-per-host-token>", "enroll": true }`:
  the first connection atomically claims its unguessable UUID room, and later
  legs must present the same token. Private legacy deployments may instead use
  the administrator-provisioned `RELAY_TOKEN`. Tokens are never put in URLs or logs.
- The iOS device opens `/?host=<hostId>&mode=<run|pair>`.

A Durable Object keyed by `hostId` keeps a **separate warm pool per mode** and
glues one device to one host leg, raw-shuttling binary frames both ways. A
pairing device (`mode=pair`, self-signed prove) can never land on the strict-mTLS
`run` pool and vice versa. Unknown host id / bad mode → close 1008; no warm leg →
close 1013.

The relay stores only a SHA-256 digest of each enrolled room token and only ever
sees encrypted inner-TLS bytes; payloads and pairing data are never persisted.
It uses the **WebSocket Hibernation API** (`state.acceptWebSocket` + `webSocket*`
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
legacy token auth plus per-host enrollment/takeover rejection (1008), pool
separation, and no-leg rejection (1013). `smoke:cf-host` wires the production
`createRelayConnectWS` →
`ReverseTunnelTransport` → `RelayClient` and round-trips bytes through the Worker.

## Deploy (needs the maintainer's Cloudflare account; free plan is enough)

Nothing here creates paid resources. To deploy once credentials are provided:

```
cd experiments/remote-g0/cf-relay
wrangler login                       # or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
wrangler secret put RELAY_TOKEN      # optional admin/legacy credential; never bundled
wrangler deploy                      # publishes to <name>.<subdomain>.workers.dev
```

Packaged Scry builds use the official `scry-relay-pages.pages.dev` origin by
default. That Pages hostname forwards upgraded requests through a private
Cloudflare service binding to this canonical Worker, preserving the same
Durable Objects and opaque byte path while remaining reachable on tested mobile
networks where `workers.dev` DNS was intercepted. The Mac generates a distinct
credential locally for each host identity and needs no environment variables.
Development remains opt-in with `SCRY_REMOTE_HOST=1`; `SCRY_REMOTE_HOST=0`
disables remote hosting in any build. A private deployment can still be selected
explicitly:

```
SCRY_REMOTE_HOST=1 \
SCRY_REMOTE_RELAY_WS='{"url":"wss://scry-relay.<subdomain>.workers.dev","token":"<RELAY_TOKEN>"}' \
  <launch Scry>
```

Explicit `SCRY_REMOTE_RELAY_WS` takes precedence over the raw-TCP
`SCRY_REMOTE_RELAY`, and malformed explicit configuration fails closed rather
than falling back to the official relay. Private deployments may use a
`workers.dev`, Pages/service-binding, or custom-domain origin. A custom domain
needs the zone in the same account plus a Workers route. No Workers Paid plan is
required for SQLite-backed Durable Objects.
