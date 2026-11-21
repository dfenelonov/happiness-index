import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const createdAt = () => text("created_at").notNull().default(now);

/** Прохождение теста. Ответы — JSON {question_id: значение}, дописываются по одному (upsert). */
export const tests = sqliteTable(
  "tests",
  {
    id: text("id").primaryKey(),
    anonId: text("anon_id").notNull(),
    sessionId: text("session_id"),
    answers: text("answers", { mode: "json" }).$type<Record<string, number | string>>().notNull().default({}),
    startedAt: createdAt(),
    completedAt: text("completed_at"),
    resultId: text("result_id"),
  },
  (t) => [index("tests_anon_idx").on(t.anonId)],
);

export const results = sqliteTable(
  "results",
  {
    id: text("id").primaryKey(),
    testId: text("test_id"),
    anonId: text("anon_id"),
    index: integer("index_score").notNull(),
    level: text("level").notNull(),
    axes: text("axes", { mode: "json" }).$type<Record<string, number>>().notNull(),
    archetype: text("archetype").notNull(),
    zones: text("zones", { mode: "json" }).$type<Record<string, number>>().notNull(),
    leaks: text("leaks", { mode: "json" }).$type<string[]>().notNull(),
    direct: text("direct_answer").notNull(),
    // синтетические результаты холодного старта: участвуют в перцентиле, исключены из аналитики
    isSeed: integer("is_seed", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("results_seed_idx").on(t.isSeed)],
);

/** Серверные события воронки. Без IP, user-agent и email. */
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    anonId: text("anon_id"),
    sessionId: text("session_id"),
    priceVariant: integer("price_variant"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmContent: text("utm_content"),
    utmTerm: text("utm_term"),
    referrer: text("referrer"),
    props: text("props", { mode: "json" }).$type<Record<string, string | number | boolean>>(),
    createdAt: createdAt(),
  },
  (t) => [index("events_name_idx").on(t.name), index("events_anon_idx").on(t.anonId)],
);

export const ORDER_STATUSES = ["pending", "paid", "failed"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    resultId: text("result_id").notNull(),
    anonId: text("anon_id"),
    sessionId: text("session_id"),
    priceVariant: integer("price_variant").notNull(),
    amountRub: integer("amount_rub").notNull(),
    email: text("email").notNull(),
    status: text("status", { enum: ORDER_STATUSES }).notNull().default("pending"),
    provider: text("provider").notNull(),
    providerPaymentId: text("provider_payment_id"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmContent: text("utm_content"),
    utmTerm: text("utm_term"),
    referrer: text("referrer"),
    createdAt: createdAt(),
    paidAt: text("paid_at"),
  },
  (t) => [
    uniqueIndex("orders_payment_uidx").on(t.providerPaymentId),
    index("orders_result_idx").on(t.resultId),
    check("orders_status_check", sql`${t.status} in ('pending', 'paid', 'failed')`),
    check("orders_amount_check", sql`${t.amountRub} > 0`),
  ],
);

export const reports = sqliteTable(
  "reports",
  {
  orderId: text("order_id").primaryKey(),
  status: text("status", { enum: ["pending", "ready", "failed"] }).notNull().default("pending"),
  provider: text("provider"),
  isFallback: integer("is_fallback", { mode: "boolean" }).notNull().default(false),
  content: text("content", { mode: "json" }).$type<unknown>(),
  emailedAt: text("emailed_at"),
  attempt: integer("attempt").notNull().default(0), // текущая попытка у LLM — для экрана прогресса
  startedAt: text("started_at"),
  durationMs: integer("duration_ms"), // реальное время генерации — чтобы подобрать таймаут по факту
  createdAt: createdAt(),
  updatedAt: text("updated_at"), // «пульс» генерации: обновляется на каждой попытке
  },
  (t) => [check("reports_status_check", sql`${t.status} in ('pending', 'ready', 'failed')`)],
);

export const leads = sqliteTable("leads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  consent: integer("consent", { mode: "boolean" }).notNull(),
  source: text("source").notNull(), // fake door: где показали — result | report
  anonId: text("anon_id"),
  resultId: text("result_id"),
  priceVariant: integer("price_variant"),
  createdAt: createdAt(),
});

/** Почтовый ящик мок-режима (MAIL_PROVIDER=mock): письма не уходят, а видны в /dev/mailbox. */
export const mailOutbox = sqliteTable("mail_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  to: text("to_email").notNull(),
  subject: text("subject").notNull(),
  text: text("body").notNull(),
  createdAt: createdAt(),
});
