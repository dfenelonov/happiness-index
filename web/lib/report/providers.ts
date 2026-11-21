import fs from "node:fs";
import path from "node:path";
import type { ReportInput } from "./input";

// Внешние LLM. Получают только ReportInput (баллы и ответы), никаких email и id.

export interface LLMProvider {
  readonly name: string;
  /** Сырой ответ модели (ожидается JSON по схеме отчёта). */
  complete(system: string, user: string, signal: AbortSignal): Promise<string>;
}

export function loadPrompt(): string {
  return fs.readFileSync(path.join(process.cwd(), "prompts", "report.md"), "utf8");
}

export function buildMessages(input: ReportInput) {
  const prompt = loadPrompt();
  return { system: prompt, user: `Данные теста (JSON):\n${JSON.stringify(input, null, 2)}` };
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  constructor(
    private apiKey: string,
    private model = process.env.OPENAI_MODEL || "gpt-4.1-mini",
    private baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(system: string, user: string, signal: AbortSignal) {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.6,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }
}

export class YandexGPTProvider implements LLMProvider {
  readonly name = "yandexgpt";
  constructor(
    private apiKey: string,
    private folderId: string,
    private model = process.env.YANDEXGPT_MODEL || "yandexgpt/latest",
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(system: string, user: string, signal: AbortSignal) {
    const res = await this.fetchImpl("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
      method: "POST",
      signal,
      headers: { Authorization: `Api-Key ${this.apiKey}`, "x-folder-id": this.folderId, "Content-Type": "application/json" },
      body: JSON.stringify({
        modelUri: `gpt://${this.folderId}/${this.model}`,
        completionOptions: { stream: false, temperature: 0.6, maxTokens: 8000 },
        jsonObject: true,
        messages: [
          { role: "system", text: system },
          { role: "user", text: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`YandexGPT ${res.status}`);
    const data = (await res.json()) as { result?: { alternatives?: { message?: { text?: string } }[] } };
    return data.result?.alternatives?.[0]?.message?.text ?? "";
  }
}

/** LLM_PROVIDER=mock (по умолчанию) | openai | yandexgpt. null — сразу mock-шаблоны. */
export function getLLMProvider(): LLMProvider | null {
  const name = process.env.LLM_PROVIDER || "mock";
  if (name === "mock") return null;
  if (name === "openai") {
    if (!process.env.OPENAI_API_KEY) throw new Error("LLM_PROVIDER=openai: задай OPENAI_API_KEY");
    return new OpenAIProvider(process.env.OPENAI_API_KEY);
  }
  if (name === "yandexgpt") {
    const key = process.env.YANDEXGPT_API_KEY;
    const folder = process.env.YANDEXGPT_FOLDER_ID;
    if (!key || !folder) throw new Error("LLM_PROVIDER=yandexgpt: задай YANDEXGPT_API_KEY и YANDEXGPT_FOLDER_ID");
    return new YandexGPTProvider(key, folder);
  }
  throw new Error(`Неизвестный LLM_PROVIDER=${name}`);
}
