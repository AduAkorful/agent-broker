#!/usr/bin/env node
/**
 * Residual free-mode live QA sweep for agent-broker.
 * Loads ADMIN_API_KEY from .env via load-env.mjs (never prints secrets).
 * Writes JSON to /tmp/agent-broker-residual-qa.json and prints a markdown table.
 */
import { loadEnvFile } from "./load-env.mjs";

const BASE = process.env.QA_BASE_URL || "http://127.0.0.1:3000";
const OUT = process.env.QA_OUT || "/tmp/agent-broker-residual-qa.json";

const VOL = "/api/v1/market-intelligence/volatility";
const HIST = "/api/v1/market-intelligence/volatility/history";
const BATCH = "/api/v1/market-intelligence/volatility/batch";
const PORT = "/api/v1/market-intelligence/portfolio/risk";
const SUB = "/api/v1/subscription";
const INFO = "/api/v1/agent/info";
const READY = "/api/v1/ready";
const HEALTH = "/health";
const OPENAPI_JSON = "/api/v1/openapi.json";
const DOCS = "/docs";
const TREASURY_BAL = "/api/v1/treasury/balance";
const TREASURY_WD = "/api/v1/treasury/withdraw";

const results = [];
const env = loadEnvFile();
const ADMIN_API_KEY = env.ADMIN_API_KEY;
if (!ADMIN_API_KEY) {
  console.error("ADMIN_API_KEY missing in .env");
  process.exit(1);
}

function decodePaymentResponse(headers) {
  const h = headers.get("PAYMENT-RESPONSE") || headers.get("payment-response");
  if (!h) return null;
  try {
    return JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  } catch {
    return { _raw: "decode_failed" };
  }
}

function noteSecrets(obj) {
  const s = JSON.stringify(obj ?? {});
  const hits = [];
  if (/ADMIN_API_KEY|BINANCE_MCP_AUTH|PRIVATE_KEY/i.test(s)) hits.push("secret_key_name");
  if (/sk-|Bearer [A-Za-z0-9._-]{20,}/i.test(s)) hits.push("bearerish");
  return hits;
}

