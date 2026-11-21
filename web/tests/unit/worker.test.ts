import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@/lib/db";
import { MockPaymentProvider } from "@/lib/payments/mock";
import { applyPayment, createOrder } from "@/lib/payments/service";
import { generateMockReport } from "@/lib/report/mock";
import { buildReportInput } from "@/lib/report/input";
import { dueReportOrders, generateReport, getReport } from "@/lib/report/generate";
import type { LLMProvider } from "@/lib/report/providers";
import { runReportWorker } from "@/lib/report/worker";
import { score } from "@/lib/scoring";
import { completeTest, saveAnswer, startOrResume } from "@/lib/test-flow";
import { freshDb } from "./db";
import { answersWith, q } from "./helpers";

const ANON = "11111111-1111-4111-8111-111111111111";
const ANSWERS = answersWith({ life: 2, leak: (z) => (z === "money" ? 1 : 4) });
let db: Awaited<ReturnType<typeof freshDb>>;

beforeEach(async () => {
  db = await freshDb();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function paidOrder(status: "succeeded" | "canceled" = "succeeded") {
  const { testId } = await startOrResume(ANON, null);
  for (const [id, v] of Object.entries(ANSWERS)) await saveAnswer(testId, ANON, id, v);
  const { resultId } = await completeTest(testId, ANON);
  const provider = new MockPaymentProvider();
  const visitor = { anonId: ANON, sessionId: null, price: 690, attribution: {} };
  const { orderId } = await createOrder({ provider, visitor, resultId, email: "buyer@example.ru", offerAccepted: true, appUrl: "" });
  const [o] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
  await applyPayment({ paymentId: o.providerPaymentId!, status, amountRub: 690 });
  return orderId;
}

/** Подставная LLM: отвечает по очереди из списка; считает вызовы и видит номер попытки в БД. */
function llm(orderId: () => string, ...replies: ("ok" | "bad" | Error)[]) {
  const good = JSON.stringify(generateMockReport(buildReportInput(q, score(q, ANSWERS), ANSWERS, 40)));
  const p = {
    name: "fake",
    calls: 0,
    seenAttempts: [] as number[],
    async complete() {
      const [row] = await db.select().from(schema.reports).where(eq(schema.reports.orderId, orderId()));
      p.seenAttempts.push(row.attempt);
      const r = replies[Math.min(p.calls++, replies.length - 1)];
      await new Promise((res) => setTimeout(res, 5));
      if (r instanceof Error) throw r;
      return r === "ok" ? good : "{}";
    },
  };
  return p as LLMProvider & typeof p;
}

const mails = () => db.select().from(schema.mailOutbox);
const noSleep = vi.fn(async () => {});

describe("фоновая генерация отчёта", () => {
  it("оплата → заказ без отчёта → воркер генерирует, пишет время и шлёт письмо один раз", async () => {
    const id = await paidOrder();
    expect(await dueReportOrders()).toEqual([id]);
    const p = llm(() => id, "ok");
    expect(await runReportWorker({ provider: p, sleep: noSleep })).toBe(1);
    const r = await getReport(id);
    expect(r).toMatchObject({ status: "ready", isFallback: false, attempt: 1 });
    const [row] = await db.select().from(schema.reports).where(eq(schema.reports.orderId, id));
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(await dueReportOrders()).toEqual([]);
    expect(await runReportWorker({ provider: p, sleep: noSleep })).toBe(0);
    expect((await mails()).filter((m) => m.subject === "Твой персональный разбор готов")).toHaveLength(1);
  });

  it("неоплаченные и отклонённые заказы не генерируются", async () => {
    await paidOrder("canceled");
    expect(await dueReportOrders()).toEqual([]);
  });

  it("идемпотентность: параллельные запуски генерируют отчёт один раз", async () => {
    const id = await paidOrder();
    const p = llm(() => id, "ok");
    const results = await Promise.all([1, 2, 3].map(() => generateReport(id, { provider: p, sleep: noSleep })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(p.calls).toBe(1);
  });

  it("3 попытки с паузой и прогрессом: две ошибки, затем успех", async () => {
    const id = await paidOrder();
    const p = llm(() => id, new Error("timeout"), "bad", "ok");
    const sleep = vi.fn(async () => {});
    await generateReport(id, { provider: p, sleep });
    expect(p.calls).toBe(3);
    expect(p.seenAttempts).toEqual([1, 2, 3]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10_000);
    expect(await getReport(id)).toMatchObject({ status: "ready", isFallback: false, attempt: 3 });
  });

  it("все 3 попытки неудачны → запасной отчёт на шаблонах, оплата не «в пустоту»", async () => {
    const id = await paidOrder();
    const p = llm(() => id, new Error("500"));
    await generateReport(id, { provider: p, sleep: noSleep });
    expect(p.calls).toBe(3);
    const r = await getReport(id);
    expect(r).toMatchObject({ status: "ready", isFallback: true });
    expect(r.report?.leaks[0].zone).toBe("money");
  });

  it("зависшая генерация (нет «пульса» дольше stale_after_minutes) перезапускается, свежая — нет", async () => {
    const id = await paidOrder();
    await db.insert(schema.reports).values({ orderId: id, status: "pending", updatedAt: new Date().toISOString() });
    expect(await dueReportOrders()).toEqual([]);
    expect(await generateReport(id, { provider: null })).toBe(false);
    await db.run(sql`update reports set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 minutes') where order_id = ${id}`);
    expect(await dueReportOrders()).toEqual([id]);
    expect(await runReportWorker({ provider: null })).toBe(1);
    expect((await getReport(id)).status).toBe("ready");
  });

  it("упавшая генерация (status failed) подбирается следующим проходом", async () => {
    const id = await paidOrder();
    await db.insert(schema.reports).values({ orderId: id, status: "failed", updatedAt: new Date().toISOString() });
    expect(await runReportWorker({ provider: null })).toBe(1);
    expect((await getReport(id)).status).toBe("ready");
  });

  it("письмо, которое не ушло, воркер отправляет следующим проходом", async () => {
    const id = await paidOrder();
    await runReportWorker({ provider: null });
    await db.delete(schema.mailOutbox);
    await db.update(schema.reports).set({ emailedAt: null }).where(eq(schema.reports.orderId, id)); // как после сбоя SMTP
    await runReportWorker({ provider: null });
    expect(await mails()).toHaveLength(1);
  });
});
