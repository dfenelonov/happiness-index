import { parse } from "yaml";
import fs from "node:fs";
import { parseQuestionnaire, questionnaire, type Questionnaire } from "@/lib/config";
import type { Answers } from "@/lib/scoring";

export const q = questionnaire();

/** Все ответы = value; оси и утечки можно переопределить по id или правилом. */
export function answersWith(opts: {
  life?: number;
  leak?: number | ((zone: string, id: string) => number);
  axis?: (axis: string, reverse: boolean) => number;
  direct?: string;
}): Answers {
  const a: Answers = {};
  for (const item of q.questions) {
    if (item.kind === "life") a[item.id] = opts.life ?? 3;
    else if (item.kind === "leak") a[item.id] = typeof opts.leak === "function" ? opts.leak(item.zone, item.id) : (opts.leak ?? 3);
    else if (item.kind === "axis") a[item.id] = opts.axis ? opts.axis(item.axis, item.reverse) : 3;
    else a[item.id] = opts.direct ?? "rather_yes";
  }
  return a;
}

/** Ответы на оси так, чтобы среднее с учётом обратных пунктов было ровно m (целое 1–5). */
export const axisAt = (target: Record<string, number>) => (axis: string, reverse: boolean) =>
  reverse ? 6 - target[axis] : target[axis];

export function rawQuestionnaire(): Record<string, unknown> {
  return parse(fs.readFileSync("config/questionnaire.yaml", "utf8"));
}

export function mutated(fn: (raw: Record<string, any>) => void): () => Questionnaire {
  return () => {
    const raw = rawQuestionnaire() as Record<string, any>;
    fn(raw);
    return parseQuestionnaire(raw);
  };
}
