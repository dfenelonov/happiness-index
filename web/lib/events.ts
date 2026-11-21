import { getDb, schema } from "./db";
import type { Attribution } from "./cookies";

// Реестр событий воронки (docs: README → «Аналитика»). Всё, что не в списке, не пишется.
export const EVENTS = [
  "visit",
  "test_start",
  "question_answered",
  "test_complete",
  "result_view",
  "share_click",
  "paywall_view",
  "checkout_start",
  "payment_success",
  "payment_fail",
  "subscription_click",
  "email_submit",
  "report_view",
  "pdf_download",
] as const;
export type EventName = (typeof EVENTS)[number];

/** Что можно прислать с клиента через /api/events. Остальное пишет только сервер. */
export const CLIENT_EVENTS: ReadonlySet<EventName> = new Set([
  "visit",
  "result_view",
  "share_click",
  "paywall_view",
  "subscription_click",
  "report_view",
  "pdf_download",
]);

/** Белый список свойств: никаких email, текстов ответов и произвольных строк. */
const PROPS: Record<string, (v: unknown) => boolean> = {
  channel: (v) => typeof v === "string" && ["telegram", "vk", "copy", "download", "native"].includes(v),
  n: (v) => Number.isInteger(v) && (v as number) > 0 && (v as number) < 1000,
  question_id: (v) => typeof v === "string" && /^[a-z0-9_]{1,40}$/.test(v),
  test_id: isId,
  result_id: isId,
  order_id: isId,
  owner: (v) => typeof v === "boolean",
  source: (v) => typeof v === "string" && ["result", "report"].includes(v),
  status: (v) => typeof v === "string" && /^[a-z_]{1,20}$/.test(v),
  amount: (v) => Number.isInteger(v),
  fallback: (v) => typeof v === "boolean",
};

function isId(v: unknown) {
  return typeof v === "string" && /^[0-9a-f-]{36}$/.test(v);
}

export function cleanProps(props: Record<string, unknown> | undefined) {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (PROPS[k]?.(v)) out[k] = v as string | number | boolean;
  }
  return out;
}

export type EventContext = {
  anonId?: string | null;
  sessionId?: string | null;
  price?: number | null;
  attribution?: Attribution;
};

export async function logEvent(name: EventName, ctx: EventContext, props?: Record<string, unknown>) {
  const a = ctx.attribution ?? {};
  await getDb()
    .insert(schema.events)
    .values({
      name,
      anonId: ctx.anonId ?? null,
      sessionId: ctx.sessionId ?? null,
      priceVariant: ctx.price ?? null,
      utmSource: a.utm_source ?? null,
      utmMedium: a.utm_medium ?? null,
      utmCampaign: a.utm_campaign ?? null,
      utmContent: a.utm_content ?? null,
      utmTerm: a.utm_term ?? null,
      referrer: a.referrer ?? null,
      props: cleanProps(props),
    });
}
