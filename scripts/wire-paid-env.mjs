#!/usr/bin/env node
/**
 * Wire self-pay seller address from PRIVATE_KEY in .env,
 * enable payments, check USDT/BNB, approve B402 relayer if needed.
 * Never prints private keys.
 */
import { ethers } from "ethers";
import { loadEnvFile, upsertEnvFile } from "./load-env.mjs";

const USDT = "0x55d398326f99059fF775485246999027B3197955";
const RELAYER = "0xE91b564EB8DFF305Ff8efA332f84c487b9da5171";
const RPC = process.env.BSC_RPC_URL || "https://bsc-dataseed1.binance.org";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

async function main() {
  const env = loadEnvFile();
  const pk = env.PRIVATE_KEY?.trim();
  if (!pk) {
    console.error("PRIVATE_KEY missing in .env");
    process.exit(1);
  }

  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
  const address = wallet.address;

  upsertEnvFile({
    B402_PAY_TO: address,
    PAYMENTS_ENABLED: "true",
  });

  console.log("buyer/seller (self-pay):", address);
  console.log("wrote B402_PAY_TO + PAYMENTS_ENABLED=true");

  const provider = new ethers.JsonRpcProvider(RPC);
  const connected = wallet.connect(provider);
  const usdt = new ethers.Contract(USDT, ERC20_ABI, connected);

  const [bnb, bal, allowance, decimals] = await Promise.all([
    provider.getBalance(address),
    usdt.balanceOf(address),
    usdt.allowance(address, RELAYER),
    usdt.decimals(),
  ]);

  console.log("BNB:", ethers.formatEther(bnb));
  console.log("USDT:", ethers.formatUnits(bal, decimals));
  console.log("USDT allowance→relayer:", ethers.formatUnits(allowance, decimals));

  // Need enough for a few 0.05 USDT smokes + gas for approve
  const minUsdt = ethers.parseUnits("0.2", decimals);
  if (bal < minUsdt) {
    console.warn("WARN: USDT balance < 0.2 — smoke may fail after a few calls");
  }
  if (bnb === 0n) {
    console.error("ERROR: no BNB for approve gas");
    process.exit(1);
  }

  const needed = ethers.parseUnits("100", decimals); // headroom for smokes
  if (allowance < needed) {
    console.log("Approving relayer for USDT (MaxUint256)...");
    const tx = await usdt.approve(RELAYER, ethers.MaxUint256);
    console.log("approve tx:", tx.hash);
    const receipt = await tx.wait();
    console.log("approve confirmed block:", receipt.blockNumber);
    const after = await usdt.allowance(address, RELAYER);
    console.log("new allowance:", ethers.formatUnits(after, decimals));
  } else {
    console.log("Allowance already sufficient — skip approve");
  }

  console.log("DONE — restart the server to pick up PAYMENTS_ENABLED=true");
}

main().catch((err) => {
  console.error(err?.shortMessage || err?.message || err);
  process.exit(1);
});
