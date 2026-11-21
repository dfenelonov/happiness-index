import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { handleError, jsonError, readJson } from "@/lib/api";
import { TEST_COOKIE } from "@/lib/cookies";
import { logEvent } from "@/lib/events";
import { startOrResume } from "@/lib/test-flow";
import { getVisitor } from "@/lib/visitor";

export async function POST(req: Request) {
  try {
    const visitor = await getVisitor();
    if (!visitor.anonId) return jsonError("Нет сессии", 401);
    const body = await readJson(req);
    const jar = await cookies();
    const candidate = (typeof body.testId === "string" && body.testId) || jar.get(TEST_COOKIE)?.value || null;
    const res = await startOrResume(visitor.anonId, visitor.sessionId, candidate);
    if (res.created) await logEvent("test_start", visitor, { test_id: res.testId });
    const out = NextResponse.json({ testId: res.testId, answers: res.answers, resumed: !res.created });
    out.cookies.set(TEST_COOKIE, res.testId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 });
    return out;
  } catch (e) {
    return handleError(e);
  }
}
