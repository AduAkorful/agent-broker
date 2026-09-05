import { upsertEnvFile, loadEnvFile } from "./load-env.mjs";
upsertEnvFile({ PAYMENTS_ENABLED: "false" });
const e = loadEnvFile();
console.log("PAYMENTS_ENABLED", e.PAYMENTS_ENABLED);
