import { type NextRequest } from "next/server";
import { seeOther } from "@/lib/http";
import { MOCK_SIGNATURE_HEADER, signMockWebhook } from "@/lib/payments/mock";
import { mockPaymentsEnabled } from "@/lib/env-guard";
import { getOrderByPayment } from "@/lib/payments/service";

/**
 * Кнопки мок-кассы. Отправляем подписанный вебхук на свой же /api/webhooks/payment —
 * ровно как это сделала бы настоящая касса, — и возвращаем покупателя на return_url.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ paymentId: string }> }) {
  if (!mockPaymentsEnabled()) return new Response("Not found", { status: 404 });
  const { paymentId } = await params;
  const order = await getOrderByPayment(paymentId);
  if (!order) return new Response("Платёж не найден", { status: 404 });
  const form = await req.formData();
  const status = form.get("outcome") === "success" ? "succeeded" : "canceled";

  const body = JSON.stringify({ paymentId, status, amountRub: order.amountRub });
  const internal = process.env.APP_INTERNAL_URL || req.nextUrl.origin;
  const res = await fetch(`${internal}/api/webhooks/payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [MOCK_SIGNATURE_HEADER]: signMockWebhook(body) },
    body,
  });
  if (!res.ok) return new Response("Вебхук не принят", { status: 502 });
  return seeOther(`/order/${order.id}`);
}
