import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@/lib/db";
import { MOCK_SIGNATURE_HEADER, MockPaymentProvider, signMockWebhook } from "@/lib/payments/mock";
import { applyPayment, CheckoutError, createOrder } from "@/lib/payments/service";
import { WebhookError } from "@/lib/payments/types";
import { YooKassaProvider } from "@/lib/payments/yookassa";
import { completeTest, saveAnswer, startOrResume } from "@/lib/test-flow";
import type { Visitor } from "@/lib/visitor";
import { freshDb } from "./db";
import { answersWith } from "./helpers";

const provider = new MockPaymentProvider();
const visitor: Visitor = {
  anonId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  price: 990,
  attribution: { utm_source: "vk", utm_campaign: "launch" },
};

async function completedResult(anonId = visitor.anonId!) {
  const { testId } = await startOrResume(anonId, null);
  for (const [id, v] of Object.entries(answersWith({}))) await saveAnswer(testId, anonId, id, v);
  return (await completeTest(testId, anonId)).resultId;
}

function webhook(paymentId: string, status: string, amountRub: number, secret?: string) {
  const body = JSON.stringify({ paymentId, status, amountRub });
  const headers = new Headers({ [MOCK_SIGNATURE_HEADER]: signMockWebhook(body, secret) });
  return provider.verifyWebhook(body, headers);
}

let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => {
  db = await freshDb();
});

const order = async (id: string) => (await db.select().from(schema.orders).where(eq(schema.orders.id, id)))[0];
const events = async (name: string) => db.select().from(schema.events).where(eq(schema.events.name, name));

describe("мок-флоу оплаты", () => {
  it("заказ по цене A/B-варианта → вебхук «успех» → paid, событие с атрибуцией", async () => {
    const resultId = await completedResult();
    const { orderId, confirmationUrl } = await createOrder({ provider, visitor, resultId, email: " Me@Example.RU ", offerAccepted: true, appUrl: "http://x" });
    expect(confirmationUrl).toMatch(/^\/pay\/mock\/mock_/);
    const created = await order(orderId);
    expect(created).toMatchObject({ status: "pending", amountRub: 990, priceVariant: 990, email: "me@example.ru", utmSource: "vk" });
    expect(await events("checkout_start")).toHaveLength(1);

    const verified = await webhook(created.providerPaymentId!, "succeeded", 990);
    expect(await applyPayment(verified!)).toEqual({ orderId, status: "paid", changed: true });
    expect((await order(orderId)).status).toBe("paid");
    const [ev] = await events("payment_success");
    expect(ev).toMatchObject({ anonId: visitor.anonId, priceVariant: 990, utmSource: "vk", utmCampaign: "launch" });
  });

  it("повтор вебхука идемпотентен: одно событие, статус не меняется", async () => {
    const { orderId } = await createOrder({ provider, visitor, resultId: await completedResult(), email: "a@b.ru", offerAccepted: true, appUrl: "" });
    const pid = (await order(orderId)).providerPaymentId!;
    await applyPayment((await webhook(pid, "succeeded", 990))!);
    expect((await applyPayment((await webhook(pid, "succeeded", 990))!))?.changed).toBe(false);
    expect((await applyPayment((await webhook(pid, "canceled", 990))!))?.changed).toBe(false);
    expect((await order(orderId)).status).toBe("paid");
    expect(await events("payment_success")).toHaveLength(1);
    expect(await events("payment_fail")).toHaveLength(0);
  });

  it("отказ → failed и payment_fail", async () => {
    const { orderId } = await createOrder({ provider, visitor, resultId: await completedResult(), email: "a@b.ru", offerAccepted: true, appUrl: "" });
    const pid = (await order(orderId)).providerPaymentId!;
    expect(await applyPayment((await webhook(pid, "canceled", 990))!)).toEqual({ orderId, status: "failed", changed: true });
    expect(await events("payment_fail")).toHaveLength(1);
  });

  it("сумма не совпала → заказ не оплачен", async () => {
    const { orderId } = await createOrder({ provider, visitor, resultId: await completedResult(), email: "a@b.ru", offerAccepted: true, appUrl: "" });
    const pid = (await order(orderId)).providerPaymentId!;
    await applyPayment((await webhook(pid, "succeeded", 1))!);
    expect((await order(orderId)).status).toBe("pending");
  });

  it("неверная подпись вебхука отклоняется", async () => {
    await expect(webhook("mock_x", "succeeded", 990, "wrong-secret")).rejects.toThrow(WebhookError);
  });

  it("неизвестный платёж игнорируется", async () => {
    expect(await applyPayment({ paymentId: "nope", status: "succeeded", amountRub: 990 })).toBeNull();
  });

  it.each([
    ["без согласия с офертой", { offerAccepted: false }],
    ["плохой email", { email: "not-an-email" }],
  ])("отказ при создании заказа: %s", async (_n, patch) => {
    const resultId = await completedResult();
    await expect(createOrder({ provider, visitor, resultId, email: "a@b.ru", offerAccepted: true, appUrl: "", ...patch })).rejects.toThrow(CheckoutError);
  });

  it("купить разбор к чужому результату нельзя", async () => {
    const resultId = await completedResult("33333333-3333-4333-8333-333333333333");
    await expect(createOrder({ provider, visitor, resultId, email: "a@b.ru", offerAccepted: true, appUrl: "" })).rejects.toThrow(/своему/);
  });
});

