import { NextResponse } from "next/server";
import { handleError, jsonError, readJson } from "@/lib/api";
import { TEST_COOKIE } from "@/lib/cookies";
import { logEvent } from "@/lib/events";
import { completeTest } from "@/lib/test-flow";
import { getVisitor } from "@/lib/visitor";

export async function POST(req: Request) {
  try {
    const visitor = await getVisitor();
    if (!visitor.anonId) return jsonError("Нет сессии", 401);
    const { testId } = await readJson(req);
    if (typeof testId !== "string") return jsonError("Неверный запрос");
    const { resultId, created } = await completeTest(testId, visitor.anonId);
    if (created) await logEvent("test_complete", visitor, { test_id: testId, result_id: resultId });
    const res = NextResponse.json({ resultId });
    res.cookies.delete(TEST_COOKIE);
    return res;
  } catch (e) {
    return handleError(e);
  }
}
