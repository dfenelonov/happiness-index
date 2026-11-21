// Node-часть хуков старта (см. instrumentation.ts): сюда можно импортировать node:-модули,
// edge-сборка этот файл не видит.
import { alert, record5xx } from "./lib/alerts";
import { checksSkipped, isProduction, productionProblems, UNSAFE_WARNING } from "./lib/env-guard";
import { startReportWorker } from "./lib/report/worker";

export async function registerNode() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (isProduction()) {
    if (checksSkipped()) {
      const bar = "!".repeat(100);
      console.error(`${bar}\n!!! ${UNSAFE_WARNING}\n${bar}`);
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
  startReportWorker();
}

export { record5xx };
