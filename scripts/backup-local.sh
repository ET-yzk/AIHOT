#!/bin/bash
# Dumps the local aihot database, verifies the archive, and keeps the newest 7
# dumps in the WSL staging directory and on F:\backup\09-regwatch.
# Run by regwatch-backup.service (daily timer) or manually.
set -euo pipefail
APP=/home/zkye/project/regwatch
DEST=/home/zkye/regwatch-backups
MIRROR=/mnt/f/backup/09-regwatch
KEEP=7
mkdir -p "$DEST"

# Only the connection string is needed. Sourcing the whole file ran a value that contains spaces
# (a cron expression) as a command and killed the backup before pg_dump (2026-11-18).
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$APP/.env.local" "$APP/.env" 2>/dev/null | head -n 1)"
export DATABASE_URL

stamp=$(date +%Y%m%d-%H%M)
out="$DEST/aihot-$stamp.dump"
/usr/bin/pg_dump --format=custom --compress=6 --no-owner --file "$out" "$DATABASE_URL"
/usr/bin/pg_restore --list "$out" >/dev/null

# Keep the newest 7 dumps in WSL.
ls -1t "$DEST"/aihot-*.dump | tail -n +$((KEEP + 1)) | xargs -r rm -f

# Mirror to the F: drive. If it is not mounted, keep the WSL copy and say so.
if [ -d "$(dirname "$MIRROR")" ]; then
  mkdir -p "$MIRROR"
  cp -f "$out" "$MIRROR/.$stamp.tmp"
  mv -f "$MIRROR/.$stamp.tmp" "$MIRROR/$(basename "$out")"
  ls -1t "$MIRROR"/aihot-*.dump | tail -n +$((KEEP + 1)) | xargs -r rm -f
  (cd "$MIRROR" && sha256sum aihot-*.dump > SHA256SUMS.txt)
else
  echo "WARNING: $MIRROR is not available; the dump stays in $DEST only" >&2
fi

echo "$(date -Is) $out $(stat -c%s "$out")"
