// Простое ограничение частоты в памяти процесса (одна инстанция в MVP). Окно — минута.

const buckets = new Map<string, { count: number; reset: number }>();

export function rateLimited(key: string, perMinute: number, now = Date.now()): boolean {
  const b = buckets.get(key);
  if (!b || b.reset <= now) {
    buckets.set(key, { count: 1, reset: now + 60_000 });
    if (buckets.size > 50_000) for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
    return false;
  }
  b.count++;
  return b.count > perMinute;
}
