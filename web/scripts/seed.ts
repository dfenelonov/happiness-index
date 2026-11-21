import { eq } from "drizzle-orm";
import { questionnaire } from "../lib/config";
import { getDb, schema } from "../lib/db";
import { syntheticResults } from "../lib/seed";

const N = Number(process.env.SEED_RESULTS ?? 500);

async function main() {
  const db = getDb();
  // идемпотентно: старый seed заменяется, настоящие результаты не трогаем
  await db.delete(schema.results).where(eq(schema.results.isSeed, true));
  const rows = syntheticResults(questionnaire(), N);
  for (let i = 0; i < rows.length; i += 100) await db.insert(schema.results).values(rows.slice(i, i + 100));
  const sorted = rows.map((r) => r.index).sort((a, b) => a - b);
  console.log(`Seed: ${rows.length} синтетических результатов (is_seed=1), медиана индекса ${sorted[Math.floor(sorted.length / 2)]}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
