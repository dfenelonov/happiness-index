/**
 * HTTP-smoke без сетевого порта: production-обработчик Next вызывается в процессе через фейковый
 * сокет. Для сред, где нельзя слушать порт и запускать браузер (CI-песочницы). Полный e2e —
 * Playwright (npm run test:e2e). Запуск: npm run build && npm run smoke
 */
import fs from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import next from "next";
import { MOCK_SIGNATURE_HEADER, signMockWebhook } from "../../lib/payments/mock";

type Res = { status: number; headers: Record<string, string[]>; body: Buffer; text: string };

const jar = new Map<string, string>();
let handler: ReturnType<ReturnType<typeof next>["getRequestHandler"]>;

function parseRaw(raw: Buffer): Res {
  const sep = raw.indexOf("\r\n\r\n");
  const head = raw.subarray(0, sep).toString("latin1").split("\r\n");
  const status = Number(head[0].split(" ")[1]);
  const headers: Record<string, string[]> = {};
  for (const line of head.slice(1)) {
    const i = line.indexOf(":");
    const k = line.slice(0, i).toLowerCase();
    (headers[k] ??= []).push(line.slice(i + 1).trim());
  }
  let body = raw.subarray(sep + 4);
  if (headers["transfer-encoding"]?.[0] === "chunked") {
    const parts: Buffer[] = [];
    let pos = 0;
    for (;;) {
      const eol = body.indexOf("\r\n", pos);
      const size = parseInt(body.subarray(pos, eol).toString(), 16);
      if (!size) break;
      parts.push(body.subarray(eol + 2, eol + 2 + size));
      pos = eol + 2 + size + 2;
    }
    body = Buffer.concat(parts);
  }
  return { status, headers, body, text: body.toString("utf8") };
}

async function call(method: string, url: string, opts: { body?: string; headers?: Record<string, string>; auth?: string } = {}): Promise<Res> {
  const out: Buffer[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      out.push(Buffer.from(chunk));
      cb();
    },
  });
  const req = new IncomingMessage(socket as never);
  req.method = method;
  req.url = url;
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  req.headers = {
    host: "hi.test",
    ...(cookie ? { cookie } : {}),
    ...(opts.body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(opts.body)) } : {}),
    ...(opts.auth ? { authorization: `Basic ${Buffer.from(opts.auth).toString("base64")}` } : {}),
    ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  };
  if (opts.body !== undefined) req.push(opts.body);
  req.push(null);
  req.complete = true;
  const res = new ServerResponse(req);
  res.assignSocket(socket as never);
  socket.on("drain", () => res.emit("drain")); // это делает http.Server, которого здесь нет
  const done = new Promise<void>((resolve) => res.on("finish", () => resolve()));
  const hang = setTimeout(() => {
    console.error(`зависло: ${method} ${url}`);
    process.exit(1);
  }, 30_000);
  await handler(req, res);
  await done;
  clearTimeout(hang);
  const parsed = parseRaw(Buffer.concat(out));
  for (const c of parsed.headers["set-cookie"] ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    const value = pair.slice(i + 1);
    if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || value === "") jar.delete(pair.slice(0, i));
    else jar.set(pair.slice(0, i), value);
  }
  return parsed;
}

