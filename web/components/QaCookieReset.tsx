"use client";

import { CONSENT_KEY } from "./CookieBanner";

/** Сбросить выбор по cookie и открыть лендинг — баннер покажется снова. */
export function QaCookieReset() {
  return (
    <button
      type="button"
      className="underline"
      onClick={() => {
        try {
          localStorage.removeItem(CONSENT_KEY);
        } catch {}
        window.location.href = "/";
      }}
    >
      Лендинг с cookie-баннером (сбросить выбор)
    </button>
  );
}
