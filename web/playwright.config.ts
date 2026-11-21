import { defineConfig, devices } from "@playwright/test";

// Всё, что зависит от окружения, — через env (локально и в CI работает без правок):
//   E2E_HOST / E2E_PORT  — где поднять production-сервер (по умолчанию 127.0.0.1:3100)
//   E2E_BASE_URL         — тестировать уже запущенный сервер, свой не поднимать
//   E2E_ADMIN_PASSWORD   — пароль /admin (по умолчанию e2e-admin)
//   PW_REPORT_DIR        — папка HTML-отчёта (по умолчанию playwright-report)
const HOST = process.env.E2E_HOST ?? "127.0.0.1";
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://${HOST}:${PORT}`;
const DB = "file:./data/e2e.db";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: process.env.PW_REPORT_DIR ?? "playwright-report" }]],
  use: { baseURL: BASE_URL, locale: "ru-RU", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "e2e", testIgnore: /screenshots\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "screenshots", testMatch: /screenshots\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        // production-сборка (npm run build) с отдельной чистой базой и моками
        command: `rm -f ./data/e2e.db && node --import tsx scripts/migrate.ts && node --import tsx scripts/seed.ts && npx next start -H ${HOST} -p ${PORT}`,
        url: `${BASE_URL}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          DATABASE_URL: DB,
          APP_URL: BASE_URL,
          ADMIN_PASSWORD: process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin",
          PAYMENT_PROVIDER: "mock",
          LLM_PROVIDER: "mock",
          MAIL_PROVIDER: "mock",
          MOCK_WEBHOOK_SECRET: "e2e-secret",
          UNSAFE_SKIP_PRODUCTION_CHECKS: "true", // next start = production, а здесь моки
          SUPPORT_EMAIL: "support@example.ru",
        },
      },
});
