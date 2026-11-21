import type { Metadata } from "next";
import { breakdown, funnelMetrics, questionReach, type Color, type Metric } from "@/lib/admin-metrics";
import { archetypeCounts, loadEvents, loadLeads, loadOrders, reportStats, revenueByVariant } from "@/lib/admin-data";
import { appConfig, questionnaire } from "@/lib/config";

export const metadata: Metadata = { title: "Админка — Индекс счастья", robots: { index: false } };
export const dynamic = "force-dynamic";

const STEP_NAMES: Record<string, string> = {
  visit: "Визит",
  test_start: "Начал тест",
  test_complete: "Завершил тест",
  result_view: "Увидел результат",
  share_click: "Поделился",
  paywall_view: "Увидел пейволл",
  checkout_start: "Начал оплату",
  payment_success: "Оплатил",
  subscription_click: "Клик «подписка»",
  email_submit: "Оставил email",
};

const COLORS: Record<Color, string> = {
  green: "bg-[#e3f1e4] text-[#2f6b36] border-[#bcdcbf]",
  yellow: "bg-[#fbf1d9] text-[#8a6212] border-[#efd9a3]",
  red: "bg-[#fbe2dc] text-[#9b3320] border-[#f0bfb2]",
  gray: "bg-[#f1ece7] text-muted border-line",
};

const pct = (v: number | null, digits = 1) => (v === null ? "—" : `${(v * 100).toFixed(digits)}%`);
const dt = (s: string | null) => (s ? s.replace("T", " ").slice(0, 16) : "—");

