"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export const CONSENT_KEY = "hi_cookie_consent";
export const CONSENT_EVENT = "hi-cookie-consent";

export function readConsent(): string | null {
  try {
    return localStorage.getItem(CONSENT_KEY);
  } catch {
    return null;
  }
}

/** Необходимые cookie работают всегда; аналитические (Метрика) — только после «Принять». */
export function CookieBanner() {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(readConsent() === null), []);
  if (!open) return null;

  const choose = (value: "all" | "necessary") => {
    try {
      localStorage.setItem(CONSENT_KEY, value);
    } catch {}
    window.dispatchEvent(new Event(CONSENT_EVENT));
    setOpen(false);
  };

  return (
    <div className="fixed inset-x-3 bottom-3 z-50 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:max-w-md" role="dialog" aria-label="Cookie">
      <div className="card rise p-5 text-sm">
        <p className="leading-relaxed">
          Мы используем cookie, чтобы сохранять прогресс теста и считать посещаемость. Аналитику включим только с
          твоего согласия. <Link href="/legal/privacy" className="underline">Подробнее</Link>
        </p>
        <div className="mt-4 flex gap-2">
          <button className="btn-primary !px-5 !py-2.5 text-sm" onClick={() => choose("all")}>Принять</button>
          <button className="btn-ghost text-sm" onClick={() => choose("necessary")}>Только необходимые</button>
        </div>
      </div>
    </div>
  );
}
