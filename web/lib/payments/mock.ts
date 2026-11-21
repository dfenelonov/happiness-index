import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { WebhookError, type PaymentProvider, type VerifiedPayment } from "./types";

// Мок-касса: страница /pay/mock/{paymentId} с кнопками «Оплатить успешно» / «Отказ» шлёт
// подписанный HMAC вебхук на /api/webhooks/payment — тот же путь, что у настоящей кассы.

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";

export function mockSecret() {
  return process.env.MOCK_WEBHOOK_SECRET || "dev-mock-secret";
}

export function signMockWebhook(body: string, secret = mockSecret()) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock" as const;

  async createPayment() {
    const paymentId = `mock_${randomUUID()}`;
    return { paymentId, confirmationUrl: `/pay/mock/${paymentId}` };
  }

  async verifyWebhook(rawBody: string, headers: Headers): Promise<VerifiedPayment | null> {
    const given = Buffer.from(headers.get(MOCK_SIGNATURE_HEADER) ?? "", "utf8");
    const expected = Buffer.from(signMockWebhook(rawBody), "utf8");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new WebhookError("bad signature");
    let body: { paymentId?: unknown; status?: unknown; amountRub?: unknown };
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new WebhookError("bad json");
    }
    if (typeof body.paymentId !== "string" || !Number.isInteger(body.amountRub)) throw new WebhookError("bad payload");
    if (body.status !== "succeeded" && body.status !== "canceled") return null;
    return { paymentId: body.paymentId, status: body.status, amountRub: body.amountRub as number };
  }
}
