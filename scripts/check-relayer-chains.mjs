#!/usr/bin/env node
import { ethers } from "ethers";

const ADDR = "0xE91b564EB8DFF305Ff8efA332f84c487b9da5171";
const rpcs = [
  ["bsc-1", "https://bsc-dataseed1.binance.org"],
  ["bsc-2", "https://rpc.ankr.com/bsc"],
  ["base", "https://mainnet.base.org"],
];

for (const [name, url] of rpcs) {
  try {
    const p = new ethers.JsonRpcProvider(url);
    const [net, code, block] = await Promise.all([p.getNetwork(), p.getCode(ADDR), p.getBlockNumber()]);
    console.log(name, {
      chainId: Number(net.chainId),
      block,
      codeLen: code.length,
      hasCode: code !== "0x",
    });
  } catch (e) {
    console.log(name, "ERR", e.shortMessage || e.message);
  }
}
