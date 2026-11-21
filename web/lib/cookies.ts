// Имена cookie и сроки — общие для middleware и серверного кода.
export const ANON_COOKIE = "hi_anon"; // посетитель, 1 год
export const SESSION_COOKIE = "hi_sess"; // сессия браузера (без срока)
export const UTM_COOKIE = "hi_utm"; // first-touch UTM + реферер, 1 год
export const TEST_COOKIE = "hi_test"; // незавершённое прохождение
export const YEAR_SECONDS = 365 * 24 * 3600;

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
export type Attribution = Partial<Record<(typeof UTM_KEYS)[number] | "referrer", string>>;

export function parseAttribution(raw?: string | null): Attribution {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Attribution) : {};
  } catch {
    return {};
  }
}
