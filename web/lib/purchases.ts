import { and, desc, eq } from "drizzle-orm";
import { questionnaire } from "./config";
import { getDb, schema } from "./db";
import { sendRestoreEmail } from "./mailer";
import { normalizeEmail } from "./payments/service";
import { appUrl } from "./report/generate";

/** Оплаченный заказ к результату (последний), если есть. Разбор к результату покупается один раз. */
export async function paidOrderForResult(resultId: string) {
  const [o] = await getDb()
    .select({ id: schema.orders.id, paidAt: schema.orders.paidAt })
    .from(schema.orders)
    .where(and(eq(schema.orders.resultId, resultId), eq(schema.orders.status, "paid")))
    .orderBy(desc(schema.orders.paidAt))
    .limit(1);
  return o ?? null;
}

/**
 * «Восстановить доступ»: письмо со ссылками на все оплаченные разборы этого email.
 * Ответ одинаковый при любом исходе — по нему нельзя узнать, покупал ли кто-то с этим адресом.
 */
export async function restoreAccess(rawEmail: unknown): Promise<{ sent: boolean }> {
  const email = normalizeEmail(rawEmail);
  const rows = await getDb()
    .select({ id: schema.orders.id, paidAt: schema.orders.paidAt, archetype: schema.results.archetype, index: schema.results.index })
    .from(schema.orders)
    .innerJoin(schema.results, eq(schema.results.id, schema.orders.resultId))
    .where(and(eq(schema.orders.email, email), eq(schema.orders.status, "paid")))
    .orderBy(desc(schema.orders.paidAt));
  if (rows.length === 0) return { sent: false };
  const names = new Map(questionnaire().archetypes.map((a) => [a.id, a.name]));
  await sendRestoreEmail(
    email,
    rows.map((r) => ({
      url: `${appUrl()}/report/${r.id}`,
      date: (r.paidAt ?? "").slice(0, 10).split("-").reverse().join("."),
      title: `${names.get(r.archetype) ?? "Разбор"}, индекс ${r.index}`,
    })),
  );
  return { sent: true };
}
