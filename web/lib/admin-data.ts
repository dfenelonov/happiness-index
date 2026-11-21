import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getDb, schema } from "./db";

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
    .where(and(from ? gte(e.createdAt, from) : undefined, to ? lt(e.createdAt, to) : undefined));
}

export async function loadOrders(p: Period, limit = 200) {
  const { from, to } = periodBounds(p);
  const o = schema.orders;
  return getDb()
    .select()
    .from(o)
    .where(and(from ? gte(o.createdAt, from) : undefined, to ? lt(o.createdAt, to) : undefined))
    .orderBy(desc(o.createdAt))
    .limit(limit);
}

export async function loadLeads(p: Period, limit = 200) {
  const { from, to } = periodBounds(p);
  const l = schema.leads;
  return getDb()
    .select()
    .from(l)
    .where(and(from ? gte(l.createdAt, from) : undefined, to ? lt(l.createdAt, to) : undefined))
    .orderBy(desc(l.createdAt))
    .limit(limit);
}

export async function revenueByVariant(p: Period) {
  const { from, to } = periodBounds(p);
  const o = schema.orders;
  return getDb()
    .select({ variant: o.priceVariant, paid: count(), revenue: sql<number>`coalesce(sum(${o.amountRub}), 0)` })
    .from(o)
    .where(and(eq(o.status, "paid"), from ? gte(o.paidAt, from) : undefined, to ? lt(o.paidAt, to) : undefined))
    .groupBy(o.priceVariant);
}

export async function archetypeCounts() {
  const r = schema.results;
  return getDb().select({ archetype: r.archetype, n: count() }).from(r).where(eq(r.isSeed, false)).groupBy(r.archetype);
}

/** Таблицы для CSV. Seed-результаты исключены. */
export const EXPORTS = {
  events: () => getDb().select().from(schema.events).orderBy(schema.events.id),
  orders: () => getDb().select().from(schema.orders).orderBy(schema.orders.createdAt),
  leads: () => getDb().select().from(schema.leads).orderBy(schema.leads.id),
  results: () => getDb().select().from(schema.results).where(eq(schema.results.isSeed, false)).orderBy(schema.results.createdAt),
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
