import { handleError, jsonError, readJson } from "@/lib/api";
import { logEvent } from "@/lib/events";
import { rateLimited } from "@/lib/rate-limit";
import { saveAnswer } from "@/lib/test-flow";
import { getVisitor } from "@/lib/visitor";

export async function POST(req: Request) {
  try {
    const visitor = await getVisitor();
    if (!visitor.anonId) return jsonError("Нет сессии", 401);
    if (rateLimited(`answers:${visitor.anonId}`, 90)) return jsonError("Слишком быстро", 429);
    const { testId, questionId, value } = await readJson(req);
    if (typeof testId !== "string" || typeof questionId !== "string") return jsonError("Неверный запрос");
    const { n } = await saveAnswer(testId, visitor.anonId, questionId, value);
    await logEvent("question_answered", visitor, { n, question_id: questionId, test_id: testId });
    return Response.json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
