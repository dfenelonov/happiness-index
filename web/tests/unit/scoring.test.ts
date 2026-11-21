import { describe, expect, it } from "vitest";
import {
  archetypeFor,
  axisDisplay,
  axisScores,
  countryLine,
  happinessIndex,
  indexLevel,
  percentile,
  poleOf,
  roundHalfUp,
  score,
  ScoringError,
  topLeaks,
  validateAnswers,
  zoneScores,
} from "@/lib/scoring";
import { answersWith, axisAt, q } from "./helpers";

describe("состав теста", () => {
  it("28 вопросов: 1 прямой, 8 про жизнь, 9 на оси (по 3), 10 на утечки (по 2 на зону)", () => {
    const kinds = (k: string) => q.questions.filter((x) => x.kind === k);
    expect(q.questions).toHaveLength(28);
    expect(kinds("direct")).toHaveLength(1);
    expect(kinds("life")).toHaveLength(8);
    expect(kinds("axis")).toHaveLength(9);
    expect(kinds("leak")).toHaveLength(10);
    for (const axis of ["energy", "stability", "openness"]) {
      const items = q.questions.filter((x) => x.kind === "axis" && x.axis === axis);
      expect(items).toHaveLength(3);
      expect(items.some((x) => x.kind === "axis" && x.reverse)).toBe(true);
    }
    for (const zone of Object.keys(q.zones)) {
      expect(q.questions.filter((x) => x.kind === "leak" && x.zone === zone)).toHaveLength(2);
    }
  });
});

describe("индекс счастья", () => {
  it("все 1 → 0, все 5 → 100, все 3 → 50", () => {
    expect(happinessIndex(q, answersWith({ life: 1 }))).toBe(0);
    expect(happinessIndex(q, answersWith({ life: 5 }))).toBe(100);
    expect(happinessIndex(q, answersWith({ life: 3 }))).toBe(50);
  });

  it("нормированная сумма: один ответ 2 вместо 1 → 1/32 → 3", () => {
    const a = answersWith({ life: 1 });
    a.life_1 = 2;
    expect(happinessIndex(q, a)).toBe(3); // 3.125
  });

  it("веса учитываются", () => {
    const weighted = structuredClone(q);
    for (const x of weighted.questions) if (x.kind === "life") x.weight = x.id === "life_1" ? 3 : 1;
    const a = answersWith({ life: 1 });
    a.life_1 = 5;
    expect(happinessIndex(weighted, a)).toBe(roundHalfUp((3 * 4) / (10 * 4) * 100)); // 30
  });

  it("не зависит от осей, утечек и прямого вопроса", () => {
    const base = happinessIndex(q, answersWith({ life: 4 }));
    expect(happinessIndex(q, answersWith({ life: 4, leak: 1, axis: () => 5, direct: "definitely_no" }))).toBe(base);
  });

  it("уровни: граница включительно", () => {
    expect(indexLevel(q, 0).id).toBe("low");
    expect(indexLevel(q, 44).id).toBe("low");
    expect(indexLevel(q, 45).id).toBe("mid");
    expect(indexLevel(q, 69).id).toBe("mid");
    expect(indexLevel(q, 70).id).toBe("high");
    expect(indexLevel(q, 100).id).toBe("high");
  });
});

describe("округление", () => {
  it("половина — вверх", () => {
    expect(roundHalfUp(62.5)).toBe(63);
    expect(roundHalfUp(12.5)).toBe(13);
    expect(roundHalfUp(12.49)).toBe(12);
    expect(roundHalfUp(((2.5 - 1) / 4) * 100)).toBe(38); // 37.5
  });
});

