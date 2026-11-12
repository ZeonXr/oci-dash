import Database from "better-sqlite3";
import { createInitialAdminSession } from "../../src/server/initial-admin.ts";
const path = process.argv[2],
  username = process.argv[3];
if (!path || !username)
  throw new Error("Initial admin fixture requires a temporary database and username");
const db = new Database(path);
db.pragma("busy_timeout=10000");
db.pragma("foreign_keys=ON");
try {
  await createInitialAdminSession(db, username, "first-setup-test-password", 43_200);
  process.stdout.write(JSON.stringify({ created: true }));
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "SETUP_ALREADY_COMPLETED")
    process.stdout.write(JSON.stringify({ created: false, code: error.code }));
  else throw error;
} finally {
  db.close();
}
