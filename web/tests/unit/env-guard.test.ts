import { describe, expect, it } from "vitest";
import { signAdminSession, verifyAdminSession } from "@/lib/admin-auth";
import { devToolsAllowed, mockPaymentsEnabled, productionProblems, receiptMode, unsafeProduction } from "@/lib/env-guard";
import { support, supportLine } from "@/lib/support";

const STRONG = "k8#Vq2!mZr7Lp9@xW4";
const ok = {
  NODE_ENV: "production",
  PAYMENT_PROVIDER: "yookassa",
  YOOKASSA_SHOP_ID: "123",
  YOOKASSA_SECRET_KEY: "test_abc",
  ADMIN_PASSWORD: STRONG,
  SUPPORT_EMAIL: "help@example.ru",
};

describe("проверки production при старте", () => {
  it("корректное окружение — проблем нет", () => {
    expect(productionProblems(ok)).toEqual([]);
  });

  it.each([
    ["PAYMENT_PROVIDER не задан", { PAYMENT_PROVIDER: undefined }, /PAYMENT_PROVIDER/],
    ["PAYMENT_PROVIDER=mock", { PAYMENT_PROVIDER: "mock" }, /PAYMENT_PROVIDER/],
    ["yookassa без ключей", { YOOKASSA_SECRET_KEY: "" }, /YOOKASSA_SHOP_ID/],
    ["ADMIN_PASSWORD не задан", { ADMIN_PASSWORD: undefined }, /короче 16/],
    ["ADMIN_PASSWORD короче 16", { ADMIN_PASSWORD: "Sh0rt!pass" }, /короче 16/],
    ["ADMIN_PASSWORD из списка слабых", { ADMIN_PASSWORD: "PasswordPassword" }, /простой/],
    ["ADMIN_PASSWORD из одного-двух символов", { ADMIN_PASSWORD: "abababababababab" }, /простой/],
    ["SUPPORT_EMAIL не задан", { SUPPORT_EMAIL: undefined }, /SUPPORT_EMAIL/],
    ["SUPPORT_EMAIL некорректен", { SUPPORT_EMAIL: "support" }, /SUPPORT_EMAIL/],
    ["RECEIPT_MODE неизвестен", { RECEIPT_MODE: "ofd" }, /RECEIPT_MODE/],
  ])("%s → отказ старта", (_n, patch, msg) => {
    const problems = productionProblems({ ...ok, ...patch });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(msg);
  });

  it("RECEIPT_MODE: по умолчанию none", () => {
    expect(receiptMode({})).toBe("none");
    expect(receiptMode({ RECEIPT_MODE: "yookassa_receipt" })).toBe("yookassa_receipt");
  });
});

describe("мок-касса", () => {
  it("вне production — при PAYMENT_PROVIDER=mock или не заданном", () => {
    expect(mockPaymentsEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(mockPaymentsEnabled({ NODE_ENV: "development", PAYMENT_PROVIDER: "yookassa" })).toBe(false);
  });

  it("в production — 404, кроме явного обхода проверок (CI)", () => {
    expect(mockPaymentsEnabled({ NODE_ENV: "production", PAYMENT_PROVIDER: "mock" })).toBe(false);
    expect(mockPaymentsEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(mockPaymentsEnabled({ NODE_ENV: "production", UNSAFE_SKIP_PRODUCTION_CHECKS: "true" })).toBe(true);
  });
});

describe("/dev/* (галерея, почтовый ящик)", () => {
  it("вне production открыто", () => {
    expect(devToolsAllowed(null, { NODE_ENV: "development" })).toBe(true);
  });

  it("в production — только с действующей сессией админа, иначе 404", () => {
    const env = { NODE_ENV: "production", ADMIN_PASSWORD: STRONG };
    expect(devToolsAllowed(null, env)).toBe(false);
    expect(devToolsAllowed("garbage", env)).toBe(false);
    expect(devToolsAllowed(signAdminSession(STRONG), env)).toBe(true);
    expect(devToolsAllowed(signAdminSession(STRONG), { NODE_ENV: "production" })).toBe(false); // без пароля в env
  });
});

describe("сессия админа (cookie после входа в /admin)", () => {
  const t0 = Date.parse("2026-12-01T00:00:00Z");

  it("действует 12 часов", () => {
    const token = signAdminSession(STRONG, t0);
    expect(verifyAdminSession(token, STRONG, t0 + 11.9 * 3600_000)).toBe(true);
    expect(verifyAdminSession(token, STRONG, t0 + 12 * 3600_000)).toBe(false);
  });

  it("подделка срока или подписи не проходит", () => {
    const [exp, sig] = signAdminSession(STRONG, t0).split(".");
    expect(verifyAdminSession(`${Number(exp) + 3600}.${sig}`, STRONG, t0)).toBe(false);
    expect(verifyAdminSession(`${exp}.${sig.slice(0, -2)}xx`, STRONG, t0)).toBe(false);
    expect(verifyAdminSession(`${exp}`, STRONG, t0)).toBe(false);
  });

  it("смена ADMIN_PASSWORD обнуляет все сессии", () => {
    expect(verifyAdminSession(signAdminSession(STRONG, t0), `${STRONG}-new`, t0)).toBe(false);
  });
});

describe("обход проверок в production", () => {
  it("unsafeProduction — только при флаге и NODE_ENV=production (для плашки в /admin и алерта)", () => {
    expect(unsafeProduction({ NODE_ENV: "production", UNSAFE_SKIP_PRODUCTION_CHECKS: "true" })).toBe(true);
    expect(unsafeProduction({ NODE_ENV: "production" })).toBe(false);
    expect(unsafeProduction({ NODE_ENV: "development", UNSAFE_SKIP_PRODUCTION_CHECKS: "true" })).toBe(false);
  });
});

describe("контакты поддержки", () => {
  it("email и telegram в любом виде", () => {
    expect(support({ SUPPORT_EMAIL: "a@b.ru", SUPPORT_TELEGRAM: "https://t.me/happy_help" })).toEqual({
      email: "a@b.ru",
      telegram: "@happy_help",
      telegramUrl: "https://t.me/happy_help",
    });
    expect(supportLine(support({ SUPPORT_EMAIL: "a@b.ru", SUPPORT_TELEGRAM: "@x" }))).toBe("Вопросы и возвраты: a@b.ru, Telegram @x");
    expect(supportLine(support({}))).toBeNull();
  });
});
