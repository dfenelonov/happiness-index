import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@/lib/db";
import { sendMail } from "@/lib/mailer";
import { MockPaymentProvider } from "@/lib/payments/mock";
import { applyPayment, CheckoutError, createOrder } from "@/lib/payments/service";
import { paidOrderForResult, restoreAccess } from "@/lib/purchases";
import { completeTest, saveAnswer, startOrResume } from "@/lib/test-flow";
import type { Visitor } from "@/lib/visitor";
import { freshDb } from "./db";
import { answersWith } from "./helpers";

const provider = new MockPaymentProvider();
const visitor: Visitor = { anonId: "11111111-1111-4111-8111-111111111111", sessionId: null, price: 690, attribution: {} };

let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => {
  db = await freshDb();
  delete process.env.MAIL_PROVIDER;
  delete process.env.SUPPORT_EMAIL;
});

async function result(anonId = visitor.anonId!) {
  const { testId } = await startOrResume(anonId, null);
  for (const [id, v] of Object.entries(answersWith({}))) await saveAnswer(testId, anonId, id, v);
  return (await completeTest(testId, anonId)).resultId;
}

async function buy(resultId: string, email = "buyer@example.ru", v = visitor) {
  const { orderId } = await createOrder({ provider, visitor: v, resultId, email, offerAccepted: true, appUrl: "" });
  const [o] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
  await applyPayment({ paymentId: o.providerPaymentId!, status: "succeeded", amountRub: o.amountRub });
  return orderId;
}

const outbox = () => db.select().from(schema.mailOutbox);

describe("повторная покупка", () => {
  it("после оплаты результат знает свой заказ, второй платёж отклоняется с 409", async () => {
    const resultId = await result();
    expect(await paidOrderForResult(resultId)).toBeNull();
    const orderId = await buy(resultId);
    expect((await paidOrderForResult(resultId))?.id).toBe(orderId);
    const err = await createOrder({ provider, visitor, resultId, email: "buyer@example.ru", offerAccepted: true, appUrl: "" }).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutError);
    expect((err as CheckoutError).status).toBe(409);
  });

  it("незавершённый или отклонённый платёж не мешает купить снова", async () => {
    const resultId = await result();
    await createOrder({ provider, visitor, resultId, email: "a@b.ru", offerAccepted: true, appUrl: "" }); // брошен на кассе
    const { orderId } = await createOrder({ provider, visitor, resultId, email: "a@b.ru", offerAccepted: true, appUrl: "" });
    const [o] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    await applyPayment({ paymentId: o.providerPaymentId!, status: "canceled", amountRub: 690 });
    await expect(buy(resultId)).resolves.toBeTruthy();
  });
});

describe("восстановление доступа по email", () => {
  it("письмо со ссылками на все оплаченные разборы этого email (регистр не важен)", async () => {
    const a = await buy(await result(), "Me@Example.ru");
    const other = { ...visitor, anonId: "22222222-2222-4222-8222-222222222222" }; // другой браузер
    const b = await buy(await result(other.anonId!), "me@example.ru", other);
    await buy(await result("33333333-3333-4333-8333-333333333333"), "stranger@example.ru", { ...visitor, anonId: "33333333-3333-4333-8333-333333333333" });

    expect(await restoreAccess("  ME@example.RU ")).toEqual({ sent: true });
    const mails = (await outbox()).filter((m) => m.subject === "Ссылки на твои разборы");
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("me@example.ru");
    expect(mails[0].text).toContain(`/report/${a}`);
    expect(mails[0].text).toContain(`/report/${b}`);
    expect(mails[0].text).not.toContain("stranger");
  });

  it("нет оплаченных покупок — письма нет (ответ API при этом тот же)", async () => {
    const resultId = await result();
    await createOrder({ provider, visitor, resultId, email: "pending@example.ru", offerAccepted: true, appUrl: "" });
    expect(await restoreAccess("pending@example.ru")).toEqual({ sent: false });
    expect(await restoreAccess("nobody@example.ru")).toEqual({ sent: false });
    expect(await outbox()).toHaveLength(0);
  });

  it("некорректный email — ошибка валидации", async () => {
    await expect(restoreAccess("not-an-email")).rejects.toThrow(CheckoutError);
  });
});

describe("почта в мок-режиме", () => {
  it("письмо сохраняется в mail_outbox (/dev/mailbox) с контактом поддержки", async () => {
    process.env.SUPPORT_EMAIL = "help@example.ru";
    await sendMail("x@example.ru", "Тема", "Текст\n");
    const [m] = await outbox();
    expect(m).toMatchObject({ to: "x@example.ru", subject: "Тема" });
    expect(m.text).toContain("help@example.ru");
  });
});
