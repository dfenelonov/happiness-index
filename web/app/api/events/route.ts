import { jsonError, readJson } from "@/lib/api";
import { CLIENT_EVENTS, logEvent, type EventName } from "@/lib/events";
import { rateLimited } from "@/lib/rate-limit";
import { getVisitor } from "@/lib/visitor";

/** Клиентские события — только из белого списка, свойства фильтруются там же. */
export async function POST(req: Request) {
  const visitor = await getVisitor();
  if (!visitor.anonId) return jsonError("Нет сессии", 401);
  if (rateLimited(`events:${visitor.anonId}`, 120)) return jsonError("Слишком много событий", 429);
  const { name, props } = await readJson(req);
  if (typeof name !== "string" || !CLIENT_EVENTS.has(name as EventName)) return jsonError("Неизвестное событие");
  await logEvent(name as EventName, visitor, (props && typeof props === "object" ? props : {}) as Record<string, unknown>);
  return new Response(null, { status: 204 });
}
