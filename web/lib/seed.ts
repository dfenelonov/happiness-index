import { randomUUID } from "node:crypto";
import type { Questionnaire } from "./config";
import { score, type Answers } from "./scoring";

// Синтетические результаты для холодного старта перцентиля. Детерминированы (seed),
// чтобы повторный `npm run setup` давал ту же картину.

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand: () => number) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

const clamp = (x: number) => Math.min(5, Math.max(1, Math.round(x)));

/**
 * Правдоподобный профиль: латентное «благополучие» h ~ N(0, 1) сдвигает ответы о жизни, утечках
 * и прямой вопрос; оси типа независимы. Средний ответ чуть выше середины шкалы — так выглядят
 * типичные опросы удовлетворённости (центр ≈ 3,2 из 5), без претензии на репрезентативность.
 */
export function syntheticAnswers(q: Questionnaire, rand: () => number): Answers {
  const h = normal(rand);
  const axes = { energy: normal(rand), stability: normal(rand), openness: normal(rand) };
  const answers: Answers = {};
  for (const item of q.questions) {
    if (item.kind === "life") answers[item.id] = clamp(3.2 + 0.9 * h + 0.6 * normal(rand));
    else if (item.kind === "leak") answers[item.id] = clamp(3.1 + 0.6 * h + 0.9 * normal(rand));
    else if (item.kind === "axis") {
      const x = 3 + 0.9 * axes[item.axis] + 0.6 * normal(rand);
      answers[item.id] = clamp(item.reverse ? 6 - x : x);
    } else {
      const p = h + 0.5 * normal(rand);
      answers[item.id] =
        p > 1.2 ? "definitely_yes" : p > -0.3 ? "rather_yes" : p > -0.8 ? "hard_to_say" : p > -1.5 ? "rather_no" : "definitely_no";
    }
  }
  return answers;
}

export function syntheticResults(q: Questionnaire, n: number, seed = 42) {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, () => {
    const r = score(q, syntheticAnswers(q, rand));
    return {
      id: randomUUID(),
      index: r.index,
      level: r.level,
      axes: r.axes,
      archetype: r.archetype,
      zones: r.zones,
      leaks: r.leaks,
      direct: r.direct,
      isSeed: true,
    };
  });
}
