import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { appConfig } from "../config";
import { getDb, schema } from "../db";
import { logEvent } from "../events";
import type { Visitor } from "../visitor";
import type { PaymentProvider, VerifiedPayment } from "./types";

export class CheckoutError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function normalizeEmail(raw: unknown): string {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) throw new CheckoutError("Проверь email — на него придёт чек и ссылка на отчёт");
  return email;
}

/** Заказ по цене A/B-варианта посетителя → платёж у провайдера → ссылка на оплату. */
export async function createOrder(opts: {
  provider: PaymentProvider;
  visitor: Visitor;
  resultId: string;
  email: unknown;
  offerAccepted: unknown;
  appUrl: string;
}) {
  const { provider, visitor } = opts;
  if (opts.offerAccepted !== true) throw new CheckoutError("Нужно согласие с офертой");
  const email = normalizeEmail(opts.email);
  if (!visitor.anonId) throw new CheckoutError("Нет сессии", 401);

  const db = getDb();
  const [result] = await db.select().from(schema.results).where(eq(schema.results.id, opts.resultId));
  if (!result || result.isSeed) throw new CheckoutError("Результат не найден", 404);
  if (result.anonId !== visitor.anonId) throw new CheckoutError("Купить разбор можно только к своему результату", 403);

  const orderId = randomUUID();
  const a = visitor.attribution;
  await db.insert(schema.orders).values({
    id: orderId,
    resultId: result.id,
    anonId: visitor.anonId,
    sessionId: visitor.sessionId,
    priceVariant: visitor.price,
    amountRub: visitor.price,
    email,
    provider: provider.name,
    utmSource: a.utm_source,
    utmMedium: a.utm_medium,
    utmCampaign: a.utm_campaign,
    utmContent: a.utm_content,
    utmTerm: a.utm_term,
    referrer: a.referrer,
  });

  const payment = await provider.createPayment({
    orderId,
    amountRub: visitor.price,
    description: `Полный разбор «${appConfig().site_name}»`,
    returnUrl: `${opts.appUrl}/order/${orderId}`,
    email,
  });
  await db.update(schema.orders).set({ providerPaymentId: payment.paymentId }).where(eq(schema.orders.id, orderId));
  await logEvent("checkout_start", visitor, { order_id: orderId, result_id: result.id, amount: visitor.price });
  return { orderId, confirmationUrl: payment.confirmationUrl };
}

export type PaymentOutcome = { orderId: string; status: "paid" | "failed"; changed: boolean } | null;

/**
 * Применить подтверждённый статус платежа. Идемпотентно: переход только из pending
 * (условный UPDATE), повтор вебхука ничего не меняет и не дублирует события.
 */
export async function applyPayment(p: VerifiedPayment): Promise<PaymentOutcome> {
  const db = getDb();
  const [order] = await db.select().from(schema.orders).where(eq(schema.orders.providerPaymentId, p.paymentId));
  if (!order) return null;

  const ctx = {
    anonId: order.anonId,
    sessionId: order.sessionId,
    price: order.priceVariant,
    attribution: {
      utm_source: order.utmSource ?? undefined,
      utm_medium: order.utmMedium ?? undefined,
      utm_campaign: order.utmCampaign ?? undefined,
      utm_content: order.utmContent ?? undefined,
      utm_term: order.utmTerm ?? undefined,
      referrer: order.referrer ?? undefined,
    },
  };

  if (p.status === "succeeded") {
    if (p.amountRub !== order.amountRub) {
      console.warn(`payment amount mismatch for order ${order.id}`);
      return { orderId: order.id, status: "failed", changed: false };
    }
    const upd = await db
      .update(schema.orders)
      .set({ status: "paid", paidAt: new Date().toISOString() })
      .where(and(eq(schema.orders.id, order.id), eq(schema.orders.status, "pending")));
    const changed = upd.rowsAffected > 0;
    if (changed) await logEvent("payment_success", ctx, { order_id: order.id, result_id: order.resultId, amount: order.amountRub });
    return { orderId: order.id, status: "paid", changed };
  }

  const upd = await db
    .update(schema.orders)
    .set({ status: "failed" })
    .where(and(eq(schema.orders.id, order.id), eq(schema.orders.status, "pending")));
  const changed = upd.rowsAffected > 0;
  if (changed) await logEvent("payment_fail", ctx, { order_id: order.id, result_id: order.resultId });
  return { orderId: order.id, status: "failed", changed };
}

export async function getOrder(orderId: string) {
  const [order] = await getDb().select().from(schema.orders).where(eq(schema.orders.id, orderId));
  return order ?? null;
}

export async function getOrderByPayment(paymentId: string) {
  const [order] = await getDb().select().from(schema.orders).where(eq(schema.orders.providerPaymentId, paymentId));
  return order ?? null;
}
