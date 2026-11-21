"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Опрашивает статус заказа/отчёта и обновляет серверную страницу, когда что-то изменилось. */
export function StatusPoller({ orderId, until }: { orderId: string; until: "paid" | "ready" }) {
  const router = useRouter();
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/report/${orderId}/status`, { cache: "no-store" });
        const s = (await res.json()) as { order: string; report: string };
        const done = until === "paid" ? s.order !== "pending" : s.report === "ready" || s.report === "failed";
        if (done) {
          router.refresh();
          return;
        }
      } catch {}
      if (!stopped) setTimeout(tick, 1500);
    };
    const t = setTimeout(tick, 1000);
    return () => {
      stopped = true;
      clearTimeout(t);
    };
  }, [orderId, until, router]);
  return null;
}