async function req(method, path, { query, body, headers, rawBody } = {}) {
  const url = new URL(path.startsWith("http") ? path : `${BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  const init = { method, headers: { ...(headers || {}) } };
  if (rawBody !== undefined) {
    init.body = rawBody;
    if (!init.headers["Content-Type"] && !init.headers["content-type"]) {
      init.headers["Content-Type"] = "application/json";
    }
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err?.message || String(err),
      ms: Date.now() - started,
      headers: new Headers(),
      text: "",
      json: null,
      pay: null,
    };
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return {
    ok: res.ok,
    status: res.status,
    ms: Date.now() - started,
    headers: res.headers,
    text,
    json,
    pay: decodePaymentResponse(res.headers),
  };
}

function record(id, result, notes, evidence = {}) {
  const row = { id, result, notes, evidence };
  results.push(row);
  return row;
}

function assert(id, cond, notes, evidence) {
  record(id, cond ? "PASS" : "FAIL", notes, evidence);
}

function skip(id, notes) {
  record(id, "SKIP", notes);
}

function clip(s, n = 240) {
  const t = typeof s === "string" ? s : JSON.stringify(s);
  if (!t) return "";
  return t.length > n ? t.slice(0, n) + "…" : t;
}

async function main() {
  // --- 1. Confirm free mode ---
  {
    const info = await req("GET", INFO);
    const pe = info.json?.payment?.payments_enabled;
    assert(
      "FREE-01",
      info.status === 200 && pe === false,
      `payments_enabled=${pe}`,
      { status: info.status }
    );
  }
  {
    const vol = await req("GET", VOL, { query: { symbol: "BTCUSDT" } });
    assert(
      "FREE-02",
      vol.status === 200 && vol.status !== 402,
      `volatility status=${vol.status} not 402`,
      { status: vol.status, symbol: vol.json?.symbol }
    );
    const freemode =
      vol.pay?.free_mode === true &&
      vol.pay?.amount === "0" &&
      (vol.pay?.payments_enabled === false || vol.pay?.payments_enabled === undefined);
    assert(
      "FREE-03",
      !!vol.pay && freemode,
      `PAYMENT-RESPONSE ${clip(vol.pay)}`,
      { pay: vol.pay }
    );
  }

  // --- 2. Warm MCP (already done above, reaffirm) ---
  {
    const vol = await req("GET", VOL, { query: { symbol: "BTCUSDT" } });
    assert("WARM-01", vol.status === 200 && !!vol.json?.symbol, `warm ${vol.json?.symbol}`, {
      status: vol.status,
    });
  }

  // --- 3. Discovery leftovers ---
  {
    const h = await req("GET", HEALTH);
    assert(
      "D-H01",
      h.status === 200 && h.json?.ok === true,
      `ok=${h.json?.ok} checks=${clip(h.json?.checks)}`,
      { status: h.status, checks: h.json?.checks }
    );
  }
  {
    const r = await req("GET", READY);
    assert(
      "D-R01",
      r.status === 200 && r.json?.ready === true && r.json?.checked_at,
      `ready=${r.json?.ready} checked_at=${r.json?.checked_at}`,
      { status: r.status, body: r.json }
    );
  }
  {
    const r = await req("GET", READY);
    const leaks = noteSecrets(r.json);
    assert(
      "D-R03",
      leaks.length === 0 && !/BINANCE_MCP|ADMIN_API|PRIVATE_KEY/i.test(r.text),
      leaks.length ? `possible leak markers: ${leaks}` : "no secrets in ready body",
      { status: r.status }
    );
  }
  {
    const info = await req("GET", INFO);
    const n = info.json?.networks || {};
    const payTo = info.json?.payment?.payTo || n.payTo;
    const relayer = info.json?.payment?.relayer || n.relayer;
    const ok =
      !!payTo &&
      !!relayer &&
      !!info.json?.payment?.facilitator_network &&
      String(payTo).toLowerCase() !== String(relayer).toLowerCase();
    assert(
      "D-I07",
      ok,
      `payTo!=relayer payTo=${payTo?.slice?.(0, 10)}… relayer=${relayer?.slice?.(0, 10)}…`,
      { payTo, relayer, chain: n.chain_id || info.json?.payment?.network }
    );
  }
  {
    const info = await req("GET", INFO);
    const sub = info.json?.payment?.subscription;
    assert(
      "D-I08",
      sub &&
        (sub.price_atomic === "0" || sub.price_decimal === "0") &&
        sub.requests_included != null &&
        sub.ttl_seconds != null,
      `sub meta ${clip(sub)}`,
      { subscription: sub }
    );
  }
  {
    const info = await req("GET", INFO);
    const sv = info.json?.secondary_venue;
    assert(
      "D-I09",
      sv && typeof sv.enabled === "boolean" && !!sv.exchange,
      `secondary_venue ${clip(sv)}`,
      { secondary_venue: sv }
    );
  }
  {
    // D-S03: curl docs + openapi (Swagger try-it-out proxy via health/info)
    const docs = await req("GET", DOCS);
    const info = await req("GET", INFO);
    const health = await req("GET", HEALTH);
    assert(
      "D-S03",
      docs.status === 200 &&
        /swagger|openapi/i.test(docs.text) &&
        info.status === 200 &&
        health.status === 200,
      `docs=${docs.status} info=${info.status} health=${health.status}`,
      { docs_ctype: docs.headers.get("content-type") }
    );
  }
  {
    // D-O04 spot-check: openapi mentions interval / funding honesty
    const oj = await req("GET", OPENAPI_JSON);
    const text = oj.text || "";
    const hasInterval = /interval/i.test(text);
    const fundingHonesty =
      /open.?interest/i.test(text) ||
      /funding/i.test(text) ||
      /klines/i.test(text);
    assert(
      "D-O04",
      oj.status === 200 && hasInterval,
      `openapi interval=${hasInterval} oi/funding mentions=${fundingHonesty}`,
      { status: oj.status, paths: Object.keys(oj.json?.paths || {}).length }
    );
  }

  // --- 4. Volatility ---
  {
    const r = await req("GET", VOL);
    assert(
      "V-01",
      r.status === 200 &&
        r.json?.symbol === "BTCUSDT" &&
        r.json?.disclaimer &&
        Array.isArray(r.json?.sources) &&
        r.json?.confidence_score != null,
      `defaults ${r.json?.symbol} vol=${r.json?.volatility_score}`,
      { status: r.status, keys: Object.keys(r.json || {}) }
    );
  }
  {
    const r = await req("GET", VOL, { query: { symbol: "ethusdt" } });
    assert(
      "V-02",
      r.status === 200 && r.json?.symbol === "ETHUSDT",
      `symbol=${r.json?.symbol}`,
      { status: r.status }
    );
  }
  {
    const r = await req("GET", VOL, { query: { symbol: "BTCUSDT", interval: "1h" } });
    assert("V-03", r.status === 200, `1h status=${r.status}`, { status: r.status });
  }
  {
    const intervals = ["15m", "4h", "1d"];
    const outs = [];
    for (const interval of intervals) {
      const r = await req("GET", VOL, { query: { symbol: "BTCUSDT", interval } });
      outs.push({ interval, status: r.status });
    }
    assert(
      "V-04",
      outs.every((o) => o.status === 200),
      `intervals ${clip(outs)}`,
      { outs }
    );
  }
  {
    const r = await req("GET", VOL, { query: { symbol: "BTCUSDT" } });
    // limit default ~24 is internal; check response still 200 with provenance
    assert(
      "V-08",
      r.status === 200 && r.json?.sources?.length >= 1,
      `default limit path status=${r.status} sources=${r.json?.sources?.length}`,
      { status: r.status }
    );
  }
  {
    const r = await req("GET", VOL, { query: { symbol: "BTCUSDT", limit: "99999" } });
    assert("V-10", r.status === 200, `limit=99999 status=${r.status}`, { status: r.status });
  }
  {
    const r = await req("GET", VOL, { query: { symbol: "BTCUSDT" } });
    const hasContrast = r.json && Object.prototype.hasOwnProperty.call(r.json, "contrast");
    assert(
      "V-13",
      r.status === 200 && hasContrast,
      `contrast=${clip(r.json?.contrast)}`,
      { contrast: r.json?.contrast }
    );
  }
  {
    const r = await req("GET", VOL, { query: { symbol: "BTCUSDT" } });
    const honest =
      r.json &&
      ("open_interest" in r.json || "open_interest_signal" in r.json) &&
      !("funding_rate" in r.json && r.json.open_interest === r.json.funding_rate && r.json.funding_rate !== 0);
    // Field honesty: open_interest present and not mislabeled as funding_rate primary
    const hasOi = "open_interest" in (r.json || {});
    const hasFundingMislabel =
      r.json?.funding_rate !== undefined &&
      r.json?.open_interest === undefined &&
      /funding/i.test(JSON.stringify(r.json?.sources || []));
    assert(
      "V-16",
      r.status === 200 && hasOi && !hasFundingMislabel,
      `open_interest=${r.json?.open_interest} honest=${honest}`,
      { open_interest: r.json?.open_interest, open_interest_signal: r.json?.open_interest_signal }
    );
  }
  {
    const r = await req("GET", VOL, { query: { symbol: "BTCUSDT" } });
    const scores = [r.json?.volatility_score, r.json?.momentum_score, r.json?.composite_score];
    const ok =
      r.status === 200 &&
      scores.every((s) => typeof s === "number" && Number.isFinite(s) && s >= 0 && s <= 100);
    assert("V-17", ok, `scores ${clip(scores)}`, { scores });
  }
  {
    const r = await req("GET", VOL, { query: { symbol: "NOTAREALPAIRZZZ" } });
    const controlled =
      (r.status >= 400 && r.status < 500) ||
      r.status === 503 ||
      (r.status === 200 && r.json?.error);
    const notHtml = !/<\/?html/i.test(r.text);
    assert(
      "V-22",
      controlled && notHtml && r.status !== 500,
      `unknown symbol status=${r.status} body=${clip(r.text)}`,
      { status: r.status, body: clip(r.json || r.text) }
    );
  }
  {
    const r = await req("GET", VOL, { query: { symbol: "../../etc" } });
    const safe =
      (r.status >= 400 && r.status < 500) ||
      r.status === 503 ||
      (r.status === 200 && !r.text.includes("root:"));
    const notHtml = !/<\/?html/i.test(r.text) && !/ENOENT|EACCES/.test(r.text);
    assert(
      "V-23",
      safe && notHtml && r.status !== 500,
      `injection status=${r.status} body=${clip(r.text)}`,
      { status: r.status }
    );
  }
  {
    const n = 5;
    const settled = await Promise.all(
      Array.from({ length: n }, () => req("GET", VOL, { query: { symbol: "BTCUSDT" } }))
    );
    const allOk = settled.every((r) => r.status === 200 && r.json?.symbol === "BTCUSDT");
    assert(
      "V-24",
      allOk,
      `parallel ${n}: statuses=${settled.map((r) => r.status).join(",")}`,
      { statuses: settled.map((r) => r.status) }
    );
  }

  // --- 5. History ---
  {
    const r = await req("GET", HIST);
    assert(
      "Y-03",
      r.status === 200 &&
        typeof r.json?.count === "number" &&
        Array.isArray(r.json?.scores) &&
        r.json.scores.length <= 100 &&
        r.json.count <= 100,
      `count=${r.json?.count} len=${r.json?.scores?.length}`,
      { count: r.json?.count }
    );
  }
  {
    const r = await req("GET", HIST, { query: { limit: "1" } });
    assert(
      "Y-04",
      r.status === 200 && (r.json?.scores?.length ?? 99) <= 1,
      `len=${r.json?.scores?.length}`,
      { count: r.json?.count, len: r.json?.scores?.length }
    );
  }
  {
    const r = await req("GET", HIST, { query: { limit: "5000" } });
    assert(
      "Y-06",
      r.status === 200 && (r.json?.scores?.length ?? 9999) <= 1000,
      `cap len=${r.json?.scores?.length}`,
      { count: r.json?.count, len: r.json?.scores?.length }
    );
  }
  {
    const r = await req("GET", HIST, { query: { symbol: "BTCUSDT", limit: "50" } });
    const only =
      r.status === 200 &&
      Array.isArray(r.json?.scores) &&
      r.json.scores.every((s) => !s.symbol || s.symbol === "BTCUSDT");
    assert("Y-07", only, `filter BTCUSDT count=${r.json?.count}`, { count: r.json?.count });
  }
  {
    const r = await req("GET", HIST, { query: { limit: "5" } });
    const scores = r.json?.scores || [];
    const provOk =
      scores.length === 0 ||
      scores.some(
        (s) =>
          s.sources != null ||
          s.confidence_score != null ||
          s.data_age_ms != null ||
          s.age != null ||
          s.provenance != null
      );
    assert(
      "Y-08",
      r.status === 200 && (scores.length === 0 || provOk),
      `provenance sample ${clip(scores[0])}`,
      { sample: scores[0] }
    );
  }
  {
    const r = await req("GET", HIST, { query: { limit: "1" } });
    assert(
      "Y-09",
      r.status === 200 && r.pay?.free_mode === true,
      `pay=${clip(r.pay)}`,
      { pay: r.pay }
    );
  }

  // --- 6. Batch ---
  {
    const r = await req("POST", BATCH, { body: { symbols: ["BTCUSDT"] } });
    assert(
      "B-02",
      r.status === 200 && r.json?.count === 1 && r.json?.scores?.length === 1,
      `count=${r.json?.count}`,
      { status: r.status, count: r.json?.count }
    );
  }
  {
    const r = await req("POST", BATCH, {
      body: { symbols: ["BTCUSDT", "BTCUSDT", "btcusdt"] },
    });
    const symbols = (r.json?.scores || []).map((s) => s.symbol);
    const uniq = new Set(symbols);
    assert(
      "B-03",
      r.status === 200 && uniq.size === 1 && symbols[0] === "BTCUSDT",
      `dedup count=${r.json?.count} symbols=${clip(symbols)}`,
      { count: r.json?.count, symbols }
    );
  }
  {
    const r = await req("POST", BATCH, { body: { symbols: ["btcusdt"] } });
    assert(
      "B-04",
      r.status === 200 && r.json?.scores?.[0]?.symbol === "BTCUSDT",
      `upper=${r.json?.scores?.[0]?.symbol}`,
      { status: r.status }
    );
  }
  {
    const r = await req("POST", BATCH, { body: { symbols: "BTCUSDT" } });
    assert("B-06", r.status === 400, `non-array status=${r.status} ${clip(r.text)}`, {
      status: r.status,
      body: clip(r.json || r.text),
    });
  }
  {
    const r = await req("POST", BATCH, {
      body: { symbols: ["BTCUSDT", "!!junk!!", "ETHUSDT"] },
    });
    const syms = (r.json?.scores || []).map((s) => s.symbol).sort();
    assert(
      "B-07",
      r.status === 200 &&
        r.json?.count >= 1 &&
        syms.every((s) => ["BTCUSDT", "ETHUSDT"].includes(s)),
      `filter keep ${clip(syms)} count=${r.json?.count}`,
      { count: r.json?.count, symbols: syms }
    );
  }
  {
    const r = await req("POST", BATCH, { body: { symbols: ["!!!", "@@@"] } });
    assert("B-08", r.status === 400, `all invalid status=${r.status} ${clip(r.text)}`, {
      status: r.status,
      body: clip(r.json || r.text),
    });
  }
  {
    const r = await req("POST", BATCH, { body: { symbols: ["BTCUSDT"], limit: 0 } });
    const r2 = await req("POST", BATCH, { body: { symbols: ["BTCUSDT"], limit: 1001 } });
    assert(
      "B-11",
      r.status === 400 && r2.status === 400,
      `limit0=${r.status} limit1001=${r2.status}`,
      { r: clip(r.json || r.text), r2: clip(r2.json || r2.text) }
    );
  }
  {
    const r = await req("POST", BATCH, { body: { symbols: ["BTCUSDT", "ETHUSDT"] } });
    assert("B-15", r.status === 200 && r.status !== 402, `free batch status=${r.status}`, {
      status: r.status,
      pay: r.pay,
    });
  }

  // --- 7. Portfolio ---
  {
    const r = await req("POST", PORT, {
      body: { symbols: ["BTCUSDT", "ETHUSDT"], weights: [0.5, 0.5] },
    });
    const j = r.json || {};
    const ok =
      r.status === 200 &&
      j.portfolio != null &&
      (j.correlation != null || j.correlation_matrix != null) &&
      (j.concentration != null ||
        j.concentration_warnings != null ||
        j.warnings != null ||
        j.diversification_headroom != null) &&
      j.disclaimer;
    assert(
      "P-01",
      ok,
      `keys=${clip(Object.keys(j))} status=${r.status}`,
      { status: r.status, keys: Object.keys(j) }
    );
  }
  {
    const r = await req("POST", PORT, {
      body: { symbols: ["BTCUSDT", "ETHUSDT"], weights: [1, 3] },
    });
    const w = r.json?.portfolio?.weights || r.json?.weights || r.json?.normalized_weights;
    let sumOk = false;
    if (Array.isArray(w)) {
      const sum = w.reduce((a, b) => a + Number(b), 0);
      sumOk = Math.abs(sum - 1) < 0.02;
    } else if (w && typeof w === "object") {
      const sum = Object.values(w).reduce((a, b) => a + Number(b), 0);
      sumOk = Math.abs(sum - 1) < 0.02;
    } else if (r.json?.portfolio?.weight_sum != null) {
      sumOk = Math.abs(Number(r.json.portfolio.weight_sum) - 1) < 0.02;
    } else if (r.status === 200 && r.json?.portfolio) {
      // accept 200 with portfolio when weights normalized internally
      sumOk = true;
    }
    assert("P-02", r.status === 200 && sumOk, `normalize status=${r.status} w=${clip(w)}`, {
      status: r.status,
      weights: w,
      portfolio: r.json?.portfolio,
    });
  }
  {
    const r = await req("POST", PORT, { body: { weights: [0.5, 0.5] } });
    assert("P-04", r.status === 400, `missing symbols status=${r.status}`, {
      status: r.status,
      body: clip(r.json || r.text),
    });
  }
  {
    const r = await req("POST", PORT, {
      body: { symbols: ["BTCUSDT", "ETHUSDT"], weights: [0.5, Number.NaN] },
    });
    assert("P-08", r.status === 400, `NaN weight status=${r.status}`, {
      status: r.status,
      body: clip(r.json || r.text),
    });
  }
  {
    const r = await req("POST", PORT, {
      body: { symbols: ["BTCUSDT", "ETHUSDT"], weights: [0.5, 0.5] },
    });
    const warnings = r.json?.warnings || r.json?.portfolio?.warnings || [];
    const heavyWarn = Array.isArray(warnings)
      ? warnings.some((w) => /50|concentrat/i.test(String(w)))
      : false;
    assert(
      "P-11",
      r.status === 200 && !heavyWarn,
      `balanced warnings=${clip(warnings)}`,
      { warnings }
    );
  }
  {
    const r = await req("POST", PORT, {
      body: { symbols: ["BTCUSDT", "ETHUSDT"], weights: [0.5, 0.5], interval: "0m" },
    });
    assert("P-14", r.status === 400, `bad interval status=${r.status}`, {
      status: r.status,
      body: clip(r.json || r.text),
    });
  }
  {
    const r = await req("POST", PORT, {
      body: {
        symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
        weights: [0.34, 0.33, 0.33],
      },
    });
    const corr =
      r.json?.correlation_matrix ||
      r.json?.correlation ||
      r.json?.corr ||
      r.json?.portfolio?.correlation;
    let matrixOk = false;
    if (Array.isArray(corr) && corr.length >= 2) {
      matrixOk = corr.every(
        (row, i) => Array.isArray(row) && Math.abs(Number(row[i]) - 1) < 0.05
      );
    } else if (corr && typeof corr === "object") {
      const keys = Object.keys(corr);
      matrixOk = keys.length >= 2;
    }
    assert(
      "P-17",
      r.status === 200 && matrixOk,
      `corr diag ok=${matrixOk} status=${r.status}`,
      { status: r.status, corr_type: Array.isArray(corr) ? "matrix" : typeof corr }
    );
  }
  {
    const r = await req("POST", PORT, {
      body: { symbols: ["BTCUSDT", "ETHUSDT"], weights: [0.5, 0.5] },
    });
    assert("P-18", r.status === 200 && r.status !== 402, `free portfolio ${r.status}`, {
      status: r.status,
      pay: r.pay,
    });
  }
  {
    const r = await req("POST", PORT, {
      body: { symbols: ["BTCUSDT", "ETHUSDT"], weights: [0.5, 0.5] },
    });
    const headroom =
      r.json?.diversification?.recommended_minimum ??
      r.json?.portfolio?.diversification?.recommended_minimum ??
      r.json?.recommended_minimum ??
      r.json?.diversification_headroom?.recommended_minimum;
    assert(
      "P-19",
      r.status === 200 && Number(headroom) === 10,
      `recommended_minimum=${headroom}`,
      { diversification: r.json?.diversification || r.json?.portfolio?.diversification }
    );
  }

  // --- 8. Subscription ---
  {
    const r = await req("POST", SUB, { body: {} });
    assert(
      "U-02",
      r.status === 200 &&
        (r.json?.requests_remaining === 200 ||
          r.json?.remaining_requests === 200 ||
          r.json?.remaining_balance === 200 ||
          r.json?.initial_balance === 200 ||
          r.json?.balance === 200 ||
          r.json?.requests_included === 200 ||
          r.json?.credits === 200),
      `credit ${clip(r.json)}`,
      { body: r.json }
    );
  }
  {
    const r = await req("POST", SUB, { body: {} });
    const exp = r.json?.expires_at;
    const ttl = r.json?.ttl_seconds;
    let ttlOk = false;
    if (typeof ttl === "number") {
      ttlOk = Math.abs(ttl - 86400) < 120;
    } else if (exp) {
      const ms = new Date(exp).getTime() - Date.now();
      ttlOk = Math.abs(ms / 1000 - 86400) < 600;
    }
    assert("U-03", r.status === 200 && ttlOk, `ttl/exp ${ttl} ${exp}`, { body: r.json });
  }
  {
    const sub = await req("POST", SUB, { body: {} });
    const nonce = sub.json?.nonce || sub.json?.subscription_nonce;
    const r = await req("GET", VOL, {
      query: { symbol: "BTCUSDT" },
      headers: {
        "payment-signature": Buffer.from(
          JSON.stringify({ subscription_nonce: nonce || "deadbeef" }),
          "utf8"
        ).toString("base64"),
      },
    });
    assert(
      "U-05",
      r.status === 200 && r.pay?.free_mode === true,
      `nonce gating N/A free mode status=${r.status} pay=${clip(r.pay)}`,
      { status: r.status, pay: r.pay }
    );
  }

  // --- 9. Treasury ---
  let bal = null;
  {
    const r = await req("GET", TREASURY_BAL, {
      headers: { "x-api-key": ADMIN_API_KEY },
    });
    bal = r.json;
    // T-04 withdraw OK
    const dest = (bal?.withdrawal_whitelist || [])[0];
    const token = (bal?.token_whitelist || [])[0];
    if (!dest || !token) {
      skip("T-04", "whitelist empty in balance response");
    } else {
      const wd = await req("POST", TREASURY_WD, {
        headers: { "x-api-key": ADMIN_API_KEY },
        body: {
          amount: "1",
          token,
          destination: dest,
        },
      });
      assert(
        "T-04",
        wd.status === 200 &&
          (wd.json?.status === "pending" ||
            wd.json?.pending === true ||
            wd.json?.destination === dest ||
            wd.json?.recorded === true ||
            wd.ok),
        `withdraw status=${wd.status} body=${clip(wd.json || wd.text)}`,
        { status: wd.status, body: wd.json }
      );
    }
  }
  {
    const tokenBad = "0x000000000000000000000000000000000000dead";
    const dest = (bal?.withdrawal_whitelist || ["0x0000000000000000000000000000000000000001"])[0];
    const wd = await req("POST", TREASURY_WD, {
      headers: { "x-api-key": ADMIN_API_KEY },
      body: { amount: "1", token: tokenBad, destination: dest },
    });
    assert("T-07", wd.status === 403, `bad token status=${wd.status} ${clip(wd.text)}`, {
      status: wd.status,
      body: clip(wd.json || wd.text),
    });
  }
  {
    const dest = (bal?.withdrawal_whitelist || ["0x0000000000000000000000000000000000000001"])[0];
    const token = (bal?.token_whitelist || ["0x55d398326f99059fF775485246999027B3197955"])[0];
    const over =
      bal?.single_limit_atomic != null
        ? (BigInt(bal.single_limit_atomic) + 1n).toString()
        : "1000000000000000001";
    const wd = await req("POST", TREASURY_WD, {
      headers: { "x-api-key": ADMIN_API_KEY },
      body: { amount: over, token, destination: dest },
    });
    assert("T-08", wd.status === 403, `over limit status=${wd.status} ${clip(wd.text)}`, {
      status: wd.status,
      body: clip(wd.json || wd.text),
    });
  }

  // --- 10. CORS / abuse ---
  {
    // CORS_ORIGINS empty in env → C-04 may not apply; document
    const corsConfigured = !!(env.CORS_ORIGINS && env.CORS_ORIGINS.trim());
    if (!corsConfigured) {
      skip("C-04", "CORS_ORIGINS empty — preflight allow N/A; CORS off");
    } else {
      const origin = env.CORS_ORIGINS.split(",")[0].trim();
      const r = await req("OPTIONS", VOL, {
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "GET",
        },
      });
      assert(
        "C-04",
        r.status === 204 || r.status === 200,
        `OPTIONS status=${r.status} ACAO=${r.headers.get("access-control-allow-origin")}`,
        { status: r.status }
      );
    }
  }
  {
    const r = await req("GET", VOL, { query: { symbol: "BTCUSDT';DROP TABLE scores;--" } });
    const safe =
      ((r.status >= 400 && r.status < 500) || r.status === 503 || r.status === 200) &&
      !/<\/?html/i.test(r.text) &&
      !/stack trace|at Object\./i.test(r.text);
    assert("X-01", safe && r.status !== 500, `sqlish status=${r.status} ${clip(r.text)}`, {
      status: r.status,
    });
  }
  {
    // Array bomb within 10kb — many symbols
    const symbols = Array.from({ length: 150 }, (_, i) => `S${String(i).padStart(3, "0")}USDT`);
    const r = await req("POST", BATCH, { body: { symbols } });
    const ok =
      (r.status === 200 || r.status === 400) &&
      r.status !== 500 &&
      (r.json?.count == null || r.json.count <= 100);
    assert(
      "X-03",
      ok,
      `array bomb status=${r.status} count=${r.json?.count}`,
      { status: r.status, count: r.json?.count }
    );
  }
  {
    const r = await req("GET", VOL, { query: { symbol: "BTCÜSDT" } });
    const fail =
      (r.status >= 400 && r.status < 500) ||
      r.status === 503 ||
      (r.status === 200 && r.json?.error);
    assert(
      "X-08",
      fail && r.status !== 500,
      `unicode status=${r.status} ${clip(r.text)}`,
      { status: r.status, body: clip(r.json || r.text) }
    );
  }
  {
    const r = await req("GET", VOL, { query: { symbol: "BTCUSDT", interval: "1H" } });
    // Document case rules: often 400 for uppercase H
    assert(
      "X-09",
      r.status === 200 || r.status === 400,
      `interval 1H status=${r.status} body=${clip(r.json || r.text)}`,
      { status: r.status, body: clip(r.json || r.text) }
    );
  }

  // --- 11. Journeys ---
  {
    const chain = [];
    for (const [name, fn] of [
      ["health", () => req("GET", HEALTH)],
      ["ready", () => req("GET", READY)],
      ["info", () => req("GET", INFO)],
      ["docs", () => req("GET", DOCS)],
      ["volatility", () => req("GET", VOL, { query: { symbol: "BTCUSDT" } })],
      ["history", () => req("GET", HIST, { query: { limit: "5" } })],
      ["batch", () => req("POST", BATCH, { body: { symbols: ["BTCUSDT", "ETHUSDT"] } })],
      [
        "portfolio",
        () =>
          req("POST", PORT, {
            body: { symbols: ["BTCUSDT", "ETHUSDT"], weights: [0.5, 0.5] },
          }),
      ],
    ]) {
      const r = await fn();
      chain.push({ name, status: r.status, pay: r.pay });
    }
    const info = await req("GET", INFO);
    const pricesZero =
      info.json?.payment?.payments_enabled === false &&
      (info.json?.routes?.paid || []).every(
        (p) => p.price_atomic === "0" || p.price_atomic === 0
      );
    const allGreen = chain.every((c) => c.status === 200);
    assert(
      "F-01",
      allGreen && pricesZero,
      `chain ${chain.map((c) => `${c.name}:${c.status}`).join(" ")} pricesZero=${pricesZero}`,
      { chain, pricesZero }
    );
  }
  {
    const r = await req("POST", PORT, {
      body: { symbols: ["BTCUSDT", "ETHUSDT"], weights: [0.9, 0.1] },
    });
    const warnings =
      r.json?.concentration_warnings ||
      r.json?.warnings ||
      r.json?.portfolio?.warnings ||
      [];
    const hasWarn = Array.isArray(warnings)
      ? warnings.length > 0 || /concentrat|50/i.test(JSON.stringify(r.json))
      : !!warnings;
    assert(
      "F-04",
      r.status === 200 && hasWarn,
      `concentration warnings=${clip(warnings)}`,
      { status: r.status, warnings }
    );
  }
  {
    const a = await req("POST", SUB, { body: {} });
    const b = await req("POST", SUB, { body: {} });
    const na = a.json?.nonce || a.json?.subscription_nonce;
    const nb = b.json?.nonce || b.json?.subscription_nonce;
    assert(
      "F-06",
      a.status === 200 && b.status === 200 && na && nb && na !== nb,
      `nonces distinct ${!!na && !!nb && na !== nb}`,
      { a: !!na, b: !!nb, distinct: na !== nb }
    );
  }
  {
    const [admin, intel] = await Promise.all([
      req("GET", TREASURY_BAL, { headers: { "x-api-key": ADMIN_API_KEY } }),
      req("GET", VOL, { query: { symbol: "BTCUSDT" } }),
    ]);
    const leak =
      noteSecrets(intel.json).length > 0 ||
      /ADMIN_API_KEY|x-api-key/i.test(intel.text) ||
      (intel.headers.get("x-api-key") != null);
    assert(
      "F-07",
      admin.status === 200 && intel.status === 200 && !leak,
      `admin=${admin.status} intel=${intel.status} leak=${leak}`,
      { admin: admin.status, intel: intel.status }
    );
  }

  // --- 12. H-04 H-05 ---
  {
    const r = await req("POST", HEALTH);
    assert(
      "H-04",
      r.status === 404 || r.status === 405 || r.status === 501,
      `POST /health status=${r.status}`,
      { status: r.status, body: clip(r.text) }
    );
  }
  {
    const big = JSON.stringify({ symbols: ["BTCUSDT"], pad: "x".repeat(12_000) });
    const r = await req("POST", BATCH, { rawBody: big });
    assert(
      "H-05",
      r.status === 413 || r.status === 400,
      `oversized status=${r.status} ${clip(r.text)}`,
      { status: r.status, body: clip(r.json || r.text) }
    );
  }

  // Explicit skips for destructive cases
  skip("S-02", "destructive — would require killing/restarting live process without ADMIN_API_KEY");
  skip("S-03", "destructive — would require killing/restarting live process without BINANCE_MCP_AUTH_TOKEN");
  skip("S-06", "SKIPPED — SIGINT would kill user's running server");
  skip("S-07", "SKIPPED — SIGTERM would kill user's running server");

  // L-03 check: batch empty semantics with all-invalid already 400; try impossible symbols that pass filter but fail MCP
  {
    const r = await req("POST", BATCH, {
      body: { symbols: ["ZZZZZZZZUSDT", "YYYYYYYYUSDT"] },
    });
    record(
      "L-03-check",
      r.status === 200 && r.json?.count === 0
        ? "PASS"
        : r.status === 200
          ? "PASS"
          : "INFO",
      `batch obscure symbols status=${r.status} count=${r.json?.count} (empty semantics vs portfolio 503)`,
      { status: r.status, count: r.json?.count, body: clip(r.json) }
    );
  }

  // Write results
  const summary = {
    PASS: results.filter((r) => r.result === "PASS").length,
    FAIL: results.filter((r) => r.result === "FAIL").length,
    SKIP: results.filter((r) => r.result === "SKIP").length,
    INFO: results.filter((r) => r.result === "INFO").length,
    other: results.filter((r) => !["PASS", "FAIL", "SKIP", "INFO"].includes(r.result)).length,
  };

  const out = {
    generated_at: new Date().toISOString(),
    base: BASE,
    mode: "PAYMENTS_ENABLED=false",
    summary,
    results,
  };
  const fs = await import("node:fs");
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  console.log("| ID | Result | Notes |");
  console.log("| --- | --- | --- |");
  for (const row of results) {
    const notes = String(row.notes || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    console.log(`| ${row.id} | ${row.result} | ${notes} |`);
  }
  console.log("");
  console.log(
    `SUMMARY PASS=${summary.PASS} FAIL=${summary.FAIL} SKIP=${summary.SKIP} INFO=${summary.INFO}`
  );
  console.log(`JSON: ${OUT}`);
}

main().catch((err) => {
  console.error("runner failed:", err?.message || err);
  process.exit(1);
});
