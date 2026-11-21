export type CreatePaymentInput = {
  orderId: string;
  amountRub: number;
  description: string;
  returnUrl: string;
  email: string; // для чека 54-ФЗ
};

export type VerifiedPayment = {
  paymentId: string;
  status: "succeeded" | "canceled";
  amountRub: number;
};

export interface PaymentProvider {
  readonly name: "mock" | "yookassa";
  createPayment(input: CreatePaymentInput): Promise<{ paymentId: string; confirmationUrl: string }>;
  /**
   * Проверить вебхук и вернуть подтверждённый статус. null — событие не про оплату (игнорируем, 200).
   * Бросает WebhookError, если источнику нельзя верить (400).
   */
  verifyWebhook(rawBody: string, headers: Headers): Promise<VerifiedPayment | null>;
}

export class WebhookError extends Error {}
