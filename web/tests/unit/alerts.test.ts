import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { alert, checkStuckReports, record5xx, resetAlertState } from "@/lib/alerts";
import { schema } from "@/lib/db";
import { MOCK_SIGNATURE_HEADER, signMockWebhook } from "@/lib/payments/mock";
import { POST as webhook } from "@/app/api/webhooks/payment/route";
import { freshDb } from "./db";

const TG = { TELEGRAM_ALERT_BOT_TOKEN: "123:abc", TELEGRAM_ALERT_CHAT_ID: "42" };
let db: Awaited<ReturnType<typeof freshDb>>;
let logged: string[];

beforeEach(async () => {
  db = await freshDb();
  resetAlertState();
  logged = [];
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void logged.push(String(line)));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  delete process.env.TELEGRAM_ALERT_BOT_TOKEN;
  delete process.env.TELEGRAM_ALERT_CHAT_ID;
  delete process.env.PAYMENT_PROVIDER;
});

const alerts = () => logged.filter((l) => l.includes('"event":"alert"')).map((l) => JSON.parse(l));

describe("алерты", () => {
  it("в Telegram на chat id, если заданы токен и чат", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    expect(await alert("k", "текст", { env: TG, fetchImpl: fetchImpl as unknown as typeof fetch })).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: "42", text: "⚠️ Индекс счастья: текст" });
  });

  it("без токена — только в лог", async () => {
    const fetchImpl = vi.fn();
    await alert("k", "только лог", { env: {}, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(alerts()).toEqual([{ event: "alert", key: "k", message: "только лог" }]);
  });

  it("один повод — не чаще раза в throttle; сбой Telegram не бросает", async () => {
    const failing = vi.fn(async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await alert("same", "1", { env: TG, fetchImpl: failing, now: 0, throttleMs: 1000 })).toBe(true);
    expect(await alert("same", "2", { env: TG, fetchImpl: failing, now: 500, throttleMs: 1000 })).toBe(false);
    expect(await alert("same", "3", { env: TG, fetchImpl: failing, now: 1500, throttleMs: 1000 })).toBe(true);
  });

  it("всплеск 5xx: алерт с 10-й ошибки за 5 минут, старые ошибки выпадают из окна", () => {
    for (let i = 0; i < 9; i++) record5xx(i * 1000, { env: {} });
    expect(alerts()).toHaveLength(0);
    record5xx(10_000, { env: {} });
    expect(alerts()[0]).toMatchObject({ key: "5xx_spike" });
    resetAlertState();
    logged = [];
    for (let i = 0; i < 9; i++) record5xx(i * 60_000, { env: {} }); // растянуто на 9 минут
    record5xx(10 * 60_000, { env: {} });
    expect(alerts()).toHaveLength(0);
  });

  it("оплачен, а отчёта нет дольше 10 минут — алерт по заказу; готовый или свежий — нет", async () => {
    const order = (id: string, minutesAgo: number) => ({
      id,
      resultId: "r",
      priceVariant: 690,
      amountRub: 690,
      email: "a@b.ru",
      status: "paid" as const,
      provider: "mock",
      providerPaymentId: `p_${id}`,
      paidAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    });
    await db.insert(schema.orders).values([order("old-no-report", 15), order("old-ready", 15), order("fresh", 2)]);
    await db.insert(schema.reports).values({ orderId: "old-ready", status: "ready" });
    expect(await checkStuckReports({ env: {} })).toEqual(["old-no-report"]);
    expect(alerts()[0].key).toBe("stuck_report:old-no-report");
  });

  it("вебхук: неверная подпись → алерт; платёж без заказа → алерт", async () => {
    const body = JSON.stringify({ paymentId: "mock_unknown", status: "succeeded", amountRub: 690 });
    const bad = await webhook(new Request("http://x/api/webhooks/payment", { method: "POST", body, headers: { [MOCK_SIGNATURE_HEADER]: "bad" } }));
    expect(bad.status).toBe(400);
    const ok = await webhook(new Request("http://x/api/webhooks/payment", { method: "POST", body, headers: { [MOCK_SIGNATURE_HEADER]: signMockWebhook(body) } }));
    expect(ok.status).toBe(200);
    expect(alerts().map((a) => a.key)).toEqual(["webhook_rejected", "payment_without_order:mock_unknown"]);
    expect(JSON.stringify(alerts())).not.toContain("@"); // без email
    await db.run(sql`select 1`);
  });
});
