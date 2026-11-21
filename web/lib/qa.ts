import { randomUUID } from "node:crypto";
import { isNull, like, notLike, or, sql, type Column } from "drizzle-orm";
import { AXIS_IDS, appConfig, questionnaire } from "./config";
import { getDb, schema } from "./db";
import { buildReportInput } from "./report/input";
import { generateMockReport } from "./report/mock";
import { score, type Answers } from "./scoring";

// Демо-данные для /dev/qa. Все строки принадлежат посетителям с anon_id «qa-…» и исключаются
// из метрик, перцентиля, списков и выгрузок админки (notQa).

export const QA_PREFIX = "qa-";

export const isQaAnon = (anonId: string | null | undefined) => !!anonId?.startsWith(QA_PREFIX);

/** Условие «не QA» для колонки anon_id (NULL — не QA). */
export const notQa = (col: Column) => or(isNull(col), notLike(col, `${QA_PREFIX}%`));

const LEVEL_LIFE: Record<string, number> = { low: 2, mid: 3, high: 4 }; // индекс 25 / 50 / 75
const LEVEL_DIRECT: Record<string, string> = { low: "rather_no", mid: "hard_to_say", high: "definitely_yes" };

/** Ответы, дающие нужный тип и уровень. Утечки сдвигаются от типа к типу, чтобы были разные. */
export function qaAnswers(archetypeIndex: number, level: keyof typeof LEVEL_LIFE): Answers {
  const q = questionnaire();
  const arch = q.archetypes[archetypeIndex];
  const zones = q.scoring.leaks.tie_break_order;
  const answers: Answers = {};
  for (const item of q.questions) {
    if (item.kind === "life") answers[item.id] = LEVEL_LIFE[level];
    else if (item.kind === "direct") answers[item.id] = LEVEL_DIRECT[level];
    else if (item.kind === "leak") answers[item.id] = ((zones.indexOf(item.zone) + archetypeIndex) % 5) + 1;
    else {
      const x = arch.when[item.axis] === "high" ? 4 : 2;
      answers[item.id] = item.reverse ? 6 - x : x;
    }
  }
  return answers;
}

async function insertResult(anonId: string, answers: Answers) {
  const r = score(questionnaire(), answers);
  const testId = randomUUID();
  const resultId = randomUUID();
  const db = getDb();
  await db.insert(schema.tests).values({ id: testId, anonId, answers, completedAt: new Date().toISOString(), resultId });
  await db.insert(schema.results).values({ id: resultId, testId, anonId, ...r, isSeed: false });
  return { resultId, ...r };
}

/** Стереть все QA-данные (любых прошлых сессий). */
export async function clearQa() {
  const db = getDb();
  const qa = `${QA_PREFIX}%`;
  await db.run(sql`delete from reports where order_id in (select id from orders where anon_id like ${qa})`);
  await db.delete(schema.orders).where(like(schema.orders.anonId, qa));
  await db.delete(schema.leads).where(like(schema.leads.anonId, qa));
  await db.delete(schema.events).where(like(schema.events.anonId, qa));
  await db.delete(schema.results).where(like(schema.results.anonId, qa));
  await db.delete(schema.tests).where(like(schema.tests.anonId, qa));
}

/** Создать набор демо-данных для посетителя anonId (с префиксом qa-). */
export async function seedQa(anonId: string) {
  if (!isQaAnon(anonId)) throw new Error("QA-данные только для anon_id с префиксом qa-");
  await clearQa();
  const q = questionnaire();
  const db = getDb();

  for (let i = 0; i < q.archetypes.length; i++) {
    for (const level of ["low", "mid", "high"] as const) await insertResult(anonId, qaAnswers(i, level));
  }
  // результат «друга» — для гостевого просмотра
  await insertResult(`${QA_PREFIX}guest-${randomUUID()}`, qaAnswers(4, "mid"));

  // заказы во всех состояниях — к результату «Первооткрыватель, средний»
  const base = await insertResult(anonId, qaAnswers(0, "mid"));
  const price = appConfig().pricing.variants_rub[Math.floor(appConfig().pricing.variants_rub.length / 2)];
  const order = async (label: string, status: "pending" | "paid" | "failed") => {
    const id = randomUUID();
    await db.insert(schema.orders).values({
      id,
      resultId: base.resultId,
      anonId,
      priceVariant: price,
      amountRub: price,
      email: "qa@example.ru",
      status,
      provider: "mock",
      providerPaymentId: `mock_qa_${label}_${id}`,
      paidAt: status === "paid" ? new Date().toISOString() : null,
    });
    return id;
  };
  await order("success", "pending");
  await order("fail", "pending");
  await order("waiting", "pending");
  await order("failed", "failed");

  const ready = await order("report", "paid");
  const [test] = await db.select().from(schema.tests).where(sql`result_id = ${base.resultId}`);
  const input = buildReportInput(q, { ...base, axes: base.axes }, test.answers, appConfig().report.low_index_threshold);
  await db.insert(schema.reports).values({ orderId: ready, status: "ready", provider: "mock", content: generateMockReport(input) });

  // «готовится»: свежий pending не перехватывается повторной генерацией 5 минут
  const pending = await order("generating", "paid");
  await db.insert(schema.reports).values({ orderId: pending, status: "pending", updatedAt: new Date().toISOString() });
}

/** Сводка QA-данных посетителя для галереи. */
export async function loadQa(anonId: string) {
  const db = getDb();
  const q = questionnaire();
  const results = await db.select().from(schema.results).where(sql`anon_id = ${anonId}`);
  const [guest] = await db.select().from(schema.results).where(like(schema.results.anonId, `${QA_PREFIX}guest-%`)).limit(1);
  const orders = await db
    .select({
      id: schema.orders.id,
      resultId: schema.orders.resultId,
      status: schema.orders.status,
      paymentId: schema.orders.providerPaymentId,
      report: schema.reports.status,
    })
    .from(schema.orders)
    .leftJoin(schema.reports, sql`${schema.reports.orderId} = ${schema.orders.id}`)
    .where(sql`${schema.orders.anonId} = ${anonId}`);
  const label = (paymentId: string | null) => paymentId?.split("_")[2] ?? "";
  const byType = q.archetypes.map((a) => ({
    id: a.id,
    name: a.name,
    poles: AXIS_IDS.map((axis) => `${q.scoring.axes.list[axis].name}: ${a.when[axis] === "high" ? "↑" : "↓"}`).join(" · "),
    levels: (["low", "mid", "high"] as const).map((level) =>
      results.find((r) => r.archetype === a.id && r.level === level && !orders.some((o) => o.resultId === r.id)),
    ),
  }));
  const purchased = new Set(orders.map((o) => o.resultId));
  return {
    byType,
    guest: guest ?? null,
    orders: orders.map((o) => ({ ...o, label: label(o.paymentId) })),
    any: results[0] ?? null,
    // пейволл виден только там, где разбор ещё не куплен
    notPurchased: results.find((r) => !purchased.has(r.id)) ?? null,
    purchased: results.find((r) => purchased.has(r.id)) ?? null,
  };
}
