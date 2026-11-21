import Link from "next/link";
import { IndexGauge } from "@/components/IndexGauge";
import { TrackVisit } from "@/components/Track";
import { appConfig, questionnaire } from "@/lib/config";

const STEPS = [
  { n: "01", title: "Отвечаешь на 28 вопросов", text: "О том, как ты живёшь сейчас: сон, люди, работа, деньги, смысл. По одному на экран, около пяти минут." },
  { n: "02", title: "Получаешь индекс и тип", text: "Личный индекс счастья от 0 до 100, свой тип из восьми и сравнение с другими участниками." },
  { n: "03", title: "Видишь, где утекает счастье", text: "Три зоны, которые сильнее всего отнимают силы прямо сейчас, — с них и стоит начинать." },
];

const FAQ = [
  {
    q: "Это правда бесплатно?",
    a: "Да. Тест, индекс, тип личности и три главные утечки — бесплатно и без регистрации. Платный только полный разбор, если захочешь углубиться.",
  },
  {
    q: "На чём основан тест?",
    a: "Вопросы об удовлетворённости жизнью и утечках счастья написаны командой проекта. Оси типа личности опираются на модель Большой пятёрки (пункты IPIP — открытая база вопросов). Это не клинический инструмент, а способ посмотреть на себя со стороны.",
  },
  {
    q: "Нужно ли оставлять email или телефон?",
    a: "Нет. Тест анонимный. Email понадобится только если ты решишь купить полный разбор — чтобы прислать чек и ссылку.",
  },
  {
    q: "Что будет в полном разборе?",
    a: "Подробный разбор по твоим ответам, объяснение, почему именно эти утечки, советы для твоего типа и план на 30 дней. Его можно скачать в PDF.",
  },
  {
    q: "Это психологическая консультация?",
    a: "Нет. Это не медицинская и не психологическая услуга, а тест для самопознания. Если тебе тяжело долгое время, лучше поговорить со специалистом.",
  },
];

export default function Landing() {
  const app = appConfig();
  const q = questionnaire();
  const happy = Math.round(q.country.share_happy * 100);
  return (
    <>
      <TrackVisit />
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 pt-8 pb-16 sm:px-8 lg:grid-cols-[1.15fr_0.85fr] lg:pt-16">
        <div className="rise">
          <p className="eyebrow">Тест · 28 вопросов · бесплатно</p>
          <h1 className="mt-5 font-serif text-4xl leading-[1.08] font-semibold tracking-tight sm:text-6xl">{app.landing.headline}</h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted sm:text-xl">
            {app.landing.subheadline}. Узнай свой личный индекс, тип личности и три главные утечки счастья.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-4">
            <Link href="/test" className="btn-primary text-lg" data-testid="start-test">
              Пройти тест
              <span aria-hidden>→</span>
            </Link>
            <span className="text-sm text-muted">Результат — сразу после теста</span>
          </div>
        </div>
        <div className="rise rise-2">
          <SampleCard />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
        <p className="eyebrow">Как это работает</p>
        <div className="mt-6 grid gap-5 md:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="card p-7">
              <div className="font-serif text-3xl text-accent">{s.n}</div>
              <h3 className="mt-4 text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 leading-relaxed text-muted">{s.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
        <div className="card grid gap-10 overflow-hidden p-8 sm:p-12 lg:grid-cols-2">
          <div>
            <p className="eyebrow">Пример результата</p>
            <h2 className="mt-4 font-serif text-3xl font-semibold sm:text-4xl">Не просто цифра, а карта твоих сил</h2>
            <p className="mt-4 leading-relaxed text-muted">
              Индекс показывает, насколько ты доволен жизнью сейчас. Тип объясняет, откуда ты берёшь энергию. А утечки — где
              она уходит. Плюс сравнение с Россией: по данным {q.country.source_name} ({q.country.period}), счастливыми себя
              называют {happy}% россиян.
            </p>
            <ul className="mt-6 space-y-3">
              {[
                ["Индекс", "64 из 100 — счастливее 58% участников"],
                ["Тип", "Тихий исследователь: черпает силы в тишине и любопытстве"],
                ["Утечки", "сон и энергия · деньги · смысл"],
              ].map(([k, v]) => (
                <li key={k} className="flex gap-3">
                  <span className="w-20 shrink-0 text-sm font-semibold text-accent">{k}</span>
                  <span className="text-ink/90">{v}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="grid place-items-center rounded-3xl bg-gradient-to-br from-[#fdeee2] via-[#fbe3dc] to-[#f1dde8] p-8">
            <IndexGauge value={64} size={300} />
            <p className="mt-4 font-serif text-2xl font-semibold">Тихий исследователь</p>
            <p className="text-sm text-muted">«Разбираюсь в сути»</p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-5 py-14 sm:px-8">
        <p className="eyebrow text-center">Вопросы</p>
        <h2 className="mt-4 text-center font-serif text-3xl font-semibold sm:text-4xl">Частые вопросы</h2>
        <div className="mt-8 space-y-3">
          {FAQ.map((f) => (
            <details key={f.q} className="card group p-6 [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-lg font-semibold">
                {f.q}
                <span className="text-accent transition-transform group-open:rotate-45" aria-hidden>+</span>
              </summary>
              <p className="mt-3 leading-relaxed text-muted">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-10 text-center sm:px-8">
        <h2 className="font-serif text-3xl font-semibold sm:text-4xl">Пять минут — и ты знаешь, где твоё счастье теряется</h2>
        <Link href="/test" className="btn-primary mt-8 text-lg">Пройти тест</Link>
      </section>
    </>
  );
}

function SampleCard() {
  return (
    <div className="card relative mx-auto max-w-sm p-8">
      <div className="absolute -top-3 right-6 rounded-full bg-ink px-3 py-1 text-xs font-medium text-cream">пример</div>
      <p className="eyebrow">Твой индекс счастья</p>
      <div className="mt-4">
        <IndexGauge value={72} size={260} />
      </div>
      <p className="mt-5 text-center text-sm text-muted">Ты счастливее 68% участников</p>
      <div className="mt-6 space-y-2.5">
        {[
          ["Сон и энергия", 38],
          ["Деньги", 50],
          ["Смысл", 63],
        ].map(([name, v]) => (
          <div key={name as string}>
            <div className="flex justify-between text-sm">
              <span>{name}</span>
              <span className="text-muted">{v}</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-line">
              <div className="h-1.5 rounded-full bg-gradient-to-r from-plum to-accent" style={{ width: `${v}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
