import fs from "node:fs";
const p = "package.json";
const d = JSON.parse(fs.readFileSync(p, "utf8"));
d.scripts.start = "node dist/src/index.js";
fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
console.log("start:", d.scripts.start);
