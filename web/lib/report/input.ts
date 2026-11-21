import { AXIS_IDS, type Questionnaire } from "../config";
import { axisDisplay, indexLevel, poleOf, type Answers } from "../scoring";

// Вход для генерации отчёта. Только баллы и ответы: без email, id заказа/результата/посетителя.

export type ReportInput = {
  index: number;
  level: string; // id уровня: low | mid | high
  level_name: string;
  low_index: boolean; // ниже порога — мягкая рекомендация специалиста
  direct_answer: string;
  direct_happy: boolean | null;
  archetype: { id: string; name: string; description: string };
  axes: { id: string; name: string; score: number; pole: "high" | "low"; pole_text: string }[];
  zones: { id: string; name: string; score: number }[];
  leaks: string[]; // id зон, от самой сильной утечки
  answers: { block: "direct" | "life" | "leak" | "axis"; zone?: string; question: string; answer: string; value: number | null }[];
};

export type StoredResult = {
  index: number;
  axes: Record<string, number>;
  archetype: string;
  zones: Record<string, number>;
  leaks: string[];
  direct: string;
};

const to100 = (m: number) => Math.round(((m - 1) / 4) * 100);

export function buildReportInput(q: Questionnaire, r: StoredResult, answers: Answers, lowThreshold: number): ReportInput {
  const arch = q.archetypes.find((a) => a.id === r.archetype)!;
  const direct = q.direct_options.find((o) => o.id === r.direct)!;
  const level = indexLevel(q, r.index);
  return {
    index: r.index,
    level: level.id,
    level_name: level.name,
    low_index: r.index < lowThreshold,
    direct_answer: direct.label,
    direct_happy: direct.happy,
    archetype: { id: arch.id, name: arch.name, description: arch.description },
    axes: AXIS_IDS.map((id) => {
      const m = r.axes[id];
      const pole = poleOf(q, m);
      const meta = q.scoring.axes.list[id];
      return { id, name: meta.name, score: axisDisplay(q, m), pole, pole_text: meta[pole] };
    }),
    zones: Object.entries(q.zones).map(([id, z]) => ({ id, name: z.name, score: to100(r.zones[id]) })),
    leaks: r.leaks,
    answers: q.questions.map((item) => {
      const v = answers[item.id];
      const answer =
        item.kind === "direct"
          ? (q.direct_options.find((o) => o.id === v)?.label ?? "")
          : (q.scale.labels[(v as number) - q.scale.min] ?? "");
      return {
        block: item.kind,
        ...(item.kind === "leak" ? { zone: item.zone } : {}),
        question: item.text,
        answer,
        value: typeof v === "number" ? v : null,
      };
    }),
  };
}
