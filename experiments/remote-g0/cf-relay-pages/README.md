# Scry relay Pages ingress

`wss://scry-relay-pages.pages.dev` is the production client-facing WSS origin.
Its `_worker.js` forwards upgraded requests through the private `RELAY` service
binding to the canonical `scry-relay` Worker, so the same Durable Objects,
per-host enrollment, and byte-only forwarding logic remain authoritative.

This ingress exists because the tested mobile network intercepted the
`workers.dev` DNS name. Pages TLS/system trust and full WSS byte relay were
verified from a physical iPhone/network path.

Deploy:

```sh
cd experiments/remote-g0/cf-relay-pages
npx --prefix ../ wrangler pages deploy public \
  --project-name scry-relay-pages --branch main
```
