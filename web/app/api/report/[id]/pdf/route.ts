import { questionnaire } from "@/lib/config";
import { getOrder } from "@/lib/payments/service";
import { getReport } from "@/lib/report/generate";
import { renderReportPdf } from "@/lib/report/pdf";
import { getResult } from "@/lib/results";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getOrder(id);
  if (!order || order.status !== "paid") return new Response("Not found", { status: 404 });
  const { report } = await getReport(id);
  const result = await getResult(order.resultId);
  if (!report || !result) return new Response("Отчёт ещё готовится", { status: 409 });
  const arch = questionnaire().archetypes.find((a) => a.id === result.archetype)!;
  const pdf = await renderReportPdf(report, { index: result.index, archetype: arch.name });
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="happiness-report.pdf"',
      "Cache-Control": "private, no-store",
    },
  });
}
