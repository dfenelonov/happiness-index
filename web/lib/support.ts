// Контакты поддержки (претензии, возвраты, вопросы). SUPPORT_EMAIL обязателен в production.

export type Support = { email: string | null; telegram: string | null; telegramUrl: string | null };

export function support(env: Record<string, string | undefined> = process.env): Support {
  const email = env.SUPPORT_EMAIL?.trim() || null;
  const tg = env.SUPPORT_TELEGRAM?.trim().replace(/^@/, "").replace(/^https?:\/\/t\.me\//, "") || null;
  return { email, telegram: tg ? `@${tg}` : null, telegramUrl: tg ? `https://t.me/${tg}` : null };
}

/** Одна строка для писем и PDF. */
export function supportLine(s: Support = support()): string | null {
  const parts = [s.email, s.telegram ? `Telegram ${s.telegram}` : null].filter(Boolean);
  return parts.length ? `Вопросы и возвраты: ${parts.join(", ")}` : null;
}
