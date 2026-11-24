import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, answerQuestions, dismissCookies } from "./helpers";

// Скриншоты всех экранов → docs/screenshots. Запуск: npm run build && npm run screenshots

const DIR = "docs/screenshots";
fs.mkdirSync(DIR, { recursive: true });
const shot = (page: Page, name: string, fullPage = true) => page.screenshot({ path: `${DIR}/${name}.png`, fullPage });

test.use({ viewport: { width: 1440, height: 900 } });

test("скриншоты экранов", async ({ page, browser }) => {
  test.setTimeout(180_000);

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Принять" })).toBeVisible();
  await shot(page, "01-landing-cookie-banner", false);
  await page.getByRole("button", { name: "Только необходимые" }).click();
  await shot(page, "02-landing");

  await page.goto("/test");
  await answerQuestions(page, 1, 1);
  await expect(page.getByTestId("progress-label")).toHaveText("Вопрос 2 из 28");
  await shot(page, "03-test-question", false);
  await answerQuestions(page, 2, 27);
  await expect(page.getByTestId("progress-label")).toHaveText("Вопрос 28 из 28"); // иначе клик уходит в переход между вопросами
  await page.getByTestId("answer-option").nth(3).click();
  await expect(page.getByTestId("analysing")).toBeVisible();
  await shot(page, "04-analysing", false);
  await page.waitForURL(/\/result\//, { timeout: 20_000 });
  const resultId = page.url().split("/result/")[1];
  await page.waitForTimeout(1600); // анимация шкалы
  await shot(page, "05-result");

  await page.getByTestId("paywall").scrollIntoViewIfNeeded();
  await page.getByTestId("buy").click();
  await shot(page, "06-paywall-checkout", false);

  await page.getByTestId("fake-door-open").first().click();
  await shot(page, "07-fake-door-modal", false);
  await page.getByRole("button", { name: "Закрыть" }).click();

  const form = page.getByTestId("checkout-form");
  await form.getByLabel("Email для чека").fill("demo@example.ru");
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: /Оплатить/ }).click();
  await page.waitForURL(/\/pay\/mock\//);
  await shot(page, "08-mock-kassa", false);
  await page.getByTestId("mock-pay-success").click();
  await page.waitForURL(/\/report\//);
  await expect(page.getByTestId("report")).toBeVisible({ timeout: 20_000 });
  await shot(page, "09-report");

  const card = await page.request.get(`/api/card/${resultId}`);
  if (card.ok()) fs.writeFileSync(`${DIR}/10-story-card.png`, await card.body());

  await page.goto("/legal/offer");
  await shot(page, "11-legal-offer", false);

  const ctx = await browser.newContext({ httpCredentials: ADMIN, viewport: { width: 1440, height: 900 } });
  const admin = await ctx.newPage();
  await dismissCookies(admin);
  await admin.goto("/admin");
  await shot(admin, "12-admin");
  await ctx.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const m = await mobile.newPage();
  await dismissCookies(m);
  await m.goto("/");
  await shot(m, "13-landing-mobile", false);
  await m.goto("/test");
  await expect(m.getByTestId("question-text")).toBeVisible();
  await shot(m, "14-test-mobile", false);
  await mobile.close();
});
