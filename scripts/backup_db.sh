#!/usr/bin/env sh
# Бэкап Postgres: pg_dump в custom-формате + удаление копий старше BACKUP_KEEP_DAYS.
#   DATABASE_URL=postgresql+psycopg://... BACKUP_DIR=/backups sh scripts/backup_db.sh
# Восстановление: pg_restore --clean --if-exists -d "$URL" файл.dump
set -eu
: "${DATABASE_URL:?нужен DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
URL=$(printf '%s' "$DATABASE_URL" | sed 's#^postgresql+psycopg://#postgresql://#')
mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/happiness-$(date -u +%Y%m%d-%H%M%S).dump"
pg_dump --format=custom --no-owner --file="$FILE.part" "$URL"
mv "$FILE.part" "$FILE"
find "$BACKUP_DIR" -name 'happiness-*.dump' -mtime +"$BACKUP_KEEP_DAYS" -delete
echo "бэкап: $FILE ($(wc -c < "$FILE") байт)"
