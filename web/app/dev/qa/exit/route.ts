import { seeOther } from "@/lib/http";
import { ANON_COOKIE } from "@/lib/cookies";
import { clearQa } from "@/lib/qa";

/** Удалить демо-данные и вернуть браузеру обычного анонимного посетителя. */
export async function POST() {
  await clearQa();
  const res = seeOther("/dev/qa");
  res.cookies.delete(ANON_COOKIE);
  return res;
}