describe("оси типа", () => {
  it("обратный пункт = 6 − x", () => {
    const a = answersWith({ axis: (_axis, reverse) => (reverse ? 1 : 5) });
    const axes = axisScores(q, a);
    expect(axes.energy).toBe(5);
    expect(axes.stability).toBe(5);
    expect(axes.openness).toBe(5);
  });

  it("среднее трёх пунктов", () => {
    const a = answersWith({});
    a.axis_energy_1 = 5;
    a.axis_energy_2 = 2; // обратный → 4
    a.axis_energy_3 = 3;
    expect(axisScores(q, a).energy).toBe(4);
  });

  it("порог строго больше: 3.0 — низкий полюс, выше — высокий", () => {
    expect(poleOf(q, 3)).toBe("low");
    expect(poleOf(q, 3 + 1 / 3)).toBe("high");
    expect(poleOf(q, 2 + 2 / 3)).toBe("low");
  });

  it("отображение 0–100", () => {
    expect(axisDisplay(q, 1)).toBe(0);
    expect(axisDisplay(q, 5)).toBe(100);
    expect(axisDisplay(q, 3)).toBe(50);
    expect(axisDisplay(q, 3 + 1 / 3)).toBe(58);
  });

  it("все 8 архетипов достижимы и различны", () => {
    const seen = new Set<string>();
    for (const e of [2, 4]) for (const s of [2, 4]) for (const o of [2, 4]) {
      const a = answersWith({ axis: axisAt({ energy: e, stability: s, openness: o }) });
      const arch = archetypeFor(q, axisScores(q, a));
      expect(arch.when).toEqual({ energy: e > 3 ? "high" : "low", stability: s > 3 ? "high" : "low", openness: o > 3 ? "high" : "low" });
      seen.add(arch.id);
    }
    expect(seen.size).toBe(8);
  });

  it("все ответы «3» → все полюса низкие → Бережный хранитель", () => {
    expect(archetypeFor(q, axisScores(q, answersWith({}))).id).toBe("careful_keeper");
  });
});

describe("утечки", () => {
  it("три зоны с наименьшим баллом", () => {
    const score = { sleep: 4, relationships: 2, work: 1, money: 5, meaning: 3 };
    const a = answersWith({ leak: (zone) => score[zone as keyof typeof score] });
    expect(topLeaks(q, zoneScores(q, a))).toEqual(["work", "relationships", "meaning"]);
  });

  it("среднее двух пунктов зоны", () => {
    const a = answersWith({});
    a.leak_money_1 = 1;
    a.leak_money_2 = 4;
    expect(zoneScores(q, a).money).toBe(2.5);
  });

  it("при равенстве — порядок tie_break_order", () => {
    expect(topLeaks(q, zoneScores(q, answersWith({ leak: 3 })))).toEqual(["sleep", "relationships", "work"]);
    const a = answersWith({ leak: (zone) => (zone === "meaning" ? 1 : 3) });
    expect(topLeaks(q, zoneScores(q, a))).toEqual(["meaning", "sleep", "relationships"]);
  });
});

describe("перцентиль", () => {
  it("доля строго ниже, вниз до целого", () => {
    expect(percentile(50, [10, 20, 50, 60])).toBe(50);
    expect(percentile(50, [50, 50, 50])).toBe(0);
    expect(percentile(100, [0, 1, 2])).toBe(100);
    expect(percentile(40, [10, 20, 50])).toBe(66); // 66.67 → 66, не завышаем
  });

  it("пустая выборка → null", () => {
    expect(percentile(50, [])).toBeNull();
  });
});

describe("прямой вопрос", () => {
  it("строка сравнения со страной подставляет долю", () => {
    expect(countryLine(q, "definitely_yes")).toContain(`${Math.round(q.country.share_happy * 100)}%`);
    expect(countryLine(q, "definitely_no")).not.toContain("{");
  });
});

describe("валидация ответов", () => {
  it("нет ответа", () => {
    const a = answersWith({});
    delete a.life_3;
    expect(() => validateAnswers(q, a)).toThrow(ScoringError);
  });

  it.each([0, 6, 2.5, "3"])("значение %s вне шкалы", (v) => {
    const a = answersWith({});
    a.axis_openness_1 = v as number;
    expect(() => score(q, a)).toThrow(ScoringError);
  });

  it("недопустимый вариант прямого вопроса", () => {
    expect(() => score(q, answersWith({ direct: "maybe" }))).toThrow(ScoringError);
    const a = answersWith({});
    a.direct = 3;
    expect(() => score(q, a)).toThrow(ScoringError);
  });
});

describe("score — полный результат", () => {
  it("собирает всё вместе", () => {
    const a = answersWith({
      life: 4,
      leak: (zone) => (zone === "money" ? 1 : 4),
      axis: axisAt({ energy: 5, stability: 4, openness: 2 }),
      direct: "definitely_yes",
    });
    const r = score(q, a);
    expect(r.index).toBe(75);
    expect(r.level).toBe("high");
    expect(r.archetype).toBe("sunny_strategist");
    expect(r.leaks[0]).toBe("money");
    expect(r.direct).toBe("definitely_yes");
  });
});
