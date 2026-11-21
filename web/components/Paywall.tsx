"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { track } from "./analytics";

type Props = {
  resultId: string;
  price: number;
  title: string;
  bullets: string[];
  leaks: string[];
  archetype: string;
  refundDays: number;
  initiallyOpen?: boolean; // ?open=checkout — для /dev/qa
};

export function Paywall({ resultId, price, title, bullets, leaks, archetype, refundDays, initiallyOpen = false }: Props) {
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(initiallyOpen);
  const [email, setEmail] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // paywall_view — когда блок действительно попал в зону видимости
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          track("paywall_view", { result_id: resultId });
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [resultId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultId, email, offerAccepted: agree }),
      });
      const data = (await res.json()) as { confirmationUrl?: string; error?: string };
      if (!res.ok || !data.confirmationUrl) throw new Error(data.error ?? "Не получилось создать платёж");
      window.location.href = data.confirmationUrl;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <section ref={ref} className="mt-8 overflow-hidden rounded-[1.75rem] bg-gradient-to-br from-[#2b1d2e] via-[#3d2440] to-[#5a2f4a] p-1" data-testid="paywall">
      <div className="grid gap-10 rounded-[1.6rem] p-8 text-cream sm:p-12 md:grid-cols-[1.1fr_0.9fr]">
        <div>
          <p className="eyebrow !text-[#e9c9b8]">Персональный разбор</p>
          <h2 className="mt-3 font-serif text-3xl font-semibold sm:text-4xl">
            {title} — <span data-testid="price">{price} ₽</span>
          </h2>
          <p className="mt-4 leading-relaxed text-[#eadbe0]">
            Почему именно {leaks.map((l) => `«${l.toLowerCase()}»`).join(", ")} и что с этим делать человеку с типом «{archetype}».
          </p>
          <ul className="mt-6 space-y-3">
            {bullets.map((b) => (
              <li key={b} className="flex gap-3">
                <span className="mt-1 text-gold">✦</span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="relative">
          <div className="pointer-events-none rounded-2xl bg-cream/95 p-6 text-ink blur-[3px] select-none" aria-hidden>
            <p className="font-serif text-xl font-semibold">Неделя 1. {leaks[0]}</p>
            <p className="mt-3 text-sm leading-relaxed">Начинаем с главной утечки: здесь изменения почувствуются быстрее всего. На этой неделе…</p>
            <p className="mt-3 text-sm leading-relaxed">• Записывай, что сегодня дало силы, а что забрало • Выбери одно маленькое изменение…</p>
          </div>
          <div className="absolute inset-0 grid place-items-center">
            {!open ? (
              <button type="button" className="btn-primary text-lg" onClick={() => setOpen(true)} data-testid="buy">
                Получить разбор за {price} ₽
              </button>
            ) : (
              <form onSubmit={submit} className="card w-full max-w-sm p-6 text-ink" data-testid="checkout-form">
                <label className="text-sm font-medium" htmlFor="email">
                  Email для чека и ссылки на разбор
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.ru"
                  className="mt-2 w-full rounded-xl border border-line bg-white px-4 py-3 outline-none focus:border-accent"
                />
                <label className="mt-4 flex gap-2.5 text-xs leading-relaxed text-muted">
                  <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} required className="mt-0.5 accent-[#c2553a]" />
                  <span>
                    Принимаю <Link href="/legal/offer" target="_blank" className="underline">оферту</Link> и даю{" "}
                    <Link href="/legal/consent" target="_blank" className="underline">согласие на обработку email</Link>
                  </span>
                </label>
                <button type="submit" className="btn-primary mt-5 w-full" disabled={busy || !agree}>
                  {busy ? "Переходим к оплате…" : `Оплатить ${price} ₽`}
                </button>
                {error && <p className="mt-3 text-sm text-accent-dark">{error}</p>}
                <p className="mt-3 text-center text-xs text-muted">Возврат в течение {refundDays} дней, если разбор не понравится</p>
              </form>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
