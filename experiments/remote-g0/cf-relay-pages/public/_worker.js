// China-reachable public hostname for the Scry relay. Pages terminates the
// outer WSS connection and forwards the upgraded request to the canonical
// scry-relay Worker through a private Cloudflare service binding. The inner
// TLS 1.3/mTLS stream remains opaque end to end.
export default {
  fetch(request, env) {
    return env.RELAY.fetch(request)
  }
}
