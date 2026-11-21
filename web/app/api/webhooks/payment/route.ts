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
    if (outcome?.status === "paid") void kickReportWorker(); // генерация — в фоне, ответ кассе сразу
    return new Response("ok", { status: 200 });
  } catch (e) {
    if (e instanceof WebhookError) return new Response("bad webhook", { status: 400 });
    console.error(e);
    return new Response("error", { status: 500 }); // провайдер повторит
  }
}
