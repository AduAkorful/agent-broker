#!/usr/bin/env node
import { ethers } from "ethers";
import { loadEnvFile } from "./load-env.mjs";

const FAC = "https://facilitatorv3.b402.ai";
const RELAYER = "0xE91b564EB8DFF305Ff8efA332f84c487b9da5171";
const USDT = "0x55d398326f99059fF775485246999027B3197955";

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

async function trySettle({ label, to, value }) {
  const env = loadEnvFile();
  const pk = env.PRIVATE_KEY.trim();
  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
  const authorization = {
    token: USDT,
    from: wallet.address,
    to,
    value,
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 3600,
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const domain = { name: "B402", version: "1", chainId: 56, verifyingContract: RELAYER };
  const signature = await wallet.signTypedData(domain, TYPES, authorization);
  const body = {
    paymentPayload: { token: USDT, payload: { signature, authorization } },
    paymentRequirements: { network: "bsc", relayerContract: RELAYER },
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
    headers: { "Content-Type": "application/json", "Idempotency-Key": authorization.nonce },
    body: JSON.stringify(body),
  });
  const text = await s.text();
  console.log(`[${label}] settle`, s.status, text.slice(0, 500));
}

async function main() {
  const env = loadEnvFile();
  const pk = env.PRIVATE_KEY.trim();
  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
  // self-pay 0.15
  await trySettle({ label: "self-0.15", to: wallet.address, value: "150000000000000000" });
  // self-pay 1.0
  await trySettle({ label: "self-1.0", to: wallet.address, value: "1000000000000000000" });
  // pay to a burn/dummy different address (still our USDT leaving wallet)
  await trySettle({
    label: "other-0.15",
    to: "0x0000000000000000000000000000000000000001",
    value: "150000000000000000",
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
