import { sql } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  getConfig();
  await getDb().run(sql`select 1`);
  return Response.json({ ok: true });
}
