import { and, eq, sql } from "drizzle-orm";
import { appConfig, questionnaire } from "../config";
import { getDb, schema } from "../db";
import { sendReportEmail } from "../mailer";
import { buildReport } from "./build";
import { buildReportInput } from "./input";
import { getLLMProvider } from "./providers";
import { ReportSchema, type Report } from "./schema";

const inFlight = new Map<string, Promise<void>>();

/**
 * Запустить генерацию отчёта для оплаченного заказа, если её ещё нет. Возвращает промис генерации
 * (вебхук его не ждёт, страница отчёта опрашивает статус). Повторные вызовы безопасны.
 */
export function ensureReport(orderId: string): Promise<void> {
  const running = inFlight.get(orderId);
  if (running) return running;
  const p = run(orderId).finally(() => inFlight.delete(orderId));
  inFlight.set(orderId, p);
  return p;
}

async function run(orderId: string) {
  const db = getDb();
  const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
  if (!order || order.status !== "paid") return;

  // «Захват» строки: вставка pending или перезапуск failed / зависшего pending (> 5 минут).
  await db.insert(schema.reports).values({ orderId }).onConflictDoNothing();
  const claim = await db.run(
    sql`update reports set status = 'pending', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        where order_id = ${orderId} and (status = 'failed' or (status = 'pending' and
          (updated_at is null or updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes'))))`,
  );
  if (claim.rowsAffected === 0) return; // уже готов или генерируется прямо сейчас

  try {
    const [result] = await db.select().from(schema.results).where(eq(schema.results.id, order.resultId));
    const [test] = result.testId ? await db.select().from(schema.tests).where(eq(schema.tests.id, result.testId)) : [];
    const cfg = appConfig().report;
    const input = buildReportInput(questionnaire(), result, test?.answers ?? {}, cfg.low_index_threshold);
    const outcome = await buildReport(input, getLLMProvider(), {
      maxAttempts: cfg.max_attempts,
      timeoutMs: cfg.attempt_timeout_seconds * 1000,
    });
    await db
      .update(schema.reports)
      .set({
        status: "ready",
        content: outcome.report,
        provider: outcome.provider,
        isFallback: outcome.isFallback,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.reports.orderId, orderId));
  } catch (e) {
    console.error(`report ${orderId} failed: ${(e as Error).message}`);
    await db.update(schema.reports).set({ status: "failed", updatedAt: new Date().toISOString() }).where(eq(schema.reports.orderId, orderId));
    return;
  }

  // Письмо со ссылкой — один раз. Email берём из заказа только здесь, в LLM он не попадает.
  const marked = await db
    .update(schema.reports)
    .set({ emailedAt: new Date().toISOString() })
    .where(and(eq(schema.reports.orderId, orderId), sql`emailed_at is null`));
  if (marked.rowsAffected > 0) {
    try {
      await sendReportEmail(order.email, `${appUrl()}/report/${orderId}`);
    } catch (e) {
      console.error(`report email for ${orderId} failed: ${(e as Error).message}`);
    }
  }
}

export async function getReport(orderId: string): Promise<{ status: string; report: Report | null; isFallback: boolean }> {
  const [row] = await getDb().select().from(schema.reports).where(eq(schema.reports.orderId, orderId));
  if (!row) return { status: "missing", report: null, isFallback: false };
  const parsed = row.status === "ready" ? ReportSchema.safeParse(row.content) : null;
  return { status: row.status, report: parsed?.success ? parsed.data : null, isFallback: row.isFallback };
}

export function appUrl() {
  return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}
