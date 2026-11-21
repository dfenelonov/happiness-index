import { migrate } from "drizzle-orm/libsql/migrator";
import { databaseUrl, getDb } from "../lib/db";

async function main() {
  await migrate(getDb(), { migrationsFolder: "./drizzle" });
  console.log(`Миграции применены: ${databaseUrl()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
