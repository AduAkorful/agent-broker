import { ethers } from "ethers";
const p = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
const addrs = {
  docs_v3: "0xE91b564EB8DFF305Ff8efA332f84c487b9da5171",
  github_v2: "0xE1C2830d5DDd6B49E9c46EbE03a98Cb44CD8eA5a",
};
for (const [name, addr] of Object.entries(addrs)) {
  const code = await p.getCode(addr);
  console.log(name, addr, "codeLen", code.length, "hasCode", code !== "0x");
}
for (const url of [
  "https://facilitatorv3.b402.ai/api/v1/health",
  "https://facilitator.b402.ai/health",
  "https://facilitator.b402.ai/api/v1/health",
  "https://facilitator.b402.network/health",
]) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const t = await r.text();
    console.log(url, r.status, t.slice(0, 160).replace(/\n/g, " "));
  } catch (e) {
    console.log(url, "ERR", e.message);
  }
}
