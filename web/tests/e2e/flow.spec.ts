import { expect, test } from "@playwright/test";
import { appConfig } from "../../lib/config";
import { ADMIN, answerQuestions, completeTest, dismissCookies } from "./helpers";

// цены — из config/app.yaml (одна цена или несколько вариантов A/B)
const PRICES = appConfig().pricing.variants_rub;
const PRICE = PRICES[0];

test.describe.configure({ mode: "serial" });

test("лендинг → тест (назад, продолжение после перезагрузки) → результат → оплата (мок) → отчёт → админка", async ({ page, browser }) => {
  await dismissCookies(page);

  // Лендинг
  await page.goto("/?utm_source=e2e&utm_campaign=launch");
  await expect(page.locator("h1")).toContainText("А какой у тебя?");
  await expect(page.getByText("Не является медицинской или психологической услугой")).toBeVisible();
  await page.getByTestId("start-test").click();

  // Тест: 5 ответов, перезагрузка — продолжаем с 6-го
  await answerQuestions(page, 1, 5);
  await expect(page.getByTestId("progress-label")).toHaveText("Вопрос 6 из 28");
  await page.reload();
  await expect(page.getByTestId("progress-label")).toHaveText("Вопрос 6 из 28");

  // «Назад» возвращает к предыдущему вопросу с сохранённым ответом
  await page.getByTestId("back").click();
  await expect(page.getByTestId("progress-label")).toHaveText("Вопрос 5 из 28");
  await expect(page.locator('[data-testid="answer-option"][aria-pressed="true"]')).toHaveCount(1);
  await answerQuestions(page, 5, 28);

  // Экран анализа → результат
  await page.waitForURL(/\/result\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  const resultUrl = page.url();
  await expect(page.getByTestId("index-value")).toHaveText(/^\d{1,3}$/);
  await expect(page.getByTestId("percentile")).toContainText("участников");
  await expect(page.getByTestId("archetype")).not.toBeEmpty();
  await expect(page.getByTestId("leaks").locator("li")).toHaveCount(3);
  await expect(page.getByTestId("country-line")).toContainText("%");
  await expect(page.getByTestId("share")).toBeVisible();
  const card = await page.request.get(resultUrl.replace("/result/", "/api/card/"));
  expect(card.headers()["content-type"]).toBe("image/png");

  // Пейволл всем владельцам; цена — из A/B, ?price= переопределяет
  await expect(page.getByTestId("price")).toHaveText(new RegExp(`^(${PRICES.join("|")}) ₽$`));
  await page.goto(`${resultUrl}?price=${PRICE}`);
  await expect(page.getByTestId("price")).toHaveText(`${PRICE} ₽`);
  await page.goto(resultUrl);
  await expect(page.getByTestId("price")).toHaveText(`${PRICE} ₽`); // закреплено в cookie

  // Шеринг — копирование ссылки
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByTestId("share-copy").click();
  await expect(page.getByTestId("share-copy")).toHaveText("Скопировано ✓");

  // Фейковая дверь
  await page.getByTestId("fake-door-open").first().click();
  const modal = page.getByTestId("fake-door-modal");
  await modal.getByLabel("Email").fill("tracker@example.ru");
  await modal.getByRole("checkbox").check();
  await modal.getByRole("button", { name: "Сообщить о запуске" }).click();
  await expect(modal).toContainText("Спасибо");
  await modal.getByRole("button", { name: "Хорошо" }).click();

  // Оплата через мок-кассу
  await page.getByTestId("buy").click();
  const form = page.getByTestId("checkout-form");
  await form.getByLabel("Email для чека").fill("buyer@example.ru");
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: new RegExp(`Оплатить ${PRICE}`) }).click();
  await page.waitForURL(/\/pay\/mock\//);
  await expect(page.getByTestId("mock-amount")).toHaveText(`${PRICE} ₽`);
  await page.getByTestId("mock-pay-success").click();

  // Отчёт
  await page.waitForURL(/\/report\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  await expect(page.getByTestId("report")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("План на 30 дней").first()).toBeVisible();
  const words = (await page.getByTestId("report").innerText()).split(/\s+/).filter(Boolean).length;
  expect(words).toBeGreaterThanOrEqual(1500);
  const pdf = await page.request.get(page.url().replace("/report/", "/api/report/") + "/pdf");
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");
  await page.getByTestId("fake-door-open").click(); // купил → клик «подписка»
  await page.keyboard.press("Escape");

  // Вернулся на результат — вместо пейволла ссылка на купленный разбор
  const reportUrl = page.url();
  await page.goto(resultUrl);
  await expect(page.getByTestId("paywall")).toHaveCount(0);
  await page.getByRole("link", { name: "Открыть мой разбор" }).click();
  await expect(page).toHaveURL(reportUrl);

  // Гость видит результат друга без пейволла
  const guest = await browser.newContext();
  const g = await guest.newPage();
  await g.goto(resultUrl);
  await expect(g.getByText("Это результат друга")).toBeVisible();
  await expect(g.getByTestId("paywall")).toHaveCount(0);
  await guest.close();

  // Админка
  const admin = await browser.newContext({ httpCredentials: ADMIN });
  const a = await admin.newPage();
  await a.goto("/admin");
  await expect(a.getByTestId("admin")).toBeVisible();
  for (const key of ["completion", "share", "purchase", "subscription"]) {
    await expect(a.getByTestId(`metric-${key}`)).toBeVisible();
  }
  await expect(a.getByTestId("metric-completion")).toHaveAttribute("data-color", "green");
  await expect(a.getByTestId("orders")).toContainText("buyer@example.ru");
  await expect(a.getByTestId("orders")).toContainText("оплачен");
  await expect(a.getByTestId("orders")).toContainText("e2e"); // utm_source с первого визита
  await expect(a.getByTestId("leads")).toContainText("tracker@example.ru");
  const csv = await a.request.get("/api/admin/export/orders");
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(await csv.text()).toContain("buyer@example.ru");
  await admin.close();
});

test("отказ в мок-кассе → заказ не оплачен, отчёт недоступен", async ({ page }) => {
  await dismissCookies(page);
  await completeTest(page);
  await page.getByTestId("buy").click();
  const form = page.getByTestId("checkout-form");
  await form.getByLabel("Email для чека").fill("fail@example.ru");
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: /Оплатить/ }).click();
  await page.waitForURL(/\/pay\/mock\//);
  await page.getByTestId("mock-pay-fail").click();
  await expect(page.getByTestId("payment-failed")).toBeVisible();
  const orderId = page.url().split("/order/")[1];
  await page.goto(`/report/${orderId}`);
  await expect(page).toHaveURL(new RegExp(`/order/${orderId}$`));
});

test("админка закрыта паролем", async ({ page }) => {
  const res = await page.goto("/admin");
  expect(res?.status()).toBe(401);
});

test("cookie-баннер: выбор запоминается", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Только необходимые" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Только необходимые" })).toHaveCount(0);
});
