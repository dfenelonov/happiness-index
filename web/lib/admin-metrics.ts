import type { AppConfig } from "./config";

// Агрегация воронки по серверным событиям. Единица — посетитель (anon_id): шаг засчитан,
// если у посетителя есть хотя бы одно такое событие за период.

export type EventRow = {
  name: string;
  anonId: string | null;
  priceVariant: number | null;
  utmSource: string | null;
  props: Record<string, unknown> | null;
};

export const FUNNEL = [
  "visit",
  "test_start",
  "test_complete",
  "result_view",
  "share_click",
  "paywall_view",
  "checkout_start",
  "payment_success",
  "subscription_click",
  "email_submit",
] as const;

export type Color = "green" | "yellow" | "red" | "gray";
export type Metric = { key: string; name: string; num: number; den: number; value: number | null; ci: [number, number] | null; go: number; stop: number | null; color: Color };

export function wilson(k: number, n: number, z = 1.96): [number, number] | null {
  if (n === 0) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export function colorFor(value: number | null, go: number, stop: number | null): Color {
  if (value === null) return "gray";
  if (value >= go) return "green";
  if (stop !== null && value < stop) return "red";
  return "yellow";
}

function byAnon(rows: EventRow[]) {
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.anonId) continue;
    let s = m.get(r.anonId);
    if (!s) m.set(r.anonId, (s = new Set()));
    s.add(r.name);
  }
  return m;
}

export function funnelMetrics(rows: EventRow[], thresholds: AppConfig["metrics"]) {
  const anons = byAnon(rows);
  const has = (a: Set<string>, ...names: string[]) => names.every((n) => a.has(n));
  const count = (...names: string[]) => [...anons.values()].filter((a) => has(a, ...names)).length;

  const steps = FUNNEL.map((name) => ({ name, visitors: count(name) }));
  const defs: [keyof AppConfig["metrics"], string[], string[]][] = [
    ["completion", ["test_complete", "test_start"], ["test_start"]],
    ["share", ["share_click", "test_complete"], ["test_complete"]],
    ["purchase", ["payment_success", "test_complete"], ["test_complete"]],
    ["subscription", ["subscription_click", "payment_success"], ["payment_success"]],
  ];
  const metrics: Metric[] = defs.map(([key, numNames, denNames]) => {
    const t = thresholds[key];
    const num = count(...numNames);
    const den = count(...denNames);
    const value = den ? num / den : null;
    return { key, name: t.name, num, den, value, ci: wilson(num, den), go: t.go, stop: t.stop, color: colorFor(value, t.go, t.stop) };
  });
  return { steps, metrics };
}

/** Разбивка по атрибуту посетителя (вариант цены или utm_source — берётся из его событий). */
export function breakdown(rows: EventRow[], thresholds: AppConfig["metrics"], key: "priceVariant" | "utmSource") {
  const groupOf = new Map<string, string>();
  for (const r of rows) {
    if (!r.anonId || groupOf.has(r.anonId)) continue;
    const v = r[key];
    if (v !== null && v !== undefined) groupOf.set(r.anonId, String(v));
  }
  const groups = new Map<string, EventRow[]>();
  for (const r of rows) {
    if (!r.anonId) continue;
    const g = groupOf.get(r.anonId) ?? (key === "utmSource" ? "(прямой заход)" : "—");
    let list = groups.get(g);
    if (!list) groups.set(g, (list = []));
    list.push(r);
  }
  return [...groups.entries()]
    .map(([group, list]) => ({ group, ...funnelMetrics(list, thresholds) }))
    .sort((a, b) => b.steps[0].visitors - a.steps[0].visitors || a.group.localeCompare(b.group));
}

/** Доходимость: сколько прохождений ответили на вопрос n (хотя бы раз), от числа стартов. */
export function questionReach(rows: EventRow[], total: number) {
  const tests = new Map<number, Set<string>>();
  const starts = new Set<string>();
  for (const r of rows) {
    const testId = r.props?.test_id;
    if (typeof testId !== "string") continue;
    if (r.name === "test_start") starts.add(testId);
    if (r.name === "question_answered" && typeof r.props?.n === "number") {
      const n = r.props.n;
      if (!tests.has(n)) tests.set(n, new Set());
      tests.get(n)!.add(testId);
    }
  }
  const base = starts.size;
  let prev = base;
  return Array.from({ length: total }, (_, i) => {
    const reached = tests.get(i + 1)?.size ?? 0;
    const row = { n: i + 1, reached, share: base ? reached / base : null, drop: prev ? (prev - reached) / prev : null };
    prev = reached;
    return row;
  });
}
