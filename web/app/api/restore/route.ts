import { handleError, jsonError, readJson } from "@/lib/api";
import { restoreAccess } from "@/lib/purchases";
import { rateLimited } from "@/lib/rate-limit";
import { getVisitor } from "@/lib/visitor";

export const RESTORE_REPLY = "Если с этим email были покупки, мы отправили письмо со ссылками. Проверь папку «Спам», если письма нет.";

/** «Уже покупал? Восстановить доступ»: ответ одинаковый, были покупки или нет. */
export async function POST(req: Request) {
  try {
    const visitor = await getVisitor();
    if (!visitor.anonId) return jsonError("Нет сессии", 401);
    if (rateLimited(`restore:${visitor.anonId}`, 5)) return jsonError("Слишком много попыток, подожди минуту", 429);
    const { email } = await readJson(req);
    if (typeof email === "string" && rateLimited(`restore-email:${email.trim().toLowerCase()}`, 3)) {
      return jsonError("Слишком много попыток, подожди минуту", 429);
    }
    await restoreAccess(email);
    return Response.json({ ok: true, message: RESTORE_REPLY });
  } catch (e) {
    return handleError(e);
  }
}
