import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getOrderByPayment } from "@/lib/payments/service";
import { maskEmail } from "@/lib/mailer";

export const metadata: Metadata = { title: "Тестовая касса", robots: { index: false } };

/** Мок платёжной страницы. Деньги не списываются; кнопки шлют вебхук на наш сервер. */
export default async function MockKassa({ params }: { params: Promise<{ paymentId: string }> }) {
  if ((process.env.PAYMENT_PROVIDER || "mock") !== "mock") notFound();
  const { paymentId } = await params;
  const order = await getOrderByPayment(paymentId);
  if (!order) notFound();
  return (
    <div className="mx-auto max-w-md px-5 py-10">
      <div className="overflow-hidden rounded-2xl border border-[#dfe3ea] bg-white shadow-xl" data-testid="mock-kassa">
        <div className="flex items-center justify-between bg-[#1f2a44] px-6 py-4 text-white">
          <span className="font-semibold">Тестовая касса</span>
          <span className="rounded-full bg-[#ffcc4d] px-2.5 py-0.5 text-xs font-semibold text-[#1f2a44]">тестовый режим</span>
        </div>
        <div className="p-6 font-sans">
          <p className="text-sm text-[#5b6476]">Оплата заказа</p>
          <p className="mt-1 text-lg font-semibold text-[#1f2a44]">Полный разбор «Индекс счастья»</p>
          <div className="mt-5 flex items-baseline justify-between border-y border-[#eef0f4] py-4">
            <span className="text-[#5b6476]">К оплате</span>
            <span className="text-3xl font-bold text-[#1f2a44]" data-testid="mock-amount">{order.amountRub} ₽</span>
          </div>
          <p className="mt-4 text-sm text-[#5b6476]">Чек будет отправлен на {maskEmail(order.email)}</p>
          {order.status !== "pending" ? (
            <p className="mt-6 rounded-xl bg-[#f3f5f8] p-4 text-sm">Этот платёж уже обработан: {order.status === "paid" ? "оплачен" : "отклонён"}.</p>
          ) : (
            <form method="post" action={`/api/pay/mock/${paymentId}`} className="mt-6 grid gap-3">
              <button name="outcome" value="success" className="rounded-xl bg-[#0070f0] py-3.5 font-semibold text-white transition hover:bg-[#005fd0]" data-testid="mock-pay-success">
                Оплатить успешно
              </button>
              <button name="outcome" value="fail" className="rounded-xl border border-[#dfe3ea] py-3.5 font-semibold text-[#1f2a44] transition hover:bg-[#f3f5f8]" data-testid="mock-pay-fail">
                Отказ
              </button>
            </form>
          )}
          <p className="mt-6 text-center text-xs text-[#8a93a5]">Это имитация кассы для разработки. Деньги не списываются.</p>
        </div>
      </div>
    </div>
  );
}
