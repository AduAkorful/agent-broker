/**
 * Tiny Cloudflare Worker: proxies Bybit public GETs so Render egress is not IP-blocked.
 * Deploy: npx wrangler deploy scripts/bybit-proxy-worker.js --name agent-broker-bybit-proxy
 * Then set SECONDARY_VENUE_BASE_URL=https://agent-broker-bybit-proxy.<you>.workers.dev
 */
export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    const upstream = new URL(incoming.pathname + incoming.search, "https://api.bybit.com");
    if (!upstream.pathname.startsWith("/v5/market/")) {
      return new Response("only /v5/market/* allowed", { status: 403 });
    }
    const res = await fetch(upstream.toString(), {
      headers: { Accept: "application/json", "User-Agent": "agent-broker-bybit-proxy/1.0" },
    });
    return new Response(await res.arrayBuffer(), {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") || "application/json",
        "Cache-Control": "public, max-age=2",
      },
    });
  },
};
