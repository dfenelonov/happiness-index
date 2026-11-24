import { describe, expect, it } from "vitest";
import { fillLegal, hasPlaceholders, LEGAL, legalValues } from "@/lib/legal";
import { seller, sellerLine, validPersonalInn } from "@/lib/seller";

const env = { SELLER_NAME: "Иванов И.И.", SELLER_INN: "500123456750", SUPPORT_EMAIL: "help@example.ru", APP_URL: "https://site.ru" };

describe("реквизиты продавца", () => {
  it("ИНН физлица: контрольные цифры", () => {
    expect(validPersonalInn("500123456750")).toBe(true);
    expect(validPersonalInn("500123456751")).toBe(false);
    expect(validPersonalInn("50012345675")).toBe(false);
  });

  it("самозанятый по умолчанию; ИП — с ОГРНИП и адресом", () => {
    expect(sellerLine(seller(env))).toBe("Иванов И.И., ИНН 500123456750, плательщик налога на профессиональный доход (самозанятый)");
    expect(sellerLine(seller({ ...env, SELLER_STATUS: "ip", SELLER_OGRNIP: "304500116000157", SELLER_ADDRESS: "г. Москва" }))).toBe(
      "ИП Иванов И.И., ИНН 500123456750, ОГРНИП 304500116000157, адрес: г. Москва",
    );
  });

  it("без ФИО или ИНН строки нет", () => {
    expect(sellerLine(seller({ SELLER_INN: "500123456750" }))).toBeNull();
    expect(sellerLine(seller({ SELLER_NAME: "Иванов И.И." }))).toBeNull();
  });
});

describe("юридические документы", () => {
  it("реквизиты, email, домен и срок возврата подставляются", () => {
    const values = legalValues(env);
    const offer = LEGAL.offer.sections.flatMap((s) => s.p).map((p) => fillLegal(p, values)).join("\n");
    expect(offer).toContain("Исполнитель: Иванов И.И., ИНН 500123456750");
    expect(offer).toContain("help@example.ru");
    expect(offer).toContain("на сайте site.ru");
    expect(offer).toContain("в течение 14 дней");
    expect(offer).not.toContain("ОГРНИП");
  });

  it("незаполненное остаётся в скобках, и тогда документ — шаблон", () => {
    expect(fillLegal("[домен] и [неизвестно]", { домен: "site.ru" })).toBe("site.ru и [неизвестно]");
    expect(hasPlaceholders(LEGAL.consent, legalValues(env))).toBe(false);
    expect(hasPlaceholders(LEGAL.consent, legalValues({}))).toBe(true);
  });
});
