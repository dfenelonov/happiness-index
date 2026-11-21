"use client";

import Link from "next/link";
import { useState } from "react";
import { track } from "./analytics";

/** Фейковая дверь подписки: клик — интерес, email — подтверждённый интерес. Оплаты нет. */
export function FakeDoor({ source, resultId, name, price, pitch }: { source: "result" | "report"; resultId: string; name: string; price: number; pitch: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [agree, setAgree] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const click = () => {
    track("subscription_click", { source, result_id: resultId });
    setOpen(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState("busy");
    setError(null);
    const res = await fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, consent: agree, source, resultId }),
    });
    if (res.ok) setState("done");
    else {
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Не получилось. Попробуй ещё раз.");
      setState("idle");
    }
  };

  return (
    <>
      <section className="card mt-8 flex flex-col gap-6 p-8 sm:flex-row sm:items-center sm:justify-between sm:p-10" data-testid="fake-door">
        <div>
          <p className="eyebrow">Скоро</p>
          <h3 className="mt-2 font-serif text-2xl font-semibold">
            {name} — {price} ₽/мес
          </h3>
          <p className="mt-2 max-w-xl leading-relaxed text-muted">{pitch}</p>
        </div>
        <button type="button" className="btn-ghost shrink-0" onClick={click} data-testid="fake-door-open">
          Хочу трекер
        </button>
      </section>

      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
          <div className="card rise w-full max-w-md p-8" onClick={(e) => e.stopPropagation()} data-testid="fake-door-modal">
            {state === "done" ? (
              <>
                <h3 className="font-serif text-2xl font-semibold">Спасибо!</h3>
                <p className="mt-3 text-muted">Напишем, как только {name.toLowerCase()} будет готов. Никакого спама — одно письмо о запуске.</p>
                <button type="button" className="btn-primary mt-6" onClick={() => setOpen(false)}>Хорошо</button>
              </>
            ) : (
              <form onSubmit={submit}>
                <h3 className="font-serif text-2xl font-semibold">Скоро запуск</h3>
                <p className="mt-3 text-muted">Мы как раз доделываем {name.toLowerCase()}. Оставь email — сообщим о запуске первым.</p>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.ru"
                  aria-label="Email"
                  className="mt-5 w-full rounded-xl border border-line bg-white px-4 py-3 outline-none focus:border-accent"
                />
                <label className="mt-4 flex gap-2.5 text-xs leading-relaxed text-muted">
                  <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} required className="mt-0.5 accent-[#c2553a]" />
                  <span>
                    Согласен(на) на <Link href="/legal/consent" target="_blank" className="underline">обработку email</Link> для письма о запуске
                  </span>
                </label>
                <div className="mt-6 flex gap-3">
                  <button type="submit" className="btn-primary" disabled={state === "busy" || !agree}>Сообщить о запуске</button>
                  <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Закрыть</button>
                </div>
                {error && <p className="mt-3 text-sm text-accent-dark">{error}</p>}
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
