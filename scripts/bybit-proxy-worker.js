/**
 * Proxies Bybit public market GETs so Render egress can read spot tickers.
 */
const UPSTREAMS = [
  "https://api.bytick.com",
  "https://api.bybit.com",
];

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    if (!incoming.pathname.startsWith("/v5/market/")) {
      return new Response("only /v5/market/* allowed", { status: 403 });
    }

    const errors = [];
    for (const base of UPSTREAMS) {
      const upstream = new URL(incoming.pathname + incoming.search, base);
      try {
        const res = await fetch(upstream.toString(), {
          headers: {
            Accept: "application/json",
            "User-Agent": "agent-broker-bybit-proxy/1.0",
          },
        });
        const body = await res.arrayBuffer();
        // Prefer a successful JSON upstream; otherwise keep trying.
        if (res.ok) {
          return new Response(body, {
            status: res.status,
            headers: {
              "Content-Type": res.headers.get("Content-Type") || "application/json",
              "Cache-Control": "public, max-age=2",
              "X-Upstream-Host": new URL(base).host,
            },
          });
        }
        errors.push(`${new URL(base).host}:${res.status}`);
      } catch (e) {
        errors.push(`${new URL(base).host}:${String(e).slice(0, 80)}`);
      }
    }
    return new Response(JSON.stringify({ error: "upstream_failed", errors }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  },
};
