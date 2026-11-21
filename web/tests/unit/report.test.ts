import { describe, expect, it, vi } from "vitest";
import { buildReport, extractJson } from "@/lib/report/build";
import { buildReportInput } from "@/lib/report/input";
import { generateMockReport } from "@/lib/report/mock";
import type { LLMProvider } from "@/lib/report/providers";
import { buildMessages } from "@/lib/report/providers";
import { reportText, ReportSchema, wordCount } from "@/lib/report/schema";
import { score } from "@/lib/scoring";
import { mulberry32, syntheticAnswers } from "@/lib/seed";
import { answersWith, axisAt, q } from "./helpers";

function inputFor(answers = answersWith({ life: 2, leak: (z) => ({ sleep: 1, money: 2, meaning: 3 })[z] ?? 4 })) {
  const r = score(q, answers);
  return buildReportInput(q, r, answers, 40);
}

const FORBIDDEN = /депресс|расстройств|синдром|диагноз|лечени|препарат|таблетк|за 7 дней|гарантир|политик/i;

describe("mock-отчёт", () => {
  it("проходит схему, ≥ 1500 слов и без запрещённых тем — для всех 8 типов и всех уровней", () => {
    const rand = mulberry32(7);
    const seenTypes = new Set<string>();
    const seenLevels = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const input = inputFor(syntheticAnswers(q, rand));
      const report = ReportSchema.parse(generateMockReport(input));
      const text = reportText(report);
      expect(wordCount(text)).toBeGreaterThanOrEqual(1500);
      expect(text).not.toMatch(FORBIDDEN);
      expect(text).not.toMatch(/\{\w+\}/); // все плейсхолдеры подставлены
      seenTypes.add(input.archetype.id);
      seenLevels.add(input.level);
    }
    expect(seenTypes.size).toBe(8);
    expect(seenLevels).toEqual(new Set(["low", "mid", "high"]));
  });

  it("персонализирован: разные типы и утечки дают разные тексты", () => {
    const a = generateMockReport(inputFor(answersWith({ axis: axisAt({ energy: 5, stability: 5, openness: 5 }), leak: (z) => (z === "money" ? 1 : 4) })));
    const b = generateMockReport(inputFor(answersWith({ axis: axisAt({ energy: 1, stability: 1, openness: 1 }), leak: (z) => (z === "sleep" ? 1 : 4) })));
    expect(a.type.heading).toContain("Первооткрыватель");
    expect(b.type.heading).toContain("Бережный хранитель");
    expect(a.leaks[0].zone).toBe("money");
    expect(b.leaks[0].zone).toBe("sleep");
    expect(a.plan.weeks[0].title).toContain("Деньги");
    expect(reportText(a)).not.toBe(reportText(b));
  });

  it("утечки и недели плана идут в порядке утечек пользователя", () => {
    const input = inputFor();
    const r = generateMockReport(input);
    expect(r.leaks.map((l) => l.zone)).toEqual(input.leaks);
    expect(r.plan.weeks).toHaveLength(4);
  });

  it("низкий индекс → мягкая рекомендация специалиста; высокий — без неё", () => {
    expect(reportText(generateMockReport(inputFor(answersWith({ life: 1 }))))).toContain("специалистом");
    expect(reportText(generateMockReport(inputFor(answersWith({ life: 5 }))))).not.toContain("специалистом");
  });

  it("детерминирован", () => {
    expect(generateMockReport(inputFor())).toEqual(generateMockReport(inputFor()));
  });
});

describe("вход для LLM", () => {
  it("без email и идентификаторов", () => {
    const input = inputFor();
    const { system, user } = buildMessages(input);
    const all = system + user;
    expect(all).not.toMatch(/@/);
    expect(all).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(Object.keys(input).sort()).toEqual(
      ["answers", "archetype", "axes", "direct_answer", "direct_happy", "index", "leaks", "level", "level_name", "low_index", "zones"].sort(),
    );
  });

  it("содержит баллы и тексты ответов", () => {
    const input = inputFor();
    expect(input.answers).toHaveLength(q.questions.length);
    expect(input.answers[0].answer).toBeTruthy();
    expect(input.axes.map((a) => a.id)).toEqual(["energy", "stability", "openness"]);
  });
});

describe("внешняя LLM: валидация, повтор, fallback", () => {
  const opts = { maxAttempts: 2, timeoutMs: 1000 };
  const provider = (...replies: (string | Error)[]): LLMProvider & { calls: number } => {
    const p = {
      name: "fake",
      calls: 0,
      async complete() {
        const r = replies[Math.min(p.calls++, replies.length - 1)];
        if (r instanceof Error) throw r;
        return r;
      },
    };
    return p;
  };

  it("валидный JSON с первой попытки", async () => {
    const input = inputFor();
    const good = JSON.stringify(generateMockReport(input));
    const p = provider("```json\n" + good + "\n```");
    const out = await buildReport(input, p, opts);
    expect(out).toMatchObject({ provider: "fake", isFallback: false, attempts: 1 });
  });

  it("невалидный ответ → повтор → успех", async () => {
    const input = inputFor();
    const p = provider('{"title": "x"}', JSON.stringify(generateMockReport(input)));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await buildReport(input, p, opts);
    expect(out).toMatchObject({ isFallback: false, attempts: 2 });
  });

  it("все попытки неудачны → fallback на mock", async () => {
    const input = inputFor();
    const p = provider(new Error("timeout"), "не json");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await buildReport(input, p, opts);
    expect(out).toMatchObject({ isFallback: true, attempts: 2 });
    expect(out.report).toEqual(generateMockReport(input));
  });

  it("отчёт с чужими утечками отклоняется", async () => {
    const input = inputFor();
    const wrong = generateMockReport(input);
    wrong.leaks = [...wrong.leaks].reverse();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await buildReport(input, provider(JSON.stringify(wrong)), opts);
    expect(out.isFallback).toBe(true);
  });

  it("пауза между попытками, но не перед первой и не после последней", async () => {
    const input = inputFor();
    const sleep = vi.fn(async () => {});
    const onAttempt = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await buildReport(input, provider(new Error("x")), { maxAttempts: 3, timeoutMs: 1000, pauseMs: 500, sleep, onAttempt });
    expect(sleep.mock.calls).toEqual([[500], [500]]);
    expect(onAttempt.mock.calls).toEqual([[1], [2], [3]]);
  });

  it("время каждой попытки пишется в лог (llm_attempt)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const input = inputFor();
    await buildReport(input, provider(JSON.stringify(generateMockReport(input))), opts);
    const line = JSON.parse(info.mock.calls.at(-1)![0] as string);
    expect(line).toMatchObject({ event: "llm_attempt", provider: "fake", attempt: 1, ok: true });
    expect(typeof line.ms).toBe("number");
  });

  it("без провайдера — сразу mock", async () => {
    const out = await buildReport(inputFor(), null, opts);
    expect(out).toMatchObject({ provider: "mock", isFallback: false, attempts: 0 });
  });

  it("extractJson терпит текст вокруг объекта", () => {
    expect(extractJson('Вот ответ: {"a": 1} спасибо')).toEqual({ a: 1 });
    expect(() => extractJson("нет json")).toThrow();
  });
});
