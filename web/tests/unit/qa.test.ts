import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { count, like } from "drizzle-orm";
import { schema } from "@/lib/db";
import { clearQa, loadQa, qaAnswers, seedQa } from "@/lib/qa";
import { resultPercentile } from "@/lib/results";
import { indexLevel, score } from "@/lib/scoring";
import { freshDb } from "./db";
import { q } from "./helpers";

let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => {
  db = await freshDb();
});

describe("/dev/qa: демо-данные", () => {
  it("ответы фикстур дают каждый из 8 типов и каждый уровень индекса", () => {
    q.archetypes.forEach((a, i) => {
      for (const level of ["low", "mid", "high"] as const) {
        const r = score(q, qaAnswers(i, level));
        expect(r.archetype).toBe(a.id);
        expect(indexLevel(q, r.index).id).toBe(level);
      }
    });
  });

  it("набор: 24 результата + гость + 6 заказов во всех состояниях, отчёт готов", async () => {
    const anon = `qa-${randomUUID()}`;
    await seedQa(anon);
    const qa = await loadQa(anon);
    expect(qa.byType.flatMap((t) => t.levels).every(Boolean)).toBe(true);
    expect(qa.guest).not.toBeNull();
    expect(qa.orders.map((o) => o.label).sort()).toEqual(["fail", "failed", "generating", "report", "success", "waiting"]);
    expect(qa.orders.find((o) => o.label === "report")?.report).toBe("ready");
    expect(qa.orders.find((o) => o.label === "generating")?.report).toBe("pending");
  });

  it("не для обычного посетителя; повторное создание и очистка не оставляют хвостов", async () => {
    await expect(seedQa(randomUUID())).rejects.toThrow();
    await seedQa(`qa-${randomUUID()}`);
    await seedQa(`qa-${randomUUID()}`);
    const [{ n }] = await db.select({ n: count() }).from(schema.orders).where(like(schema.orders.anonId, "qa-%"));
    expect(n).toBe(6);
    await clearQa();
    const [{ r }] = await db.select({ r: count() }).from(schema.results).where(like(schema.results.anonId, "qa-%"));
    expect(r).toBe(0);
  });

  it("QA-результаты не считаются в пороге и выборке перцентиля", async () => {
    const id = randomUUID();
    await db.insert(schema.results).values({
      id,
      anonId: "real",
      index: 50,
      level: "mid",
      axes: { energy: 3, stability: 3, openness: 3 },
      archetype: "careful_keeper",
      zones: { sleep: 3, relationships: 3, work: 3, money: 3, meaning: 3 },
      leaks: ["sleep", "relationships", "work"],
      direct: "rather_yes",
    });
    await seedQa(`qa-${randomUUID()}`); // 26 QA-результатов
    expect(await resultPercentile(id, 50, 2)).toEqual({ value: null, usesSeed: true });
  });
});
