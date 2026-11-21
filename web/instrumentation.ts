// Хуки старта сервера Next.js: проверка окружения production, фоновые задачи, учёт ошибок.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { checksSkipped, isProduction, productionProblems } = await import("./lib/env-guard");
  if (isProduction()) {
    if (checksSkipped()) {
      console.warn("⚠ UNSAFE_SKIP_PRODUCTION_CHECKS=true — проверки production отключены. Только для CI и локальных прогонов.");
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
}
