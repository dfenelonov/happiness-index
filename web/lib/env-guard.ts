import { checkBasicAuth } from "./admin-auth";

// Проверки окружения. В production приложение не стартует, пока список проблем не пуст
// (instrumentation.ts → register). Чистые функции от env — покрыты юнит-тестами.

type Env = Record<string, string | undefined>;

export const RECEIPT_MODES = ["none", "yookassa_receipt"] as const;
export type ReceiptMode = (typeof RECEIPT_MODES)[number];

/** Пароли, которые не годятся даже при длине ≥ 16 (без учёта регистра). */
const WEAK_PASSWORDS = new Set([
  "change-me",
  "changeme",
  "password",
  "admin",
  "administrator",
  "qwerty",
  "123456",
  "12345678",
  "1234567890123456",
  "passwordpassword",
  "adminadminadmin1",
  "qwertyqwertyqwer",
  "aaaaaaaaaaaaaaaa",
  "e2e-admin",
  "smoke",
  "happiness-index-admin",
]);
export const MIN_ADMIN_PASSWORD = 16;

export const isProduction = (env: Env = process.env) => env.NODE_ENV === "production";

/** Явный обход проверок — только для CI и локального прогона production-сборки на моках. */
export const checksSkipped = (env: Env = process.env) => env.UNSAFE_SKIP_PRODUCTION_CHECKS === "true";

export function receiptMode(env: Env = process.env): ReceiptMode {
  const v = env.RECEIPT_MODE || "none";
  if (!(RECEIPT_MODES as readonly string[]).includes(v)) throw new Error(`RECEIPT_MODE=${v}: допустимо ${RECEIPT_MODES.join(" | ")}`);
  return v as ReceiptMode;
}

/** Что мешает запуску в production. Пустой список — можно стартовать. */
export function productionProblems(env: Env = process.env): string[] {
  const problems: string[] = [];
  const provider = env.PAYMENT_PROVIDER || "";
  if (!provider || provider === "mock") {
    problems.push("PAYMENT_PROVIDER не задан или mock: в production нужна настоящая касса (yookassa)");
  } else if (provider === "yookassa" && (!env.YOOKASSA_SHOP_ID || !env.YOOKASSA_SECRET_KEY)) {
    problems.push("PAYMENT_PROVIDER=yookassa: нужны YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY");
  }
  const pass = env.ADMIN_PASSWORD ?? "";
  if (pass.length < MIN_ADMIN_PASSWORD) problems.push(`ADMIN_PASSWORD короче ${MIN_ADMIN_PASSWORD} символов`);
  else if (WEAK_PASSWORDS.has(pass.toLowerCase()) || new Set(pass).size < 5) problems.push("ADMIN_PASSWORD слишком простой");
  if (!env.SUPPORT_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.SUPPORT_EMAIL)) problems.push("SUPPORT_EMAIL не задан или некорректен");
  try {
    receiptMode(env);
  } catch (e) {
    problems.push((e as Error).message);
  }
  return problems;
}

/** Мок-касса (страница и её кнопки): только при PAYMENT_PROVIDER=mock. В production это возможно лишь в обход проверок. */
export function mockPaymentsEnabled(env: Env = process.env): boolean {
  if ((env.PAYMENT_PROVIDER || "mock") !== "mock") return false;
  return !isProduction(env) || checksSkipped(env);
}

/**
 * /dev/* (галерея, почтовый ящик): вне production открыто; в production — только с верным паролем админки,
 * иначе 404 (страницы как будто нет). Браузер присылает пароль сам после входа в /admin.
 */
export function devToolsAllowed(authorization: string | null, env: Env = process.env): boolean {
  if (!isProduction(env)) return true;
  if (!env.ADMIN_PASSWORD || !authorization) return false;
  return checkBasicAuth(authorization, env.ADMIN_PASSWORD) === null;
}
