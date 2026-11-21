import { and, eq, sql } from "drizzle-orm";
import { appConfig, questionnaire } from "../config";
import { getDb, schema } from "../db";
import { sendReportEmail } from "../mailer";
import { buildReport, type BuildOptions } from "./build";
import { buildReportInput } from "./input";
import { getLLMProvider, type LLMProvider } from "./providers";
import { ReportSchema, type Report } from "./schema";

const NOW = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export type GenerateDeps = { provider?: LLMProvider | null; sleep?: BuildOptions["sleep"] };

/**
 * Сгенерировать отчёт оплаченного заказа. Идемпотентно: сначала «захват» строки reports условным
 * UPDATE — генерирует только тот, кому он удался (новая строка, failed или зависшая без «пульса»).
 * Возвращает false, если генерировать не нужно или этим уже занят кто-то другой.
 */
export async function generateReport(orderId: string, deps: GenerateDeps = {}): Promise<boolean> {
  const db = getDb();
  const cfg = appConfig().report;
  const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
  if (!order || order.status !== "paid") return false;

  await db.insert(schema.reports).values({ orderId }).onConflictDoNothing();
  const staleBefore = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${cfg.stale_after_minutes * 60} seconds`})`;
  const claim = await db.run(
    sql`update reports set status = 'pending', attempt = 0, started_at = ${NOW}, updated_at = ${NOW}
        where order_id = ${orderId} and (status = 'failed' or (status = 'pending' and (updated_at is null or updated_at < ${staleBefore})))`,
  );
  if (claim.rowsAffected === 0) return false;

  const started = Date.now();
  try {
    const [result] = await db.select().from(schema.results).where(eq(schema.results.id, order.resultId));
    const [test] = result.testId ? await db.select().from(schema.tests).where(eq(schema.tests.id, result.testId)) : [];
    const input = buildReportInput(questionnaire(), result, test?.answers ?? {}, cfg.low_index_threshold);
    const outcome = await buildReport(input, deps.provider !== undefined ? deps.provider : getLLMProvider(), {
      maxAttempts: cfg.max_attempts,
      timeoutMs: cfg.attempt_timeout_seconds * 1000,
      pauseMs: cfg.retry_pause_seconds * 1000,
      sleep: deps.sleep,
      onAttempt: async (attempt) => {
        await db.update(schema.reports).set({ attempt, updatedAt: new Date().toISOString() }).where(eq(schema.reports.orderId, orderId));
      },
    });
    const durationMs = Date.now() - started;
    await db
      .update(schema.reports)
      .set({
        status: "ready",
        content: outcome.report,
        provider: outcome.provider,
        isFallback: outcome.isFallback,
        attempt: outcome.attempts,
        durationMs,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.reports.orderId, orderId));
    console.info(
      JSON.stringify({
        event: "report_generated",
        order_id: orderId,
        provider: outcome.provider,
        attempts: outcome.attempts,
        fallback: outcome.isFallback,
        duration_ms: durationMs,
      }),
    );
  } catch (e) {
    console.error(JSON.stringify({ event: "report_failed", order_id: orderId, error: (e as Error).message.slice(0, 300) }));
    await db.update(schema.reports).set({ status: "failed", updatedAt: new Date().toISOString() }).where(eq(schema.reports.orderId, orderId));
    return false;
  }

  await emailReport(orderId, order.email);
  return true;
}

/**
 * Письмо со ссылкой — ровно один раз (условная отметка emailed_at). Если отправка упала, отметка
 * снимается и воркер повторит письмо следующим проходом. Email берём из заказа только здесь.
 */
export async function emailReport(orderId: string, email: string): Promise<boolean> {
  const db = getDb();
  const marked = await db
    .update(schema.reports)
    .set({ emailedAt: new Date().toISOString() })
    .where(and(eq(schema.reports.orderId, orderId), eq(schema.reports.status, "ready"), sql`emailed_at is null`));
  if (marked.rowsAffected === 0) return false;
  try {
    await sendReportEmail(email, `${appUrl()}/report/${orderId}`);
    return true;
  } catch (e) {
    await db.update(schema.reports).set({ emailedAt: null }).where(eq(schema.reports.orderId, orderId));
    console.error(JSON.stringify({ event: "report_email_failed", order_id: orderId, error: (e as Error).message.slice(0, 300) }));
    return false;
  }
}

/** Готовые отчёты, письмо о которых ещё не ушло. */
export async function unsentReportEmails() {
  return getDb().all<{ id: string; email: string }>(
    sql`select o.id, o.email from orders o join reports r on r.order_id = o.id
        where o.status = 'paid' and r.status = 'ready' and r.emailed_at is null`,
  );
}

/** Оплаченные заказы, которым нужна генерация: отчёта нет, он упал или завис без «пульса». */
export async function dueReportOrders(): Promise<string[]> {
  const staleBefore = `-${appConfig().report.stale_after_minutes * 60} seconds`;
  const rows = await getDb().all<{ id: string }>(
    sql`select o.id from orders o left join reports r on r.order_id = o.id
        where o.status = 'paid' and (r.order_id is null or r.status = 'failed'
          or (r.status = 'pending' and (r.updated_at is null or r.updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${staleBefore}))))
        order by o.paid_at`,
  );
  return rows.map((r) => r.id);
}

export type ReportState = {
  status: "missing" | "pending" | "ready" | "failed";
  report: Report | null;
  isFallback: boolean;
  attempt: number;
  maxAttempts: number;
  startedAt: string | null;
};

export async function getReport(orderId: string): Promise<ReportState> {
  const maxAttempts = appConfig().report.max_attempts;
  const [row] = await getDb().select().from(schema.reports).where(eq(schema.reports.orderId, orderId));
  if (!row) return { status: "missing", report: null, isFallback: false, attempt: 0, maxAttempts, startedAt: null };
  const parsed = row.status === "ready" ? ReportSchema.safeParse(row.content) : null;
  return {
    status: row.status,
    report: parsed?.success ? parsed.data : null,
    isFallback: row.isFallback,
    attempt: row.attempt,
    maxAttempts,
    startedAt: row.startedAt,
  };
}

export function appUrl() {
  return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}
