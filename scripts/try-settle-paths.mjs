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
const env = loadEnvFile();
const wallet = new ethers.Wallet(env.PRIVATE_KEY.trim().startsWith("0x") ? env.PRIVATE_KEY.trim() : `0x${env.PRIVATE_KEY.trim()}`);
const authorization = {
  token: USDT,
  from: wallet.address,
  to: wallet.address,
  value: "150000000000000000",
  validAfter: 0,
  validBefore: Math.floor(Date.now() / 1000) + 3600,
  nonce: ethers.hexlify(ethers.randomBytes(32)),
};
const signature = await wallet.signTypedData(
  { name: "B402", version: "1", chainId: 56, verifyingContract: RELAYER },
  TYPES,
  authorization,
);
const body = {
  paymentPayload: { token: USDT, payload: { signature, authorization } },
  paymentRequirements: { network: "bsc", relayerContract: RELAYER },
};
for (const path of ["/api/v1/settle", "/settle", "/api/v1/verify", "/verify"]) {
  const r = await fetch(`${FAC}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": authorization.nonce },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  console.log(path, r.status, t.slice(0, 180).replace(/\n/g, " "));
}
