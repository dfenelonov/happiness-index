"use client";

import { useState } from "react";

export function RestoreForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState("busy");
    const res = await fetch("/api/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    setMessage(data.message ?? data.error ?? "Не получилось. Попробуй ещё раз.");
    setState(res.ok ? "done" : "idle");
  };

  if (state === "done") {
    return (
      <p className="card p-6" data-testid="restore-done">
        {message}
      </p>
    );
  }
  return (
    <form onSubmit={submit} className="card p-6" data-testid="restore-form">
      <label htmlFor="restore-email" className="text-sm font-medium">
        Email, который ты указывал при оплате
      </label>
      <input
        id="restore-email"
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.ru"
        className="mt-2 w-full rounded-xl border border-line bg-white px-4 py-3 outline-none focus:border-accent"
      />
      <button type="submit" className="btn-primary mt-5" disabled={state === "busy"}>
        {state === "busy" ? "Отправляем…" : "Прислать ссылки"}
      </button>
      {message && <p className="mt-3 text-sm text-accent-dark">{message}</p>}
    </form>
  );
}
