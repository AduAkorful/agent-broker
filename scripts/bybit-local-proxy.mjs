import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const UPSTREAMS = ["https://api.bytick.com", "https://api.bybit.com"];

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.writeHead(405).end("method not allowed");
      return;
    }
    const path = req.url || "/";
    if (!path.startsWith("/v5/market/")) {
      res.writeHead(403).end("only /v5/market/* allowed");
      return;
    }
    const errors = [];
    for (const base of UPSTREAMS) {
      try {
        const upstream = await fetch(`${base}${path}`, {
          headers: {
            Accept: "application/json",
            "User-Agent": "agent-broker-bybit-local-proxy/1.0",
          },
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        if (upstream.ok) {
          res.writeHead(upstream.status, {
            "Content-Type": upstream.headers.get("content-type") || "application/json",
            "X-Upstream-Host": new URL(base).host,
          });
          res.end(body);
          return;
        }
        errors.push(`${new URL(base).host}:${upstream.status}`);
      } catch (e) {
        errors.push(`${new URL(base).host}:${String(e).slice(0, 80)}`);
      }
    }
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "upstream_failed", errors }));
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`bybit local proxy on http://127.0.0.1:${PORT}`);
});
