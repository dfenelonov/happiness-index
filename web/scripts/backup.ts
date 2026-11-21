/**
 * Бэкап базы в S3-совместимое хранилище.
 *   node --import tsx scripts/backup.ts           — один раз (cron, ручной запуск)
 *   node --import tsx scripts/backup.ts --daily   — работать постоянно, бэкап раз в сутки в backup.hour_utc
 * Настройки — BACKUP_* в .env, срок хранения — config/app.yaml → backup.retention_days.
 */
import { alert } from "../lib/alerts";
import { backupStoreFromEnv, runBackup } from "../lib/backup";
import { appConfig } from "../lib/config";

async function once() {
  const store = backupStoreFromEnv();
  if (!store) {
    console.warn("Бэкап не настроен: задай BACKUP_S3_BUCKET и ключи (или BACKUP_DIR для локальной папки).");
    return false;
  }
  const started = Date.now();
  try {
    const r = await runBackup(store, { retentionDays: appConfig().backup.retention_days });
    console.info(JSON.stringify({ event: "backup_done", store: store.name, key: r.key, bytes: r.bytes, deleted: r.deleted.length, ms: Date.now() - started }));
    return true;
  } catch (e) {
    console.error(JSON.stringify({ event: "backup_failed", error: (e as Error).message.slice(0, 300) }));
    await alert("backup_failed", `бэкап базы не удался: ${(e as Error).message.slice(0, 200)}`);
    return false;
  }
}

function msUntilNext(hourUtc: number, now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

async function main() {
  if (!process.argv.includes("--daily")) {
    process.exit((await once()) ? 0 : 1);
  }
  if (!backupStoreFromEnv()) {
    console.warn("Бэкап не настроен — сервис бэкапа завершается. Настрой BACKUP_* и перезапусти.");
    await alert("backup_not_configured", "бэкапы базы не настроены (BACKUP_S3_*) — данные не копируются");
    process.exit(0);
  }
  await once(); // сразу при старте — чтобы сразу увидеть, что настройки верные
  for (;;) {
    const wait = msUntilNext(appConfig().backup.hour_utc);
    console.info(JSON.stringify({ event: "backup_scheduled", in_minutes: Math.round(wait / 60000) }));
    await new Promise((r) => setTimeout(r, wait));
    await once();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
