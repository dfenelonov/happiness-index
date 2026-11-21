import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { migrate } from "drizzle-orm/libsql/migrator";
import { getDb } from "@/lib/db";

/** Свежая SQLite-база с миграциями для теста. */
export async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hi-test-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  const db = getDb();
  await migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}
