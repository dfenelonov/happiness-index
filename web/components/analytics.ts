"use client";

// Клиентские события: на сервер (основной источник метрик) и в Яндекс Метрику, если она загружена.

declare global {
  interface Window {
    ym?: (id: number, method: string, ...args: unknown[]) => void;
    __hiYmId?: number;
  }
}

export function track(name: string, props: Record<string, unknown> = {}) {
  try {
    fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, props }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // аналитика не должна ломать интерфейс
  }
  reachGoal(name, props);
}

/** Только Метрика — для событий, которые сервер уже записал сам. */
export function reachGoal(name: string, props: Record<string, unknown> = {}) {
  if (window.ym && window.__hiYmId) window.ym(window.__hiYmId, "reachGoal", name, props);
}
