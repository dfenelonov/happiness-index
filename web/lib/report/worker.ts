import { checkStuckReports } from "../alerts";
import { appConfig } from "../config";
import { dueReportOrders, emailReport, generateReport, unsentReportEmails, type GenerateDeps } from "./generate";

// Фоновый воркер отчётов в процессе сервера. Запускается при старте (instrumentation.ts), проходит
// по оплаченным заказам без отчёта сразу и раз в worker_interval_seconds; вебхук оплаты и страница
// ожидания «будят» его, не дожидаясь интервала. Один проход за раз; повторную генерацию
// одного заказа исключает «захват» строки в generateReport.

type State = { timer: NodeJS.Timeout | null; running: Promise<number> | null; again: boolean };
const g = globalThis as unknown as { __hiReportWorker?: State };
const state = (g.__hiReportWorker ??= { timer: null, running: null, again: false });

/** Один проход: сгенерировать всё, что ждёт. Возвращает число сгенерированных отчётов. */
export async function runReportWorker(deps: GenerateDeps = {}): Promise<number> {
  let done = 0;
  for (const orderId of await dueReportOrders()) {
    try {
      if (await generateReport(orderId, deps)) done++;
    } catch (e) {
      console.error(JSON.stringify({ event: "report_worker_error", order_id: orderId, error: (e as Error).message.slice(0, 300) }));
    }
  }
  for (const { id, email } of await unsentReportEmails()) await emailReport(id, email); // повтор упавших писем
  await checkStuckReports(); // оплачен, а отчёта всё нет — алерт
  return done;
}

/** Разбудить воркер. Если проход уже идёт — после него будет ещё один (вдруг заказ пришёл в середине). */
export function kickReportWorker(): Promise<number> {
  if (state.running) {
    state.again = true;
    return state.running;
  }
  state.running = (async () => {
    let total = 0;
    do {
      state.again = false;
      total += await runReportWorker();
    } while (state.again);
    return total;
  })().finally(() => {
    state.running = null;
  });
  return state.running;
}

export function startReportWorker() {
  if (state.timer) return;
  const every = appConfig().report.worker_interval_seconds * 1000;
  void kickReportWorker();
  state.timer = setInterval(() => void kickReportWorker(), every);
  state.timer.unref?.();
  console.info(JSON.stringify({ event: "report_worker_started", interval_s: every / 1000 }));
}
