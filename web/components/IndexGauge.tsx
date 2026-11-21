"use client";

import { useEffect, useState } from "react";

/** Полукруглая шкала 0–100: дуга дорисовывается, число считает вверх. */
export function IndexGauge({ value, size = 280, animate = true }: { value: number; size?: number; animate?: boolean }) {
  const [shown, setShown] = useState(animate ? 0 : value);
  useEffect(() => {
    if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const dur = 1400;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / dur);
      setShown(Math.round(value * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, animate]);

  const r = 100;
  const len = Math.PI * r;
  const offset = len * (1 - shown / 100);
  const angle = Math.PI * (1 - shown / 100);
  const dot = { x: 120 + r * Math.cos(angle), y: 120 - r * Math.sin(angle) };

  return (
    <div className="relative mx-auto" style={{ width: size, height: size * 0.62 }} role="img" aria-label={`Индекс ${value} из 100`}>
      <svg viewBox="0 0 240 140" width={size} height={size * 0.62} aria-hidden>
        <defs>
          <linearGradient id="gauge" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#b04a6a" />
            <stop offset="55%" stopColor="#d0603f" />
            <stop offset="100%" stopColor="#e3a04a" />
          </linearGradient>
        </defs>
        <path d="M20 120 A100 100 0 0 1 220 120" fill="none" stroke="#efe4d8" strokeWidth="16" strokeLinecap="round" />
        <path
          d="M20 120 A100 100 0 0 1 220 120"
          fill="none"
          stroke="url(#gauge)"
          strokeWidth="16"
          strokeLinecap="round"
          strokeDasharray={len}
          strokeDashoffset={offset}
        />
        {shown > 0 && <circle cx={dot.x} cy={dot.y} r="9" fill="#fffdf9" stroke="#d0603f" strokeWidth="4" />}
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <div className="font-serif text-6xl leading-none font-semibold tabular-nums" data-testid="index-value">
          {shown}
        </div>
        <div className="mt-1 text-sm text-muted">из 100</div>
      </div>
    </div>
  );
}
