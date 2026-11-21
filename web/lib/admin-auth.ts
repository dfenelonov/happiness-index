import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Basic auth для /admin. Логин любой, пароль — ADMIN_PASSWORD. Без пароля админка выключена. */
export function checkBasicAuth(header: string | null, password: string | undefined): Response | null {
  if (!password) return new Response("Админка выключена: задай ADMIN_PASSWORD в .env", { status: 503 });
  const given = header?.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString("utf8") : "";
  const sep = given.indexOf(":");
  const pass = sep >= 0 ? given.slice(sep + 1) : "";
  const a = Buffer.from(pass);
  const b = Buffer.from(password);
  if (a.length === b.length && timingSafeEqual(a, b)) return null;
  return new Response("Нужен пароль", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="admin", charset="UTF-8"' },
  });
}

// Сессия админа для /dev/*: после входа в /admin ставится httpOnly-cookie «срок.подпись» на 12 часов.
// Ключ подписи выводится из ADMIN_PASSWORD — смена пароля сразу обнуляет все сессии.

export const ADMIN_SESSION_COOKIE = "hi_admin";
export const ADMIN_SESSION_SECONDS = 12 * 3600;

function sessionKey(password: string) {
  return createHash("sha256").update(`admin-session:${password}`).digest();
}

export function signAdminSession(password: string, now = Date.now()): string {
  const exp = String(Math.floor(now / 1000) + ADMIN_SESSION_SECONDS);
  return `${exp}.${createHmac("sha256", sessionKey(password)).update(exp).digest("base64url")}`;
}

export function verifyAdminSession(token: string | undefined | null, password: string | undefined, now = Date.now()): boolean {
  if (!token || !password) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) * 1000 <= now) return false;
  const expected = Buffer.from(createHmac("sha256", sessionKey(password)).update(exp).digest("base64url"));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
