import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { FakeDoor } from "@/components/FakeDoor";
import { ReportProgress } from "@/components/ReportProgress";
import { TrackOnMount } from "@/components/Track";
import { PdfLink } from "@/components/PdfLink";
import { SupportContacts } from "@/components/SupportContacts";
import { appConfig } from "@/lib/config";
import { getOrder } from "@/lib/payments/service";
import { maskEmail } from "@/lib/mailer";
import { getReport } from "@/lib/report/generate";

export const metadata: Metadata = { title: "Твой разбор — Индекс счастья", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getOrder(id);
  if (!order) notFound();
  if (order.status !== "paid") redirect(`/order/${id}`); // отчёт доступен только после оплаты
  const state = await getReport(id);
  const { report, isFallback } = state;
  const app = appConfig();

  if (!report) {
    // генерирует фоновый воркер; страница только показывает прогресс (и будит воркер через статус)
    return (
      <div className="mx-auto max-w-xl px-5 py-20 text-center" data-testid="report-waiting">
        <div className="pulse-soft mx-auto h-16 w-16 rounded-full bg-gradient-to-br from-gold via-accent to-plum" />
        <h1 className="mt-8 font-serif text-3xl font-semibold">Готовим твой разбор…</h1>
        <ReportProgress
          orderId={id}
          email={maskEmail(order.email)}
          initial={{ report: state.status, attempt: state.attempt, maxAttempts: state.maxAttempts, startedAt: state.startedAt }}
        />
        <SupportContacts lead="Что-то пошло не так? Напиши нам:" className="mt-6 text-sm text-muted" />
      </div>
    );
  }

  return (
    <article className="mx-auto max-w-3xl px-5 sm:px-8" data-testid="report">
      <TrackOnMount name="report_view" props={{ order_id: id, status: "ready", fallback: isFallback }} />
      <header className="rise text-center">
        <p className="eyebrow">Персональный разбор</p>
        <h1 className="mt-4 font-serif text-4xl leading-tight font-semibold sm:text-5xl">{report.title}</h1>
        <div className="mt-8 flex justify-center">
          <PdfLink orderId={id} />
        </div>
      </header>

      <Section>
        {report.intro.map((p) => (
          <P key={p}>{p}</P>
        ))}
      </Section>

      <Section title={report.index.heading}>
        {report.index.paragraphs.map((p) => (
          <P key={p}>{p}</P>
        ))}
      </Section>

      <Section title={report.type.heading}>
        {report.type.paragraphs.map((p) => (
          <P key={p}>{p}</P>
        ))}
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <ListCard title="Сильные стороны" items={report.type.strengths} tone="sage" />
          <ListCard title="Ловушки" items={report.type.pitfalls} tone="accent" />
        </div>
      </Section>

      <Section title="Три главные утечки счастья">
        <div className="space-y-6">
          {report.leaks.map((l) => (
            <div key={l.zone} className="card p-7">
              <h3 className="font-serif text-2xl font-semibold">{l.heading}</h3>
              {l.why.map((p) => (
                <P key={p}>{p}</P>
              ))}
              <p className="mt-5 font-semibold">Что можно сделать</p>
              <ul className="mt-2 space-y-2">
                {l.actions.map((a) => (
                  <li key={a} className="flex gap-3 leading-relaxed">
                    <span className="text-accent">→</span>
                    {a}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      <Section title={report.type_advice.heading}>
        {report.type_advice.paragraphs.map((p) => (
          <P key={p}>{p}</P>
        ))}
        <ListCard title="Советы" items={report.type_advice.tips} tone="plum" />
      </Section>

      <Section title={report.plan.heading}>
        <P>{report.plan.intro}</P>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {report.plan.weeks.map((w) => (
            <div key={w.title} className="card p-6">
              <p className="font-serif text-xl font-semibold">{w.title}</p>
              <p className="mt-2 text-sm leading-relaxed text-muted">{w.focus}</p>
              <ol className="mt-4 space-y-2 text-[0.95rem]">
                {w.steps.map((s, i) => (
                  <li key={s} className="flex gap-3">
                    <span className="font-semibold text-accent">{i + 1}.</span>
                    {s}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Напоследок">
        {report.closing.map((p) => (
          <P key={p}>{p}</P>
        ))}
        <div className="mt-8 flex justify-center">
          <PdfLink orderId={id} />
        </div>
        <SupportContacts lead="Вопросы, возврат или что-то не так с разбором:" className="mt-8 text-center text-sm text-muted" />
      </Section>

      <FakeDoor source="report" resultId={order.resultId} name={app.fake_door.name} price={app.fake_door.price_rub_month} pitch={app.fake_door.pitch} />
    </article>
  );
}

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="mt-14">
      {title && <h2 className="mb-5 font-serif text-3xl font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 text-[1.08rem] leading-[1.75] text-ink/90">{children}</p>;
}

function ListCard({ title, items, tone }: { title: string; items: string[]; tone: "sage" | "accent" | "plum" }) {
  const color = { sage: "text-sage", accent: "text-accent", plum: "text-plum" }[tone];
  return (
    <div className="card mt-6 p-6">
      <p className={`font-semibold ${color}`}>{title}</p>
      <ul className="mt-3 space-y-2">
        {items.map((i) => (
          <li key={i} className="flex gap-3 leading-relaxed">
            <span className={color}>•</span>
            {i}
          </li>
        ))}
      </ul>
    </div>
  );
}
