import { randomUUID } from "node:crypto";
import { seeOther } from "@/lib/http";
import { ANON_COOKIE, YEAR_SECONDS } from "@/lib/cookies";
import { QA_PREFIX, seedQa } from "@/lib/qa";

/** Создать демо-данные и сделать этот браузер их владельцем (anon_id «qa-…», вне метрик). */
export async function POST() {
  const anonId = `${QA_PREFIX}${randomUUID()}`;
  await seedQa(anonId);
  const res = seeOther("/dev/qa");
  res.cookies.set(ANON_COOKIE, anonId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: YEAR_SECONDS });
  return res;
}
