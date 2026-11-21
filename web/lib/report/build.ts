import type { ReportInput } from "./input";
import { generateMockReport } from "./mock";
import { buildMessages, type LLMProvider } from "./providers";
import { ReportSchema, type Report } from "./schema";

export type BuildOutcome = { report: Report; provider: string; isFallback: boolean; attempts: number };

/** Достаёт JSON из ответа модели: голый объект или в ```-блоке. */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : raw).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("в ответе нет JSON");
  return JSON.parse(text.slice(start, end + 1));
}

export type BuildOptions = {
  maxAttempts: number;
  timeoutMs: number;
  pauseMs?: number;
  /** Перед каждой попыткой (номер с 1) — для прогресса и «пульса» генерации. */
  onAttempt?: (attempt: number) => Promise<void> | void;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Отчёт от внешней LLM: валидация zod, повтор с паузой при ошибке, потом fallback на mock-шаблоны.
 * Утечки в ответе должны совпадать с утечками пользователя — иначе это чужой отчёт.
 * Время каждой попытки пишется в лог (event: llm_attempt) — по нему подбирается таймаут.
 */
export async function buildReport(input: ReportInput, provider: LLMProvider | null, opts: BuildOptions): Promise<BuildOutcome> {
  if (!provider) return { report: generateMockReport(input), provider: "mock", isFallback: false, attempts: 0 };
  const { system, user } = buildMessages(input);
  const sleep = opts.sleep ?? defaultSleep;
  let attempts = 0;
  while (attempts < opts.maxAttempts) {
    attempts++;
    if (attempts > 1 && opts.pauseMs) await sleep(opts.pauseMs);
    await opts.onAttempt?.(attempts);
    const started = Date.now();
    try {
      const raw = await provider.complete(system, user, AbortSignal.timeout(opts.timeoutMs));
      const report = ReportSchema.parse(extractJson(raw));
      if (report.leaks.map((l) => l.zone).join() !== input.leaks.join()) throw new Error("утечки не совпадают с входом");
      logAttempt(provider.name, attempts, Date.now() - started, true);
      return { report, provider: provider.name, isFallback: false, attempts };
    } catch (e) {
      logAttempt(provider.name, attempts, Date.now() - started, false, (e as Error).message);
    }
  }
  return { report: generateMockReport(input), provider: provider.name, isFallback: true, attempts };
}

function logAttempt(provider: string, attempt: number, ms: number, ok: boolean, error?: string) {
  const line = JSON.stringify({ event: "llm_attempt", provider, attempt, ms, ok, ...(error ? { error: error.slice(0, 200) } : {}) });
  if (ok) console.info(line);
  else console.warn(line);
}
