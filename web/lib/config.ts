import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

// Конфиги читаются с диска один раз на процесс и проверяются схемой: ошибка в YAML роняет старт,
// а не всплывает посреди теста у пользователя.

const AXES = ["energy", "stability", "openness"] as const;
export type Axis = (typeof AXES)[number];
export const AXIS_IDS = AXES;

const Pole = z.enum(["high", "low"]);

const QuestionSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("direct"), text: z.string().min(1) }),
  z.object({ id: z.string(), kind: z.literal("life"), text: z.string().min(1), weight: z.number().positive().default(1) }),
  z.object({ id: z.string(), kind: z.literal("leak"), text: z.string().min(1), zone: z.string() }),
  z.object({
    id: z.string(),
    kind: z.literal("axis"),
    text: z.string().min(1),
    axis: z.enum(AXES),
    reverse: z.boolean().default(false),
  }),
]);
export type Question = z.infer<typeof QuestionSchema>;

const QuestionnaireSchema = z
  .object({
    version: z.number().int(),
    scale: z.object({
      min: z.literal(1),
      max: z.literal(5),
      labels: z.array(z.string()).length(5),
    }),
    direct_options: z
      .array(z.object({ id: z.string(), label: z.string(), happy: z.boolean().nullable() }))
      .min(2),
    questions: z.array(QuestionSchema).min(1),
    scoring: z.object({
      index: z.object({
        levels: z.array(z.object({ id: z.string(), min: z.number().int().min(0).max(100), name: z.string() })).min(1),
      }),
      axes: z.object({
        threshold: z.number().min(1).max(5),
        list: z.object({
          energy: z.object({ name: z.string(), high: z.string(), low: z.string() }),
          stability: z.object({ name: z.string(), high: z.string(), low: z.string() }),
          openness: z.object({ name: z.string(), high: z.string(), low: z.string() }),
        }),
      }),
      leaks: z.object({ count: z.number().int().min(1), tie_break_order: z.array(z.string()) }),
    }),
    zones: z.record(z.string(), z.object({ name: z.string(), leak: z.string() })),
    archetypes: z
      .array(
        z.object({
          id: z.string(),
          when: z.object({ energy: Pole, stability: Pole, openness: Pole }),
          name: z.string(),
          slogan: z.string(),
          description: z.string(),
        }),
      )
      .length(8),
    country: z.object({
      share_happy: z.number().min(0).max(1),
      period: z.string(),
      source_name: z.string(),
      source_url: z.string().url(),
      texts: z.record(z.string(), z.string()),
    }),
  })
  .superRefine((q, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    const ids = q.questions.map((x) => x.id);
    if (new Set(ids).size !== ids.length) issue("id вопросов должны быть уникальны");
    if (q.questions.filter((x) => x.kind === "direct").length !== 1) issue("нужен ровно один прямой вопрос (kind: direct)");
    if (!q.questions.some((x) => x.kind === "life")) issue("нужен хотя бы один вопрос kind: life (база индекса)");

    const zoneIds = Object.keys(q.zones);
    for (const x of q.questions) {
      if (x.kind === "leak" && !q.zones[x.zone]) issue(`вопрос ${x.id}: неизвестная зона ${x.zone}`);
    }
    for (const z of zoneIds) {
      if (!q.questions.some((x) => x.kind === "leak" && x.zone === z)) issue(`зона ${z}: нет вопросов`);
    }
    const tb = q.scoring.leaks.tie_break_order;
    if (tb.length !== zoneIds.length || !zoneIds.every((z) => tb.includes(z))) {
      issue("scoring.leaks.tie_break_order должен перечислять все зоны ровно по разу");
    }
    if (q.scoring.leaks.count > zoneIds.length) issue("scoring.leaks.count больше числа зон");

    for (const a of AXES) {
      if (!q.questions.some((x) => x.kind === "axis" && x.axis === a)) issue(`ось ${a}: нет вопросов`);
    }
    const combos = new Set(q.archetypes.map((a) => `${a.when.energy}/${a.when.stability}/${a.when.openness}`));
    if (combos.size !== 8) issue("архетипы должны покрывать все 8 сочетаний полюсов ровно по разу");
    const archIds = q.archetypes.map((a) => a.id);
    if (new Set(archIds).size !== archIds.length) issue("id архетипов должны быть уникальны");

    const levels = q.scoring.index.levels;
    if (levels[0]?.min !== 0) issue("первый уровень индекса должен начинаться с 0");
    for (let i = 1; i < levels.length; i++) {
      if (levels[i].min <= levels[i - 1].min) issue("уровни индекса должны идти по возрастанию min");
    }
    for (const o of q.direct_options) {
      if (!q.country.texts[o.id]) issue(`country.texts: нет текста для варианта ${o.id}`);
    }
  });
export type Questionnaire = z.infer<typeof QuestionnaireSchema>;

const Threshold = z.object({ name: z.string(), go: z.number().min(0).max(1), stop: z.number().min(0).max(1).nullable() });

const AppConfigSchema = z.object({
  site_name: z.string(),
  landing: z.object({ headline: z.string(), subheadline: z.string() }),
  pricing: z.object({
    variants_rub: z.array(z.number().int().positive()).min(1),
    refund_days: z.number().int().min(0),
  }),
  paywall: z.object({ title: z.string(), bullets: z.array(z.string()).min(1) }),
  fake_door: z.object({ name: z.string(), price_rub_month: z.number().int().positive(), pitch: z.string() }),
  percentile: z.object({ real_results_threshold: z.number().int().min(0) }),
  metrics: z.object({ completion: Threshold, share: Threshold, purchase: Threshold, subscription: Threshold }),
  report: z.object({
    max_attempts: z.number().int().min(1).max(5),
    attempt_timeout_seconds: z.number().positive(),
    low_index_threshold: z.number().int().min(0).max(100),
  }),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

function configDir() {
  return process.env.CONFIG_DIR ?? path.join(process.cwd(), "config");
}

function load<T>(file: string, schema: z.ZodType<T>): T {
  const full = path.join(configDir(), file);
  const parsed = schema.safeParse(parse(fs.readFileSync(full, "utf8")));
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(корень)"}: ${i.message}`).join("\n");
    throw new Error(`Ошибка в ${file}:\n${details}`);
  }
  return parsed.data;
}

export function parseQuestionnaire(raw: unknown): Questionnaire {
  return QuestionnaireSchema.parse(raw);
}

let cached: { questionnaire: Questionnaire; app: AppConfig } | null = null;

export function getConfig() {
  if (!cached) {
    cached = {
      questionnaire: load("questionnaire.yaml", QuestionnaireSchema),
      app: load("app.yaml", AppConfigSchema),
    };
  }
  return cached;
}

export const questionnaire = () => getConfig().questionnaire;
export const appConfig = () => getConfig().app;
