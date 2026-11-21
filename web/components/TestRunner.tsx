"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

export type ClientQuestion = {
  id: string;
  text: string;
  section: string;
  options: { value: number | string; label: string }[];
};

type Saved = { testId: string; answers: Record<string, number | string>; position: number; pending: string[] };

const ANALYSIS_MS = 1800;

type StartResponse = { testId: string; answers: Record<string, number | string> };
// Один запрос старта на загрузку страницы: StrictMode в dev вызывает эффект дважды,
// а два параллельных старта создали бы два прохождения и два test_start.
let startRequest: { key: string; promise: Promise<StartResponse> } | null = null;

function startTest(localTestId: string | undefined): Promise<StartResponse> {
  const key = localTestId ?? "";
  if (startRequest?.key === key) return startRequest.promise;
  const promise = fetch("/api/test/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ testId: localTestId }),
  }).then(async (res) => {
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as StartResponse;
  });
  startRequest = { key, promise };
  const clear = () => setTimeout(() => (startRequest = null), 1000);
  promise.then(clear, clear);
  return promise;
}

function load(key: string): Saved | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

function store(key: string, s: Saved | null) {
  try {
    if (s) localStorage.setItem(key, JSON.stringify(s));
    else localStorage.removeItem(key);
  } catch {}
}

/**
 * Тест по одному вопросу на экран. Ответы — в localStorage сразу и на сервер следом;
 * неотправленные (pending) досылаются при следующем ответе или после перезагрузки.
 */
/** preview — режим для /dev/qa: показать вопрос №position или экран анализа без сервера и localStorage. */
export type TestPreview = { position: number; phase?: "question" | "analysing" };

