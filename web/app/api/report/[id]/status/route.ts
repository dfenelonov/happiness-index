import { getOrder } from "@/lib/payments/service";
import { ensureReport, getReport } from "@/lib/report/generate";

export const dynamic = "force-dynamic";

/** Статус заказа и отчёта для экранов ожидания. Для оплаченного заказа без отчёта — запускает генерацию. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getOrder(id);
  if (!order) return Response.json({ error: "not found" }, { status: 404 });
  if (order.status !== "paid") return Response.json({ order: order.status, report: "missing" });
  const r = await getReport(id);
  if (r.status !== "ready") void ensureReport(id);
  return Response.json({ order: order.status, report: r.status });
}
