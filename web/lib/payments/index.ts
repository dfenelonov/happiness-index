import { receiptMode } from "../env-guard";
import { MockPaymentProvider } from "./mock";
import type { PaymentProvider } from "./types";
import { YooKassaProvider } from "./yookassa";

/** PAYMENT_PROVIDER=mock (по умолчанию) | yookassa (нужны YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY). */
export function getPaymentProvider(): PaymentProvider {
  const name = process.env.PAYMENT_PROVIDER || "mock";
  if (name === "yookassa") {
    const shopId = process.env.YOOKASSA_SHOP_ID;
    const secret = process.env.YOOKASSA_SECRET_KEY;
    if (!shopId || !secret) throw new Error("PAYMENT_PROVIDER=yookassa: задай YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY");
    return new YooKassaProvider(shopId, secret, receiptMode());
  }
  if (name !== "mock") throw new Error(`Неизвестный PAYMENT_PROVIDER=${name}`);
  return new MockPaymentProvider();
}

export * from "./types";
