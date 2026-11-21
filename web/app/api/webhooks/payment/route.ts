import { alert, record5xx } from "@/lib/alerts";
import { getPaymentProvider, WebhookError } from "@/lib/payments";
import { applyPayment } from "@/lib/payments/service";
import { kickReportWorker } from "@/lib/report/worker";

/** Вебхук платёжного провайдера. Статус берётся только из проверенного источника (см. provider.verifyWebhook). */
export async function POST(req: Request) {
  const raw = await req.text();
  try {
    const verified = await getPaymentProvider().verifyWebhook(raw, req.headers);
    if (!verified) return new Response("ignored", { status: 200 });
    const outcome = await applyPayment(verified);
    if (!outcome) {
      // ЮKassa подтвердила платёж, а заказа у нас нет — деньги могли прийти «мимо»
      await alert(`payment_without_order:${verified.paymentId}`, `платёж ${verified.paymentId} (${verified.status}, ${verified.amountRub} ₽) без заказа в базе`);
    } else if (verified.status === "succeeded" && outcome.status !== "paid") {
      await alert(`payment_mismatch:${verified.paymentId}`, `платёж ${verified.paymentId}: сумма ${verified.amountRub} ₽ не совпала с заказом ${outcome.orderId} — заказ не оплачен`);
    }
    if (outcome?.status === "paid") void kickReportWorker(); // генерация — в фоне, ответ кассе сразу
    return new Response("ok", { status: 200 });
  } catch (e) {
    if (e instanceof WebhookError) {
      await alert("webhook_rejected", `вебхук оплаты отклонён: ${e.message} (неверная подпись, чужой или неизвестный платёж)`);
      return new Response("bad webhook", { status: 400 });
    }
    console.error(e);
    record5xx();
    await alert("webhook_error", `ошибка обработки вебхука оплаты: ${(e as Error).message.slice(0, 200)} — касса повторит`);
    return new Response("error", { status: 500 }); // провайдер повторит
  }
}
