#!/usr/bin/env node
import { ethers } from "ethers";
import { loadEnvFile } from "./load-env.mjs";

const FAC = "https://facilitatorv3.b402.ai";
const V2 = "0xE1C2830d5DDd6B49E9c46EbE03a98Cb44CD8eA5a";
const V3 = "0xE91b564EB8DFF305Ff8efA332f84c487b9da5171";
const USDT = "0x55d398326f99059fF775485246999027B3197955";

// V3 docs include token; V2 GitHub issue shows WITHOUT token
const TYPES_WITH_TOKEN = {
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
const TYPES_NO_TOKEN = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

async function attempt(label, { verifyingContract, relayerContract, withToken }) {
  const env = loadEnvFile();
  const wallet = new ethers.Wallet(
    env.PRIVATE_KEY.trim().startsWith("0x") ? env.PRIVATE_KEY.trim() : `0x${env.PRIVATE_KEY.trim()}`,
  );
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const baseAuth = {
    from: wallet.address,
    to: wallet.address,
    value: "150000000000000000",
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 3600,
    nonce,
  };
  const authorization = withToken ? { token: USDT, ...baseAuth } : baseAuth;
  const types = withToken ? TYPES_WITH_TOKEN : TYPES_NO_TOKEN;
  const domain = { name: "B402", version: "1", chainId: 56, verifyingContract };
  const signature = await wallet.signTypedData(domain, types, authorization);
  // facilitator body always wants token in authorization for v3 API
  const authForFac = withToken ? authorization : { token: USDT, ...authorization };
  const body = {
    paymentPayload: { token: USDT, payload: { signature, authorization: authForFac } },
    paymentRequirements: { network: "bsc", relayerContract },
  };
  const v = await fetch(`${FAC}/api/v1/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const vj = await v.json();
  console.log(`\n[${label}] verify`, v.status, JSON.stringify(vj));
  if (vj.isValid !== true) return;
  const s = await fetch(`${FAC}/api/v1/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": nonce },
    body: JSON.stringify(body),
  });
  console.log(`[${label}] settle`, s.status, (await s.text()).slice(0, 220));
}

await attempt("v2-contract+token-types", { verifyingContract: V2, relayerContract: V2, withToken: true });
await attempt("v2-contract+no-token-types", { verifyingContract: V2, relayerContract: V2, withToken: false });
await attempt("v3-empty+token-types", { verifyingContract: V3, relayerContract: V3, withToken: true });
