import { and, count, eq, lt, ne } from "drizzle-orm";
import { appConfig } from "./config";
import { getDb, schema } from "./db";
import { percentileFromCounts } from "./scoring";

export async function getResult(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const [r] = await getDb()
    .select()
    .from(schema.results)
    .where(and(eq(schema.results.id, id), eq(schema.results.isSeed, false)));
  return r ?? null;
}

/**
 * «Счастливее X% участников». Пока настоящих результатов (включая этот) меньше порога
 * `percentile.real_results_threshold`, сравниваем вместе с синтетическим seed — страница показывает
 * пометку по `usesSeed`. С порога seed исключается, пометка пропадает. Сам результат в сравнение не входит.
 */
export async function resultPercentile(
  id: string,
  index: number,
  threshold = appConfig().percentile.real_results_threshold,
): Promise<{ value: number | null; usesSeed: boolean }> {
  const db = getDb();
  const t = schema.results;
  const [{ real }] = await db.select({ real: count() }).from(t).where(eq(t.isSeed, false));
  const usesSeed = real < threshold;
  const scope = usesSeed ? ne(t.id, id) : and(eq(t.isSeed, false), ne(t.id, id));
  const [{ total }] = await db.select({ total: count() }).from(t).where(scope);
  const [{ below }] = await db.select({ below: count() }).from(t).where(and(scope, lt(t.index, index)));
  return { value: percentileFromCounts(below, total), usesSeed };
}
