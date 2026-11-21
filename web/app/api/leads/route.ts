import { handleError, jsonError, readJson } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { normalizeEmail } from "@/lib/payments/service";
import { rateLimited } from "@/lib/rate-limit";
import { getVisitor } from "@/lib/visitor";

/** Email из фейковой двери «Трекер счастья». Только с согласием. */
export async function POST(req: Request) {
  try {
    const visitor = await getVisitor();
    if (!visitor.anonId) return jsonError("Нет сессии", 401);
    if (rateLimited(`lead:${visitor.anonId}`, 10)) return jsonError("Слишком много попыток", 429);
    const body = await readJson(req);
    if (body.consent !== true) return jsonError("Нужно согласие на обработку email");
    const email = normalizeEmail(body.email);
    const source = body.source === "report" ? "report" : "result";
    const resultId = typeof body.resultId === "string" && /^[0-9a-f-]{36}$/.test(body.resultId) ? body.resultId : null;
    await getDb().insert(schema.leads).values({ email, consent: true, source, anonId: visitor.anonId, resultId, priceVariant: visitor.price });
    await logEvent("email_submit", visitor, { source, ...(resultId ? { result_id: resultId } : {}) });
    return Response.json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
