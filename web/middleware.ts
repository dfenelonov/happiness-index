import { NextResponse, type NextRequest } from "next/server";
import { PRICE_COOKIE, resolvePriceVariant } from "@/lib/ab";
import { appConfig } from "@/lib/config";
import { ANON_COOKIE, SESSION_COOKIE, UTM_COOKIE, UTM_KEYS, YEAR_SECONDS, type Attribution } from "@/lib/cookies";
import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_SECONDS, checkBasicAuth, signAdminSession, verifyAdminSession } from "@/lib/admin-auth";
import { devToolsAllowed, mockPaymentsEnabled } from "@/lib/env-guard";

// Node.js-рантайм: читаем варианты цены из config/app.yaml.
export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/|fonts/|favicon|robots.txt|api/health).*)"],
};

export function middleware(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  // /dev/* в production — только с паролем админки, иначе 404; мок-касса — только при PAYMENT_PROVIDER=mock
  const notFound = () => new NextResponse("Not found", { status: 404 });
  if (pathname.startsWith("/dev/") && !devToolsAllowed(req.cookies.get(ADMIN_SESSION_COOKIE)?.value)) return notFound();
  if ((pathname.startsWith("/pay/mock/") || pathname.startsWith("/api/pay/mock/")) && !mockPaymentsEnabled()) return notFound();
  // вход в админку открывает сессию для /dev/* (подписанная httpOnly-cookie на 12 часов)
  let openAdminSession = false;
  if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
    const denied = checkBasicAuth(req.headers.get("authorization"), process.env.ADMIN_PASSWORD);
    if (denied) return denied;
    openAdminSession = !verifyAdminSession(req.cookies.get(ADMIN_SESSION_COOKIE)?.value, process.env.ADMIN_PASSWORD);
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
  if (openAdminSession) {
    res.cookies.set(ADMIN_SESSION_COOKIE, signAdminSession(process.env.ADMIN_PASSWORD!), {
      httpOnly: true,
      sameSite: "strict",
      secure,
      path: "/",
      maxAge: ADMIN_SESSION_SECONDS,
    });
  }
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
