import type { Metadata } from "next";
import Link from "next/link";
import { QaCookieReset } from "@/components/QaCookieReset";
import { appConfig, questionnaire } from "@/lib/config";
import { isQaAnon, loadQa } from "@/lib/qa";
import { getVisitor } from "@/lib/visitor";

export const metadata: Metadata = { title: "QA-галерея — Индекс счастья", robots: { index: false } };

const LEVEL_NAMES = { low: "низкий", mid: "средний", high: "высокий" } as const;

/** Галерея всех экранов и состояний для ручной проверки (docs/MANUAL_QA.md). */
export default async function QaGallery() {
  const visitor = await getVisitor();
  const q = questionnaire();
  const app = appConfig();
  const qa = isQaAnon(visitor.anonId) ? await loadQa(visitor.anonId!) : null;
  const hasData = !!qa?.any;

  const firstOf = (kind: string) => q.questions.findIndex((x) => x.kind === kind) + 1;
  const questionLinks = [
    [1, `№1 — первый вопрос (прямой, свои 5 вариантов)`],
    [firstOf("life"), `№${firstOf("life")} — про жизнь (база индекса)`],
    [firstOf("leak"), `№${firstOf("leak")} — утечка`],
    [firstOf("axis"), `№${firstOf("axis")} — ось типа`],
    [q.questions.length, `№${q.questions.length} — последний вопрос (ответ → экран анализа)`],
  ] as const;

  const order = (label: string) => qa?.orders.find((o) => o.label === label);
  const sample = qa?.notPurchased;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-5 pb-10 sm:px-8" data-testid="qa">
      <div>
        <p className="eyebrow">Для ручной проверки · docs/MANUAL_QA.md</p>
        <h1 className="mt-2 font-serif text-4xl font-semibold">QA-галерея</h1>
        <p className="mt-2 max-w-3xl text-muted">
          Все экраны и состояния по ссылкам. Демо-данные принадлежат этому браузеру (anon_id «qa-…»), поэтому ты видишь
          результаты как владелец. В метрики, перцентиль, списки и CSV админки они не попадают. Ссылки открывай в новой
          вкладке.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <form method="post" action="/dev/qa/seed">
            <button className="btn-primary !py-2.5 text-sm" data-testid="qa-seed">
              {hasData ? "Пересоздать демо-данные" : "Создать демо-данные"}
            </button>
          </form>
          {hasData && (
            <form method="post" action="/dev/qa/exit">
              <button className="btn-ghost !py-2.5 text-sm">Удалить демо-данные и выйти из QA-режима</button>
            </form>
          )}
        </div>
      </div>

      <Section title="1. Общее">
        <L href="/">Лендинг</L>
        <QaCookieReset />
        <L href="/result/00000000-0000-4000-8000-000000000000">404</L>
        <L href="/legal/offer">Оферта</L>
        <L href="/legal/privacy">Политика ПДн</L>
        <L href="/legal/consent">Согласие на обработку ПДн</L>
        <L href="/admin">/admin (пароль ADMIN_PASSWORD)</L>
      </Section>

      <Section title="2. Тест (превью без сохранения)">
        {questionLinks.map(([n, label]) => (
          <L key={label} href={`/dev/qa/question/${n}`}>
            {label}
          </L>
        ))}
        <L href="/dev/qa/question/analysing">Экран «Анализируем твои ответы…»</L>
        <L href="/test">Настоящий тест /test (создаёт прохождение)</L>
      </Section>

      {!hasData ? (
        <div className="card p-6 text-muted">Нажми «Создать демо-данные», чтобы появились результаты, пейволл, оплата и отчёт.</div>
      ) : (
        <>
          <section className="card overflow-x-auto p-6">
            <h2 className="font-serif text-2xl font-semibold">3. Результат: 8 типов × 3 уровня индекса</h2>
            <p className="mt-1 text-sm text-muted">Индекс: низкий — 25, средний — 50, высокий — 75. Утечки у разных типов разные.</p>
            <table className="mt-4 w-full text-sm">
              <thead className="text-left text-muted">
                <tr>
                  <th className="py-1.5 pr-3">Тип</th>
                  <th className="pr-3">Полюса</th>
                  {(["low", "mid", "high"] as const).map((l) => (
                    <th key={l} className="pr-3">{LEVEL_NAMES[l]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {qa!.byType.map((t) => (
                  <tr key={t.id} className="border-t border-line">
                    <td className="py-1.5 pr-3 font-medium">{t.name}</td>
                    <td className="pr-3 text-xs text-muted">{t.poles}</td>
                    {t.levels.map((r, i) => (
                      <td key={i} className="pr-3">
                        {r ? <L href={`/result/${r.id}`}>индекс {r.index}</L> : "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <Section title="4. Гостевой просмотр и шеринг">
            {qa!.guest && <L href={`/result/${qa!.guest.id}`}>Чужой результат (без пейволла, с «Пройди тест сам»)</L>}
            {sample && <L href={`/api/card/${sample.id}`}>Карточка для сторис 1080×1920</L>}
            {sample && <L href={`/api/og/${sample.id}`}>OG-картинка результата</L>}
            <L href="/api/og">OG-картинка лендинга</L>
          </Section>

          {sample && (
            <Section title="5. Пейволл и подписка">
              {app.pricing.variants_rub.map((p) => (
                <L key={p} href={`/result/${sample.id}?price=${p}&open=checkout`}>
                  Пейволл {p} ₽ (форма оплаты открыта)
                </L>
              ))}
              <L href={`/result/${sample.id}?open=tracker`}>Модалка «{app.fake_door.name}»</L>
              {qa!.purchased && (
                <L href={`/result/${qa!.purchased.id}`}>Результат после покупки: вместо пейволла — «Открыть мой разбор»</L>
              )}
              <L href="/restore">«Уже покупал? Восстановить доступ» (письмо — в почтовом ящике)</L>
              <L href="/dev/mailbox">Почтовый ящик (мок)</L>
              <span className="text-xs text-muted">?price= закрепляет цену в cookie этого браузера — проверь все три по очереди.</span>
            </Section>
          )}

          <Section title="6. Оплата и отчёт">
            {(process.env.PAYMENT_PROVIDER || "mock") !== "mock" && (
              <span className="text-sm text-accent-dark">PAYMENT_PROVIDER не mock — мок-касса отключена, её ссылки дадут 404.</span>
            )}
            <OrderLink o={order("success")} href={(o) => `/pay/mock/${o.paymentId}`}>
              Мок-касса → нажми «Оплатить успешно» (→ ожидание → отчёт)
            </OrderLink>
            <OrderLink o={order("fail")} href={(o) => `/pay/mock/${o.paymentId}`}>
              Мок-касса → нажми «Отказ» (→ «Оплата не прошла»)
            </OrderLink>
            <OrderLink o={order("waiting")} href={(o) => `/order/${o.id}`}>
              Ожидание подтверждения оплаты (вебхук ещё не пришёл)
            </OrderLink>
            <OrderLink o={order("failed")} href={(o) => `/order/${o.id}`}>
              Оплата не прошла
            </OrderLink>
            <OrderLink o={order("report")} href={(o) => `/report/${o.id}`}>
              Готовый отчёт
            </OrderLink>
            <OrderLink o={order("report")} href={(o) => `/api/report/${o.id}/pdf`}>
              PDF отчёта
            </OrderLink>
            <OrderLink o={order("generating")} href={(o) => `/report/${o.id}`}>
              Отчёт готовится — это же видит покупатель, если генерация упала (повтор и fallback идут сами; через 5 минут
              состояние сменится на готовый отчёт)
            </OrderLink>
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-6">
      <h2 className="font-serif text-2xl font-semibold">{title}</h2>
      <div className="mt-3 flex flex-col items-start gap-2">{children}</div>
    </section>
  );
}

function L({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} target="_blank" className="text-accent-dark underline underline-offset-2 hover:text-ink">
      {children}
    </Link>
  );
}

type QaOrder = { id: string; status: string; paymentId: string | null; report: string | null };

function OrderLink({ o, href, children }: { o?: QaOrder; href: (o: QaOrder) => string; children: React.ReactNode }) {
  if (!o) return <span className="text-muted">— (нет демо-заказа)</span>;
  const status = { pending: "ожидает", paid: "оплачен", failed: "отказ" }[o.status] ?? o.status;
  return (
    <span>
      <L href={href(o)}>{children}</L> <span className="text-xs text-muted">· заказ {status}</span>
    </span>
  );
}
