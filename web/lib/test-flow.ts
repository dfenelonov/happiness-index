import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { questionnaire } from "./config";
import { getDb, schema } from "./db";
import { score, type Answers } from "./scoring";

export class FlowError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Продолжить незавершённое прохождение этого посетителя или начать новое. */
export async function startOrResume(anonId: string, sessionId: string | null, testId?: string | null) {
  const db = getDb();
  if (testId) {
    const [t] = await db
      .select()
      .from(schema.tests)
      .where(and(eq(schema.tests.id, testId), eq(schema.tests.anonId, anonId), isNull(schema.tests.completedAt)));
    if (t) return { testId: t.id, answers: t.answers, created: false };
  }
  const id = randomUUID();
  await db.insert(schema.tests).values({ id, anonId, sessionId, answers: {} });
  return { testId: id, answers: {} as Answers, created: true };
}

/** Проверка ответа по конфигу. Возвращает позицию вопроса (с 1) для события question_answered. */
export function checkAnswer(questionId: string, value: unknown): { n: number; value: number | string } {
  const q = questionnaire();
  const idx = q.questions.findIndex((x) => x.id === questionId);
  if (idx < 0) throw new FlowError("Неизвестный вопрос");
  const item = q.questions[idx];
  if (item.kind === "direct") {
    if (typeof value !== "string" || !q.direct_options.some((o) => o.id === value)) throw new FlowError("Недопустимый ответ");
  } else if (typeof value !== "number" || !Number.isInteger(value) || value < q.scale.min || value > q.scale.max) {
    throw new FlowError("Недопустимый ответ");
  }
  return { n: idx + 1, value };
}

/** Upsert одного ответа: атомарно, без гонки «прочитал — дописал». */
export async function saveAnswer(testId: string, anonId: string, questionId: string, value: unknown) {
  const checked = checkAnswer(questionId, value);
  const res = await getDb().run(
    sql`update tests set answers = json_set(answers, ${`$."${questionId}"`}, json(${JSON.stringify(checked.value)}))
        where id = ${testId} and anon_id = ${anonId} and completed_at is null`,
  );
  if (res.rowsAffected === 0) throw new FlowError("Прохождение не найдено или уже завершено", 404);
  return checked;
}

/** Подсчёт и сохранение результата. Повторный вызов возвращает тот же результат. */
export async function completeTest(testId: string, anonId: string) {
  const db = getDb();
  const [t] = await db.select().from(schema.tests).where(and(eq(schema.tests.id, testId), eq(schema.tests.anonId, anonId)));
  if (!t) throw new FlowError("Прохождение не найдено", 404);
  if (t.resultId) return { resultId: t.resultId, created: false };

  let r;
  try {
    r = score(questionnaire(), t.answers);
  } catch (e) {
    throw new FlowError(`Тест заполнен не полностью: ${(e as Error).message}`);
  }
  const resultId = randomUUID();
  return db.transaction(async (tx) => {
    const upd = await tx
      .update(schema.tests)
      .set({ completedAt: new Date().toISOString(), resultId })
      .where(and(eq(schema.tests.id, testId), isNull(schema.tests.resultId)));
    if (upd.rowsAffected === 0) {
      const [again] = await tx.select().from(schema.tests).where(eq(schema.tests.id, testId));
      return { resultId: again.resultId!, created: false };
    }
    await tx.insert(schema.results).values({
      id: resultId,
      testId,
      anonId,
      index: r.index,
      level: r.level,
      axes: r.axes,
      archetype: r.archetype,
      zones: r.zones,
      leaks: r.leaks,
      direct: r.direct,
    });
    return { resultId, created: true };
  });
}
