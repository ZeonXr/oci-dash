import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureInitialAdmin } from "../../src/server/initial-admin.ts";
import { verifyPassword } from "../../src/server/crypto.ts";

const path = process.argv[2];
if (!path) throw new Error("Initial admin fixture requires its temporary database path");
const db = new Database(path);
db.pragma("busy_timeout=10000");
try {
  ensureInitialAdmin(db, path);
  const user = db.prepare("SELECT id,password_hash FROM users").get() as {
    id: string;
    password_hash: string;
  };
  const password = readFileSync(join(dirname(path), ".initial-admin-password"), "utf8").trim();
  process.stdout.write(
    JSON.stringify({
      id: user.id,
      digest: createHash("sha256").update(password).digest("hex"),
      matches: verifyPassword(password, user.password_hash),
    }),
  );
} finally {
  db.close();
}
