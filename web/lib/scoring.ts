import { AXIS_IDS, type Axis, type Questionnaire } from "./config";

// Чистые функции подсчёта: только конфиг + ответы на входе, без БД, HTTP и случайности.

export type Answers = Record<string, number | string>;
export type AxisScores = Record<Axis, number>;

export class ScoringError extends Error {}

/** Округление половины вверх, устойчивое к хвостам двоичной арифметики (62.4999999 → 62.5 → 63). */
export function roundHalfUp(x: number): number {
  return Math.floor(Math.round(x * 1e9) / 1e9 + 0.5);
}

export function validateAnswers(q: Questionnaire, answers: Answers): void {
  const optionIds = new Set(q.direct_options.map((o) => o.id));
  for (const item of q.questions) {
    const v = answers[item.id];
    if (v === undefined) throw new ScoringError(`нет ответа на ${item.id}`);
    if (item.kind === "direct") {
      if (typeof v !== "string" || !optionIds.has(v)) throw new ScoringError(`недопустимый ответ на ${item.id}`);
    } else if (typeof v !== "number" || !Number.isInteger(v) || v < q.scale.min || v > q.scale.max) {
      throw new ScoringError(`ответ на ${item.id} вне шкалы ${q.scale.min}–${q.scale.max}`);
    }
  }
}

const num = (answers: Answers, id: string) => answers[id] as number;

/** Индекс 0–100: нормированная взвешенная сумма по вопросам kind: life. */
export function happinessIndex(q: Questionnaire, answers: Answers): number {
  let sum = 0;
  let max = 0;
  const span = q.scale.max - q.scale.min;
  for (const item of q.questions) {
    if (item.kind !== "life") continue;
    sum += item.weight * (num(answers, item.id) - q.scale.min);
    max += item.weight * span;
  }
  return roundHalfUp((sum / max) * 100);
}

export function indexLevel(q: Questionnaire, index: number) {
  const levels = q.scoring.index.levels;
  let level = levels[0];
  for (const l of levels) if (index >= l.min) level = l;
  return level;
}

/** Среднее по оси с учётом обратных пунктов (min + max − x), 1–5. */
export function axisScores(q: Questionnaire, answers: Answers): AxisScores {
  const acc = Object.fromEntries(AXIS_IDS.map((a) => [a, [] as number[]])) as Record<Axis, number[]>;
  for (const item of q.questions) {
    if (item.kind !== "axis") continue;
    const x = num(answers, item.id);
    acc[item.axis].push(item.reverse ? q.scale.min + q.scale.max - x : x);
  }
  return Object.fromEntries(AXIS_IDS.map((a) => [a, mean(acc[a])])) as AxisScores;
}

/** Балл оси для интерфейса, 0–100. */
export function axisDisplay(q: Questionnaire, m: number): number {
  return roundHalfUp(((m - q.scale.min) / (q.scale.max - q.scale.min)) * 100);
}

export function poleOf(q: Questionnaire, m: number): "high" | "low" {
  return m > q.scoring.axes.threshold ? "high" : "low";
}

export function archetypeFor(q: Questionnaire, axes: AxisScores) {
  const found = q.archetypes.find((a) => AXIS_IDS.every((axis) => a.when[axis] === poleOf(q, axes[axis])));
  if (!found) throw new ScoringError("нет архетипа для сочетания полюсов"); // недостижимо при валидном конфиге
  return found;
}

/** Средний балл по каждой зоне утечек, 1–5. */
export function zoneScores(q: Questionnaire, answers: Answers): Record<string, number> {
  const acc: Record<string, number[]> = Object.fromEntries(Object.keys(q.zones).map((z) => [z, []]));
  for (const item of q.questions) {
    if (item.kind === "leak") acc[item.zone].push(num(answers, item.id));
  }
  return Object.fromEntries(Object.entries(acc).map(([z, xs]) => [z, mean(xs)]));
}

/** Утечки — зоны с наименьшим баллом; при равенстве — порядок tie_break_order. */
export function topLeaks(q: Questionnaire, zones: Record<string, number>): string[] {
  const order = q.scoring.leaks.tie_break_order;
  return [...order].sort((a, b) => zones[a] - zones[b] || order.indexOf(a) - order.indexOf(b)).slice(0, q.scoring.leaks.count);
}

/** «Ты счастливее X% участников»: доля результатов строго ниже, округление вниз (не завышаем). */
export function percentile(index: number, population: number[]): number | null {
  return percentileFromCounts(population.filter((x) => x < index).length, population.length);
}

export function percentileFromCounts(below: number, total: number): number | null {
  return total === 0 ? null : Math.floor((below / total) * 100);
}

export function countryLine(q: Questionnaire, directAnswer: string): string {
  const happy = String(Math.round(q.country.share_happy * 100));
  return (q.country.texts[directAnswer] ?? "").replaceAll("{happy}", happy);
}

export type ScoringResult = {
  index: number;
  level: string;
  axes: AxisScores;
  archetype: string;
  zones: Record<string, number>;
  leaks: string[];
  direct: string;
};

export function score(q: Questionnaire, answers: Answers): ScoringResult {
  validateAnswers(q, answers);
  const index = happinessIndex(q, answers);
  const axes = axisScores(q, answers);
  const zones = zoneScores(q, answers);
  const direct = q.questions.find((x) => x.kind === "direct")!;
  return {
    index,
    level: indexLevel(q, index).id,
    axes,
    archetype: archetypeFor(q, axes).id,
    zones,
    leaks: topLeaks(q, zones),
    direct: answers[direct.id] as string,
  };
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
