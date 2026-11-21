// Хуки старта сервера Next.js: проверка окружения production, фоновые задачи, учёт ошибок.
// В dev Next собирает этот файл и для edge-рантайма: импорты node-кода — только внутри
// if (NEXT_RUNTIME === "nodejs"), иначе webpack тянет nodemailer и т. п. в edge-бандл.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}

/** Необработанные ошибки рендера и маршрутов — в счётчик всплеска 5xx (алерт). */
export async function onRequestError() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { record5xx } = await import("./instrumentation-node");
    record5xx();
  }
}
