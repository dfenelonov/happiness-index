import { NextResponse, type NextRequest } from "next/server";
import { PRICE_COOKIE, resolvePriceVariant } from "@/lib/ab";
import { appConfig } from "@/lib/config";
import { ANON_COOKIE, SESSION_COOKIE, UTM_COOKIE, UTM_KEYS, YEAR_SECONDS, type Attribution } from "@/lib/cookies";
import { checkBasicAuth } from "@/lib/admin-auth";

// Node.js-рантайм: читаем варианты цены из config/app.yaml.
export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/|fonts/|favicon|robots.txt|api/health).*)"],
};

export function middleware(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
    const denied = checkBasicAuth(req.headers.get("authorization"), process.env.ADMIN_PASSWORD);
    if (denied) return denied;
  }

  // Новые cookie кладём и в ответ (сохранить в браузере), и в текущий запрос (чтобы их видел рендер).
  const toSet: [string, string, number | undefined][] = [];
  const ensure = (name: string, value: string, maxAge?: number) => {
    req.cookies.set(name, value);
    toSet.push([name, value, maxAge]);
  };

  if (!req.cookies.get(ANON_COOKIE)) ensure(ANON_COOKIE, crypto.randomUUID(), YEAR_SECONDS);
  if (!req.cookies.get(SESSION_COOKIE)) ensure(SESSION_COOKIE, crypto.randomUUID());

  const price = resolvePriceVariant({
    variants: appConfig().pricing.variants_rub,
    cookie: req.cookies.get(PRICE_COOKIE)?.value,
    query: searchParams.get("price"),
  });
  if (price.persist) ensure(PRICE_COOKIE, String(price.price), YEAR_SECONDS);

  // UTM и реферер — с первого визита (first touch). Реферер — только внешний хост, без пути и query.
  if (!req.cookies.get(UTM_COOKIE) && !pathname.startsWith("/api/")) {
    const attribution: Attribution = {};
    for (const k of UTM_KEYS) {
      const v = searchParams.get(k);
      if (v) attribution[k] = v.slice(0, 100);
    }
    const ref = refererHost(req.headers.get("referer"), req.nextUrl.host);
    if (ref) attribution.referrer = ref;
    ensure(UTM_COOKIE, JSON.stringify(attribution), YEAR_SECONDS);
  }

  const res = NextResponse.next({ request: { headers: req.headers } });
  const secure = process.env.NODE_ENV === "production" && (process.env.APP_URL ?? "").startsWith("https://");
  for (const [name, value, maxAge] of toSet) {
    res.cookies.set(name, value, { httpOnly: true, sameSite: "lax", secure, path: "/", ...(maxAge ? { maxAge } : {}) });
  }
  return res;
}

function refererHost(referer: string | null, ownHost: string): string | undefined {
  if (!referer) return undefined;
  try {
    const host = new URL(referer).host;
    return host && host !== ownHost ? host.slice(0, 100) : undefined;
  } catch {
    return undefined;
  }
}
