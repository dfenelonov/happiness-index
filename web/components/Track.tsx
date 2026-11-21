"use client";

import { useEffect, useRef } from "react";
import { reachGoal, track } from "./analytics";

/** Событие один раз при показе страницы. serverLogged — сервер уже записал, дублируем только в Метрику. */
export function TrackOnMount({ name, props, serverLogged = false }: { name: string; props?: Record<string, unknown>; serverLogged?: boolean }) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    if (serverLogged) reachGoal(name, props);
    else track(name, props);
  }, [name, props, serverLogged]);
  return null;
}

/** visit — один раз за сессию браузера. */
export function TrackVisit() {
  useEffect(() => {
    try {
      if (sessionStorage.getItem("hi_visit")) return;
      sessionStorage.setItem("hi_visit", "1");
    } catch {
      // приватный режим: шлём без дедупликации
    }
    track("visit");
  }, []);
  return null;
}
