import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { StatusPoller } from "@/components/StatusPoller";
import { getOrder } from "@/lib/payments/service";

export const metadata: Metadata = { title: "Оплата — Индекс счастья", robots: { index: false } };
export const dynamic = "force-dynamic";

/** Сюда касса возвращает покупателя (return_url). Статус — только из вебхука, не из параметров URL. */
export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getOrder(id);
  if (!order) notFound();
  if (order.status === "paid") redirect(`/report/${id}`);

  return (
    <div className="mx-auto max-w-xl px-5 py-20 text-center">
      {order.status === "pending" ? (
        <>
          <StatusPoller orderId={id} until="paid" />
          <div className="pulse-soft mx-auto h-16 w-16 rounded-full bg-gradient-to-br from-gold via-accent to-plum" />
          <h1 className="mt-8 font-serif text-3xl font-semibold">Ждём подтверждения оплаты…</h1>
          <p className="mt-3 text-muted">Обычно это занимает несколько секунд. Страница обновится сама.</p>
        </>
      ) : (
        <div className="card p-10" data-testid="payment-failed">
          <h1 className="font-serif text-3xl font-semibold">Оплата не прошла</h1>
          <p className="mt-3 text-muted">Деньги не списаны. Можно попробовать ещё раз — результат теста сохранён.</p>
          <Link href={`/result/${order.resultId}`} className="btn-primary mt-8">Вернуться к результату</Link>
        </div>
      )}
    </div>
  );
}
