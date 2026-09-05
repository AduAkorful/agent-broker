#!/usr/bin/env node
import { ethers } from "ethers";
import { loadEnvFile } from "./load-env.mjs";

const RELAYER = "0xE91b564EB8DFF305Ff8efA332f84c487b9da5171";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const RPC = "https://bsc-dataseed1.binance.org";

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

const RELAYER_ABI = [
  "function transferWithAuthorization(address token,address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)",
  "function authorizationState(address from, bytes32 nonce) view returns (bool)",
];

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

async function main() {
  const env = loadEnvFile();
  const pk = env.PRIVATE_KEY.trim();
  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
  const provider = new ethers.JsonRpcProvider(RPC);
  const code = await provider.getCode(RELAYER);
  console.log("relayer code length:", code.length, "starts:", code.slice(0, 20));

  const relayer = new ethers.Contract(RELAYER, RELAYER_ABI, provider);
  const usdt = new ethers.Contract(USDT, ERC20_ABI, provider);
  const [bal, all] = await Promise.all([
    usdt.balanceOf(wallet.address),
    usdt.allowance(wallet.address, RELAYER),
  ]);
  console.log({ bal: ethers.formatUnits(bal, 18), allowance: all.toString().slice(0, 30) + "…" });

  const authorization = {
    token: USDT,
    from: wallet.address,
    to: wallet.address,
    value: "150000000000000000",
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 3600,
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const domain = { name: "B402", version: "1", chainId: 56, verifyingContract: RELAYER };
  const signature = await wallet.signTypedData(domain, TYPES, authorization);
  console.log("nonce", authorization.nonce);

  try {
    const used = await relayer.authorizationState(wallet.address, authorization.nonce);
    console.log("authorizationState before:", used);
  } catch (e) {
    console.log("authorizationState err:", e.shortMessage || e.message);
  }

  try {
    await relayer.transferWithAuthorization.staticCall(
      authorization.token,
      authorization.from,
      authorization.to,
      BigInt(authorization.value),
      BigInt(authorization.validAfter),
      BigInt(authorization.validBefore),
      authorization.nonce,
      signature,
    );
    console.log("staticCall: SUCCESS");
  } catch (e) {
    console.log("staticCall REVERT short:", e.shortMessage);
    console.log("reason:", e.reason);
    console.log("revert:", e.revert);
    console.log("data:", typeof e.data === "string" ? e.data.slice(0, 200) : e.data);
    if (e.info?.error) console.log("info.error:", JSON.stringify(e.info.error).slice(0, 400));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
