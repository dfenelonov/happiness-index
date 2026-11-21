import { sql } from "drizzle-orm";
import { appConfig } from "./config";
import { getDb } from "./db";

// Алерты владельцу: Telegram-бот (TELEGRAM_ALERT_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID), без них — только лог.
// В текст алерта не попадают email и ответы — только id заказов/платежей и счётчики.

type State = { last: Map<string, number>; errors: number[] };
const g = globalThis as unknown as { __hiAlerts?: State };
const state: State = (g.__hiAlerts ??= { last: new Map(), errors: [] });

export function resetAlertState() {
  state.last.clear();
  state.errors.length = 0;
}

type Env = Record<string, string | undefined>;

/**
 * Отправить алерт. Один и тот же key — не чаще раза в throttle (по умолчанию из config/app.yaml).
 * Никогда не бросает: сбой алерта не должен ломать оплату. Возвращает, ушёл ли алерт.
 */
export async function alert(
  key: string,
  message: string,
  opts: { throttleMs?: number; env?: Env; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const throttle = opts.throttleMs ?? appConfig().alerts.throttle_minutes * 60_000;
  const last = state.last.get(key);
  if (last !== undefined && now - last < throttle) return false;
  state.last.set(key, now);

  console.error(JSON.stringify({ event: "alert", key, message }));
  const env = opts.env ?? process.env;
  const token = env.TELEGRAM_ALERT_BOT_TOKEN;
  const chat = env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chat) return true;
  try {
    const res = await (opts.fetchImpl ?? fetch)(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: `⚠️ Индекс счастья: ${message}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(JSON.stringify({ event: "alert_send_failed", key, status: res.status }));
  } catch (e) {
    console.error(JSON.stringify({ event: "alert_send_failed", key, error: (e as Error).message.slice(0, 200) }));
  }
  return true;
}

/** Учесть ответ 5xx; при всплеске (threshold за окно) — алерт. */
export function record5xx(now = Date.now(), opts: { env?: Env; fetchImpl?: typeof fetch } = {}) {
  const { errors_5xx_threshold: threshold, errors_5xx_window_minutes: minutes } = appConfig().alerts;
  const windowMs = minutes * 60_000;
  state.errors.push(now);
  while (state.errors.length && state.errors[0] <= now - windowMs) state.errors.shift();
  if (state.errors.length >= threshold) {
    void alert("5xx_spike", `всплеск ошибок сервера: ${state.errors.length} ответов 5xx за ${minutes} мин`, { now, ...opts });
  }
}

/** Оплаченные заказы без готового отчёта дольше alert_no_report_minutes — алерт по каждому (раз в 6 часов). */
export async function checkStuckReports(opts: { env?: Env; fetchImpl?: typeof fetch } = {}): Promise<string[]> {
  const minutes = appConfig().report.alert_no_report_minutes;
  const rows = await getDb().all<{ id: string; status: string | null }>(
    sql`select o.id, r.status from orders o left join reports r on r.order_id = o.id
        where o.status = 'paid' and (r.status is null or r.status != 'ready')
          and o.paid_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${minutes * 60} seconds`})`,
  );
  for (const r of rows) {
    await alert(`stuck_report:${r.id}`, `заказ ${r.id} оплачен больше ${minutes} мин назад, а отчёта нет (статус: ${r.status ?? "не начат"})`, {
      throttleMs: 6 * 3600_000,
      ...opts,
    });
  }
  return rows.map((r) => r.id);
}
