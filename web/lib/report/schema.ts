import { z } from "zod";

// Структура отчёта: ровно её ждём от LLM (JSON) и ровно её собирает mock-генератор.

const Text = z.string().trim().min(1).max(2000);
const Paragraphs = z.array(Text).min(1).max(8);

export const ReportSchema = z.object({
  title: z.string().trim().min(1).max(200),
  intro: Paragraphs,
  index: z.object({ heading: Text, paragraphs: Paragraphs }),
  type: z.object({
    heading: Text,
    paragraphs: Paragraphs,
    strengths: z.array(Text).min(2).max(8),
    pitfalls: z.array(Text).min(1).max(8),
  }),
  leaks: z
    .array(z.object({ zone: z.string(), heading: Text, why: Paragraphs, actions: z.array(Text).min(2).max(10) }))
    .length(3),
  type_advice: z.object({ heading: Text, paragraphs: Paragraphs, tips: z.array(Text).min(2).max(10) }),
  plan: z.object({
    heading: Text,
    intro: Text,
    weeks: z.array(z.object({ title: Text, focus: Text, steps: z.array(Text).min(3).max(10) })).length(4),
  }),
  closing: Paragraphs,
});
export type Report = z.infer<typeof ReportSchema>;

/** Весь текст отчёта одной строкой — для подсчёта слов и проверок запрещённых тем. */
export function reportText(r: Report): string {
  return [
    r.title,
    ...r.intro,
    r.index.heading,
    ...r.index.paragraphs,
    r.type.heading,
    ...r.type.paragraphs,
    ...r.type.strengths,
    ...r.type.pitfalls,
    ...r.leaks.flatMap((l) => [l.heading, ...l.why, ...l.actions]),
    r.type_advice.heading,
    ...r.type_advice.paragraphs,
    ...r.type_advice.tips,
    r.plan.heading,
    r.plan.intro,
    ...r.plan.weeks.flatMap((w) => [w.title, w.focus, ...w.steps]),
    ...r.closing,
  ].join("\n");
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
