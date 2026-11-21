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

/**
 * Отчёт от внешней LLM: валидация zod, повтор при ошибке, потом fallback на mock-шаблоны.
 * Утечки в ответе должны совпадать с утечками пользователя — иначе это чужой отчёт.
 */
export async function buildReport(
  input: ReportInput,
  provider: LLMProvider | null,
  opts: { maxAttempts: number; timeoutMs: number },
): Promise<BuildOutcome> {
  if (!provider) return { report: generateMockReport(input), provider: "mock", isFallback: false, attempts: 0 };
  const { system, user } = buildMessages(input);
  let attempts = 0;
  for (; attempts < opts.maxAttempts; ) {
    attempts++;
    try {
      const raw = await provider.complete(system, user, AbortSignal.timeout(opts.timeoutMs));
      const report = ReportSchema.parse(extractJson(raw));
      if (report.leaks.map((l) => l.zone).join() !== input.leaks.join()) throw new Error("утечки не совпадают с входом");
      return { report, provider: provider.name, isFallback: false, attempts };
    } catch (e) {
      console.warn(`LLM ${provider.name}: попытка ${attempts} не удалась: ${(e as Error).message}`);
    }
  }
  return { report: generateMockReport(input), provider: provider.name, isFallback: true, attempts };
}
