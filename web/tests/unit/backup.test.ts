import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { backupKey, backupStoreFromEnv, expiredBackups, LocalDirStore, latestBackup, restoreBackup, runBackup } from "@/lib/backup";
import { databaseUrl, schema } from "@/lib/db";
import { freshDb } from "./db";

let db: Awaited<ReturnType<typeof freshDb>>;
let dir: string;
beforeEach(async () => {
  db = await freshDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hi-store-"));
});

const DAY = 86_400_000;

describe("бэкапы", () => {
  it("срок хранения 14 дней: удаляются только наши старые дампы", () => {
    const now = new Date("2026-12-01T00:00:00Z");
    const o = (key: string, daysAgo: number) => ({ key, lastModified: new Date(now.getTime() - daysAgo * DAY), size: 1 });
    expect(
      expiredBackups([o("p/app-a.db.gz", 15), o("p/app-b.db.gz", 13), o("p/app-c.db.gz", 14.5), o("p/notes.txt", 30)], now, 14),
    ).toEqual(["p/app-a.db.gz", "p/app-c.db.gz"]);
  });

  it("дамп → хранилище → восстановление: данные на месте, целостность ok", async () => {
    await db.insert(schema.leads).values({ email: "lead@example.ru", consent: true, source: "result" });
    const store = new LocalDirStore(dir);
    const r = await runBackup(store, { retentionDays: 14, prefix: "hi/", url: databaseUrl() });
    expect(r.key).toMatch(/^hi\/app-.*\.db\.gz$/);
    expect(r.bytes).toBeGreaterThan(0);
    expect((await latestBackup(store, "hi/"))?.key).toBe(r.key);

    const target = path.join(dir, "restored", "app.db");
    const report = await restoreBackup(store, r.key, target);
    expect(report.integrity).toBe("ok");
    expect(report.tables.leads).toBe(1);
    await expect(restoreBackup(store, r.key, target)).rejects.toThrow(/--force/);
    await restoreBackup(store, r.key, target, { force: true });
    expect(fs.existsSync(`${target}.before-restore`)).toBe(true);
  });

  it("старые дампы удаляются при новом бэкапе", async () => {
    const store = new LocalDirStore(dir);
    await store.put("hi/app-old.db.gz", Buffer.from("x"));
    const old = new Date(Date.now() - 20 * DAY);
    fs.utimesSync(path.join(dir, "hi/app-old.db.gz"), old, old);
    const r = await runBackup(store, { retentionDays: 14, prefix: "hi/" });
    expect(r.deleted).toEqual(["hi/app-old.db.gz"]);
  });

  it("повреждённый дамп не заменяет базу", async () => {
    const store = new LocalDirStore(dir);
    await store.put("hi/app-broken.db.gz", Buffer.from("это не gzip"));
    const target = path.join(dir, "keep.db");
    fs.writeFileSync(target, "старая база");
    await expect(restoreBackup(store, "hi/app-broken.db.gz", target, { force: true })).rejects.toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("старая база");
  });

  it("настройка из env: S3 → S3Store (нужны ключи), BACKUP_DIR → папка, ничего → null", () => {
    expect(backupStoreFromEnv({})).toBeNull();
    expect(backupStoreFromEnv({ BACKUP_DIR: dir })?.name).toBe(`dir://${dir}`);
    expect(() => backupStoreFromEnv({ BACKUP_S3_BUCKET: "b" })).toThrow(/BACKUP_S3_ACCESS_KEY_ID/);
    expect(backupStoreFromEnv({ BACKUP_S3_BUCKET: "b", BACKUP_S3_ACCESS_KEY_ID: "k", BACKUP_S3_SECRET_ACCESS_KEY: "s" })?.name).toBe("s3://b");
    expect(backupKey("p/", new Date("2026-12-01T03:00:00.000Z"))).toBe("p/app-2026-12-01T03-00-00-000Z.db.gz");
  });
});
