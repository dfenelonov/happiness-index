// Хуки старта сервера Next.js: проверка окружения production, фоновые задачи, учёт ошибок.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { checksSkipped, isProduction, productionProblems, UNSAFE_WARNING } = await import("./lib/env-guard");
  if (isProduction()) {
    if (checksSkipped()) {
      const bar = "!".repeat(100);
      console.error(`${bar}\n!!! ${UNSAFE_WARNING}\n${bar}`);
      const { alert } = await import("./lib/alerts");
      await alert("unsafe_production", UNSAFE_WARNING);
    } else {
      const problems = productionProblems();
      if (problems.length) {
        console.error(`Запуск в production остановлен. Исправь .env:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
        process.exit(1);
      }
    }
    if ((process.env.MAIL_PROVIDER || "mock") !== "smtp") {
      console.warn("⚠ MAIL_PROVIDER не smtp — письма со ссылкой на разбор не уходят покупателям.");
    }
  }
  const { startReportWorker } = await import("./lib/report/worker");
  startReportWorker();
}

/** Необработанные ошибки рендера и маршрутов — в счётчик всплеска 5xx (алерт). */
export async function onRequestError() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { record5xx } = await import("./lib/alerts");
  record5xx();
}
