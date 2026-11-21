import { randomUUID } from "node:crypto";
import type { ReceiptMode } from "../env-guard";
import { WebhookError, type CreatePaymentInput, type PaymentProvider, type VerifiedPayment } from "./types";

// ЮKassa через REST API v3 (https://yookassa.ru/developers/api). Тело вебхука не доверяем:
// по id из уведомления запрашиваем платёж у API и берём статус и сумму оттуда.

const API = "https://api.yookassa.ru/v3";

type YkPayment = {
  id: string;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  amount: { value: string; currency: string };
  confirmation?: { confirmation_url?: string };
};

export class YooKassaProvider implements PaymentProvider {
  readonly name = "yookassa" as const;

  constructor(
    private shopId: string,
    private secretKey: string,
    /** none — чек не передаём (самозанятый: чек в «Мой налог» формирует ЮKassa); yookassa_receipt — чек 54-ФЗ в платеже */
    private receipt: ReceiptMode = "none",
    private vatCode = Number(process.env.YOOKASSA_VAT_CODE ?? 1),
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private auth() {
    return "Basic " + Buffer.from(`${this.shopId}:${this.secretKey}`).toString("base64");
  }

  async createPayment(input: CreatePaymentInput) {
    const value = input.amountRub.toFixed(2);
    const res = await this.fetchImpl(`${API}/payments`, {
      method: "POST",
      headers: { Authorization: this.auth(), "Idempotence-Key": randomUUID(), "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: { value, currency: "RUB" },
        capture: true,
        confirmation: { type: "redirect", return_url: input.returnUrl },
        description: input.description.slice(0, 128),
        metadata: { order_id: input.orderId },
        ...(this.receipt === "yookassa_receipt" ? { receipt: this.receiptFor(input, value) } : {}),
      }),
    });
    if (!res.ok) throw new Error(`ЮKassa: создание платежа ${res.status}`);
    const p = (await res.json()) as YkPayment;
    const url = p.confirmation?.confirmation_url;
    if (!url) throw new Error("ЮKassa: нет confirmation_url");
    return { paymentId: p.id, confirmationUrl: url };
  }

  /** Чек 54-ФЗ в составе платежа (RECEIPT_MODE=yookassa_receipt). */
  private receiptFor(input: CreatePaymentInput, value: string) {
    return {
      customer: { email: input.email },
      items: [
        {
          description: input.description.slice(0, 128),
          quantity: "1.00",
          amount: { value, currency: "RUB" },
          vat_code: this.vatCode,
          payment_mode: "full_payment",
          payment_subject: "service",
        },
      ],
    };
  }

  async verifyWebhook(rawBody: string): Promise<VerifiedPayment | null> {
    let id: unknown;
    try {
      id = JSON.parse(rawBody)?.object?.id;
    } catch {
      throw new WebhookError("bad json");
    }
    if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id)) throw new WebhookError("no payment id");
    const res = await this.fetchImpl(`${API}/payments/${id}`, { headers: { Authorization: this.auth() } });
    if (res.status === 404) throw new WebhookError("unknown payment");
    if (!res.ok) throw new Error(`ЮKassa: проверка платежа ${res.status}`); // 500 → ЮKassa повторит
    const p = (await res.json()) as YkPayment;
    if (p.status !== "succeeded" && p.status !== "canceled") return null;
    if (p.amount.currency !== "RUB") throw new WebhookError("currency");
    return { paymentId: p.id, status: p.status, amountRub: Math.round(Number(p.amount.value)) };
  }
}