export function TestRunner({ questions, storageKey, preview }: { questions: ClientQuestion[]; storageKey: string; preview?: TestPreview }) {
  const router = useRouter();
  const [state, setState] = useState<Saved | null>(null);
  const [phase, setPhase] = useState<"loading" | "question" | "analysing" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<Saved | null>(null);
  const advancing = useRef(false);

  const update = useCallback(
    (s: Saved) => {
      stateRef.current = s;
      if (!preview) store(storageKey, s);
      setState(s);
    },
    [storageKey, preview],
  );

  const send = useCallback(async (testId: string, questionId: string, value: number | string) => {
    const res = await fetch("/api/answers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testId, questionId, value }),
    });
    if (!res.ok) throw new Error(String(res.status));
  }, []);

  const flush = useCallback(async () => {
    const s = stateRef.current;
    if (!s || s.pending.length === 0) return true;
    const left: string[] = [];
    for (const id of s.pending) {
      try {
        await send(s.testId, id, s.answers[id]);
      } catch {
        left.push(id);
      }
    }
    const cur = stateRef.current!;
    update({ ...cur, pending: cur.pending.filter((id) => left.includes(id) || !s.pending.includes(id)) });
    return left.length === 0;
  }, [send, update]);

  // Старт или продолжение: сервер знает свои ответы, localStorage — то, что могло не доехать.
  useEffect(() => {
    if (preview) {
      update({ testId: "preview", answers: {}, position: preview.position, pending: [] });
      setPhase(preview.phase ?? "question");
      return;
    }
    let cancelled = false;
    (async () => {
      const local = load(storageKey);
      try {
        const { testId, answers } = await startTest(local?.testId);
        if (cancelled) return;
        const sameTest = local?.testId === testId;
        const merged = { ...(sameTest ? local!.answers : {}), ...answers };
        const pending = sameTest ? Object.keys(local!.answers).filter((id) => !(id in answers)) : [];
        const firstEmpty = questions.findIndex((q) => !(q.id in merged));
        const position = sameTest ? Math.min(local!.position, firstEmpty < 0 ? questions.length - 1 : firstEmpty) : Math.max(firstEmpty, 0);
        update({ testId, answers: merged, position, pending });
        setPhase("question");
        if (pending.length) void flush();
      } catch {
        if (!cancelled) {
          setPhase("error");
          setError("Не получилось начать тест. Проверь интернет и обнови страницу.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [questions, storageKey, update, flush, preview]);

  const finish = useCallback(async () => {
    setPhase("analysing");
    if (preview) return; // в превью экран анализа остаётся на месте
    const started = Date.now();
    try {
      if (!(await flush())) throw new Error("pending");
      const res = await fetch("/api/test/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testId: stateRef.current!.testId }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const { resultId } = (await res.json()) as { resultId: string };
      await new Promise((r) => setTimeout(r, Math.max(0, ANALYSIS_MS - (Date.now() - started))));
      store(storageKey, null);
      router.push(`/result/${resultId}`);
    } catch {
      setPhase("question");
      setError("Не удалось сохранить ответы. Проверь интернет и нажми ещё раз.");
    }
  }, [flush, router, storageKey, preview]);

  const answer = useCallback(
    (value: number | string) => {
      const s = stateRef.current;
      if (!s || advancing.current) return;
      const q = questions[s.position];
      advancing.current = true;
      setError(null);
      const isLast = s.position === questions.length - 1;
      const next: Saved = {
        ...s,
        answers: { ...s.answers, [q.id]: value },
        pending: preview || s.pending.includes(q.id) ? s.pending : [...s.pending, q.id],
      };
      update(next);
      if (!preview) void flush();
      setTimeout(() => {
        advancing.current = false;
        if (isLast) void finish();
        else update({ ...stateRef.current!, position: stateRef.current!.position + 1 });
      }, 260);
    },
    [questions, update, flush, finish, preview],
  );

  const back = () => {
    const s = stateRef.current;
    if (s && s.position > 0) update({ ...s, position: s.position - 1 });
  };

  // Клавиатура: 1–5 — ответ, ← — назад
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = stateRef.current;
      if (phase !== "question" || !s) return;
      const q = questions[s.position];
      const i = Number(e.key) - 1;
      if (i >= 0 && i < q.options.length) answer(q.options[i].value);
      if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (phase === "loading") {
    return <div className="mx-auto max-w-2xl px-5 py-24 text-center text-muted">Готовим вопросы…</div>;
  }
  if (phase === "error" || !state) {
    return <div className="mx-auto max-w-2xl px-5 py-24 text-center">{error}</div>;
  }
  if (phase === "analysing") {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center px-5 py-28 text-center" data-testid="analysing">
        <div className="pulse-soft h-20 w-20 rounded-full bg-gradient-to-br from-gold via-accent to-plum" />
        <h2 className="mt-8 font-serif text-3xl font-semibold">Анализируем твои ответы…</h2>
        <p className="mt-3 text-muted">Считаем индекс, определяем тип и ищем утечки счастья</p>
      </div>
    );
  }

  const q = questions[state.position];
  const current = state.answers[q.id];
  const done = Object.keys(state.answers).length;
  const progress = Math.round((done / questions.length) * 100);
  const answeredAll = questions.every((x) => x.id in state.answers);

  return (
    <div className="mx-auto max-w-2xl px-5 pt-4 pb-16 sm:px-8">
      <div className="flex items-center justify-between text-sm text-muted">
        <span data-testid="progress-label">
          Вопрос {state.position + 1} из {questions.length}
        </span>
        <span>{progress}%</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-2 rounded-full bg-gradient-to-r from-plum via-accent to-gold transition-all duration-500" style={{ width: `${progress}%` }} />
      </div>

      <div key={q.id} className="card rise mt-8 p-7 sm:p-10">
        <p className="eyebrow">{q.section}</p>
        <h1 className="mt-4 font-serif text-2xl leading-snug font-semibold sm:text-3xl" data-testid="question-text">
          {q.text}
        </h1>
        <div className="mt-8 grid gap-2.5">
          {q.options.map((o, i) => {
            const selected = current === o.value;
            return (
              <button
                key={String(o.value)}
                type="button"
                onClick={() => answer(o.value)}
                data-testid="answer-option"
                aria-pressed={selected}
                className={`group flex items-center gap-4 rounded-2xl border px-5 py-4 text-left transition-all duration-200 ${
                  selected ? "border-accent bg-[#fdf0e8] shadow-sm" : "border-line bg-paper hover:-translate-y-px hover:border-[#dcc4b2] hover:bg-[#fffaf4]"
                }`}
              >
                <span
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border text-xs font-semibold transition-colors ${
                    selected ? "border-accent bg-accent text-white" : "border-line text-muted group-hover:border-accent/50"
                  }`}
                >
                  {i + 1}
                </span>
                <span className="text-[1.02rem]">{o.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <button type="button" onClick={back} disabled={state.position === 0} className="btn-ghost text-sm disabled:opacity-40" data-testid="back">
          ← Назад
        </button>
        {state.position === questions.length - 1 && answeredAll && (
          <button type="button" onClick={() => void finish()} className="btn-primary text-sm">
            Узнать результат
          </button>
        )}
      </div>
      {error && <p className="mt-4 text-center text-sm text-accent-dark">{error}</p>}
      <p className="mt-8 text-center text-xs text-muted">Ответы сохраняются — можно закрыть вкладку и продолжить позже.</p>
    </div>
  );
}
