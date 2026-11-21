import { handleError, jsonError, readJson } from "@/lib/api";
import { getPaymentProvider } from "@/lib/payments";
import { createOrder } from "@/lib/payments/service";
import { rateLimited } from "@/lib/rate-limit";
import { appUrl } from "@/lib/report/generate";
import { getVisitor } from "@/lib/visitor";

export async function POST(req: Request) {
  try {
    const visitor = await getVisitor();
    if (!visitor.anonId) return jsonError("Нет сессии", 401);
    if (rateLimited(`checkout:${visitor.anonId}`, 10)) return jsonError("Слишком много попыток, подожди минуту", 429);
    const body = await readJson(req);
    if (typeof body.resultId !== "string") return jsonError("Неверный запрос");
    const res = await createOrder({
      provider: getPaymentProvider(),
      visitor,
      resultId: body.resultId,
      email: body.email,
      offerAccepted: body.offerAccepted,
      appUrl: appUrl(),
    });
    return Response.json(res);
  } catch (e) {
    return handleError(e);
  }
}