const json = (r: Res) => JSON.parse(r.text);
let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const app = next({ dev: false, dir: process.cwd() });
  await app.prepare();
  handler = app.getRequestHandler();

  let r = await call("GET", "/?utm_source=smoke&utm_campaign=night");
  check("лендинг 200", r.status === 200 && r.text.includes("А какой у тебя?"));
  check("лендинг: дисклеймер и FAQ", r.text.includes("Не является медицинской или психологической услугой") && r.text.includes("Частые вопросы"));
  check("cookie посетителя, сессии, цены, UTM", ["hi_anon", "hi_sess", "hi_price", "hi_utm"].every((k) => jar.has(k)), [...jar.keys()].join(","));
  check("visit (клиентское событие)", (await call("POST", "/api/events", { body: JSON.stringify({ name: "visit" }) })).status === 204);
  check("неизвестное клиентское событие отклоняется", (await call("POST", "/api/events", { body: JSON.stringify({ name: "payment_success" }) })).status === 400);

  r = await call("GET", "/test");
  check("страница теста 200", r.status === 200);
  r = await call("POST", "/api/test/start", { body: "{}" });
  const { testId } = json(r);
  check("старт теста", r.status === 200 && !!testId);

  const { questionnaire } = await import("../../lib/config");
  const q = questionnaire();
  let n = 0;
  for (const item of q.questions) {
    n++;
    const value = item.kind === "direct" ? "rather_yes" : ((n % 5) + 1);
    r = await call("POST", "/api/answers", { body: JSON.stringify({ testId, questionId: item.id, value }) });
    if (r.status !== 200) break;
    if (n === 5) {
      const resumed = json(await call("POST", "/api/test/start", { body: JSON.stringify({ testId }) }));
      check("продолжение после перезагрузки: тот же тест и 5 ответов", resumed.testId === testId && Object.keys(resumed.answers).length === 5);
    }
  }
  check(`ответы на ${q.questions.length} вопросов сохранены`, r.status === 200);
  check("ответ вне шкалы → 400", (await call("POST", "/api/answers", { body: JSON.stringify({ testId, questionId: "life_1", value: 9 }) })).status === 400);

  r = await call("POST", "/api/test/complete", { body: JSON.stringify({ testId }) });
  const { resultId } = json(r);
  check("завершение → результат", r.status === 200 && !!resultId);

  r = await call("GET", `/result/${resultId}`);
  check("страница результата 200", r.status === 200, String(r.status));
  check("результат: индекс, перцентиль, тип, утечки, ВЦИОМ", ["из 100", "участников", "Тип личности", "Три главные утечки", "россиян"].every((s) => r.text.includes(s)));
  check("пометка о модельном распределении, пока настоящих результатов мало", r.text.includes("модельным распределением"));
  check("пейволл и фейковая дверь у владельца", r.text.includes('data-testid="paywall"') && r.text.includes('data-testid="fake-door"'));
  r = await call("GET", `/result/${resultId}?price=990`);
  check("?price=990 переопределяет цену", r.text.includes(">990<!-- --> ₽") || r.text.includes("990 ₽"));

  r = await call("GET", `/api/card/${resultId}`);
  if (process.env.SMOKE_SAVE_IMAGES) {
    fs.mkdirSync("docs/screenshots", { recursive: true });
    fs.writeFileSync("docs/screenshots/10-story-card.png", r.body);
  }
  check("карточка 1080×1920 PNG", r.status === 200 && r.headers["content-type"]?.[0] === "image/png" && r.body.readUInt32BE(16) === 1080 && r.body.readUInt32BE(20) === 1920);
  r = await call("GET", `/api/og/${resultId}`);
  check("OG 1200×630 PNG", r.status === 200 && r.body.readUInt32BE(16) === 1200 && r.body.readUInt32BE(20) === 630);
  r = await call("GET", "/api/og");
  check("OG лендинга", r.status === 200);
  if (process.env.SMOKE_SAVE_IMAGES) fs.writeFileSync("docs/screenshots/15-og-landing.png", r.body);
  check("share_click", (await call("POST", "/api/events", { body: JSON.stringify({ name: "share_click", props: { channel: "telegram", result_id: resultId } }) })).status === 204);
  check("paywall_view", (await call("POST", "/api/events", { body: JSON.stringify({ name: "paywall_view", props: { result_id: resultId } }) })).status === 204);
  check("subscription_click", (await call("POST", "/api/events", { body: JSON.stringify({ name: "subscription_click", props: { source: "result", result_id: resultId } }) })).status === 204);
  r = await call("POST", "/api/leads", { body: JSON.stringify({ email: "lead@example.ru", consent: true, source: "result", resultId }) });
  check("email фейковой двери", r.status === 200);
  check("email без согласия → 400", (await call("POST", "/api/leads", { body: JSON.stringify({ email: "x@example.ru", consent: false }) })).status === 400);

  check("заказ без оферты → 400", (await call("POST", "/api/checkout", { body: JSON.stringify({ resultId, email: "b@example.ru", offerAccepted: false }) })).status === 400);
  r = await call("POST", "/api/checkout", { body: JSON.stringify({ resultId, email: "buyer@example.ru", offerAccepted: true }) });
  const checkout = json(r);
  check("checkout → ссылка на мок-кассу", r.status === 200 && checkout.confirmationUrl?.startsWith("/pay/mock/"));
  r = await call("GET", checkout.confirmationUrl);
  check("мок-касса 200, сумма 990 ₽", r.status === 200 && r.text.includes("990") && r.text.includes("Оплатить успешно"));

  r = await call("GET", `/report/${checkout.orderId}`);
  check("отчёт до оплаты → редирект на заказ", r.status === 307 && r.headers.location?.[0]?.includes(`/order/${checkout.orderId}`));

  // Кнопка мок-кассы шлёт вебхук по HTTP на свой адрес; без порта отправляем его так же, напрямую.
  const paymentId = checkout.confirmationUrl.split("/").pop();
  const body = JSON.stringify({ paymentId, status: "succeeded", amountRub: 990 });
  check("вебхук с неверной подписью → 400", (await call("POST", "/api/webhooks/payment", { body, headers: { [MOCK_SIGNATURE_HEADER]: "bad" } })).status === 400);
  r = await call("POST", "/api/webhooks/payment", { body, headers: { [MOCK_SIGNATURE_HEADER]: signMockWebhook(body) } });
  check("вебхук успешной оплаты", r.status === 200);
  check("повтор вебхука — 200", (await call("POST", "/api/webhooks/payment", { body, headers: { [MOCK_SIGNATURE_HEADER]: signMockWebhook(body) } })).status === 200);

  let status = "";
  for (let i = 0; i < 40 && status !== "ready"; i++) {
    status = json(await call("GET", `/api/report/${checkout.orderId}/status`)).report;
    if (status !== "ready") await new Promise((res) => setTimeout(res, 250));
  }
  check("отчёт сгенерирован", status === "ready");
  r = await call("GET", `/report/${checkout.orderId}`);
  const words = r.text.replace(/<[^>]+>/g, " ").split(/\s+/).filter((w) => /[а-яё]/i.test(w)).length;
  check("страница отчёта ≥ 1500 слов", r.status === 200 && words >= 1500, `${words} слов`);
  r = await call("GET", `/api/report/${checkout.orderId}/pdf`);
  check("PDF", r.status === 200 && r.body.subarray(0, 4).toString() === "%PDF", `${r.body.length} байт`);

  r = await call("GET", `/result/${resultId}`);
  check("купивший видит «Открыть мой разбор» вместо пейволла", r.text.includes('data-testid="my-report"') && !r.text.includes('data-testid="paywall"') && r.text.includes(`/report/${checkout.orderId}`));
  r = await call("POST", "/api/checkout", { body: JSON.stringify({ resultId, email: "buyer@example.ru", offerAccepted: true }) });
  check("второй платёж за оплаченный результат → 409", r.status === 409);
  check("страница «Восстановить доступ»", (await call("GET", "/restore")).status === 200);
  r = await call("POST", "/api/restore", { body: JSON.stringify({ email: "BUYER@example.ru" }) });
  const r2 = await call("POST", "/api/restore", { body: JSON.stringify({ email: "nobody@example.ru" }) });
  check("восстановление: одинаковый ответ, есть покупки или нет", r.status === 200 && r2.status === 200 && json(r).message === json(r2).message);
  r = await call("GET", "/dev/mailbox", { auth: `admin:${process.env.ADMIN_PASSWORD}` });
  check("/dev/mailbox: письмо с разбором и письмо со ссылками", r.text.includes("Твой персональный разбор готов") && r.text.includes("Ссылки на твои разборы") && r.text.includes(`/report/${checkout.orderId}`));

  check("админка без пароля → 401", (await call("GET", "/admin")).status === 401);
  r = await call("GET", "/admin", { auth: `admin:${process.env.ADMIN_PASSWORD}` });
  check("админка 200", r.status === 200);
  check("админка: метрики, воронка, заказ, email", ["Старт → завершил тест", "Воронка", "Где отваливаются", "buyer@example.ru", "lead@example.ru", "smoke"].every((s) => r.text.includes(s)));
  r = await call("GET", "/api/admin/export/orders", { auth: `admin:${process.env.ADMIN_PASSWORD}` });
  check("CSV заказов", r.status === 200 && r.text.includes("buyer@example.ru"));
  for (const doc of ["offer", "privacy", "consent"]) {
    r = await call("GET", `/legal/${doc}`);
    check(`юр. страница ${doc}`, r.status === 200 && r.text.includes("[ФИО ИП]"));
  }
  check("404", (await call("GET", "/result/00000000-0000-4000-8000-000000000000")).status === 404);

  // /dev/qa: в production — только по паролю админки; демо-данные не попадают в админку
  const auth = `admin:${process.env.ADMIN_PASSWORD}`;
  check("/dev/qa без пароля в production → 404", (await call("GET", "/dev/qa")).status === 404);
  check("/dev/qa с неверным паролем → 404", (await call("GET", "/dev/qa", { auth: "admin:wrong" })).status === 404);
  r = await call("POST", "/dev/qa/seed", { auth });
  check("/dev/qa: демо-данные созданы, браузер стал QA-посетителем", r.status === 303 && (jar.get("hi_anon") ?? "").startsWith("qa-"));
  r = await call("GET", "/dev/qa", { auth });
  const qaLinks = [...r.text.matchAll(/href="(\/result\/[0-9a-f-]{36})"/g)].map((m) => m[1]).filter((h) => !h.includes("00000000-0000")); // ссылка на 404 — намеренная
  check("/dev/qa: 8 типов × 3 уровня + гость", r.status === 200 && q.archetypes.every((a) => r.text.includes(a.name)) && new Set(qaLinks).size >= 25, `${new Set(qaLinks).size} результатов`);
  const qaPages = [...new Set([...r.text.matchAll(/href="(\/(?:pay\/mock|order|report|dev\/qa\/question)\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&")))];
  let qaOk = 0;
  for (const href of [...new Set(qaLinks)].concat(qaPages)) {
    const res = await call("GET", href, { auth });
    if (res.status === 200) qaOk++;
    else console.log(`  ${href} → ${res.status}`);
  }
  check("/dev/qa: все ссылки на результаты, оплату, отчёт и превью вопросов открываются", qaOk === new Set(qaLinks).size + qaPages.length, `${qaOk} страниц`);
  r = await call("GET", `${qaLinks[0]}?price=490&open=checkout`, { auth });
  check("/dev/qa: пейволл с открытой формой и ценой 490", r.text.includes('data-testid="checkout-form"') && r.text.includes("490"));
  r = await call("GET", "/admin", { auth });
  check("/admin не показывает демо-заказы", r.status === 200 && !r.text.includes("qa@example.ru"));

  console.log(failures ? `\n${failures} проверок не прошли` : "\nВсе проверки прошли");
  await app.close();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
