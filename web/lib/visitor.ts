import { cookies } from "next/headers";
import { PRICE_COOKIE } from "./ab";
import { appConfig } from "./config";
import { ANON_COOKIE, parseAttribution, SESSION_COOKIE, UTM_COOKIE, type Attribution } from "./cookies";

export type Visitor = {
  anonId: string | null;
  sessionId: string | null;
  price: number;
  attribution: Attribution;
};

/** Посетитель из cookie (их выставляет middleware). Цена — всегда из списка вариантов. */
export async function getVisitor(): Promise<Visitor> {
  const jar = await cookies();
  const variants = appConfig().pricing.variants_rub;
  const raw = Number(jar.get(PRICE_COOKIE)?.value);
  return {
    anonId: jar.get(ANON_COOKIE)?.value ?? null,
    sessionId: jar.get(SESSION_COOKIE)?.value ?? null,
    price: variants.includes(raw) ? raw : variants[Math.floor(variants.length / 2)],
    attribution: parseAttribution(jar.get(UTM_COOKIE)?.value),
  };
}
