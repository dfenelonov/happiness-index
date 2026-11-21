import { questionnaire } from "@/lib/config";
import { ogCard } from "@/lib/images";
import { getResult } from "@/lib/results";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await getResult(id);
  if (!r) return new Response("Not found", { status: 404 });
  const arch = questionnaire().archetypes.find((a) => a.id === r.archetype)!;
  return ogCard({ title: `Мой индекс счастья — ${r.index}. ${arch.name}`, subtitle: "А какой у тебя? Тест за 5 минут", index: r.index });
}
