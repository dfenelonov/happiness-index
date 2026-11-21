import { getOrder } from "@/lib/payments/service";
import { getReport } from "@/lib/report/generate";
import { kickReportWorker } from "@/lib/report/worker";

export const dynamic = "force-dynamic";

/** Статус заказа и отчёта для экранов ожидания (прогресс). Если отчёт не готов — будит фоновый воркер. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getOrder(id);
  if (!order) return Response.json({ error: "not found" }, { status: 404 });
  if (order.status !== "paid") return Response.json({ order: order.status, report: "missing" });
  const r = await getReport(id);
  if (r.status !== "ready") void kickReportWorker();
  return Response.json({ order: order.status, report: r.status, attempt: r.attempt, maxAttempts: r.maxAttempts, startedAt: r.startedAt });
}
