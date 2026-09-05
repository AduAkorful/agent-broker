import { upsertEnvFile, loadEnvFile } from "./load-env.mjs";
upsertEnvFile({
  B402_PRICE_ATOMIC: "150000000000000000",
  B402_PRICE_DECIMAL: "0.15",
});
const e = loadEnvFile();
console.log("PAYMENTS_ENABLED", e.PAYMENTS_ENABLED);
console.log("B402_PRICE_ATOMIC", e.B402_PRICE_ATOMIC);
console.log("B402_PRICE_DECIMAL", e.B402_PRICE_DECIMAL);
console.log("B402_PAY_TO set", Boolean(e.B402_PAY_TO));
