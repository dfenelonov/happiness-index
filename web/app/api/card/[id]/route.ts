import { questionnaire } from "@/lib/config";
import { storyCard } from "@/lib/images";
import { getResult } from "@/lib/results";

/** PNG 1080×1920 для сторис: индекс, тип, слоган, адрес сайта. Ответы на карточку не попадают. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await getResult(id);
  if (!r) return new Response("Not found", { status: 404 });
  const arch = questionnaire().archetypes.find((a) => a.id === r.archetype)!;
  const img = await storyCard({ index: r.index, archetype: arch.name, slogan: arch.slogan });
  const headers = new Headers(img.headers);
  headers.set("Cache-Control", "public, max-age=86400, immutable");
  if (new URL(req.url).searchParams.has("download")) headers.set("Content-Disposition", 'attachment; filename="happiness-index.png"');
  return new Response(img.body, { headers });
}
