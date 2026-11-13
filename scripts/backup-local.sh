#!/bin/bash
# Dumps the local aihot database, verifies the archive, keeps the newest 40 in
# ~/regwatch-backups, and mirrors the newest one to the Windows drive so a WSL
# or disk failure does not take the only copy with it.
# Run by regwatch-backup.service (daily timer) or manually.
set -euo pipefail
APP=/home/zkye/project/regwatch
DEST=/home/zkye/regwatch-backups
MIRROR=/mnt/e/project/AIHOT/server-backups/live
mkdir -p "$DEST"

set -a
# shellcheck disable=SC1091
. "$APP/.env"
# shellcheck disable=SC1091
. "$APP/.env.local"
set +a

stamp=$(date +%Y%m%d-%H%M)
out="$DEST/aihot-$stamp.dump"
/usr/bin/pg_dump --format=custom --compress=6 --no-owner --file "$out" "$DATABASE_URL"
/usr/bin/pg_restore --list "$out" >/dev/null

# Keep the newest 40 dumps in WSL.
ls -1t "$DEST"/aihot-*.dump | tail -n +41 | xargs -r rm -f

# Mirror to Windows. If the drive is not mounted, keep the WSL copy and say so.
if [ -d "$(dirname "$MIRROR")" ]; then
  mkdir -p "$MIRROR"
  cp -f "$out" "$MIRROR/.$stamp.tmp"
  mv -f "$MIRROR/.$stamp.tmp" "$MIRROR/$(basename "$out")"
  ls -1t "$MIRROR"/aihot-*.dump | tail -n +41 | xargs -r rm -f
  (cd "$MIRROR" && sha256sum aihot-*.dump > SHA256SUMS.txt)
else
  echo "WARNING: $MIRROR is not available; the dump stays in $DEST only" >&2
fi

echo "$(date -Is) $out $(stat -c%s "$out")"
