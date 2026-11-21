import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createClient } from "@libsql/client";
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { databaseUrl } from "./db";

// Бэкапы SQLite: согласованный снимок (VACUUM INTO, без остановки сервера) → gzip → S3-совместимое
// хранилище (Yandex Object Storage, Selectel, …). Хранится retention_days дней. Восстановление —
// с проверкой целостности до замены файла базы. Инструкция — LAUNCH.md, «Бэкапы».

export type StoredObject = { key: string; lastModified: Date; size: number };

export interface ObjectStore {
  readonly name: string;
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  list(prefix: string): Promise<StoredObject[]>;
  delete(key: string): Promise<void>;
}

export class S3Store implements ObjectStore {
  readonly name: string;
  private client: S3Client;
  constructor(
    private bucket: string,
    cfg: { endpoint?: string; region: string; accessKeyId: string; secretAccessKey: string },
  ) {
    this.name = `s3://${bucket}`;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      forcePathStyle: true,
    });
  }
  async put(key: string, body: Buffer) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: "application/gzip" }));
  }
  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  async list(prefix: string) {
    const out: StoredObject[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of res.Contents ?? []) out.push({ key: o.Key!, lastModified: o.LastModified ?? new Date(0), size: o.Size ?? 0 });
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** Папка на диске вместо S3 — для разработки и тестов (BACKUP_DIR). */
export class LocalDirStore implements ObjectStore {
  readonly name: string;
  constructor(private dir: string) {
    this.name = `dir://${dir}`;
  }
  private file(key: string) {
    return path.join(this.dir, key);
  }
  async put(key: string, body: Buffer) {
    fs.mkdirSync(path.dirname(this.file(key)), { recursive: true });
    fs.writeFileSync(this.file(key), body);
  }
  async get(key: string) {
    return fs.readFileSync(this.file(key));
  }
  async list(prefix: string) {
    const dir = path.dirname(this.file(prefix + "x"));
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .map((f) => path.relative(this.dir, path.join(dir, f)).split(path.sep).join("/"))
      .filter((key) => key.startsWith(prefix))
      .map((key) => {
        const st = fs.statSync(this.file(key));
        return { key, lastModified: st.mtime, size: st.size };
      });
  }
  async delete(key: string) {
    fs.rmSync(this.file(key), { force: true });
  }
}

type Env = Record<string, string | undefined>;

/** Хранилище из env: BACKUP_S3_* → S3; иначе BACKUP_DIR → папка; иначе бэкап не настроен (null). */
export function backupStoreFromEnv(env: Env = process.env): ObjectStore | null {
  if (env.BACKUP_S3_BUCKET) {
    const missing = ["BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY"].filter((k) => !env[k]);
    if (missing.length) throw new Error(`BACKUP_S3_BUCKET задан, но нет ${missing.join(", ")}`);
    return new S3Store(env.BACKUP_S3_BUCKET, {
      endpoint: env.BACKUP_S3_ENDPOINT || undefined,
      region: env.BACKUP_S3_REGION || "ru-central1",
      accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID!,
      secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY!,
    });
  }
  if (env.BACKUP_DIR) return new LocalDirStore(env.BACKUP_DIR);
  return null;
}

export const backupPrefix = (env: Env = process.env) => {
  const p = env.BACKUP_S3_PREFIX ?? "happiness-index/";
  return p && !p.endsWith("/") ? `${p}/` : p;
};

export function backupKey(prefix: string, now: Date) {
  return `${prefix}app-${now.toISOString().replace(/[:.]/g, "-")}.db.gz`;
}

/** Ключи дампов старше retentionDays (только наши файлы app-*.db.gz). */
export function expiredBackups(objects: StoredObject[], now: Date, retentionDays: number): string[] {
  const border = now.getTime() - retentionDays * 86_400_000;
  return objects.filter((o) => /app-[^/]*\.db\.gz$/.test(o.key) && o.lastModified.getTime() < border).map((o) => o.key);
}

/** Согласованный снимок базы в gzip. */
export async function dumpDatabase(url = databaseUrl()): Promise<Buffer> {
  if (!url.startsWith("file:")) throw new Error(`Бэкап умеет только локальный SQLite (file:…), а не ${url}`);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hi-backup-")), "snapshot.db");
  const client = createClient({ url });
  try {
    await client.execute({ sql: "VACUUM INTO ?", args: [tmp] });
    return gzipSync(fs.readFileSync(tmp), { level: 9 });
  } finally {
    client.close();
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

export async function runBackup(store: ObjectStore, opts: { retentionDays: number; prefix?: string; now?: Date; url?: string }) {
  const now = opts.now ?? new Date();
  const prefix = opts.prefix ?? backupPrefix();
  const body = await dumpDatabase(opts.url);
  const key = backupKey(prefix, now);
  await store.put(key, body);
  const expired = expiredBackups(await store.list(prefix), now, opts.retentionDays).filter((k) => k !== key);
  for (const k of expired) await store.delete(k);
  return { key, bytes: body.length, deleted: expired };
}

export type VerifyReport = { integrity: string; tables: Record<string, number> };

/** Проверить файл базы: PRAGMA integrity_check и число строк в ключевых таблицах. */
export async function verifyDatabaseFile(file: string): Promise<VerifyReport> {
  const client = createClient({ url: `file:${file}` });
  try {
    const integrity = String((await client.execute("PRAGMA integrity_check")).rows[0]?.[0] ?? "");
    const tables: Record<string, number> = {};
    for (const t of ["orders", "reports", "results", "tests", "events", "leads"]) {
      tables[t] = Number((await client.execute(`select count(*) from ${t}`)).rows[0][0]);
    }
    return { integrity, tables };
  } finally {
    client.close();
  }
}

/**
 * Восстановить дамп в файл target. Сначала распаковка во временный файл и проверка целостности —
 * только потом замена. Существующий файл перезаписывается лишь с force (старый остаётся рядом *.before-restore).
 */
export async function restoreBackup(store: ObjectStore, key: string, target: string, opts: { force?: boolean } = {}) {
  if (fs.existsSync(target) && !opts.force) throw new Error(`${target} уже существует — останови приложение и добавь --force`);
  const tmp = `${target}.restore-tmp`;
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(tmp, gunzipSync(await store.get(key)));
  let report: VerifyReport;
  try {
    report = await verifyDatabaseFile(tmp);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Дамп ${key} не прошёл проверку: ${(e as Error).message}`);
  }
  if (report.integrity !== "ok") {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Дамп ${key} повреждён: integrity_check = ${report.integrity}`);
  }
  if (fs.existsSync(target)) fs.renameSync(target, `${target}.before-restore`);
  fs.renameSync(tmp, target);
  return report;
}

export async function latestBackup(store: ObjectStore, prefix = backupPrefix()) {
  const list = (await store.list(prefix)).filter((o) => o.key.endsWith(".db.gz")).sort((a, b) => a.key.localeCompare(b.key));
  return list.at(-1) ?? null;
}

