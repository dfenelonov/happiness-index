"use client";

import { useEffect } from "react";
import { CONSENT_EVENT, readConsent } from "./CookieBanner";

/** Яндекс Метрика: только если задан YM_COUNTER_ID и посетитель принял аналитические cookie. */
export function Metrika({ counterId }: { counterId?: string }) {
  useEffect(() => {
    const id = Number(counterId);
    if (!id) return;
    const load = () => {
      if (readConsent() !== "all" || window.__hiYmId) return;
      window.__hiYmId = id;
      const w = window as unknown as { ym: { (...a: unknown[]): void; a?: unknown[]; l?: number } };
      w.ym = function (...args: unknown[]) {
        (w.ym.a = w.ym.a || []).push(args);
      } as typeof w.ym;
      w.ym.l = Date.now();
      const s = document.createElement("script");
      s.async = true;
      s.src = "https://mc.yandex.ru/metrika/tag.js";
      document.head.appendChild(s);
      w.ym(id, "init", { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: false });
    };
    load();
    window.addEventListener(CONSENT_EVENT, load);
    return () => window.removeEventListener(CONSENT_EVENT, load);
  }, [counterId]);
  return null;
}
