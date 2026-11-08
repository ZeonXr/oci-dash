import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

if (existsSync(".env")) {
  console.log(".env already exists; existing configuration was preserved.");
  process.exit(0);
}
const password = randomBytes(24).toString("base64url");
const key = randomBytes(32).toString("base64");
writeFileSync(
  ".env",
  `ADMIN_USERNAME=admin\nADMIN_PASSWORD=${password}\nMASTER_KEY=${key}\nAPP_ORIGIN=http://localhost:3000\nDATABASE_PATH=data/oci-dash.db\nPORT=3000\nNEXT_TELEMETRY_DISABLED=1\n`,
  { mode: 0o600, flag: "wx" },
);
console.log(
  "Created .env with a random administrator password and encryption key. Keep this file private. Sign in to add your first OCI account.",
);
