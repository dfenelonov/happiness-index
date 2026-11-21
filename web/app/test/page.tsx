import type { Metadata } from "next";
import { TestRunner, type ClientQuestion } from "@/components/TestRunner";
import { questionnaire } from "@/lib/config";

export const metadata: Metadata = { title: "Тест — Индекс счастья", robots: { index: false } };

const SECTIONS: Record<string, string> = {
  direct: "Для начала",
  life: "Твоя жизнь в целом",
  leak: "Из чего складывается твой день",
  axis: "Какой ты",
};

export default function TestPage() {
  const q = questionnaire();
  const likert = q.scale.labels.map((label, i) => ({ value: q.scale.min + i, label }));
  const questions: ClientQuestion[] = q.questions.map((item) => ({
    id: item.id,
    text: item.text,
    section: SECTIONS[item.kind],
    options: item.kind === "direct" ? q.direct_options.map((o) => ({ value: o.id, label: o.label })) : likert,
  }));
  return <TestRunner questions={questions} storageKey={`hi_test_v${q.version}`} />;
}
