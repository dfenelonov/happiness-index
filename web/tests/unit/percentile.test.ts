import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { appConfig } from "@/lib/config";
import { schema } from "@/lib/db";
import { resultPercentile } from "@/lib/results";
import { freshDb } from "./db";

let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => {
  db = await freshDb();
});

const row = (index: number, isSeed: boolean) => ({
  id: randomUUID(),
  index,
  level: "mid",
  axes: { energy: 3, stability: 3, openness: 3 },
  archetype: "careful_keeper",
  zones: { sleep: 3, relationships: 3, work: 3, money: 3, meaning: 3 },
  leaks: ["sleep", "relationships", "work"],
  direct: "rather_yes",
  isSeed,
});

async function insert(...rows: ReturnType<typeof row>[]) {
  await db.insert(schema.results).values(rows);
  return rows;
}

describe("перцентиль: синтетика до порога настоящих результатов", () => {
  it("порог берётся из config/app.yaml", () => {
    expect(appConfig().percentile.real_results_threshold).toBe(500);
  });

  it("ниже порога — сравнение вместе с seed и пометка (usesSeed)", async () => {
    await insert(row(10, true), row(20, true), row(90, true), row(95, true)); // seed: 2 ниже 50, 2 выше
    const [me] = await insert(row(50, false));
    await insert(row(80, false));
    // настоящих 2 < 3: в выборке 4 seed + 1 настоящий (без себя) → ниже 2 из 5
    expect(await resultPercentile(me.id, me.index, 3)).toEqual({ value: 40, usesSeed: true });
  });

  it("на пороге seed исключается автоматически и пометка пропадает", async () => {
    await insert(row(10, true), row(20, true), row(30, true), row(40, true)); // seed целиком ниже
    const [me] = await insert(row(50, false));
    await insert(row(80, false), row(90, false));
    // настоящих 3 = порог: сравниваем только с 2 другими настоящими, оба выше → 0%
    expect(await resultPercentile(me.id, me.index, 3)).toEqual({ value: 0, usesSeed: false });
    // тот же расклад при пороге 4 — ещё со смесью: ниже 4 seed из 6
    expect(await resultPercentile(me.id, me.index, 4)).toEqual({ value: 66, usesSeed: true });
  });

  it("сам результат в сравнение не входит; пустая выборка → null", async () => {
    const [me] = await insert(row(50, false));
    expect(await resultPercentile(me.id, me.index, 1)).toEqual({ value: null, usesSeed: false });
  });
});
