import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const DB = "file:./data/e2e.db";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, locale: "ru-RU", trace: "retain-on-failure" },
  projects: [
    { name: "e2e", testIgnore: /screenshots\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "screenshots", testMatch: /screenshots\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    // e2e гоняется на production-сборке (npm run build) с отдельной базой и моками
    command: `rm -f ./data/e2e.db && node --import tsx scripts/migrate.ts && node --import tsx scripts/seed.ts && npx next start -H 127.0.0.1 -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: DB,
      APP_URL: `http://127.0.0.1:${PORT}`,
      ADMIN_PASSWORD: "e2e-admin",
      PAYMENT_PROVIDER: "mock",
      LLM_PROVIDER: "mock",
      MAIL_PROVIDER: "mock",
      MOCK_WEBHOOK_SECRET: "e2e-secret",
    },
  },
});
