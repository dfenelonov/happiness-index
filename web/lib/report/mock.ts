import type { ReportInput } from "./input";
import {
  ARCHETYPE_TEXTS,
  AXIS_TEXTS,
  CLOSING,
  CLOSING_COMMON,
  DIRECT_TEXTS,
  LEVEL_TEXTS,
  LOW_INDEX_SUPPORT,
  PLAN_WEEK_WHY,
  RANKS,
  ZONE_ANSWERS,
  ZONE_VERDICT,
  ZONE_TEXTS,
} from "./mock-texts";
import type { Report } from "./schema";

// Детерминированный отчёт из шаблонов, персонализированный по баллам: тип, уровень индекса,
// полюса осей, порядок и баллы утечек, прямой ответ, самые сильные и слабые утверждения.

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

export function generateMockReport(input: ReportInput): Report {
  const arch = ARCHETYPE_TEXTS[input.archetype.id];
  const zoneName = (id: string) => input.zones.find((z) => z.id === id)?.name ?? id;
  const zoneScore = (id: string) => input.zones.find((z) => z.id === id)?.score ?? 0;
  const pole = (axis: string) => input.axes.find((a) => a.id === axis)?.pole ?? "low";
  const leakNames = input.leaks.map(zoneName);

  const indexParagraphs = (LEVEL_TEXTS[input.level] ?? LEVEL_TEXTS.mid).map((p) => fill(p, { index: input.index }));
  indexParagraphs.push(directParagraph(input));
  const anchors = lifeAnchors(input);
  if (anchors) indexParagraphs.push(anchors);
  if (input.low_index) indexParagraphs.push(LOW_INDEX_SUPPORT);

  const strongest = [...input.zones].sort((a, b) => b.score - a.score)[0];
  const strongestText = `А вот где у тебя всё неплохо: «${strongest.name}» — ${strongest.score} из 100. Это твой ресурс. Когда будешь работать с утечками, опирайся на него: то, что уже получается в одной сфере, часто можно перенести в другую.`;

  return {
    title: `${input.archetype.name}: твой разбор индекса счастья`,
    intro: [
      `Привет! Это твой персональный разбор по результатам теста «Индекс счастья». Он собран по твоим ответам: индексу (${input.index} из 100), типу «${input.archetype.name}» и трём главным утечкам — ${leakNames[0].toLowerCase()}, ${leakNames[1].toLowerCase()} и ${leakNames[2].toLowerCase()}.`,
      "Читай его не как инструкцию, а как разговор с внимательным собеседником. Бери то, что откликается, и не спеши внедрять всё сразу: в конце тебя ждёт план на 30 дней, где шаги разложены по неделям.",
      "Разбор не является медицинской или психологической услугой. Это повод взглянуть на свою жизнь со стороны и выбрать, с чего начать.",
    ],
    index: { heading: `Индекс ${input.index} из 100: что он значит`, paragraphs: indexParagraphs },
    type: {
      heading: `Твой тип — ${input.archetype.name}`,
      paragraphs: [
        input.archetype.description,
        ...input.axes.map((a) => fill(AXIS_TEXTS[a.id][a.pole], { score: a.score })),
        arch.happiness,
      ],
      strengths: arch.strengths,
      pitfalls: arch.pitfalls,
    },
    leaks: input.leaks.map((zone, i) => {
      const t = ZONE_TEXTS[zone];
      return {
        zone,
        heading: `${i + 1}. ${zoneName(zone)}`,
        why: [
          ...t.why.map((p) => fill(p, { score: zoneScore(zone), rank: RANKS[i] ?? "" })),
          ...zoneAnswers(input, zone),
          t.link[pole(t.axis)],
          t.today,
        ],
        actions: t.actions,
      };
    }),
    type_advice: {
      heading: `Что делать человеку с типом «${input.archetype.name}»`,
      paragraphs: [arch.advice, strongestText],
      tips: arch.tips,
    },
    plan: {
      heading: "План на 30 дней",
      intro:
        "Три недели — по одной на каждую утечку, начиная с самой заметной. Четвёртая — чтобы закрепить то, что сработало. Делай по одному шагу в день или пару в неделю — как тебе удобно. Пропустил день — не страшно, просто продолжай.",
      weeks: [
        ...input.leaks.map((zone, i) => ({
          title: `Неделя ${i + 1}. ${zoneName(zone)}`,
          focus: `${
            i === 0
              ? "Начинаем с главной утечки: здесь изменения почувствуются быстрее всего."
              : `Продолжаем: ${zoneName(zone).toLowerCase()} — ${RANKS[i]}.`
          } ${fill(PLAN_WEEK_WHY, { zone: zoneName(zone), score: zoneScore(zone) })}`,
          steps: ZONE_TEXTS[zone].steps,
        })),
        {
          title: "Неделя 4. Закрепляем",
          focus: "Оставляем то, что сработало, и встраиваем это в обычную жизнь.",
          steps: [
            "Перечитай свои заметки за три недели: какие шаги дались легко и дали эффект?",
            "Выбери 2–3 привычки, которые хочешь оставить, и запиши их на видное место",
            arch.tips[0],
            arch.tips[1],
            "Пройди тест ещё раз и сравни индекс с сегодняшним",
          ],
        },
      ],
    },
    closing: [CLOSING[input.level] ?? CLOSING.mid, CLOSING_COMMON],
  };
}

function directParagraph(input: ReportInput): string {
  const answer = input.direct_answer;
  let t: string;
  if (input.direct_happy === null) t = DIRECT_TEXTS.unsure;
  else if (input.direct_happy) t = input.level === "low" ? DIRECT_TEXTS.happyLowIndex : DIRECT_TEXTS.happyConsistent;
  else t = input.level === "high" ? DIRECT_TEXTS.unhappyHighIndex : DIRECT_TEXTS.unhappyConsistent;
  return fill(t, { answer: answer.toLowerCase() });
}

/** Цитата ответов пользователя по зоне утечки и короткий вывод. */
function zoneAnswers(input: ReportInput, zone: string): string[] {
  const items = input.answers.filter((a) => a.block === "leak" && a.zone === zone && a.value !== null);
  if (items.length < 2) return [];
  const [x, y] = items as { question: string; answer: string; value: number }[];
  const verdict =
    x.value < 3 && y.value < 3 ? ZONE_VERDICT.both_low : Math.abs(x.value - y.value) >= 2 ? ZONE_VERDICT.mixed : ZONE_VERDICT.middle;
  return [
    fill(ZONE_ANSWERS, {
      q1: x.question,
      a1: x.answer.toLowerCase(),
      q2: y.question,
      a2: y.answer.toLowerCase(),
      verdict,
    }),
  ];
}

/** Самое сильное и самое слабое утверждение о жизни (блок life) — по ответам. */
function lifeAnchors(input: ReportInput): string | null {
  const life = input.answers.filter((a) => a.block === "life" && a.value !== null) as { question: string; value: number }[];
  if (life.length < 2) return null;
  const top = life.reduce((m, a) => (a.value > m.value ? a : m));
  const bottom = life.reduce((m, a) => (a.value < m.value ? a : m));
  if (top.value === bottom.value) {
    return "Твои ответы об удовлетворённости жизнью довольно ровные: нет одной сферы, которая резко выбивается вверх или вниз. Поэтому особенно полезно посмотреть на утечки — они покажут, где именно теряются силы.";
  }
  return `Сильнее всего ты согласился с утверждением «${top.question}» — это твоя опора, на неё можно рассчитывать. Слабее всего — с утверждением «${bottom.question}»: здесь индекс проседает сильнее всего, и к этому мы ещё вернёмся.`;
}
