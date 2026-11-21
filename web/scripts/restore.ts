/**
 * Восстановление базы из бэкапа.
 *   node --import tsx scripts/restore.ts --list                       — список дампов
 *   node --import tsx scripts/restore.ts --latest --to /tmp/check.db  — проверочное восстановление
 *   node --import tsx scripts/restore.ts --key <ключ> --to /data/app.db --force   — боевое (приложение остановлено!)
 * Перед заменой дамп проверяется (integrity_check, число строк); старый файл сохраняется как *.before-restore.
 */
import { backupPrefix, backupStoreFromEnv, latestBackup, restoreBackup } from "../lib/backup";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const store = backupStoreFromEnv();
  if (!store) throw new Error("Хранилище бэкапов не настроено (BACKUP_S3_* или BACKUP_DIR)");
  if (process.argv.includes("--list")) {
    const list = (await store.list(backupPrefix())).sort((a, b) => a.key.localeCompare(b.key));
    for (const o of list) console.log(`${o.key}\t${(o.size / 1024).toFixed(0)} КБ\t${o.lastModified.toISOString()}`);
    console.log(`Всего: ${list.length}`);
    return;
  }
  const key = process.argv.includes("--latest") ? (await latestBackup(store))?.key : arg("--key");
  const to = arg("--to");
  if (!key || !to) throw new Error("Укажи --latest или --key <ключ>, и --to <путь к файлу базы>");
  const report = await restoreBackup(store, key, to, { force: process.argv.includes("--force") });
  console.log(`Восстановлено: ${key} → ${to}`);
  console.log(`integrity_check: ${report.integrity}`);
  for (const [t, n] of Object.entries(report.tables)) console.log(`  ${t}: ${n}`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
