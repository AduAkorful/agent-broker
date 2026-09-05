#!/usr/bin/env node
/**
 * Live paid smoke: unpaid 402 → EIP-712 sign → paid 200 with CVMS.
 * Reuses server challenge nonce; signs validAfter=0 to avoid BSC clock skew.
 */
import { ethers } from "ethers";
import { loadEnvFile } from "./load-env.mjs";

const BASE = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3000";
const PATH = "/api/v1/market-intelligence/volatility?symbol=BTCUSDT&interval=1h";
const RELAYER = "0xE91b564EB8DFF305Ff8efA332f84c487b9da5171";

const TYPES = {
  TransferWithAuthorization: [
    { name: "token", type: "address" },
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

function b64encode(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}
function b64decode(h) {
  return JSON.parse(Buffer.from(h, "base64").toString("utf8"));
}

async function main() {
  const env = loadEnvFile();
  const pk = env.PRIVATE_KEY?.trim();
  if (!pk) {
    console.error("PRIVATE_KEY missing in .env");
    process.exit(1);
  }
  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
  console.log("buyer:", wallet.address);
  console.log("seller payTo:", (env.B402_PAY_TO || wallet.address).trim());
  console.log("price atomic env:", env.B402_PRICE_ATOMIC);

  const unpaid = await fetch(`${BASE}${PATH}`);
  console.log("unpaid status:", unpaid.status);
  if (unpaid.status !== 402) {
    console.error("Expected 402. Body:", (await unpaid.text()).slice(0, 400));
    process.exit(1);
  }

  const prHeader = unpaid.headers.get("PAYMENT-REQUIRED") || unpaid.headers.get("payment-required");
  const paymentRequired = b64decode(prHeader);
  const usdt =
    (paymentRequired.accepts || []).find((a) => (a.asset || "").toLowerCase().includes("55d398")) ||
    paymentRequired.accepts[0];
  const extra = usdt.extra || {};
  const nonce = extra.nonce;
  if (!nonce) {
    console.error("Challenge missing extra.nonce");
    process.exit(1);
  }
  console.log("challenge amount:", usdt.amount);

  const authorization = {
    token: usdt.asset,
    from: wallet.address,
    to: usdt.payTo,
    value: usdt.amount,
    validAfter: 0,
    validBefore: Number(extra.validBefore ?? Math.floor(Date.now() / 1000) + 3600),
    nonce,
  };

  const domain = {
    name: "B402",
    version: "1",
    chainId: Number(extra.chainId || 56),
    verifyingContract: extra.verifyingContract || extra.relayerContract || RELAYER,
  };

  const signature = await wallet.signTypedData(domain, TYPES, authorization);
  console.log("signed challenge nonce:", nonce.slice(0, 10) + "…");

  const paymentPayload = {
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted: usdt,
    payload: {
      signature,
      authorization: {
        ...authorization,
        value: String(authorization.value),
        validAfter: String(authorization.validAfter),
        validBefore: String(authorization.validBefore),
      },
    },
  };

  const paid = await fetch(`${BASE}${PATH}`, {
    headers: { "payment-signature": b64encode(paymentPayload) },
  });
  const paidText = await paid.text();
  let paidJson;
  try {
    paidJson = JSON.parse(paidText);
  } catch {
    paidJson = null;
  }
  console.log("paid status:", paid.status);
  const payResp = paid.headers.get("PAYMENT-RESPONSE") || paid.headers.get("payment-response");
  if (payResp) {
    try {
      console.log("PAYMENT-RESPONSE:", JSON.stringify(b64decode(payResp)));
    } catch {
      /* ignore */
    }
  }
  if (paid.status !== 200) {
    console.error("Paid request failed:", paidText.slice(0, 800));
    process.exit(1);
  }
  console.log("body keys:", paidJson ? Object.keys(paidJson).slice(0, 20) : "(non-json)");
  if (paidJson?.symbol) console.log("symbol:", paidJson.symbol);
  if (paidJson?.cvms) console.log("cvms:", JSON.stringify(paidJson.cvms).slice(0, 200));
  if (paidJson?.score != null) console.log("score:", paidJson.score);

  const replay = await fetch(`${BASE}${PATH}`, {
    headers: { "payment-signature": b64encode(paymentPayload) },
  });
  console.log("replay status (expect 402):", replay.status);
  console.log("PASS paid smoke");
}

main().catch((err) => {
  console.error(err?.shortMessage || err?.message || err);
  process.exit(1);
});
