import { EXPORTS, toCsv } from "@/lib/admin-data";

export const dynamic = "force-dynamic";

/** CSV-выгрузка (basic auth — в middleware). */
export async function GET(_req: Request, { params }: { params: Promise<{ table: string }> }) {
  const { table } = await params;
  const load = EXPORTS[table as keyof typeof EXPORTS];
  if (!load) return new Response("Not found", { status: 404 });
  const csv = "﻿" + toCsv((await load()) as Record<string, unknown>[]);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${table}-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
