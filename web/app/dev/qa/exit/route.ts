import { NextResponse, type NextRequest } from "next/server";
import { ANON_COOKIE } from "@/lib/cookies";
import { clearQa } from "@/lib/qa";

/** Удалить демо-данные и вернуть браузеру обычного анонимного посетителя. */
export async function POST(req: NextRequest) {
  await clearQa();
  const res = NextResponse.redirect(new URL("/dev/qa", req.nextUrl.origin), 303);
  res.cookies.delete(ANON_COOKIE);
  return res;
}
