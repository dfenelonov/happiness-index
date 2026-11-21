import fs from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";

export type DB = LibSQLDatabase<typeof schema>;

export function databaseUrl() {
  return process.env.DATABASE_URL || "file:./data/app.db";
}

function ensureDir(url: string) {
  if (url.startsWith("file:") && !url.includes(":memory:")) {
    fs.mkdirSync(path.dirname(url.slice("file:".length)), { recursive: true });
  }
}

const g = globalThis as unknown as { __hiDb?: { url: string; client: Client; db: DB } };

/** Один клиент на процесс (и на hot reload в dev). Смена DATABASE_URL (в тестах) создаёт новый. */
export function getDb(): DB {
  const url = databaseUrl();
  if (!g.__hiDb || g.__hiDb.url !== url) {
    ensureDir(url);
    const client = createClient({ url });
    g.__hiDb = { url, client, db: drizzle(client, { schema }) };
  }
  return g.__hiDb.db;
}

export { schema };