export default async function Admin({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const period = await searchParams;
  const cfg = appConfig().metrics;
  const q = questionnaire();
  const [events, orders, leads, revenue, archetypes, reports] = await Promise.all([
    loadEvents(period),
    loadOrders(period),
    loadLeads(period),
    revenueByVariant(period),
    archetypeCounts(),
    reportStats(),
  ]);
  const sec = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} с`);
  const { steps, metrics } = funnelMetrics(events, cfg);
  const byPrice = breakdown(events, cfg, "priceVariant");
  const byUtm = breakdown(events, cfg, "utmSource");
  const reach = questionReach(events, q.questions.length);
  const top = steps[0].visitors || 1;
  const archTotal = archetypes.reduce((s, a) => s + a.n, 0);
  const completedByVariant = new Map(byPrice.map((g) => [g.group, g.steps.find((s) => s.name === "test_complete")!.visitors]));

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-5 pb-10 sm:px-8" data-testid="admin">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Эксперимент MVP</p>
          <h1 className="mt-2 font-serif text-4xl font-semibold">Админка</h1>
          <p className="mt-1 text-sm text-muted">Посетители — уникальные anon_id. Seed-результаты в метрики не входят. Даты — UTC.</p>
          <p className="mt-1 text-sm">
            <a href="/dev/qa" className="underline">QA-галерея</a> · <a href="/dev/mailbox" className="underline">Почтовый ящик (мок)</a>
          </p>
        </div>
        <form className="flex flex-wrap items-end gap-2 text-sm">
          <label className="grid gap-1">
            с <input type="date" name="from" defaultValue={period.from} className="rounded-lg border border-line bg-white px-3 py-2" />
          </label>
          <label className="grid gap-1">
            по <input type="date" name="to" defaultValue={period.to} className="rounded-lg border border-line bg-white px-3 py-2" />
          </label>
          <button className="btn-ghost !py-2">Показать</button>
        </form>
      </div>

      <section className="grid gap-4 md:grid-cols-4">
        {metrics.map((m) => (
          <MetricCard key={m.key} m={m} />
        ))}
      </section>

      <section className="card p-6">
        <h2 className="font-serif text-2xl font-semibold">Воронка</h2>
        <div className="mt-4 space-y-2">
          {steps.map((s) => (
            <div key={s.name} className="grid grid-cols-[11rem_1fr_6rem] items-center gap-3 text-sm">
              <span>{STEP_NAMES[s.name]}</span>
              <div className="h-5 rounded bg-line/60">
                <div className="h-5 rounded bg-gradient-to-r from-plum to-accent" style={{ width: `${(s.visitors / top) * 100}%` }} />
              </div>
              <span className="text-right tabular-nums">{s.visitors}</span>
            </div>
          ))}
        </div>
      </section>

      <Breakdown title="По вариантам цены" groups={byPrice} extra={(g) => {
        const r = revenue.find((x) => String(x.variant) === g);
        const done = completedByVariant.get(g) ?? 0;
        return `выручка ${r?.revenue ?? 0} ₽ · на завершившего ${done ? ((r?.revenue ?? 0) / done).toFixed(1) : "—"} ₽`;
      }} />
      <Breakdown title="По источникам (utm_source)" groups={byUtm} />

      <section className="card overflow-x-auto p-6">
        <h2 className="font-serif text-2xl font-semibold">Где отваливаются</h2>
        <p className="mt-1 text-sm text-muted">Сколько прохождений дошло до вопроса (от числа стартов) и сколько ушло после предыдущего.</p>
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1.5 pr-3">№</th>
              <th className="pr-3">Вопрос</th>
              <th className="pr-3 text-right">Дошли</th>
              <th className="pr-3 text-right">От стартов</th>
              <th className="text-right">Ушли</th>
            </tr>
          </thead>
          <tbody>
            {reach.map((r) => (
              <tr key={r.n} className="border-t border-line">
                <td className="py-1.5 pr-3 tabular-nums">{r.n}</td>
                <td className="max-w-md truncate pr-3">{q.questions[r.n - 1].text}</td>
                <td className="pr-3 text-right tabular-nums">{r.reached}</td>
                <td className="pr-3 text-right tabular-nums">{pct(r.share, 0)}</td>
                <td className={`text-right tabular-nums ${r.drop !== null && r.drop > 0.05 ? "font-semibold text-accent-dark" : ""}`}>{pct(r.drop, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card p-6" data-testid="report-stats">
        <h2 className="font-serif text-2xl font-semibold">Отчёты (за всё время)</h2>
        <p className="mt-1 text-sm text-muted">Время генерации — по нему подбирается таймаут LLM (`config/app.yaml` → `report`).</p>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-4">
          <div>Готово: <b>{reports.ready}</b>{reports.providers && <span className="text-muted"> · {reports.providers}</span>}</div>
          <div>
            Запасных (шаблоны): <b>{reports.fallback}</b> · с повтором: <b>{reports.retried}</b>
          </div>
          <div>
            Время: медиана <b>{sec(reports.p50)}</b>, p95 <b>{sec(reports.p95)}</b>, макс {sec(reports.max)}
          </div>
          <div className={reports.pending || reports.failed ? "font-semibold text-accent-dark" : ""}>
            В работе: {reports.pending} · упали: {reports.failed}
          </div>
        </div>
      </section>

      <section className="card p-6">
        <h2 className="font-serif text-2xl font-semibold">Типы (все настоящие результаты)</h2>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {q.archetypes.map((a) => {
            const n = archetypes.find((x) => x.archetype === a.id)?.n ?? 0;
            return (
              <div key={a.id} className="flex justify-between text-sm">
                <span>{a.name}</span>
                <span className="tabular-nums text-muted">
                  {n} · {archTotal ? pct(n / archTotal, 0) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card overflow-x-auto p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-2xl font-semibold">Заказы</h2>
          <Exports />
        </div>
        <table className="mt-4 w-full text-sm" data-testid="orders">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1.5 pr-3">Создан</th>
              <th className="pr-3">Email</th>
              <th className="pr-3 text-right">Сумма</th>
              <th className="pr-3">Статус</th>
              <th className="pr-3">Провайдер</th>
              <th>Источник</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-t border-line">
                <td className="py-1.5 pr-3 whitespace-nowrap">{dt(o.createdAt)}</td>
                <td className="pr-3">{o.email}</td>
                <td className="pr-3 text-right tabular-nums">{o.amountRub} ₽</td>
                <td className="pr-3">{{ pending: "ожидает", paid: "оплачен", failed: "отказ" }[o.status]}</td>
                <td className="pr-3">{o.provider}</td>
                <td>{o.utmSource ?? "—"}</td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={6} className="py-3 text-muted">Заказов пока нет</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto p-6">
        <h2 className="font-serif text-2xl font-semibold">Email из «Трекера счастья»</h2>
        <table className="mt-4 w-full text-sm" data-testid="leads">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1.5 pr-3">Когда</th>
              <th className="pr-3">Email</th>
              <th className="pr-3">Где</th>
              <th>Цена</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id} className="border-t border-line">
                <td className="py-1.5 pr-3 whitespace-nowrap">{dt(l.createdAt)}</td>
                <td className="pr-3">{l.email}</td>
                <td className="pr-3">{l.source === "report" ? "отчёт" : "результат"}</td>
                <td>{l.priceVariant ?? "—"}</td>
              </tr>
            ))}
            {leads.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 text-muted">Пока пусто</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function MetricCard({ m }: { m: Metric }) {
  return (
    <div className={`rounded-2xl border p-5 ${COLORS[m.color]}`} data-testid={`metric-${m.key}`} data-color={m.color}>
      <p className="text-sm font-medium">{m.name}</p>
      <p className="mt-2 font-serif text-4xl font-semibold">{pct(m.value)}</p>
      <p className="mt-1 text-xs opacity-80">
        {m.num} из {m.den}
        {m.ci && ` · 95% ДИ ${pct(m.ci[0])}–${pct(m.ci[1])}`}
      </p>
      <p className="mt-2 text-xs opacity-80">
        цель ≥ {pct(m.go)}
        {m.stop !== null && ` · стоп < ${pct(m.stop)}`}
      </p>
    </div>
  );
}

function Breakdown({ title, groups, extra }: { title: string; groups: ReturnType<typeof breakdown>; extra?: (group: string) => string }) {
  return (
    <section className="card overflow-x-auto p-6">
      <h2 className="font-serif text-2xl font-semibold">{title}</h2>
      <table className="mt-4 w-full text-sm">
        <thead className="text-left text-muted">
          <tr>
            <th className="py-1.5 pr-3">Группа</th>
            <th className="pr-3 text-right">Визиты</th>
            <th className="pr-3 text-right">Завершили</th>
            {groups[0]?.metrics.map((m) => (
              <th key={m.key} className="pr-3 text-right">{m.name}</th>
            ))}
            {extra && <th className="text-right">Деньги</th>}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.group} className="border-t border-line">
              <td className="py-1.5 pr-3 font-medium">{g.group}</td>
              <td className="pr-3 text-right tabular-nums">{g.steps[0].visitors}</td>
              <td className="pr-3 text-right tabular-nums">{g.steps[2].visitors}</td>
              {g.metrics.map((m) => (
                <td key={m.key} className="pr-3 text-right tabular-nums">
                  <span className={`rounded px-1.5 py-0.5 ${COLORS[m.color]}`}>{pct(m.value)}</span>
                  <span className="ml-1 text-xs text-muted">{m.num}/{m.den}</span>
                </td>
              ))}
              {extra && <td className="text-right text-xs whitespace-nowrap text-muted">{extra(g.group)}</td>}
            </tr>
          ))}
          {groups.length === 0 && (
            <tr>
              <td colSpan={8} className="py-3 text-muted">Нет данных за период</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function Exports() {
  return (
    <div className="flex flex-wrap gap-2 text-sm">
      {["orders", "leads", "events", "results"].map((t) => (
        <a key={t} href={`/api/admin/export/${t}`} className="btn-ghost !px-3 !py-1.5">
          {t}.csv
        </a>
      ))}
    </div>
  );
}
