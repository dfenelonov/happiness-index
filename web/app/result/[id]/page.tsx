import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FakeDoor } from "@/components/FakeDoor";
import { IndexGauge } from "@/components/IndexGauge";
import { Paywall } from "@/components/Paywall";
import { ShareBlock } from "@/components/ShareBlock";
import { TrackOnMount } from "@/components/Track";
import { AXIS_IDS, appConfig, questionnaire } from "@/lib/config";
import { appUrl } from "@/lib/report/generate";
import { paidOrderForResult } from "@/lib/purchases";
import { getResult, resultPercentile } from "@/lib/results";
import { axisDisplay, countryLine, indexLevel, poleOf } from "@/lib/scoring";
import { getVisitor } from "@/lib/visitor";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ open?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const r = await getResult(id);
  if (!r) return {};
  const arch = questionnaire().archetypes.find((a) => a.id === r.archetype);
  const title = `Мой индекс счастья — ${r.index} из 100. ${arch?.name ?? ""}`;
  return {
    title,
    description: "А какой у тебя? Пройди тест за 5 минут — бесплатно и без регистрации.",
    openGraph: { title, images: [`/api/og/${id}`] },
    robots: { index: false },
  };
}

export default async function ResultPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { open } = await searchParams;
  const r = await getResult(id);
  if (!r) notFound();
  const q = questionnaire();
  const app = appConfig();
  const visitor = await getVisitor();
  const owner = !!visitor.anonId && r.anonId === visitor.anonId;
  const pct = await resultPercentile(r.id, r.index);
  const arch = q.archetypes.find((a) => a.id === r.archetype)!;
  const level = indexLevel(q, r.index);
  const direct = q.direct_options.find((o) => o.id === r.direct);
  const shareUrl = `${appUrl()}/result/${r.id}`;
  // уже купленный разбор: вместо пейволла — ссылка на него (повторно купить нельзя)
  const paid = owner ? await paidOrderForResult(r.id) : null;

  return (
    <div className="mx-auto max-w-5xl px-5 sm:px-8">
      <TrackOnMount name="result_view" props={{ result_id: r.id, owner }} />

      {!owner && (
        <div className="card rise mb-8 flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-lg">Это результат друга. А какой индекс счастья у тебя?</p>
          <Link href="/test" className="btn-primary">Пройти тест</Link>
        </div>
      )}

      <section className="card rise overflow-hidden">
        <div className="grid gap-8 p-8 sm:p-12 md:grid-cols-[1fr_1fr] md:items-center">
          <div className="text-center md:text-left">
            <p className="eyebrow">{owner ? "Твой индекс счастья" : "Индекс счастья"}</p>
            <h1 className="mt-4 font-serif text-4xl font-semibold sm:text-5xl">
              {r.index} из 100 — {level.name}
            </h1>
            {pct.value !== null && (
              <p className="mt-4 text-lg" data-testid="percentile">
                {owner ? "Ты счастливее" : "Счастливее"} <b>{pct.value}%</b> участников
              </p>
            )}
            {pct.usesSeed && (
              <p className="mt-2 text-xs text-muted">Пока участников мало, сравниваем и с модельным распределением ответов.</p>
            )}
          </div>
          <div className="rounded-3xl bg-gradient-to-br from-[#fdeee2] via-[#fbe3dc] to-[#f1dde8] px-6 py-8">
            <IndexGauge value={r.index} size={300} />
          </div>
        </div>
        {direct && (
          <div className="border-t border-line bg-[#fff8f1] px-8 py-6 sm:px-12">
            <p className="text-sm text-muted">На вопрос «Если говорить в целом, ты счастлив или нет?» — «{direct.label}»</p>
            <p className="mt-1.5 text-lg" data-testid="country-line">
              {countryLine(q, r.direct)}
            </p>
            <p className="mt-1 text-xs text-muted">
              Данные:{" "}
              <a href={q.country.source_url} target="_blank" rel="noopener noreferrer" className="underline">
                {q.country.source_name}
              </a>
              , {q.country.period}
            </p>
          </div>
        )}
      </section>

      <section className="mt-8 grid gap-8 md:grid-cols-[1.1fr_0.9fr]">
        <div className="card rise rise-2 p-8 sm:p-10">
          <p className="eyebrow">Тип личности</p>
          <h2 className="mt-3 font-serif text-3xl font-semibold" data-testid="archetype">
            {arch.name}
          </h2>
          <p className="mt-1 text-accent italic">«{arch.slogan}»</p>
          <p className="mt-5 leading-relaxed text-ink/90">{arch.description}</p>
          <div className="mt-7 space-y-4">
            {AXIS_IDS.map((axis) => {
              const m = r.axes[axis];
              const meta = q.scoring.axes.list[axis];
              const v = axisDisplay(q, m);
              return (
                <div key={axis}>
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">{meta.name}</span>
                    <span className="text-muted">{meta[poleOf(q, m)]}</span>
                  </div>
                  <div className="mt-1.5 h-2 rounded-full bg-line">
                    <div className="h-2 rounded-full bg-gradient-to-r from-plum to-accent" style={{ width: `${Math.max(v, 3)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card rise rise-3 p-8 sm:p-10">
          <p className="eyebrow">Три главные утечки счастья</p>
          <ol className="mt-5 space-y-5" data-testid="leaks">
            {r.leaks.map((zone, i) => {
              const z = q.zones[zone];
              const v = Math.round(((r.zones[zone] - 1) / 4) * 100);
              return (
                <li key={zone} className="flex gap-4">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#fbe6dc] font-serif text-lg text-accent">{i + 1}</span>
                  <div>
                    <p className="font-semibold">
                      {z.name} <span className="font-normal text-muted">· {v} из 100</span>
                    </p>
                    <p className="mt-1 leading-relaxed text-ink/85">{z.leak}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      {owner && (
        <>
          <ShareBlock resultId={r.id} shareUrl={shareUrl} index={r.index} archetype={arch.name} />
          {paid ? (
            <section className="mt-8 overflow-hidden rounded-[1.75rem] bg-gradient-to-br from-[#2b1d2e] via-[#3d2440] to-[#5a2f4a] p-8 text-cream sm:p-12" data-testid="my-report">
              <p className="eyebrow !text-[#e9c9b8]">Персональный разбор</p>
              <h2 className="mt-3 font-serif text-3xl font-semibold sm:text-4xl">Твой разбор уже готов</h2>
              <p className="mt-3 text-[#eadbe0]">Ссылку мы также отправили на почту, указанную при оплате.</p>
              <Link href={`/report/${paid.id}`} className="btn-primary mt-7 text-lg">
                Открыть мой разбор
              </Link>
            </section>
          ) : (
            <Paywall
              resultId={r.id}
              price={visitor.price}
              title={app.paywall.title}
              bullets={app.paywall.bullets}
              leaks={r.leaks.map((z) => q.zones[z].name)}
              archetype={arch.name}
              refundDays={app.pricing.refund_days}
              initiallyOpen={open === "checkout"}
            />
          )}
          <FakeDoor
            source="result"
            resultId={r.id}
            name={app.fake_door.name}
            price={app.fake_door.price_rub_month}
            pitch={app.fake_door.pitch}
            initiallyOpen={open === "tracker"}
          />
        </>
      )}
    </div>
  );
}
