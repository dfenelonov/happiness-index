import { describe, expect, it } from "vitest";
import { appConfig } from "@/lib/config";
import { mutated, q } from "./helpers";

describe("questionnaire.yaml проходит схему", () => {
  it("загружается", () => {
    expect(q.questions.length).toBeGreaterThan(0);
    expect(appConfig().pricing.variants_rub).toEqual([490, 690, 990]);
  });

  it.each([
    ["дубль id", (r: any) => r.questions.push({ ...r.questions[1] })],
    ["два прямых вопроса", (r: any) => r.questions.push({ id: "direct_2", kind: "direct", text: "?" })],
    ["неизвестная зона", (r: any) => (r.questions.find((x: any) => x.kind === "leak").zone = "health")],
    ["tie_break без зоны", (r: any) => r.scoring.leaks.tie_break_order.pop()],
    ["архетипы не покрывают все сочетания", (r: any) => (r.archetypes[0].when = { ...r.archetypes[1].when })],
    ["уровни не с нуля", (r: any) => (r.scoring.index.levels[0].min = 5)],
    ["нет текста сравнения для варианта", (r: any) => delete r.country.texts.hard_to_say],
    ["ось без вопросов", (r: any) => (r.questions = r.questions.filter((x: any) => x.axis !== "openness"))],
    ["шкала не 1–5", (r: any) => (r.scale.max = 7)],
  ])("отказ: %s", (_name, fn) => {
    expect(mutated(fn)).toThrow();
  });
});
