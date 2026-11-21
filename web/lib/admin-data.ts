import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import { notQa } from "./qa";

export type Period = { from?: string; to?: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Границы периода в UTC по датам (YYYY-MM-DD), to — включительно. */
export function periodBounds(p: Period) {
  const from = p.from && DATE.test(p.from) ? `${p.from}T00:00:00.000Z` : undefined;
  const to = p.to && DATE.test(p.to) ? new Date(Date.parse(`${p.to}T00:00:00.000Z`) + 86_400_000).toISOString() : undefined;
  return { from, to };
}

export async function loadEvents(p: Period) {
  const { from, to } = periodBounds(p);
  const e = schema.events;
  return getDb()
    .select({ name: e.name, anonId: e.anonId, priceVariant: e.priceVariant, utmSource: e.utmSource, props: e.props })
    .from(e)
    .where(and(notQa(e.anonId), from ? gte(e.createdAt, from) : undefined, to ? lt(e.createdAt, to) : undefined));
}

export async function loadOrders(p: Period, limit = 200) {
  const { from, to } = periodBounds(p);
  const o = schema.orders;
  return getDb()
    .select()
    .from(o)
    .where(and(notQa(o.anonId), from ? gte(o.createdAt, from) : undefined, to ? lt(o.createdAt, to) : undefined))
    .orderBy(desc(o.createdAt))
    .limit(limit);
}

export async function loadLeads(p: Period, limit = 200) {
  const { from, to } = periodBounds(p);
  const l = schema.leads;
  return getDb()
    .select()
    .from(l)
    .where(and(notQa(l.anonId), from ? gte(l.createdAt, from) : undefined, to ? lt(l.createdAt, to) : undefined))
    .orderBy(desc(l.createdAt))
    .limit(limit);
}

export async function revenueByVariant(p: Period) {
  const { from, to } = periodBounds(p);
  const o = schema.orders;
  return getDb()
    .select({ variant: o.priceVariant, paid: count(), revenue: sql<number>`coalesce(sum(${o.amountRub}), 0)` })
    .from(o)
    .where(and(eq(o.status, "paid"), notQa(o.anonId), from ? gte(o.paidAt, from) : undefined, to ? lt(o.paidAt, to) : undefined))
    .groupBy(o.priceVariant);
}

export async function archetypeCounts() {
  const r = schema.results;
  return getDb().select({ archetype: r.archetype, n: count() }).from(r).where(and(eq(r.isSeed, false), notQa(r.anonId))).groupBy(r.archetype);
}

/** Отчёты: сколько готово, доля запасных, время генерации (по нему подбирается таймаут LLM). */
export async function reportStats() {
  const rows = await getDb().all<{ status: string; is_fallback: number; duration_ms: number | null; attempt: number; provider: string | null }>(
    sql`select r.status, r.is_fallback, r.duration_ms, r.attempt, r.provider from reports r
        join orders o on o.id = r.order_id where coalesce(o.anon_id, '') not like 'qa-%'`,
  );
  const ready = rows.filter((r) => r.status === "ready");
  const durations = ready.map((r) => r.duration_ms).filter((d): d is number => d !== null).sort((a, b) => a - b);
  const pct = (p: number) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(p * durations.length))] : null);
  return {
    ready: ready.length,
    pending: rows.filter((r) => r.status === "pending").length,
    failed: rows.filter((r) => r.status === "failed").length,
    fallback: ready.filter((r) => r.is_fallback).length,
    retried: ready.filter((r) => r.attempt > 1).length,
    p50: pct(0.5),
    p95: pct(0.95),
    max: durations.at(-1) ?? null,
    providers: [...new Set(ready.map((r) => r.provider ?? "—"))].join(", "),
  };
}

/** Таблицы для CSV. Seed-результаты и демо-данные /dev/qa исключены. */
export const EXPORTS = {
  events: () => getDb().select().from(schema.events).where(notQa(schema.events.anonId)).orderBy(schema.events.id),
  orders: () => getDb().select().from(schema.orders).where(notQa(schema.orders.anonId)).orderBy(schema.orders.createdAt),
  leads: () => getDb().select().from(schema.leads).where(notQa(schema.leads.anonId)).orderBy(schema.leads.id),
  results: () =>
    getDb()
      .select()
      .from(schema.results)
      .where(and(eq(schema.results.isSeed, false), notQa(schema.results.anonId)))
      .orderBy(schema.results.createdAt),
} as const;

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    // защита от формул в Excel и экранирование кавычек
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}