describe("ЮKassa: вебхуку не верим, статус — из API", () => {
  const api = (payment: object, status = 200) =>
    (async () => new Response(JSON.stringify(payment), { status })) as unknown as typeof fetch;

  it("статус и сумма берутся из ответа API, а не из тела вебхука", async () => {
    const yk = new YooKassaProvider("shop", "secret", "none", 1, api({ id: "pay_1", status: "canceled", amount: { value: "690.00", currency: "RUB" } }));
    const body = JSON.stringify({ event: "payment.succeeded", object: { id: "pay_1", status: "succeeded", amount: { value: "1.00" } } });
    expect(await yk.verifyWebhook(body)).toEqual({ paymentId: "pay_1", status: "canceled", amountRub: 690 });
  });

  it("промежуточные статусы игнорируются, неизвестный платёж — ошибка", async () => {
    const pending = new YooKassaProvider("s", "k", "none", 1, api({ id: "p", status: "pending", amount: { value: "690.00", currency: "RUB" } }));
    expect(await pending.verifyWebhook(JSON.stringify({ object: { id: "p" } }))).toBeNull();
    const missing = new YooKassaProvider("s", "k", "none", 1, api({}, 404));
    await expect(missing.verifyWebhook(JSON.stringify({ object: { id: "p" } }))).rejects.toThrow(WebhookError);
  });

  it("создание платежа: сумма, чек 54-ФЗ, return_url", async () => {
    let sent: { body: string; headers: Record<string, string> } | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = { body: init.body as string, headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify({ id: "pay_2", status: "pending", amount: { value: "490.00", currency: "RUB" }, confirmation: { confirmation_url: "https://yoomoney.ru/x" } }));
    }) as unknown as typeof fetch;
    const yk = new YooKassaProvider("shop", "secret", "yookassa_receipt", 1, fetchImpl);
    const res = await yk.createPayment({ orderId: "o1", amountRub: 490, description: "Разбор", returnUrl: "https://site/order/o1", email: "a@b.ru" });
    expect(res).toEqual({ paymentId: "pay_2", confirmationUrl: "https://yoomoney.ru/x" });
    const body = JSON.parse(sent!.body);
    expect(body.amount).toEqual({ value: "490.00", currency: "RUB" });
    expect(body.receipt.customer.email).toBe("a@b.ru");
    expect(body.confirmation.return_url).toBe("https://site/order/o1");
    expect(sent!.headers["Idempotence-Key"]).toBeTruthy();
  });

  it("RECEIPT_MODE=none (по умолчанию) — данные чека в платёж не передаются", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ id: "p", status: "pending", amount: { value: "690.00", currency: "RUB" }, confirmation: { confirmation_url: "https://x" } }));
    }) as unknown as typeof fetch;
    await new YooKassaProvider("shop", "secret", undefined, 1, fetchImpl).createPayment({ orderId: "o", amountRub: 690, description: "Разбор", returnUrl: "https://s/o", email: "a@b.ru" });
    expect(body.receipt).toBeUndefined();
    expect(body.amount).toEqual({ value: "690.00", currency: "RUB" });
  });
});
