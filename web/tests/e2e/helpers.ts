import { expect, type Page } from "@playwright/test";

export const ADMIN = { username: "admin", password: process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin" };

/** Скрыть cookie-баннер (выбор «только необходимые»), чтобы он не перекрывал кнопки. */
export async function dismissCookies(page: Page) {
  await page.addInitScript(() => localStorage.setItem("hi_cookie_consent", "necessary"));
}

/** Ответить на вопросы с from по to (номера с 1). Вариант выбирается по номеру вопроса. */
export async function answerQuestions(page: Page, from: number, to: number, total = 28) {
  for (let n = from; n <= to; n++) {
    await expect(page.getByTestId("progress-label")).toHaveText(`Вопрос ${n} из ${total}`);
    const options = page.getByTestId("answer-option");
    const k = await options.count();
    await options.nth(n % k).click();
  }
}

export async function completeTest(page: Page) {
  await page.goto("/test");
  await answerQuestions(page, 1, 28);
  await page.waitForURL(/\/result\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  return page.url();
}
