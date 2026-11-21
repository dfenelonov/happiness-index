import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TestRunner, type ClientQuestion } from "@/components/TestRunner";
import { questionnaire } from "@/lib/config";

export const metadata: Metadata = { title: "QA: вопрос", robots: { index: false } };

const SECTIONS: Record<string, string> = { direct: "Для начала", life: "Твоя жизнь в целом", leak: "Из чего складывается твой день", axis: "Какой ты" };

/** Превью вопроса №n (или экрана анализа: /dev/qa/question/analysing) без сервера и без сохранения. */
export default async function QuestionPreview({ params }: { params: Promise<{ n: string }> }) {
  const { n } = await params;
  const q = questionnaire();
  const analysing = n === "analysing";
  const position = analysing ? q.questions.length - 1 : Number(n) - 1;
  if (!Number.isInteger(position) || position < 0 || position >= q.questions.length) notFound();
  const likert = q.scale.labels.map((label, i) => ({ value: q.scale.min + i, label }));
  const questions: ClientQuestion[] = q.questions.map((item) => ({
    id: item.id,
    text: item.text,
    section: SECTIONS[item.kind],
    options: item.kind === "direct" ? q.direct_options.map((o) => ({ value: o.id, label: o.label })) : likert,
  }));
  return <TestRunner questions={questions} storageKey="hi_qa_preview" preview={{ position, phase: analysing ? "analysing" : "question" }} />;
}
