// Реквизиты продавца (Исполнитель в оферте, оператор ПДн) — из .env. Нужны ЮKassa: ФИО и ИНН видны
// на каждой странице (футер) и в документах. В production без них приложение не стартует (env-guard).

type Env = Record<string, string | undefined>;

export const SELLER_STATUSES = ["npd", "ip"] as const;
export type SellerStatus = (typeof SELLER_STATUSES)[number];

export type Seller = {
  name: string | null;
  inn: string | null;
  status: SellerStatus;
  ogrnip: string | null;
  address: string | null;
};

export function seller(env: Env = process.env): Seller {
  const v = (k: string) => env[k]?.trim() || null;
  return {
    name: v("SELLER_NAME"),
    inn: v("SELLER_INN"),
    status: env.SELLER_STATUS === "ip" ? "ip" : "npd",
    ogrnip: v("SELLER_OGRNIP"),
    address: v("SELLER_ADDRESS"),
  };
}

/** Контрольные цифры ИНН физлица (12 цифр) — ловит опечатки. */
export function validPersonalInn(inn: string): boolean {
  if (!/^\d{12}$/.test(inn)) return false;
  const d = [...inn].map(Number);
  const check = (w: number[]) => (w.reduce((s, x, i) => s + x * d[i], 0) % 11) % 10;
  return check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
}

/** Что не так с реквизитами для production. */
export function sellerProblems(env: Env = process.env): string[] {
  const s = seller(env);
  const problems: string[] = [];
  if (env.SELLER_STATUS && !(SELLER_STATUSES as readonly string[]).includes(env.SELLER_STATUS)) {
    problems.push(`SELLER_STATUS=${env.SELLER_STATUS}: допустимо ${SELLER_STATUSES.join(" | ")}`);
  }
  if (!s.name) problems.push("SELLER_NAME не задан: ФИО продавца нужно в оферте и футере");
  if (!s.inn || !validPersonalInn(s.inn)) problems.push("SELLER_INN не задан или некорректен (12 цифр ИНН физлица)");
  if (s.status === "ip" && !s.ogrnip) problems.push("SELLER_STATUS=ip: нужен SELLER_OGRNIP");
  return problems;
}

/** Строка реквизитов (именительный падеж): для оферты, политики и футера. Без реквизитов — null. */
export function sellerLine(s: Seller = seller()): string | null {
  if (!s.name || !s.inn) return null;
  if (s.status === "ip") {
    return [`ИП ${s.name}`, `ИНН ${s.inn}`, s.ogrnip && `ОГРНИП ${s.ogrnip}`, s.address && `адрес: ${s.address}`].filter(Boolean).join(", ");
  }
  return `${s.name}, ИНН ${s.inn}, плательщик налога на профессиональный доход (самозанятый)`;
}
