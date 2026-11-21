"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type Status = { report: string; attempt: number; maxAttempts: number; startedAt: string | null };

/** Экран «Готовим твой разбор…»: опрашивает статус, показывает шаги и попытку, обновляет страницу по готовности. */
export function ReportProgress({ orderId, email, initial }: { orderId: string; email: string; initial: Status }) {
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [now, setNow] = useState(() => Date.now());
  const [opened] = useState(() => Date.now());

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/report/${orderId}/status`, { cache: "no-store" });
        const next = (await res.json()) as Status;
        if (!stopped) setS(next);
        if (next.report === "ready") {
          router.refresh();
          return;
        }
      } catch {}
      if (!stopped) setTimeout(tick, 2000);
    };
    const t = setTimeout(tick, 1500);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopped = true;
      clearTimeout(t);
      clearInterval(clock);
    };
  }, [orderId, router]);

  const since = s.startedAt ? Date.parse(s.startedAt) : opened;
  const elapsed = Math.max(0, Math.round((now - since) / 1000));
  const generating = s.report === "pending" && s.attempt > 0;
  const steps = [
    { label: "Оплата подтверждена", state: "done" },
    {
      label: generating
        ? s.attempt > 1
          ? `Собираем разбор по твоим ответам — пробуем ещё раз (попытка ${s.attempt} из ${s.maxAttempts})`
          : "Собираем разбор по твоим ответам"
        : "Разбор в очереди на сборку",
      state: "active",
    },
    { label: "Разбор готов — откроется здесь автоматически", state: "todo" },
  ];

  return (
    <div data-testid="report-progress">
      <ol className="mx-auto mt-8 max-w-sm space-y-3 text-left">
        {steps.map((step) => (
          <li key={step.label} className="flex items-start gap-3">
            <span
              className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${
                step.state === "done" ? "bg-sage text-white" : step.state === "active" ? "pulse-soft bg-accent text-white" : "border border-line text-muted"
              }`}
            >
              {step.state === "done" ? "✓" : step.state === "active" ? "…" : ""}
            </span>
            <span className={step.state === "todo" ? "text-muted" : ""}>{step.label}</span>
          </li>
        ))}
      </ol>
      <p className="mt-6 rounded-2xl bg-[#fff6e8] px-4 py-3 text-sm" data-testid="report-eta">
        Обычно 1–2 минуты. Можно закрыть вкладку — ссылка придёт на почту <b>{email}</b>.
      </p>
      <p className="mt-3 text-xs text-muted tabular-nums" data-testid="report-elapsed">
        Прошло {Math.floor(elapsed / 60) ? `${Math.floor(elapsed / 60)} мин ` : ""}
        {elapsed % 60} с
      </p>
    </div>
  );
}
