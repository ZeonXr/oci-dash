import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { initializeMasterKey, readMasterKey } from "../../src/server/master-key.ts";

const path = process.argv[2];
if (!path) throw new Error("Master key fixture requires its temporary database path");
const db = new Database(path);
db.pragma("busy_timeout=10000");
try {
  initializeMasterKey(db, path);
  process.stdout.write(createHash("sha256").update(readMasterKey(path)).digest("hex"));
} finally {
  db.close();
}
