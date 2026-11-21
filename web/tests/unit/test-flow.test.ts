import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@/lib/db";
import { completeTest, FlowError, saveAnswer, startOrResume } from "@/lib/test-flow";
import { freshDb } from "./db";
import { answersWith } from "./helpers";

const ANON = "11111111-1111-4111-8111-111111111111";
let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => {
  db = await freshDb();
});

describe("прохождение теста", () => {
  it("продолжение по id своего незавершённого теста; чужой — новый тест", async () => {
    const a = await startOrResume(ANON, null);
    await saveAnswer(a.testId, ANON, "life_1", 4);
    const again = await startOrResume(ANON, null, a.testId);
    expect(again).toMatchObject({ testId: a.testId, created: false, answers: { life_1: 4 } });
    const other = await startOrResume("other-anon", null, a.testId);
    expect(other.testId).not.toBe(a.testId);
  });

  it("ответ — upsert: изменение перезаписывает, остальные ответы сохраняются", async () => {
    const { testId } = await startOrResume(ANON, null);
    await saveAnswer(testId, ANON, "life_1", 2);
    await saveAnswer(testId, ANON, "direct", "rather_yes");
    await saveAnswer(testId, ANON, "life_1", 5);
    const [t] = await db.select().from(schema.tests).where(eq(schema.tests.id, testId));
    expect(t.answers).toEqual({ life_1: 5, direct: "rather_yes" });
  });

  it.each([
    ["неизвестный вопрос", "nope", 3],
    ["вне шкалы", "life_1", 6],
    ["строка вместо числа", "life_1", "5"],
    ["число вместо варианта", "direct", 1],
  ])("отказ: %s", async (_n, id, v) => {
    const { testId } = await startOrResume(ANON, null);
    await expect(saveAnswer(testId, ANON, id, v)).rejects.toThrow(FlowError);
  });

  it("завершение: неполный тест — ошибка; полный — результат, повтор возвращает тот же", async () => {
    const { testId } = await startOrResume(ANON, null);
    await saveAnswer(testId, ANON, "life_1", 3);
    await expect(completeTest(testId, ANON)).rejects.toThrow(FlowError);
    for (const [id, v] of Object.entries(answersWith({ life: 5 }))) await saveAnswer(testId, ANON, id, v);
    const first = await completeTest(testId, ANON);
    expect(first.created).toBe(true);
    expect(await completeTest(testId, ANON)).toEqual({ resultId: first.resultId, created: false });
    const [r] = await db.select().from(schema.results).where(eq(schema.results.id, first.resultId));
    expect(r).toMatchObject({ index: 100, isSeed: false, anonId: ANON });
    await expect(saveAnswer(testId, ANON, "life_1", 1)).rejects.toThrow(/завершено/);
  });
});
