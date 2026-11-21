import { timingSafeEqual } from "node:crypto";

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
