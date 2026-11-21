// A/B-тест цены. Чистая функция: вызывается из middleware, тестируется без HTTP.

export const PRICE_COOKIE = "hi_price";

export type PriceResolution = { price: number; persist: boolean; source: "query" | "cookie" | "random" };

/**
 * ?price= из списка вариантов переопределяет всё и закрепляется в cookie; иначе — вариант из cookie;
 * иначе (первый визит или вариант, которого больше нет в конфиге) — случайный равновероятный.
 */
export function resolvePriceVariant(opts: {
  variants: number[];
  cookie?: string | null;
  query?: string | null;
  random?: () => number;
}): PriceResolution {
  const { variants, cookie, query, random = Math.random } = opts;
  const pick = (raw?: string | null) => {
    if (!raw || !/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return variants.includes(n) ? n : null;
  };

  const fromQuery = pick(query);
  if (fromQuery !== null) return { price: fromQuery, persist: fromQuery !== pick(cookie), source: "query" };

  const fromCookie = pick(cookie);
  if (fromCookie !== null) return { price: fromCookie, persist: false, source: "cookie" };

  const i = Math.min(Math.floor(random() * variants.length), variants.length - 1);
  return { price: variants[i], persist: true, source: "random" };
}
