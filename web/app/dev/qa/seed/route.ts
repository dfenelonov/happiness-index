import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { ANON_COOKIE, YEAR_SECONDS } from "@/lib/cookies";
import { QA_PREFIX, seedQa } from "@/lib/qa";

/** Создать демо-данные и сделать этот браузер их владельцем (anon_id «qa-…», вне метрик). */
export async function POST(req: NextRequest) {
  const anonId = `${QA_PREFIX}${randomUUID()}`;
  await seedQa(anonId);
  const res = NextResponse.redirect(new URL("/dev/qa", req.nextUrl.origin), 303);
  res.cookies.set(ANON_COOKIE, anonId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: YEAR_SECONDS });
  return res;
}
