/**
 * Собирает docs/TEXTS_REVIEW.md — все пользовательские тексты теста одним файлом для вычитки.
 * Сравнивает с утверждённой Python-версией (../config/*.yaml) и помечает новое и изменённое.
 * Запуск: npm run texts:review
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { appConfig, questionnaire } from "../lib/config";

const REF_DIR = process.env.REF_CONFIG_DIR ?? path.join("..", "config");
const OUT = path.join("docs", "TEXTS_REVIEW.md");

type RefItem = { id: string; text: string };
const ref = fs.existsSync(path.join(REF_DIR, "questionnaire.yaml"))
  ? (parse(fs.readFileSync(path.join(REF_DIR, "questionnaire.yaml"), "utf8")) as Record<string, any>)
  : null;
const refApp = fs.existsSync(path.join(REF_DIR, "app.yaml"))
  ? (parse(fs.readFileSync(path.join(REF_DIR, "app.yaml"), "utf8")) as Record<string, any>)
  : null;

const refItems: RefItem[] = (ref?.blocks ?? []).flatMap((b: { items: RefItem[] }) => b.items);
const refById = new Map(refItems.map((i) => [i.id, i.text]));
const refTexts = new Map(refItems.map((i) => [i.text, i.id]));

const counts = { new: 0, changed: 0, same: 0 };
const NEW = "🆕 новый";
const CHANGED = "✏️ изменён";

function mark(current: string, old: string | undefined | null): string {
  if (old === undefined || old === null) {
    counts.new++;
    return NEW;
  }
  if (old.trim() !== current.trim()) {
    counts.changed++;
    return `${CHANGED}<br>было: «${old.trim()}»`;
  }
  counts.same++;
  return "";
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const q = questionnaire();
const app = appConfig();
const lines: string[] = [];
const push = (...l: string[]) => lines.push(...l);

// ── Вопросы ──
const KIND: Record<string, string> = { direct: "прямой", life: "жизнь (индекс)", leak: "утечка", axis: "ось типа" };
const qRows = q.questions.map((item, i) => {
  // сначала по id, иначе — тот же текст под другим id (оси типа были пунктами big5)
  const old = refById.get(item.id) ?? (refTexts.has(item.text) ? item.text : item.kind === "direct" ? refById.get("vciom_1") : undefined);
  const extra =
    item.kind === "leak" ? `зона: ${q.zones[item.zone].name}` : item.kind === "axis" ? `${q.scoring.axes.list[item.axis].name}${item.reverse ? ", обратный" : ""}` : "";
  return `| ${i + 1} | ${item.id} | ${KIND[item.kind]}${extra ? ` · ${extra}` : ""} | ${esc(item.text)} | ${mark(item.text, old)} |`;
});

const refLabels: string[] = ref?.scales?.agree5?.labels ?? [];
const refOptions = new Map<string, string>((ref?.scales?.vciom5?.options ?? []).map((o: { id: string; label: string }) => [o.id, o.label]));
const scaleRows = q.scale.labels.map((l, i) => `| ${i + 1} | ${esc(l)} | ${mark(l, refLabels[i])} |`);
const optionRows = q.direct_options.map((o) => `| ${o.id} | ${esc(o.label)} | ${mark(o.label, refOptions.get(o.id))} |`);

// ── Типы: сопоставляем по сочетанию полюсов (в Python-версии — N, у нас устойчивость = обратный N) ──
type RefArch = { E: string; N: string; O: string; id: string; name: string };
const refArch: RefArch[] = ref?.scoring?.archetype?.table ?? [];
const refArchText: Record<string, string> = ref?.texts?.archetypes ?? {};
const flip = (p: string) => (p === "high" ? "low" : "high");
const archBlocks = q.archetypes.map((a) => {
  const old = refArch.find((r) => r.E === a.when.energy && flip(r.N) === a.when.stability && r.O === a.when.openness);
  const poles = `энергия ${a.when.energy === "high" ? "↑" : "↓"} · устойчивость ${a.when.stability === "high" ? "↑" : "↓"} · открытость ${a.when.openness === "high" ? "↑" : "↓"}`;
  return [
    `### ${a.name}`,
    "",
    `\`${a.id}\` · ${poles}`,
    "",
    "| Поле | Текст | Статус |",
    "|---|---|---|",
    `| Название | ${esc(a.name)} | ${mark(a.name, old?.name)} |`,
    `| Слоган (карточка для сторис) | ${esc(a.slogan)} | ${mark(a.slogan, undefined)} |`,
    `| Описание | ${esc(a.description)} | ${mark(a.description, old ? refArchText[old.id] : undefined)} |`,
    "",
  ].join("\n");
});

// ── Утечки ──
const refDomains: Record<string, { name: string; leak: string }> = ref?.texts?.domains ?? {};
const zoneRows = Object.entries(q.zones).map(
  ([id, z]) => `| ${id} | ${esc(z.name)} | ${mark(z.name, refDomains[id]?.name)} | ${esc(z.leak)} | ${mark(z.leak, refDomains[id]?.leak)} |`,
);

// ── Строка сравнения со страной ──
const refCountry: Record<string, string> = refApp?.vciom_result_texts ?? {};
const countryRows = Object.entries(q.country.texts).map(([id, t]) => `| ${id} | ${esc(t)} | ${mark(t, refCountry[id] ?? undefined)} |`);

// ── Пейволл и фейковая дверь (в Python-версии были в шаблонах, не в конфиге — считаем новыми) ──
const price = app.pricing.variants_rub.join(" / ");
const paywallRows = [
  `| Заголовок | ${esc(app.paywall.title)} — {цена} ₽ (A/B: ${price}) | ${mark(app.paywall.title, undefined)} |`,
  ...app.paywall.bullets.map((b, i) => `| Пункт ${i + 1} | ${esc(b)} | ${mark(b, undefined)} |`),
  `| Подзаголовок | Почему именно «{утечка 1}», «{утечка 2}», «{утечка 3}» и что с этим делать человеку с типом «{тип}». | ${mark("x", undefined)} |`,
  `| Кнопка | Получить разбор за {цена} ₽ | ${mark("x", undefined)} |`,
  `| Под формой | Возврат в течение ${app.pricing.refund_days} дней, если разбор не понравится | ${mark("x", undefined)} |`,
];
const refFake = refApp?.fake_door ?? {};
const fakeRows = [
  `| Название | ${esc(app.fake_door.name)} — ${app.fake_door.price_rub_month} ₽/мес | ${mark(`${app.fake_door.name} ${app.fake_door.price_rub_month}`, refFake.name ? `${refFake.name} ${refFake.price_rub_month}` : undefined)} |`,
  `| Описание | ${esc(app.fake_door.pitch)} | ${mark(app.fake_door.pitch, undefined)} |`,
];

const summary = () =>
  `Итого: **${counts.new}** новых, **${counts.changed}** изменённых, ${counts.same} без изменений.`;

push(
  "# Тексты на вычитку",
  "",
  "Все тексты, которые видит человек в тесте и на результате. Файл собран скриптом `npm run texts:review` из",
  "`config/questionnaire.yaml` и `config/app.yaml` и сравнён с утверждённой Python-версией (`../config/`).",
  "",
  `- ${NEW} — текста не было в утверждённой версии`,
  `- ${CHANGED} — текст отличается, рядом — как было`,
  "- без пометки — как в утверждённой версии",
  "",
  "Править тексты — в YAML (пути указаны в каждом разделе), затем `npm run texts:review`, чтобы обновить этот файл.",
  "",
  "SUMMARY_PLACEHOLDER",
  "",
  "## 1. Вопросы (28) — `config/questionnaire.yaml` → `questions`",
  "",
  "| № | id | Блок | Текст | Статус |",
  "|---|---|---|---|---|",
  ...qRows,
  "",
  "### Шкала ответов — `scale.labels`",
  "",
  "| Балл | Подпись | Статус |",
  "|---|---|---|",
  ...scaleRows,
  "",
  "### Варианты прямого вопроса — `direct_options`",
  "",
  "| id | Подпись | Статус |",
  "|---|---|---|",
  ...optionRows,
  "",
  "## 2. Типы личности (8) — `config/questionnaire.yaml` → `archetypes`",
  "",
  ...archBlocks,
  "## 3. Утечки счастья — `config/questionnaire.yaml` → `zones`",
  "",
  "| id | Название зоны | Статус | Текст утечки | Статус |",
  "|---|---|---|---|---|",
  ...zoneRows,
  "",
  "### Строка сравнения с Россией — `country.texts`",
  "",
  `\`{happy}\` = ${Math.round(q.country.share_happy * 100)}% (${q.country.source_name}, ${q.country.period}).`,
  "",
  "| Ответ | Текст | Статус |",
  "|---|---|---|",
  ...countryRows,
  "",
  "## 4. Пейволл — `config/app.yaml` → `paywall` (подзаголовок и кнопка — `components/Paywall.tsx`)",
  "",
  "| Элемент | Текст | Статус |",
  "|---|---|---|",
  ...paywallRows,
  "",
  "### Фейковая дверь — `config/app.yaml` → `fake_door`",
  "",
  "| Элемент | Текст | Статус |",
  "|---|---|---|",
  ...fakeRows,
  "",
  "## Не вошло в этот файл",
  "",
  "- Шаблоны платного отчёта (mock) — `lib/report/mock-texts.ts`. Все тексты новые, около 3 000 слов.",
  "- Лендинг и FAQ — `app/page.tsx`, `config/app.yaml` → `landing`.",
  "- Юридические шаблоны — `lib/legal.ts`.",
  "",
);

const text = lines.join("\n").replace("SUMMARY_PLACEHOLDER", summary());
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text);
console.log(`${OUT}: ${summary().replace(/\*/g, "")}${ref ? "" : " (референс ../config не найден — всё помечено новым)"}`);
